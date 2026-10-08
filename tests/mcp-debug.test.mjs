import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate persistence before importing the store: never touch /data.
const testDataDir = await mkdtemp(join(tmpdir(), 'callgemini-debugmcp-test-'));
process.env.AURA_DATA_DIR = testDataDir;
const conversations = await import('../src/server/conversations.mjs');
const { register, unregister } = await import('../src/server/sessions.mjs');
const { handlers } = await import('../src/server/mcpDebug.mjs');
after(async () => {
  await globalThis.__callgeminiConversations.opChain;
  await rm(testDataDir, { recursive: true, force: true });
});

const data = (res) => res.structuredContent;
const CONFIGURED = [{ url: 'http://a/mcp' }, { url: 'http://b/mcp' }];

test('without a call: latest conversation, calling:false, servers from stored toggles', async () => {
  globalThis.__callgeminiShared.lastConfiguredServers = CONFIGURED; // the bridge holds this object
  const conv = await conversations.create({ mcpDisabled: ['http://b/mcp'] });
  await conversations.appendTurn(conv.id, { role: 'user', text: 'hello there', ts: String(Date.now()) });
  await conversations.update(conv.id, { mcpTemporary: [{ url: 'http://t/mcp', name: 'Temp', toolCount: 62 }] });
  const r = data(await handlers.get_current_conversation({}));
  assert.equal(r.calling, false);
  assert.equal(r.conversation.id, conv.id);
  assert.equal(r.conversation.turns, 1);
  const byUrl = Object.fromEntries(r.mcp_servers.map((s) => [s.url, s]));
  assert.equal(byUrl['http://a/mcp'].enabled, true);
  assert.equal(byUrl['http://b/mcp'].enabled, false);
  assert.equal(byUrl['http://t/mcp'].temporary, true);

  const c = data(await handlers.get_conversation_context({}));
  assert.equal(c.calling, false);
  assert.match(c.system_instruction, /User: hello there/);
  assert.equal(c.transcript.total_turns, 1);
});

test('during a call: live session, its servers, dialed context and tools by server', async (t) => {
  const conv = await conversations.create({});
  const fake = {
    convId: conv.id, closed: false, session: {}, liveConfig: {}, userStopped: false,
    callStartedAt: Date.now(), model: 'gemini-x', voiceName: 'Kore', reconnectTries: 0, speakerMuted: false,
    accrual: { role: 'user', text: 'switch to work' },
    lastDial: { at: Date.now(), resumed: false, systemInstruction: 'Base.\n--- Conversation so far ---', toolNames: ['get_x', 'run_y'], slidingWindow: true },
    mcp: {
      functionDeclarations: [{}, {}],
      toolRoutes: () => [{ fn: 'get_x', serverUrl: 'http://a/mcp' }, { fn: 'run_y', serverUrl: 'http://b/mcp' }],
    },
    mcpServerReport: () => [{ url: 'http://a/mcp', enabled: true, ok: true, tools: 1 }],
    close() {},
  };
  register(fake);
  t.after(() => unregister(fake));
  const r = data(await handlers.get_current_conversation({}));
  assert.equal(r.calling, true);
  assert.equal(r.conversation.id, conv.id);
  assert.equal(r.call.gemini_state, 'live');
  assert.equal(r.call.model, 'gemini-x');
  assert.equal(r.call.declared_tools, 2);
  assert.equal(r.mcp_servers[0].url, 'http://a/mcp');

  fake.session = null; // dropped, resuming
  assert.equal(data(await handlers.get_current_conversation({})).call.gemini_state, 'reconnecting');

  const c = data(await handlers.get_conversation_context({ include_system_instruction: false }));
  assert.match(c.source, /^fresh/);
  assert.equal(c.system_instruction, undefined);
  assert.deepEqual(c.declared_tools_by_server, { 'http://a/mcp': ['get_x'], 'http://b/mcp': ['run_y'] });
  assert.equal(c.transcript.current.text, 'switch to work');
});

test('configured MCP servers keep their custom name; empty name stays empty (UI falls back to the URL)', async () => {
  const { mergeServers } = await import('../src/server/callBridge.mjs');
  const merged = mergeServers(
    [{ url: 'http://a/mcp', name: '  Shell  ' }, { url: 'http://b/mcp' }],
    [{ url: 'http://a/mcp', name: 'dup temp' }, { url: 'http://t/mcp', name: 'Temp' }],
  );
  assert.deepEqual(merged.map((s) => [s.url, s.name, s.temporary]), [
    ['http://a/mcp', 'Shell', false],   // Settings wins over a temporary duplicate, name trimmed
    ['http://b/mcp', '', false],         // old config without a name still works
    ['http://t/mcp', 'Temp', true],
  ]);

  globalThis.__callgeminiShared.lastConfiguredServers = [{ url: 'http://a/mcp', name: 'Shell' }];
  await conversations.create({});
  const r = (await handlers.get_current_conversation({})).structuredContent;
  assert.equal(r.mcp_servers.find((s) => s.url === 'http://a/mcp').name, 'Shell');
});
