/**
 * `callgemini-debug` — metrics, logs and traces of CallGemini's live voice
 * pipeline, for an agent improving it (Claude, Hermes …). NOT wired into
 * Gemini's own tool list: the voice model never sees these tools.
 *
 * Advertised by the `provides` entry `debug` in app.manifest.json (kind mcp,
 * address /mcp/debug). The data lives in debugMetrics.mjs: counters and
 * per-turn traces are always recorded; `set_debug_logging` adds the browser's
 * detailed stats (mic level, VAD, jitter cushion, RTT) and an optional
 * one-line console trace per interval. Memory only — an app restart clears it.
 */
import { findByConversation, liveConversations, liveSessions } from './sessions.mjs';
import { CONVERSATION_ID_DESC, ToolError, ok, createToolServer } from './mcpCommon.mjs';
import * as dm from './debugMetrics.mjs';
import * as conversations from './conversations.mjs';
import { historyInstruction, HISTORY_MAX_TURNS, HISTORY_MAX_CHARS, HISTORY_MAX_LINE } from './history.mjs';
import { getLastConfiguredServers, mergeServers } from './callBridge.mjs';

/** pause / unpause state of mcpControl.mjs (same globalThis anchor). */
const paused = (globalThis.__callgeminiPaused ??= new Set());

const CONV = { conversation_id: { type: 'string', description: CONVERSATION_ID_DESC + ' Calls that already ended stay inspectable (see list_traced_calls).' } };
const RO = { readOnlyHint: true, idempotentHint: true };

const TOOLS = [
  {
    name: 'get_current_conversation',
    title: 'Current conversation',
    description:
      'Are we calling right now, and which conversation is current: id, title, turn count, last turns; for a ' +
      'live call also model, voice, Gemini state (live / reconnecting), paused, speaker, declared tools; and the ' +
      'MCP servers of that Gemini conversation (enabled / skipped / temporary, connected, tool count). Without ' +
      'conversation_id: the live call, else the most recently updated conversation.',
    inputSchema: { type: 'object', properties: { ...CONV }, additionalProperties: false },
    annotations: RO,
  },
  {
    name: 'get_conversation_context',
    title: 'Conversation context',
    description:
      'What Gemini has as context for a conversation: whether the session was resumed (server-side state via ' +
      'resumption handle) or dialled fresh with the history replayed into the system instruction, the exact ' +
      'system instruction (incl. replayed history), declared tool names per MCP server, and the transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        max_turns: { type: 'integer', minimum: 1, maximum: 500, description: 'Newest transcript turns to return (default 40).' },
        include_system_instruction: { type: 'boolean', description: 'Return the full system instruction text (default true).' },
        ...CONV,
      },
      additionalProperties: false,
    },
    annotations: RO,
  },
  {
    name: 'set_debug_logging',
    title: 'Enable / disable live telemetry',
    description:
      'Turn detailed telemetry on or off for a live call: the browser then sends mic level, VAD state, ' +
      'jitter-cushion/queue/underrun stats, audio output latency, WS backlog and RTT every interval_ms. ' +
      'console=true also writes one "[callgemini/debug …]" summary line per interval to the app log. ' +
      'default_for_new_calls=true applies the same settings to every call started afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true = on, false = off.' },
        interval_ms: { type: 'integer', minimum: 250, maximum: 10000, description: 'Browser stats interval (default 1000).' },
        console: { type: 'boolean', description: 'Also log a summary line per interval (default false).' },
        default_for_new_calls: { type: 'boolean', description: 'Remember as default for new calls.' },
        ...CONV,
      },
      required: ['enabled'],
      additionalProperties: false,
    },
  },
  { name: 'list_traced_calls', title: 'List traced calls', description: 'Conversations with recorded telemetry (live and recently ended), newest last, plus the live ones and the defaults.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: RO },
  {
    name: 'get_live_metrics',
    title: 'Live metrics',
    description:
      'Snapshot of the whole pipeline: uplink (mic frame cadence/gaps, RMS), downlink (Gemini audio chunk gaps), ' +
      'latency percentiles (end of speech → first audio chunk → audible), stream speed vs real time, ' +
      'connection (declared tools, setup times, close codes, reconnect times), tool timings, and the latest ' +
      'browser stats (playback cushion/queue/underruns, VAD, output latency, WS backlog, RTT).',
    inputSchema: { type: 'object', properties: { ...CONV }, additionalProperties: false },
    annotations: RO,
  },
  {
    name: 'get_trace',
    title: 'Per-turn traces',
    description:
      'Trace of the most recent turns, one span chain each: speech end → first Gemini audio chunk → audible in the ' +
      'browser → turn complete, with stream speed, biggest chunk gap, tool spans and interruption. Where the time ' +
      'went in each reply.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Turns to return (default 20).' }, ...CONV },
      additionalProperties: false,
    },
    annotations: RO,
  },
  {
    name: 'get_events',
    title: 'Event timeline',
    description:
      'Timestamped pipeline events: dial, live, close (code/reason), goAway, vad, playback playing/idle, ' +
      'interrupted, tool_start/tool_end, turn, debug.',
    inputSchema: {
      type: 'object',
      properties: {
        since_ms_ago: { type: 'integer', minimum: 0, description: 'Only events from the last N ms.' },
        kinds: { type: 'array', items: { type: 'string' }, description: 'Filter by event kinds.' },
        limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Max events (default 200, newest).' },
        ...CONV,
      },
      additionalProperties: false,
    },
    annotations: RO,
  },
  {
    name: 'get_logs',
    title: 'App logs',
    description: "The app's own [callgemini…] log lines (bridge, tools, MCP, ACP, debug trace), newest last. App-wide, not per conversation.",
    inputSchema: {
      type: 'object',
      properties: {
        grep: { type: 'string', description: 'Case-insensitive regex filter.' },
        level: { type: 'string', enum: ['log', 'warn', 'error'] },
        since_ms_ago: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 3000, description: 'Default 200.' },
      },
      additionalProperties: false,
    },
    annotations: RO,
  },
  {
    name: 'diagnose',
    title: 'Diagnose latency / quality',
    description: 'Rule-based findings over the recorded data (model latency, playback cushion, downlink speed, uplink gaps, socket errors, tool count/size, mic level) with hints, plus the metrics snapshot they are based on.',
    inputSchema: { type: 'object', properties: { ...CONV }, additionalProperties: false },
    annotations: RO,
  },
];

