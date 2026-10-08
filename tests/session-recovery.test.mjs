import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate persistence before importing the real bridge/store: never touch /data.
const testDataDir = await mkdtemp(join(tmpdir(), 'callgemini-recovery-test-'));
process.env.AURA_DATA_DIR = testDataDir;
const { CallSession } = await import('../src/server/callBridge.mjs');
const conversations = await import('../src/server/conversations.mjs');
after(async () => {
  await globalThis.__callgeminiConversations.opChain;
  await rm(testDataDir, { recursive: true, force: true });
});

function harness(t) {
  const events = [];
  const dials = [];
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, OPEN: 1, send: (data) => events.push(JSON.parse(data)), close() {} });
  const call = new CallSession(ws);
  t.after(() => call.close('test'));
  call.model = 'test-model';
  call.liveConfig = { sessionResumption: {}, systemInstruction: 'Test instruction' };
  call.genai = { live: { connect: async (request) => {
    const session = { close() {} };
    dials.push({ ...request, session });
    request.callbacks.onopen();
    return session;
  } } };
  return { call, events, dials };
}

const rejected = { code: 1007, reason: 'Request contains an invalid argument.' };
async function settle() { for (let i = 0; i < 10; i++) await tick(); }

test('a 1007 after completed turns and goAway recovers fresh once, not a dead call', async (t) => {
  const { call, events, dials } = harness(t);
  await call.connectGemini('saved-handle');
  dials[0].callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'latest-handle' } });
  dials[0].callbacks.onmessage({ serverContent: { turnComplete: true } });
  dials[0].callbacks.onmessage({ goAway: { timeLeft: '50s' } });
  dials[0].callbacks.onclose(rejected);
  await settle();
  assert.equal(dials.length, 2, 'rejection must reconnect, not end the call');
  assert.deepEqual(dials[1].config.sessionResumption, {}, 'do not reuse rejected server state');
  assert.equal(call.resumeHandle, null);
  assert.equal(events.some((e) => e.state === 'error' || e.state === 'ended'), false);
  assert.equal(events.at(-1).state, 'live');

  // If the unchanged request really is invalid, stop instead of looping.
  dials[1].callbacks.onclose(rejected);
  await settle();
  assert.equal(dials.length, 2);
  assert.equal(events.at(-1).state, 'ended');
});

test('a network reconnect rejected during setup also falls back fresh', async (t) => {
  const { call, events, dials } = harness(t);
  await call.connectGemini();
  call.resumeHandle = 'expired-handle';
  const connect = call.genai.live.connect;
  call.genai.live.connect = (request) => {
    if (request.config.sessionResumption?.handle) {
      request.callbacks.onclose(rejected);
      return new Promise(() => {}); // SDK waits for setupComplete, which never arrives
    }
    return connect(request);
  };
  dials[0].callbacks.onclose({ code: 1006 });
  await settle();
  assert.equal(dials.length, 2);
  assert.deepEqual(dials[1].config.sessionResumption, {});
  assert.equal(events.at(-1).state, 'live');
});

test('opening a socket does not reset the reconnect budget before a completed turn', async (t) => {
  const { call, events, dials } = harness(t);
  await call.connectGemini();
  call.resumeHandle = 'handle';
  for (let i = 0; i < 3; i++) {
    dials.at(-1).callbacks.onclose({ code: 1006 });
    await settle();
  }
  assert.equal(dials.length, 3, 'at most two automatic resume attempts');
  assert.equal(events.at(-1).state, 'ended');
});

test('stopping while recovery connects closes the late session without announcing live', async (t) => {
  const { call, events, dials } = harness(t);
  await call.connectGemini('handle');
  let finish;
  let closed = false;
  call.genai.live.connect = () => new Promise((resolve) => { finish = resolve; });
  dials[0].callbacks.onclose(rejected);
  await settle();
  assert.equal(typeof finish, 'function');
  call.stopGemini('test');
  const eventCount = events.length;
  finish({ close() { closed = true; } });
  await settle();
  assert.equal(closed, true);
  assert.equal(call.session, null);
  assert.equal(events.length, eventCount, 'no new status after Stop');
});

test('policy rejections do not start an automatic fresh call', async (t) => {
  const { call, events, dials } = harness(t);
  await call.connectGemini();
  dials[0].callbacks.onclose({ code: 1008, reason: 'Policy violation' });
  await settle();
  assert.equal(dials.length, 1);
  assert.equal(events.at(-1).state, 'ended');
});

test('fresh recovery saves the partial turn, replays history, and invalidates the stored handle', async (t) => {
  const { call, dials } = harness(t);
  const conv = await conversations.create({});
  call.convId = conv.id;
  await conversations.appendTurn(conv.id, { role: 'user', text: 'Earlier context' });
  await conversations.update(conv.id, { resumeHandle: 'rejected-handle' });
  await call.connectGemini('rejected-handle');
  call.resumeHandle = 'rejected-handle';
  call.accrue('model', 'An unfinished answer');
  await dials[0].callbacks.onclose(rejected);
  const saved = await conversations.get(conv.id);
  assert.equal(saved.resumeHandle, null);
  assert.equal(saved.turns.at(-1).text, 'An unfinished answer');
  assert.match(dials[1].config.systemInstruction, /Earlier context/);
  assert.match(dials[1].config.systemInstruction, /An unfinished answer/);
  assert.equal(call.liveConfig.systemInstruction, 'Test instruction', 'do not accumulate replay into base config');
});

test('a failed fresh setup reports the new error, not the original 1007, without looping', async (t) => {
  const { call, events, dials } = harness(t);
  await call.connectGemini();
  let attempts = 0;
  call.genai.live.connect = async () => {
    attempts++;
    throw new Error('Service unavailable');
  };
  await dials[0].callbacks.onclose(rejected);
  assert.equal(attempts, 1);
  assert.match(events.findLast((e) => e.state === 'error').message, /Service unavailable/);
  assert.equal(events.at(-1).state, 'ended');
});

test('Stop while saved history loads prevents a fresh dial', async (t) => {
  const { call, events, dials } = harness(t);
  const conv = await conversations.create({});
  call.convId = conv.id;
  await call.connectGemini();
  const recovery = dials[0].callbacks.onclose(rejected);
  call.stopGemini('test');
  await recovery;
  assert.equal(dials.length, 1);
  assert.equal(call.session, null);
  assert.equal(events.at(-1).state, 'idle');
});
