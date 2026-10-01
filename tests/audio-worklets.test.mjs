import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function worklet(name, rate) {
  const messages = [];
  let Processor;
  const context = vm.createContext({
    sampleRate: rate,
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: (m) => messages.push(m) }; } },
    registerProcessor: (_, ctor) => { Processor = ctor; },
  });
  const source = fs.readFileSync(new URL(`../public/worklets/${name}.js`, import.meta.url), 'utf8');
  vm.runInContext(source.replace('export class ', 'class '), context);
  return { processor: new Processor(), messages };
}

for (const rate of [24000, 44100, 48000]) {
  test(`24 kHz speech plays at the correct speed and pitch on a ${rate} Hz device`, () => {
    const { processor: p } = worklet('playback-worklet', rate);
    const pcm = Int16Array.from({ length: 24000 }, (_, i) => Math.round(16000 * Math.sin(2 * Math.PI * 440 * i / 24000)));
    // Uneven network chunks exercise interpolation across chunk boundaries.
    for (let i = 0; i < pcm.length; i += 701) p.port.onmessage({ data: pcm.slice(i, i + 701).buffer });
    p.port.onmessage({ data: 'flush' });
    const output = [];
    for (let i = 0; i < Math.ceil(rate * 1.1 / 128); i++) {
      const block = new Float32Array(128);
      p.process([], [[block]]);
      output.push(...block);
    }
    const lastSignal = output.findLastIndex((v) => Math.abs(v) > 0.01);
    assert.ok(Math.abs(lastSignal / rate - 1) < 0.015, `speech duration was ${lastSignal / rate}s`);
    let crossings = 0;
    for (let i = Math.ceil(rate * 0.1); i < rate * 0.9; i++) {
      if (output[i - 1] <= 0 && output[i] > 0) crossings++;
    }
    assert.ok(Math.abs(crossings / 0.8 - 440) < 3, `pitch was ${crossings / 0.8} Hz`);
  });

  test(`capture at ${rate} Hz still sends 16 kHz, 20 ms PCM frames`, () => {
    const { processor: p, messages } = worklet('capture-worklet', rate);
    for (let i = 0; i < rate; i += 128) {
      const block = new Float32Array(Math.min(128, rate - i)).fill(0.25);
      p.process([[block]]);
    }
    const frames = messages.filter((m) => m.buf);
    assert.ok(frames.length >= 49 && frames.length <= 50);
    for (const frame of frames) {
      assert.equal(frame.buf.byteLength, 640);
      assert.ok(Math.abs(new Int16Array(frame.buf)[100] - 8192) < 2);
    }
  });
}

test('clearing playback drops queued speech at a native device rate', () => {
  const { processor: p } = worklet('playback-worklet', 48000);
  p.port.onmessage({ data: new Int16Array(24000).fill(16000).buffer });
  p.port.onmessage({ data: 'clear' });
  const block = new Float32Array(128);
  p.process([], [[block]]);
  assert.ok(block.every((v) => v === 0));
});
