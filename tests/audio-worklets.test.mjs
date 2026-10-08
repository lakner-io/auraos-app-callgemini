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

function render(p, blocks = 1) {
  const output = [];
  for (let i = 0; i < blocks; i++) {
    const block = new Float32Array(128);
    p.process([], [[block]]);
    output.push(...block);
  }
  return output;
}

function growCushion(p, rate) {
  // Reproduce the four underruns observed in the user's call: 80→300 ms.
  for (let i = 0; i < 4; i++) {
    const samples = p.prime;
    p.port.onmessage({ data: new Int16Array(samples).fill(16000).buffer });
    render(p, Math.ceil(samples * rate / 24000 / 128) + 2);
  }
  assert.equal(p.prime, 7200);
  p.port.onmessage({ data: 'clear' });
  render(p, Math.ceil(rate * 0.02 / 128));
}

for (const rate of [24000, 44100, 48000]) {
  test(`a grown jitter cushion is not bypassed while chunks keep arriving (${rate} Hz)`, () => {
    const { processor: p } = worklet('playback-worklet', rate);
    growCushion(p, rate);
    const arrivalEvery = Math.ceil(rate * 0.02 / 128);
    const output = [];
    // Supply less than 300 ms of speech over 240 ms. Active delivery must
    // build the negotiated cushion, not restart early at the old 160 ms cap.
    for (let b = 0; b < Math.ceil(rate * 0.24 / 128); b++) {
      if (b % arrivalEvery === 0) p.port.onmessage({ data: new Int16Array(480).fill(16000).buffer });
      output.push(...render(p));
    }
    assert.ok(output.every((v) => Math.abs(v) < 0.001), 'played before the 300 ms cushion was ready');
    p.port.onmessage({ data: new Int16Array(7200).fill(16000).buffer });
    assert.ok(render(p, 4).some((v) => v > 0.1), 'did not start after enough audio arrived');
  });

  test(`an isolated short tail still plays without a flush (${rate} Hz)`, () => {
    const { processor: p } = worklet('playback-worklet', rate);
    growCushion(p, rate);
    p.port.onmessage({ data: new Int16Array(480).fill(16000).buffer });
    assert.ok(render(p, Math.ceil(rate * 0.25 / 128)).some((v) => v > 0.1));
  });
}

test('resuming after a one-sample underrun does not introduce a click', () => {
  const { processor: p } = worklet('playback-worklet', 24000);
  p.port.onmessage({ data: new Int16Array(2047).fill(16000).buffer });
  const before = render(p, 16); // one decaying sample after the queue drains
  p.port.onmessage({ data: new Int16Array(4000).fill(16000).buffer });
  const after = render(p);
  assert.ok(Math.abs(after[0] - before.at(-1)) < 0.05,
    `resume jumped from ${before.at(-1)} to ${after[0]}`);
});

test('a flushed short ending plays immediately even with a grown cushion', () => {
  const { processor: p, messages } = worklet('playback-worklet', 24000);
  growCushion(p, 24000);
  const underruns = messages.filter((m) => m?.t === 'underrun').length;
  p.port.onmessage({ data: new Int16Array(480).fill(16000).buffer });
  p.port.onmessage({ data: 'flush' });
  assert.ok(render(p).some((v) => v > 0.1));
  render(p, 10);
  assert.equal(messages.filter((m) => m?.t === 'underrun').length, underruns);
});

test('clearing and immediately replacing speech does not create a waveform step', () => {
  const { processor: p } = worklet('playback-worklet', 24000);
  p.port.onmessage({ data: new Int16Array(4000).fill(16000).buffer });
  const before = render(p, 8);
  p.port.onmessage({ data: 'clear' });
  p.port.onmessage({ data: new Int16Array(4000).fill(-16000).buffer });
  const after = render(p, 2);
  assert.ok(Math.abs(after[0] - before.at(-1)) < 0.05);
  assert.ok(after.at(-1) < -0.4, 'replacement speech should finish fading in');
});

test('playback worklet reports debug stats only when asked', () => {
  const { processor: p, messages } = worklet('playback-worklet', 24000);
  growCushion(p, 24000);
  assert.ok(!messages.some((m) => m?.t === 'stats'), 'stats posted without a request');
  p.port.onmessage({ data: { t: 'stats?' } });
  const st = messages.findLast((m) => m?.t === 'stats');
  assert.equal(st.cushionMs, 300);
  assert.equal(st.underruns, 4);
  assert.ok(st.bursts >= 4);
});

/** One burst: `ms` of audio, then 'flush', then render until it has played out. */
function cleanBurst(p, ms = 400) {
  p.port.onmessage({ data: new Int16Array(ms * 24).fill(16000).buffer });
  p.port.onmessage({ data: 'flush' });
  render(p, Math.ceil(ms * 24 / 128) + 4);
}

test('a tool-call pause after flush is not an underrun and does not grow the cushion', () => {
  const { processor: p, messages } = worklet('playback-worklet', 24000);
  cleanBurst(p);                       // speech before the tool call, then toolPause → flush
  render(p, Math.ceil(24000 * 0.6 / 128)); // 600 ms tool pause
  cleanBurst(p);                       // speech after the tool
  assert.equal(messages.filter((m) => m?.t === 'underrun').length, 0);
  assert.equal(p.prime, 1920);
});

test('a grown cushion shrinks after clean bursts, down to the 80 ms floor', () => {
  const { processor: p } = worklet('playback-worklet', 24000);
  growCushion(p, 24000);               // 300 ms
  cleanBurst(p);
  assert.equal(p.prime, 7200, 'one clean burst is not enough');
  cleanBurst(p);
  assert.equal(p.prime, 7200 - 480);   // 280 ms
  cleanBurst(p);
  assert.equal(p.prime, 7200 - 960);   // 260 ms
  for (let i = 0; i < 20; i++) cleanBurst(p);
  assert.equal(p.prime, 1920);
});

test('an underrun resets the clean streak', () => {
  const { processor: p } = worklet('playback-worklet', 24000);
  growCushion(p, 24000);
  cleanBurst(p);
  // A burst that dries out mid-way (no flush), then ends with a flush.
  p.port.onmessage({ data: new Int16Array(p.prime).fill(16000).buffer });
  render(p, Math.ceil(p.prime / 128) + 4);
  p.port.onmessage({ data: new Int16Array(p.prime).fill(16000).buffer });
  p.port.onmessage({ data: 'flush' });
  render(p, Math.ceil(p.prime / 128) + 4);
  cleanBurst(p);
  assert.equal(p.prime, 7200, 'streak should have restarted after the underrun');
  cleanBurst(p);
  assert.equal(p.prime, 7200 - 480);
});
