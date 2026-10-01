/**
 * `callgemini-control` — CallGemini's general control MCP server.
 *
 * Lets another agent or app drive a live call the way the user would from the
 * call bar: read its state, silence / unsilence the speaker. The page owns
 * that state, so the server reaches it through the call's own WebSocket
 * (CallSession → browser) — every action therefore needs a live call.
 *
 * Advertised by the `provides` entry `control` in app.manifest.json (kind
 * mcp, address /mcp/control) — the OS Interface Registry materialises it as a
 * live address whenever this app is up. Managing MCP servers stays in its own
 * special-purpose server (`mcpServers.mjs`, /mcp/servers).
 *
 * `pause` / `unpause` control nothing in the app: they hold one boolean per
 * conversation, and their descriptions + results are the MISSION for the
 * agent calling them (Gemini, when this server is wired into CallGemini):
 * while paused, stay silent until the user says unpause / continue.
 */
import { findByConversation } from './sessions.mjs';
import { CONVERSATION_ID_DESC, ToolError, ok, createToolServer, resolveConversation } from './mcpCommon.mjs';

/** Paused conversations — anchored on globalThis like sessions.mjs, so the
 * state survives this route module being re-evaluated per dev edit. */
const paused = (globalThis.__callgeminiPaused ??= new Set());

const PAUSE_MISSION =
  'You are now PAUSED. Stay completely silent: do not answer, comment, acknowledge or react to anything ' +
  'you hear — not even "okay" — and call no other tools. Ignore everything until the user clearly says ' +
  '"unpause", "continue" or "resume"; only then call the `unpause` tool and carry on normally.';
const UNPAUSE_MISSION =
  'You are no longer paused. Respond normally again — briefly confirm you are back and continue ' +
  'where the conversation left off.';

const TOOLS = [
  {
    name: 'get_call_state',
    title: 'Get call state',
    description:
      'Whether a conversation has a live call, whether it is paused, and (live only) whether its ' +
      'speaker is silenced. ' +
      'Without conversation_id: the one live call.',
    inputSchema: {
      type: 'object',
      properties: { conversation_id: { type: 'string', description: CONVERSATION_ID_DESC } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'pause',
    title: 'Pause (stay silent)',
    description:
      'Call this when the user asks you to pause — e.g. "pause", "hold on", "stop listening", "be quiet ' +
      'for a moment". After calling it you MUST stay completely silent: do not answer, comment, acknowledge ' +
      'or react to anything you hear, and call no other tools, until the user says "unpause", "continue" ' +
      'or "resume" — then call `unpause`. Speech while paused is not meant for you.',
    inputSchema: {
      type: 'object',
      properties: { conversation_id: { type: 'string', description: CONVERSATION_ID_DESC } },
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'unpause',
    title: 'Unpause (respond again)',
    description:
      'Call this when you are paused and the user says "unpause", "continue" or "resume" (or clearly asks ' +
      'you to talk again). It ends the pause: from then on respond normally. The ONLY tool you may call ' +
      'while paused.',
    inputSchema: {
      type: 'object',
      properties: { conversation_id: { type: 'string', description: CONVERSATION_ID_DESC } },
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'set_speaker_muted',
    title: 'Silence / unsilence the speaker',
    description:
      "Silence or unsilence Gemini's voice on the user's side of a live call — like clicking the speaker " +
      'icon in CallGemini. Output only: the microphone, the transcript and the call itself keep running, ' +
      'and unsilencing restores the previous volume. Omit `muted` to toggle. Needs a live call.',
    inputSchema: {
      type: 'object',
      properties: {
        muted: { type: 'boolean', description: 'true = silence, false = unsilence. Omit to toggle.' },
        conversation_id: { type: 'string', description: CONVERSATION_ID_DESC },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
];

function callState(conv) {
  const session = findByConversation(conv.id);
  return {
    conversation: { id: conv.id, title: conv.title },
    live: !!session,
    paused: paused.has(conv.id),
    ...(session ? { speaker_muted: !!session.speakerMuted } : {}),
  };
}

/** The live session of the resolved conversation, or a ToolError. */
async function liveSession(conversationId) {
  const conv = await resolveConversation(conversationId);
  const session = findByConversation(conv.id);
  if (!session) throw new ToolError(`Conversation "${conv.id}" has no live call — this needs a call in progress.`);
  return { conv, session };
}

const handlers = {
  async get_call_state(args) {
    return ok(callState(await resolveConversation(args.conversation_id)));
  },

  async pause(args) {
    const conv = await resolveConversation(args.conversation_id);
    paused.add(conv.id);
    return ok({ ...callState(conv), mission: PAUSE_MISSION });
  },

  async unpause(args) {
    const conv = await resolveConversation(args.conversation_id);
    paused.delete(conv.id);
    return ok({ ...callState(conv), mission: UNPAUSE_MISSION });
  },

  async set_speaker_muted(args) {
    if (args.muted !== undefined && typeof args.muted !== 'boolean') throw new ToolError('muted must be true or false (or omitted to toggle).');
    const { conv, session } = await liveSession(args.conversation_id);
    const target = typeof args.muted === 'boolean' ? args.muted : !session.speakerMuted;
    const speaker = await session.setSpeakerMuted(target);
    return ok({ speaker, ...callState(conv) });
  },
};

export const buildServer = createToolServer({
  name: 'callgemini-control',
  instructions:
    'Control a live CallGemini call the way the user would from the call bar: read its state and silence / ' +
    "unsilence Gemini's voice. pause / unpause: when the user asks you to pause, call `pause` and stay " +
    'completely silent — ignore everything — until they say "unpause" or "continue"; then call `unpause`. ' +
    'Tools default to the conversation of the single live call; pass conversation_id otherwise.',
  tools: TOOLS,
  handlers,
});
