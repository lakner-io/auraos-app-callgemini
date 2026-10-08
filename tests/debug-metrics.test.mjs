import test from 'node:test';
import assert from 'node:assert/strict';
import { Tracker, summarizeTurn, percentiles, diagnose, int16Rms, logs, captureConsole } from '../src/server/debugMetrics.mjs';

const tone = (n, amp) => Buffer.from(Int16Array.from({ length: n }, () => amp).buffer);

test('percentiles', () => {
  assert.equal(percentiles([]), null);
  const p = percentiles([10, 20, 30, 40, 1000]);
  assert.equal(p.p50, 30);
  assert.equal(p.max, 1000);
});

test('int16Rms', () => {
  assert.equal(Math.round(int16Rms(tone(320, 1000))), 1000);
  assert.equal(int16Rms(tone(320, 0)), 0);
});

test('a turn trace measures speech end → first chunk → audible → complete', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const tr = new Tracker('c1');
  tr.dial({ resumed: false, tools: 52, sysChars: 900 });
  t.mock.timers.tick(400);
  tr.live();
  tr.micFrame(tone(320, 3000), true);        // voice
  tr.userTranscript();
  t.mock.timers.tick(20);
  tr.micFrame(tone(320, 10), true);          // silence → speech ended 20 ms ago
  t.mock.timers.tick(1180);
  tr.downChunk(48 * 100);                    // 100 ms of audio, 1200 ms after speech end
  t.mock.timers.tick(90);
  tr.playback('playing');
  t.mock.timers.tick(50);
  tr.downChunk(48 * 900);
  t.mock.timers.tick(1000);
  tr.turnComplete();
  const s = summarizeTurn(tr.turns[0]);
  assert.equal(s.speech_end_to_first_chunk_ms, 1200);
  assert.equal(s.first_chunk_to_audible_ms, 90);
  assert.equal(s.speech_end_source, 'mic_energy');
  assert.equal(s.audio_ms, 1000);
  assert.equal(s.max_chunk_gap_ms, 140);
  assert.equal(tr.conn.connects[0].setupMs, 400);
});

test('browser VAD end wins over mic energy for the speech end', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 5_000 });
  const tr = new Tracker('c2');
  tr.micFrame(tone(320, 3000), true);
  t.mock.timers.tick(300);
  tr.vad('end');
  t.mock.timers.tick(700);
  tr.downChunk(4800);
  assert.equal(summarizeTurn(tr.cur).speech_end_to_first_chunk_ms, 700);
});

test('diagnose flags socket errors, slow model and a capped cushion', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const tr = new Tracker('c3');
  tr.dial({ resumed: true, tools: 114, sysChars: 500 });
  tr.live();
  tr.closed(1011, 'Internal error encountered.');
  t.mock.timers.tick(2500);
  tr.live();
  tr.vad('end');
  t.mock.timers.tick(3000);
  tr.downChunk(4800);
  tr.turnComplete();
  tr.clientStats({ playback: { cushionMs: 300, underruns: 4 }, rttMs: 40 });
  const areas = diagnose(tr).findings.map((f) => f.area);
  for (const a of ['connection', 'model', 'jitter']) assert.ok(areas.includes(a), `missing ${a}: ${areas}`);
  assert.equal(tr.conn.reconnects[0].ms, 2500);
});

test('log capture keeps only [callgemini…] lines', () => {
  captureConsole();
  const orig = console.log;
  console.log('[callgemini/test] hello', { a: 1 });
  console.log('unrelated');
  const lines = logs({ grep: 'callgemini/test' });
  assert.equal(lines.at(-1).text, '[callgemini/test] hello {"a":1}');
  assert.ok(!logs({ grep: 'unrelated' }).length);
  assert.ok(orig);
});
