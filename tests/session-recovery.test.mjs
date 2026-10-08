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
const { CallSession, parseDurationMs } = await import('../src/server/callBridge.mjs');
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
  call.toolsInFlight = 1; // hold the proactive goAway switch: the server closes first here
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

test('a tool call tells the page to play out its queue (toolPause) before the tool runs', async (t) => {
  const { call, events, dials } = harness(t);
  await call.connectGemini();
  dials[0].callbacks.onmessage({ toolCall: { functionCalls: [{ id: 'c1', name: 'get_x', args: {} }] } });
  const i = events.findIndex((e) => e.type === 'toolPause');
  assert.ok(i >= 0, 'no toolPause event');
  assert.ok(i < events.findIndex((e) => e.type === 'tool'), 'toolPause must come before the tool chip');
});

test('parseDurationMs reads the goAway timeLeft formats', () => {
  assert.equal(parseDurationMs('50s'), 50_000);
  assert.equal(parseDurationMs('1.5s'), 1500);
  assert.equal(parseDurationMs({ seconds: '2', nanos: 500_000_000 }), 2500);
  assert.equal(parseDurationMs('soon'), null);
});

test('goAway while quiet switches to a resumed connection right away', async (t) => {
  const { call, dials, events } = harness(t);
  await call.connectGemini();
  dials[0].callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
  dials[0].callbacks.onmessage({ goAway: { timeLeft: '50s' } });
  await settle();
  assert.equal(dials.length, 2);
  assert.deepEqual(dials[1].config.sessionResumption, { handle: 'h1' });
  dials[0].callbacks.onclose({ code: 1000 }); // the old socket closing must not trigger another resume
  await settle();
  assert.equal(dials.length, 2);
  assert.equal(events.at(-1).state, 'live');
});

test('goAway during a reply waits for turnComplete, then switches', async (t) => {
  const { call, dials } = harness(t);
  await call.connectGemini();
  dials[0].callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
  dials[0].callbacks.onmessage({ serverContent: { outputTranscription: { text: 'Es geht darum, den ' } } });
  dials[0].callbacks.onmessage({ goAway: { timeLeft: '50s' } });
  await settle();
  assert.equal(dials.length, 1, 'must not cut the reply');
  dials[0].callbacks.onmessage({ serverContent: { outputTranscription: { text: 'korrekten Status zu prüfen.' } } });
  dials[0].callbacks.onmessage({ serverContent: { turnComplete: true } });
  await settle();
  assert.equal(dials.length, 2);
});

test('goAway waits for a tool in flight, and the deadline forces the switch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const { call, dials } = harness(t);
  await call.connectGemini();
  dials[0].callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'h1' } });
  call.toolsInFlight = 1;                         // a BLOCKING tool's answer belongs to this session
  dials[0].callbacks.onmessage({ goAway: { timeLeft: '10s' } });
  await settle();
  assert.equal(dials.length, 1);
  t.mock.timers.tick(4000);                       // still inside the 10 s − 5 s margin window
  await settle();
  assert.equal(dials.length, 1);
  t.mock.timers.tick(1500);                       // past the deadline
  await settle();
  assert.equal(dials.length, 2, 'deadline must force the switch');
});

test('stopping the call cancels a pending goAway switch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000 });
  const { call, dials } = harness(t);
  await call.connectGemini();
  call.toolsInFlight = 1;
  dials[0].callbacks.onmessage({ goAway: { timeLeft: '10s' } });
  call.stopGemini('user-stop');
  t.mock.timers.tick(20_000);
  await settle();
  assert.equal(dials.length, 1);
});