/** Tracker of the requested / single live / most recent conversation. */
function resolveTracker(conversationId) {
  if (conversationId) {
    const t = dm.existingTracker(String(conversationId));
    if (!t) throw new ToolError(`No telemetry for conversation "${conversationId}". See list_traced_calls.`);
    return t;
  }
  const live = liveConversations();
  if (live.length === 1) return dm.tracker(live[0]);
  if (live.length > 1) throw new ToolError(`Several calls are live — pass conversation_id. Live: ${JSON.stringify(live)}.`);
  const all = dm.trackedConversations();
  if (!all.length) throw new ToolError('No call has been traced since the app started. Start a call first.');
  return dm.existingTracker(all[all.length - 1].id);
}

/** ISO time of a ms number, numeric string or date string; null when unparseable. */
const iso = (v) => {
  if (v == null || v === '') return null;
  const d = new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Conversation + its call (if any): explicit id, else the live call, else the latest. */
async function resolveCurrent(conversationId) {
  const live = liveSessions();
  let id = conversationId ? String(conversationId) : null;
  if (!id) {
    if (live.length > 1) {
      throw new ToolError(`Several calls are live — pass conversation_id. Live: ${JSON.stringify(live.map((s) => s.convId))}.`);
    }
    id = live[0]?.convId ?? (await conversations.list())[0]?.id;
  }
  if (!id) throw new ToolError('There are no conversations yet.');
  const conv = await conversations.get(id);
  if (!conv) throw new ToolError(`No conversation with id "${id}".`);
  const session = live.find((s) => s.convId === id) ?? null;
  return { conv, session, live };
}

/** MCP servers of a conversation that is not in a call, from its stored toggles. */
function storedServerReport(conv) {
  const disabled = new Set(conv.mcpDisabled ?? []);
  const skipped = new Set(conv.mcpSkipped ?? []);
  return mergeServers(getLastConfiguredServers(), conversations.temporaryList(conv.mcpTemporary)).map((s) => ({
    url: s.url, name: s.name ?? '', temporary: !!s.temporary, behavior: s.behavior,
    enabled: !disabled.has(s.url), skipped: skipped.has(s.url),
    ...(s.temporary ? { toolCount: s.toolCount ?? null } : {}),
  }));
}

const clip = (text, n) => { const t = String(text ?? ''); return t.length > n ? `${t.slice(0, n)} …` : t; };

export const handlers = { // exported for tests
  async get_current_conversation(args) {
    const { conv, session, live } = await resolveCurrent(args.conversation_id);
    const turns = conv.turns ?? [];
    return ok({
      calling: !!session,
      ...(live.length ? { live_conversations: live.map((s) => s.convId) } : {}),
      conversation: {
        id: conv.id, title: conv.title, created_at: iso(conv.createdAt), updated_at: iso(conv.updatedAt),
        turns: turns.length,
        last_turns: turns.slice(-3).map((t) => ({ role: t.role, text: clip(t.text, 200), at: iso(t.ts) })),
      },
      ...(session ? {
        call: {
          started_at: iso(session.callStartedAt),
          gemini_state: session.session ? 'live' : 'reconnecting',
          reconnect_tries: session.reconnectTries,
          model: session.model ?? null,
          voice: session.voiceName ?? null,
          declared_tools: session.mcp?.functionDeclarations?.length ?? 0,
          system_instruction_chars: session.lastDial?.systemInstruction.length ?? null,
          paused: paused.has(conv.id),
          speaker_muted: !!session.speakerMuted,
          debug: dm.existingTracker(conv.id)?.debug ?? dm.defaults(),
        },
      } : {}),
      mcp_servers: session ? session.mcpServerReport() : storedServerReport(conv),
      mcp_servers_source: session ? 'live call' : 'stored toggles + last configured servers (not connected)',
    });
  },

  async get_conversation_context(args) {
    const { conv, session } = await resolveCurrent(args.conversation_id);
    const maxTurns = Math.min(500, Math.max(1, Number(args.max_turns) || 40));
    const withSys = args.include_system_instruction !== false;
    const turns = conv.turns ?? [];
    const dial = session?.lastDial ?? null;
    let source, systemInstruction, toolsByServer = null;
    if (dial) {
      source = dial.resumed
        ? 'resumed — Gemini restored its own server-side context from a resumption handle; the system instruction below is the base one'
        : 'fresh — the stored history was replayed into the system instruction below';
      systemInstruction = dial.systemInstruction;
      const routes = new Map((session.mcp?.toolRoutes?.() ?? []).map((r) => [r.fn, r.serverUrl]));
      toolsByServer = {};
      for (const fn of dial.toolNames) (toolsByServer[routes.get(fn) ?? 'unknown'] ??= []).push(fn);
    } else {
      const handleFresh = conv.resumeHandle && Date.now() - (conv.resumeHandleAt ?? 0) < 24 * 60 * 60 * 1000;
      source = `not in a call — the next call would ${handleFresh ? 'try to resume from the stored handle' : 'start fresh with this history'}`;
      systemInstruction = `(base system instruction from Settings)${historyInstruction(turns)}`;
    }
    const accrual = session?.accrual?.text ? { role: session.accrual.role, text: session.accrual.text, in_progress: true } : null;
    return ok({
      conversation: { id: conv.id, title: conv.title },
      calling: !!session,
      source,
      ...(dial ? { dialed_at: iso(dial.at), sliding_window_compression: dial.slidingWindow } : {}),
      resume_handle_age_s: conv.resumeHandleAt ? Math.round((Date.now() - conv.resumeHandleAt) / 1000) : null,
      system_instruction_chars: systemInstruction.length,
      ...(withSys ? { system_instruction: systemInstruction } : {}),
      history_caps: { max_turns: HISTORY_MAX_TURNS, max_chars: HISTORY_MAX_CHARS, max_line: HISTORY_MAX_LINE },
      ...(toolsByServer ? { declared_tools_by_server: toolsByServer } : {}),
      transcript: {
        total_turns: turns.length,
        turns: turns.slice(-maxTurns).map((t) => ({ role: t.role, text: t.text, at: iso(t.ts) })),
        ...(accrual ? { current: accrual } : {}),
      },
    });
  },

  async set_debug_logging(args) {
    if (typeof args.enabled !== 'boolean') throw new ToolError('enabled must be true or false.');
    const cfg = { enabled: args.enabled };
    if (args.interval_ms !== undefined) cfg.intervalMs = Math.min(10000, Math.max(250, Number(args.interval_ms) || 1000));
    if (args.console !== undefined) cfg.console = !!args.console;
    const defaults = args.default_for_new_calls ? dm.setDefaults(cfg) : dm.defaults();
    const live = liveConversations();
    const target = args.conversation_id ?? (live.length === 1 ? live[0] : null);
    if (!target) {
      if (!args.default_for_new_calls) throw new ToolError(live.length ? `Several calls are live — pass conversation_id. Live: ${JSON.stringify(live)}.` : 'No call is live. Pass default_for_new_calls=true to enable it for the next call.');
      return ok({ applied_to: null, defaults });
    }
    const session = findByConversation(target);
    if (!session) throw new ToolError(`Conversation "${target}" has no live call.`);
    return ok({ applied_to: target, debug: session.setDebug(cfg), defaults });
  },

  async list_traced_calls() {
    return ok({ traced: dm.trackedConversations(), live: liveConversations(), defaults: dm.defaults() });
  },

  async get_live_metrics(args) {
    return ok(dm.snapshot(resolveTracker(args.conversation_id)));
  },

  async get_trace(args) {
    const t = resolveTracker(args.conversation_id);
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
    const turns = t.turns.slice(-limit).map((x) => ({ n: x.n, at: iso(x.openedAt), ...dm.summarizeTurn(x) }));
    const open = t.cur ? { n: t.cur.n, at: iso(t.cur.openedAt), open: true, ...dm.summarizeTurn(t.cur) } : null;
    return ok({ conversation_id: t.convId, turns, ...(open ? { in_progress: open } : {}) });
  },

  async get_events(args) {
    const t = resolveTracker(args.conversation_id);
    const since = args.since_ms_ago ? Date.now() - Number(args.since_ms_ago) : 0;
    const kinds = Array.isArray(args.kinds) && args.kinds.length ? new Set(args.kinds) : null;
    const limit = Math.min(2000, Math.max(1, Number(args.limit) || 200));
    const events = t.events.filter((e) => e.at > since && (!kinds || kinds.has(e.kind))).slice(-limit)
      .map((e) => ({ ...e, at: iso(e.at) }));
    return ok({ conversation_id: t.convId, events });
  },

  async get_logs(args) {
    const since = args.since_ms_ago ? Date.now() - Number(args.since_ms_ago) : 0;
    return ok({ lines: dm.logs({ since, grep: args.grep, level: args.level, limit: Math.min(3000, Number(args.limit) || 200) }) });
  },

  async diagnose(args) {
    return ok(dm.diagnose(resolveTracker(args.conversation_id)));
  },
};

export const buildServer = createToolServer({
  name: 'callgemini-debug',
  instructions:
    'Debug CallGemini\'s live voice pipeline. get_current_conversation says whether a call is live, which ' +
    'conversation is current and its MCP servers; get_conversation_context shows what Gemini has as context. ' +
    'For performance, start with diagnose (or get_live_metrics) on the live call; ' +
    'get_trace shows where the time went in each reply; get_events / get_logs give the timeline. For mic ' +
    'level, VAD, jitter cushion and RTT, first call set_debug_logging { enabled: true }. Tools default to the ' +
    'single live call, else the most recently traced one.',
  tools: TOOLS,
  handlers,
});
