import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallAudio } from '../src/client/callAudio.mjs';

function fixture({ pendingPermission = false, blockedResume = false } = {}) {
  const events = [];
  const track = { stopped: false, stop() { this.stopped = true; events.push('track-stop'); } };
  const stream = { getTracks: () => [track] };
  let permit;
  const permission = pendingPermission ? new Promise((resolve) => { permit = resolve; }) : Promise.resolve(stream);
  class Context {
    constructor(options) { this.options = options; this.state = 'suspended'; events.push('context'); }
    resume() {
      events.push('resume');
      if (blockedResume) return new Promise(() => {});
      this.state = 'running';
      return Promise.resolve();
    }
    close() { events.push('context-close'); this.state = 'closed'; return Promise.resolve(); }
  }
  const audio = createCallAudio({ Context, mediaDevices: { getUserMedia: () => { events.push('permission'); return permission; } } });
  return { audio, events, track, permit: () => permit(stream) };
}

test('one native-rate context is resumed and permission requested synchronously in the tap', async () => {
  const { audio, events } = fixture();
  assert.deepEqual(events, ['context', 'resume', 'permission']);
  assert.equal(audio.context.options.sampleRate, undefined);
  await audio.microphone();
  await audio.resume();
  audio.close();
  audio.close();
  assert.equal(events.filter((e) => e === 'context-close').length, 1);
});

test('hanging up while permission is pending stops a subsequently granted microphone', async () => {
  const { audio, track, permit } = fixture({ pendingPermission: true });
  const waiting = audio.microphone();
  audio.close();
  await assert.rejects(waiting, { name: 'AbortError' });
  permit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(track.stopped, true);
  assert.throws(() => audio.assertActive(), { name: 'AbortError' });
});

test('closing an active call releases the microphone and cancels startup waits', async () => {
  const { audio, track } = fixture();
  await audio.microphone();
  const waiting = audio.waitFor(new Promise(() => {}));
  audio.close();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(track.stopped, true);
});

test('a suspended context can be resumed after an interruption', async () => {
  const { audio } = fixture();
  audio.context.state = 'interrupted';
  await audio.resume();
  assert.equal(audio.context.state, 'running');
  audio.close();
});

test('a browser that never grants audio activation gives a bounded error', async () => {
  const { audio } = fixture({ blockedResume: true });
  await assert.rejects(audio.resume(5), /Audio is paused by the browser/);
  audio.close();
});

test('a synchronous microphone error closes the newly created context', () => {
  let closed = false;
  class Context {
    resume() { return Promise.resolve(); }
    close() { closed = true; return Promise.resolve(); }
  }
  assert.throws(() => createCallAudio({ Context, mediaDevices: { getUserMedia() { throw new Error('denied'); } } }), /denied/);
  assert.equal(closed, true);
});

test('the iOS compatibility rate applies to the single shared context', () => {
  class Context {
    constructor(options) { this.sampleRate = options.sampleRate; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  const audio = createCallAudio({ sampleRate: 24000, Context,
    mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) } });
  assert.equal(audio.context.sampleRate, 24000);
  audio.close();
});
