/**
 * CallGemini WebSocket bridge (server side).
 *
 * The shell proxies `/api/proxy/<instanceId>/ws` to this app at the bare path
 * `/ws` (see packages/shell/astro.config.mjs → wsProxyPlugin). We accept that
 * upgrade, and for each browser we open a Gemini **Live** session via
 * `@google/genai` and pump audio + transcripts + tool calls between the two.
 *
 * Frame convention over the browser leg (binary/text is preserved by the proxy):
 *   • BINARY browser→app  = mic PCM16 @16 kHz  → session.sendRealtimeInput({audio})
 *   • BINARY app→browser  = speaker PCM16 @24 kHz (Gemini inline audio)
 *   • TEXT   both ways     = JSON control / events
 *
 * TEXT control frames from the browser:
 *   { type:'start', config, conversationId?, mcp? }   { type:'text', text }   { type:'stop' }
 *   { type:'mcp', disabled:[url], skipped:[url], temporary?:[{url,transport,name}] }
 *                                                   (per-conversation MCP toggles + temporary servers, live)
 *   (conversationId set → resume that saved conversation with its history as context)
 * TEXT event frames to the browser:
 *   { type:'status', state }   { type:'transcript', role, text }
 *   { type:'tool', name, phase }   { type:'interrupted' }   { type:'turnComplete' }
 *   { type:'conversation', id, title }   (the conversation being recorded / its title)
 *   { type:'mcp', servers:[{ url, name, temporary, enabled, skipped, ok, tools, error? }] }
 *
 * MCP toggles: "OFF" servers are not connected and their tools are not declared
 * — Gemini fixes the tool list at setup, so flipping ON/OFF mid-call re-dials
 * the Gemini leg (the browser leg stays up). "Skip" keeps the tools declared but
 * answers every call with a skipped error — instant, no reconnect (see mcp.mjs).
 *
 * Context continuity: every Gemini session asks for resumption handles. A
 * re-dial (tool change, network drop) reconnects WITH the latest handle, which
 * restores the model's full server-side state — verified to work even when the
 * tool list or voice changed. The handle is also stored on the conversation
 * when a call stops, so "continue" restores the real context instead of a text
 * replay. Only when no (valid) handle exists do we fall back to re-seeding the
 * saved transcript.
 * status.state includes 'reconnecting' while a dropped Gemini socket is being
 * resumed via a Live API session-resumption handle (state preserved server-side).
 */

import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from '@google/genai';
import { connectAll, createSeenValues } from './mcp.mjs';
import { register, unregister } from './sessions.mjs';
import * as conversations from './conversations.mjs';

/** Settings-configured servers as last seen in a `start` frame. The app's own
 * MCP server reports them without ever reading the KV config (API key). */
// On globalThis: the MCP route runs in Vite's SSR module instance of this
// file, the bridge in Node's — see sessions.mjs.
const shared = (globalThis.__callgeminiShared ??= { lastConfiguredServers: [] });
export function getLastConfiguredServers() { return shared.lastConfiguredServers; }

/**
 * Configured (Settings) servers plus a conversation's temporary ones, one
 * entry per URL — a temporary server that duplicates a configured URL is
 * ignored, so Settings always wins.
 */
export function mergeServers(configured, temporary) {
  const out = [];
  const seen = new Set();
  for (const s of configured ?? []) {
    if (!s?.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ url: s.url, transport: s.transport ?? 'http', name: '', temporary: false });
  }
  for (const t of temporary ?? []) {
    if (!t?.url || seen.has(t.url)) continue;
    seen.add(t.url);
    out.push({ url: t.url, transport: t.transport ?? 'http', name: t.name ?? '', temporary: true, addedAt: t.addedAt, toolCount: t.toolCount });
  }
  return out;
}

/**
 * End-of-speech silence window per "Responsiveness" preset (Settings). Lower =
 * Gemini commits end-of-speech sooner → the input transcript prints and the
 * reply starts faster, at the cost of possibly cutting off mid-pause.
 */
const RESPONSIVENESS_MS = { snappy: 350, balanced: 600, relaxed: 1000 };

/** Don't bother trying a stored resumption handle older than this — fall
 * straight back to the transcript replay. (Handles are server-side state with
 * a finite lifetime; a rejected one costs a round-trip.) */
const RESUME_HANDLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Persist a fresh handle at most this often (they arrive every few seconds). */
const HANDLE_PERSIST_INTERVAL_MS = 20_000;

/** Bound the history we replay when resuming so reconnect stays cheap. */
const RESUME_MAX_TURNS = 20;
const RESUME_MAX_CHARS = 6000;
function capTurns(turns) {
  const tail = turns.slice(-RESUME_MAX_TURNS);
  let total = 0;
  const out = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    total += tail[i].text.length;
    if (total > RESUME_MAX_CHARS && out.length) break;
    out.unshift(tail[i]);
  }
  return out;
}

/** Normalise a list of server URLs from the browser (dedup, strings only). */
function urlList(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim()))];
}

/** Same set of URLs? (`a` may be an array or undefined; `b` a Set/array.) */
function sameUrls(a, b) {
  const sa = new Set(urlList(Array.isArray(a) ? a : [])), sb = new Set(b ?? []);
  if (sa.size !== sb.size) return false;
  for (const u of sa) if (!sb.has(u)) return false;
  return true;
}

/** Native-audio Live dialog model. Date-versioned & preview — keep configurable. */
export const DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
export const DEFAULT_VOICE = 'Kore';
const DEFAULT_SYSTEM_INSTRUCTION =
  'You are a helpful, friendly voice assistant. Keep replies concise and ' +
  'conversational. When you trigger a tool that may take a while, briefly tell ' +
  "the user you're looking into it and keep the conversation going, then share " +
  'the result once it arrives. When a tool needs a value that only an earlier ' +
  'tool result provides (for example a session_id), wait for that result and ' +
  'pass the exact value it returned; never guess or invent ids or arguments. ' +
  'Leave optional arguments out unless a tool result gave you the value: never ' +
  'construct ids, tokens or configuration handles yourself. If a tool fails, ' +
  'say so and ask the user instead of retrying the same call.';

export class CallSession {
  /** @param {import('ws').WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.session = null; // Gemini Live session
    this.mcp = null;      // MCP bridge handle
    this.closed = false;
    this.convId = null;                       // conversation being recorded
    this.accrual = { role: null, text: '' };  // in-progress turn (chunks accumulate)
    this.resumeHandle = null;                 // Live API session-resumption token
    this.reconnectTries = 0;
    this.userStopped = false;                 // stop was intentional — don't auto-resume
    this.allServers = [];                     // configured + temporary servers of the current call
    this.configuredServers = [];              // Settings' mcpServers (from the start frame)
    this.temporaryServers = [];               // this conversation's temporary servers (record)
    this.mcpDisabled = new Set();             // server URLs turned OFF for this conversation
    this.mcpSkipped = new Set();              // server URLs whose calls are skipped
    this.retooling = false;                   // Gemini leg is being re-dialled for a tool change
    this.retoolChain = Promise.resolve();     // serialises retools (rapid toggles coalesce)
    this.seen = createSeenValues();           // fabricated-handle guard memory (see mcp.mjs)
    this.handlePersistedAt = 0;               // last time resumeHandle was written to the store
    register(this);

    ws.on('message', (data, isBinary) => this.onClientMessage(data, isBinary));
    ws.on('close', () => this.close('client-closed'));
    ws.on('error', () => this.close('client-error'));
  }

  /** Send a JSON event frame to the browser. */
  emit(obj) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    try { this.ws.send(JSON.stringify(obj)); } catch { /* socket gone */ }
  }

  /** Send a binary (audio) frame to the browser. */
  emitAudio(buf) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    try { this.ws.send(buf, { binary: true }); } catch { /* socket gone */ }
  }

  async onClientMessage(data, isBinary) {
    if (isBinary) {
      // Mic PCM16 @16 kHz → Gemini. Drop until the session is live.
      if (!this.session) return;
      const base64 = Buffer.isBuffer(data)
        ? data.toString('base64')
        : Buffer.from(data).toString('base64');
      try {
        this.session.sendRealtimeInput({ audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } });
      } catch (err) {
        console.error('[callgemini] sendRealtimeInput failed:', err?.message ?? err);
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg?.type) {
      case 'start':   await this.start(msg.config ?? {}, msg.conversationId, msg.mcp); break;
      case 'text':    this.sendText(msg.text ?? ''); break;
      case 'vad':     this.sendActivitySignal(msg.event); break;
      case 'mcp':     await this.applyMcpChange({ disabled: msg.disabled, skipped: msg.skipped, ...(Array.isArray(msg.temporary) ? { temporary: msg.temporary } : {}), why: 'ui' }); break;
      case 'stop':    this.stopGemini('user-stop'); break;
      default: break;
    }
  }

  /** Browser-VAD mode: relay the client's speech start/end as explicit activity
   * signals (server-side automatic detection is disabled for these calls). */
  sendActivitySignal(event) {
    if (!this.session) return;
    try {
      if (event === 'start') this.session.sendRealtimeInput({ activityStart: {} });
      else if (event === 'end') this.session.sendRealtimeInput({ activityEnd: {} });
    } catch (err) {
      console.error('[callgemini] activity signal failed:', err?.message ?? err);
    }
  }

  async start(config, conversationId, mcp) {
    if (this.session) return; // already in a call
    const apiKey = (config.apiKey && String(config.apiKey).trim()) || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      this.emit({ type: 'status', state: 'error', message: 'No Gemini API key. Add one in Settings or set GEMINI_API_KEY.' });
      return;
    }
    const model = config.model || DEFAULT_MODEL;
    const voiceName = config.voiceName || DEFAULT_VOICE;
    const systemInstruction = config.systemInstruction || DEFAULT_SYSTEM_INSTRUCTION;
    const silenceDurationMs = RESPONSIVENESS_MS[config.responsiveness] ?? RESPONSIVENESS_MS.balanced;
    this.seen.note(systemInstruction); // handles the user put in the instruction are theirs, not invented

    this.emit({ type: 'status', state: 'connecting' });

    // Per-conversation MCP toggles. The browser's state is authoritative: it
    // loaded the record and PATCHed any later change, and for a brand-new chat
    // it is the only copy there is.
    this.configuredServers = Array.isArray(config.mcpServers) ? config.mcpServers.filter((s) => s?.url) : [];
    shared.lastConfiguredServers = this.configuredServers.map((s) => ({ url: s.url, transport: s.transport ?? 'http' }));
    this.temporaryServers = [];
    this.mcpDisabled = new Set(urlList(mcp?.disabled));
    this.mcpSkipped = new Set(urlList(mcp?.skipped));

    // Resolve the conversation being recorded: resume an existing one (and
    // gather its history to seed context) or create a fresh one.
    let priorTurns = [];
    let storedHandle = null;
    try {
      if (conversationId) {
        this.convId = conversationId;
        const conv = await conversations.get(conversationId);
        priorTurns = conv?.turns ?? [];
        this.temporaryServers = conversations.temporaryList(conv?.mcpTemporary);
        if (conv?.resumeHandle && Date.now() - (conv.resumeHandleAt ?? 0) < RESUME_HANDLE_MAX_AGE_MS) {
          storedHandle = conv.resumeHandle;
        }
        if (conv && (!sameUrls(conv.mcpDisabled, this.mcpDisabled) || !sameUrls(conv.mcpSkipped, this.mcpSkipped))) {
          await conversations.update(conversationId, { mcpDisabled: [...this.mcpDisabled], mcpSkipped: [...this.mcpSkipped] });
        }
      } else {
        const conv = await conversations.create({ mcpDisabled: [...this.mcpDisabled], mcpSkipped: [...this.mcpSkipped] });
        this.convId = conv.id;
        this.emit({ type: 'conversation', id: conv.id, title: conv.title });
      }
    } catch (err) {
      console.error('[callgemini] conversation setup failed:', err?.message ?? err);
    }

    this.allServers = mergeServers(this.configuredServers, this.temporaryServers);

    // Bridge the enabled MCP servers first so their tools are known at connect time.
    this.mcp = await this.connectMcp();
    this.emitMcpReport();
    const decls = this.mcp.functionDeclarations;
    if (decls.length) this.emit({ type: 'status', state: 'connecting', message: `${decls.length} MCP tool(s) ready` });

    const liveConfig = {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      systemInstruction,
      // Language hints (Settings → Languages): BCP-47 codes bias understanding
      // toward the user's languages; empty = auto-detect. Output language is
      // left auto so replies follow whichever language the user actually spoke.
      inputAudioTranscription: (config.languages?.length ? { languageCodes: config.languages } : {}),
      outputAudioTranscription: {},
      // Keep per-turn latency flat over a long call — the server rolls the
      // context window instead of reprocessing all accumulated audio tokens.
      contextWindowCompression: { slidingWindow: {} },
      // Voice detection (Settings): 'browser' = client-side Silero VAD sends
      // explicit activityStart/activityEnd signals, so server detection is off.
      // 'server' (default) = tuned automatic detection: commit end-of-speech
      // sooner so the input transcript + reply come faster.
      realtimeInputConfig: config.vadMode === 'browser'
        ? { automaticActivityDetection: { disabled: true } }
        : {
            automaticActivityDetection: {
              startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
              endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
              prefixPaddingMs: 100,
              silenceDurationMs,
            },
          },
      // The native-audio model is thinking-capable and reasons before it
      // speaks; 0 disables that (docs: "0 is DISABLED"). Guarded by model id —
      // the API errors if set on a model without thinking support (and
      // live.connect below retries once without it if the guard guessed wrong).
      ...(model.includes('native-audio') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      // Ask the server for resumption handles so a dropped Gemini socket can
      // be reconnected with state intact (see onclose / sessionResumptionUpdate).
      sessionResumption: {},
      ...(decls.length ? { tools: [{ functionDeclarations: decls }] } : {}),
    };

    try {
      this.genai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } });
      this.model = model;
      this.liveConfig = liveConfig;
      this.userStopped = false;
      this.reconnectTries = 0;
      this.resumeHandle = null;
      this.handlePersistedAt = 0;
      // Continue a saved conversation with its REAL context when we hold a
      // resumption handle from the previous call; otherwise (first call, or the
      // handle expired / was rejected) replay the transcript as text.
      const resumed = storedHandle ? await this.tryResume(storedHandle, 'continue') : false;
      if (!resumed) {
        await this.connectGemini();
        this.seedTurns(priorTurns);
      }
    } catch (err) {
      console.error('[callgemini] live.connect failed:', err?.message ?? err);
      this.emit({ type: 'status', state: 'error', message: err?.message ?? 'Failed to connect to Gemini' });
      await this.mcp?.close?.();
      this.mcp = null;
    }
  }

  /** Replay saved turns as context WITHOUT eliciting a reply
   * (turnComplete:false) so Gemini continues where it left off once the user
   * speaks. */
  seedTurns(turns) {
    if (!turns?.length || !this.session) return;
    for (const t of turns) this.seen.note(t.text); // ids from earlier in this conversation are legitimate
    try {
      this.session.sendClientContent({
        turns: capTurns(turns).map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
        turnComplete: false,
      });
    } catch (err) {
      console.error('[callgemini] resume seed failed:', err?.message ?? err);
    }
  }

  /** Servers that are ON for this conversation (config order). */
  enabledServers() {
    return this.allServers.filter((s) => !this.mcpDisabled.has(s.url));
  }

  /** Connect the enabled MCP servers. Never throws — a failure yields an
   * inert bridge so the call still starts (tools just aren't there). */
  async connectMcp() {
    try {
      return await connectAll(this.enabledServers(), { skipped: this.mcpSkipped, seen: this.seen });
    } catch (err) {
      console.error('[callgemini] MCP connect error:', err?.message ?? err);
      return {
        functionDeclarations: [],
        servers: this.enabledServers().map((s) => ({ url: s.url, ok: false, tools: 0, error: err?.message ?? 'mcp unavailable' })),
        dispatch: async () => ({ error: 'mcp unavailable' }),
        dispatchBatch: (fcs) => fcs.map(() => Promise.resolve({ error: 'mcp unavailable' })),
        setSkipped() {},
        close: async () => {},
      };
    }
  }

  /** Tell the browser where every configured server stands right now. */
  emitMcpReport() {
    const live = new Map((this.mcp?.servers ?? []).map((r) => [r.url, r]));
    this.emit({
      type: 'mcp',
      servers: this.allServers.map((s) => {
        const enabled = !this.mcpDisabled.has(s.url);
        const r = enabled ? live.get(s.url) : null;
        return {
          url: s.url, transport: s.transport ?? 'http', name: s.name ?? '', temporary: !!s.temporary, enabled, skipped: this.mcpSkipped.has(s.url),
          ok: r ? r.ok : false, tools: r?.tools ?? 0, ...(r?.error ? { error: r.error } : {}),
          ...(s.temporary ? { addedAt: s.addedAt ?? null, toolCount: s.toolCount ?? null } : {}),
        };
      }),
    });
  }

  /** Browser flipped a toggle (see applyMcpChange). */
  setMcpState(disabled, skipped) {
    return this.applyMcpChange({ disabled, skipped, why: 'toggle' });
  }

  /** The conversation's temporary servers changed — from the app's own MCP
   * server (`add_mcp_server` / `remove_mcp_server`) or the drawer's X button. */
  setTemporaryServers(temporary, why = 'temporary server change') {
    return this.applyMcpChange({ temporary, why });
  }

  /**
   * One entry point for every per-conversation MCP change: ON/OFF, Skip and
   * the temporary server list. Skip is applied on the spot; anything that
   * changes the set of DECLARED servers (ON/OFF, a temporary server added or
   * removed) re-dials the Gemini leg while a call is live — Gemini's tool list
   * is fixed at setup. Everything is persisted on the conversation record.
   * Resolves `{ redialed }` once the change is in effect.
   */
  async applyMcpChange({ disabled, skipped, temporary, why = 'change' } = {}) {
    const before = new Set(this.enabledServers().map((s) => s.url));
    if (disabled !== undefined) this.mcpDisabled = new Set(urlList(disabled));
    if (skipped !== undefined) this.mcpSkipped = new Set(urlList(skipped));
    if (temporary !== undefined) {
      this.temporaryServers = conversations.temporaryList(temporary);
      this.allServers = mergeServers(this.configuredServers, this.temporaryServers);
    }
    this.mcp?.setSkipped?.(this.mcpSkipped);
    if (this.convId) {
      const patch = {
        ...(disabled !== undefined ? { mcpDisabled: [...this.mcpDisabled] } : {}),
        ...(skipped !== undefined ? { mcpSkipped: [...this.mcpSkipped] } : {}),
        ...(temporary !== undefined ? { mcpTemporary: this.temporaryServers } : {}),
      };
      if (Object.keys(patch).length) {
        try { await conversations.update(this.convId, patch); }
        catch (err) { console.error('[callgemini] mcp state save failed:', err?.message ?? err); }
      }
    }
    const after = new Set(this.enabledServers().map((s) => s.url));
    const declaredChanged = before.size !== after.size || [...after].some((u) => !before.has(u));
    if (declaredChanged && (this.session || this.retooling)) {
      // Serialise: a second change during a re-dial waits for it, then runs
      // with whatever the state says by then (so a flurry collapses into one).
      this.retoolWhy = why;
      this.retoolChain = this.retoolChain.then(() => this.retool()).catch((err) => {
        console.error('[callgemini] retool failed:', err?.message ?? err);
      });
      await this.retoolChain;
      return { redialed: true };
    }
    this.emitMcpReport();
    return { redialed: false };
  }

  /** Swap the MCP bridge for the current toggle state and re-dial Gemini with
   * the new tool list. Fresh dial + transcript re-seed on purpose: a changed
   * setup on a resumption handle isn't guaranteed to be accepted, and the
   * rejection would only show up later as an async 1007 close. */
  async retool() {
    if (this.closed || this.userStopped || (!this.session && !this.retooling)) return;
    this.retooling = true;
    this.emit({ type: 'status', state: 'reconnecting', message: 'Updating tools…' });
    this.flushTurn(); // the in-progress turn must be in the store before we re-seed
    const old = this.mcp;
    const next = await this.connectMcp();
    if (this.closed || this.userStopped) { this.retooling = false; next.close().catch(() => {}); return; }
    const decls = next.functionDeclarations;
    const { tools: _tools, ...rest } = this.liveConfig;
    this.liveConfig = decls.length ? { ...rest, tools: [{ functionDeclarations: decls }] } : rest;
    this.mcp = next;
    old?.close?.().catch(() => {});
    const handle = this.resumeHandle; // latest token — carries the model's full context
    try { this.session?.close?.(); } catch { /* noop */ }
    this.session = null;
    this.reconnectTries = 0;
    try {
      // Preferred: resume with the handle (context intact, new tool list —
      // the API accepts a changed setup). Fallback: fresh + transcript replay.
      const resumed = handle ? await this.tryResume(handle, 'tool change') : false;
      if (!resumed) {
        this.resumeHandle = null;
        await this.connectGemini(); // emits 'live'
        const turns = this.convId ? (await conversations.get(this.convId))?.turns ?? [] : [];
        this.seedTurns(turns);
      }
      if (this.closed || this.userStopped) { try { this.session?.close?.(); } catch { /* noop */ } this.session = null; return; }
      console.log(`[callgemini] tools updated (${this.retoolWhy ?? 'change'}) — ${decls.length} MCP tool(s) declared${resumed ? ', context resumed' : ', transcript replayed'}`);
    } catch (err) {
      console.error('[callgemini] re-dial after tool change failed:', err?.message ?? err);
      this.emit({ type: 'status', state: 'error', message: `Could not update tools: ${err?.message ?? err}` });
      this.emit({ type: 'status', state: 'ended' });
    } finally {
      this.retooling = false;
      this.emitMcpReport();
    }
  }

  /** Reconnect with a resumption handle, restoring the model's server-side
   * state. Returns false (after logging) when the server rejects it, so the
   * caller can fall back to a fresh session. A rejected stored handle is
   * dropped from the conversation record. */
  async tryResume(handle, why) {
    try {
      await this.connectGemini(handle);
      this.resumeHandle = handle;
      console.log(`[callgemini] resumed Gemini session with context (${why})`);
      return true;
    } catch (err) {
      console.error(`[callgemini] resume (${why}) rejected, starting fresh:`, err?.message ?? err);
      if (this.convId) {
        conversations.update(this.convId, { resumeHandle: null }).catch(() => {});
      }
      return false;
    }
  }

  /** Write the latest resumption handle to the conversation record, so a later
   * "continue" (or another app instance) can pick the context back up. */
  persistHandle(force = false) {
    if (!this.convId || !this.resumeHandle) return;
    if (!force && Date.now() - this.handlePersistedAt < HANDLE_PERSIST_INTERVAL_MS) return;
    this.handlePersistedAt = Date.now();
    conversations.update(this.convId, { resumeHandle: this.resumeHandle })
      .catch((err) => console.error('[callgemini] resume handle save failed:', err?.message ?? err));
  }

  /** Dial (or re-dial) the Gemini Live socket. With a resumption handle the
   * server restores the previous session's state — mid-call network drops
   * become a brief "reconnecting" instead of a dead call.
   *
   * The SDK's connect() only settles on the server's setupComplete; a rejected
   * setup (bad key, bad handle, bad tool schema) arrives as a CLOSE instead, so
   * the connect is raced against it — otherwise the call would hang forever. */
  async connectGemini(resumeHandle) {
    const config = resumeHandle
      ? { ...this.liveConfig, sessionResumption: { handle: resumeHandle } }
      : this.liveConfig;
    // Every dial gets its own callbacks closure. A close event belongs to
    // THAT dial's socket: while it's still connecting, the close is the server
    // rejecting the setup (→ reject the pending connect); once it's live, the
    // close only matters if that socket is still the current session — the
    // previous session's close (a re-dial shuts it first) must not be mistaken
    // for the new one failing.
    const dial = (cfg) => {
      let rejectClose = () => {};
      const closedDuringSetup = new Promise((_, reject) => { rejectClose = reject; });
      closedDuringSetup.catch(() => {}); // settled by the race; never unhandled
      let mine = null; // the Session object once connected
      const callbacks = {
        onopen: () => { this.reconnectTries = 0; },
        onmessage: (message) => { if (!mine || this.session === mine) this.onServerMessage(message); },
        onerror: (e) => { if (!mine || this.session === mine) this.emit({ type: 'status', state: 'error', message: e?.message ?? 'Gemini stream error' }); },
        onclose: (e) => {
          if (!mine) {
            const err = new Error(`Gemini rejected the session (${e?.code ?? '?'}): ${e?.reason || 'no reason given'}`);
            err.code = e?.code;
            rejectClose(err);
            return;
          }
          if (this.session !== mine) return; // stale socket (replaced or already torn down)
          this.onGeminiClose(e);
        },
      };
      return Promise.race([
        this.genai.live.connect({ model: this.model, callbacks, config: cfg }).then((session) => { mine = session; return session; }),
        closedDuringSetup,
      ]);
    };
    try {
      this.session = await dial(config);
    } catch (err) {
      // The thinking guard keys off the model id; if this id doesn't actually
      // support thinking the API rejects the config — retry once without it.
      if (!config.thinkingConfig) throw err;
      console.error('[callgemini] connect with thinkingConfig failed, retrying without:', err?.message ?? err);
      const { thinkingConfig, ...rest } = config;
      this.session = await dial(rest);
    }
    this.handlePersistedAt = 0; // persist the first handle of this socket right away
    // Only now is `this.session` set. Announcing 'live' from onopen (earlier)
    // let a text/vad frame sent right after 'live' hit the `!this.session`
    // guards and vanish silently.
    this.emit({ type: 'status', state: 'live' });
  }

  /** Gemini socket closed. Intentional (user stop / teardown) → today's clean
   * end. Unexpected + we hold a resumption handle → bounded auto-resume. */
  onGeminiClose(event) {
    this.session = null;
    // A tool-change re-dial closes the socket itself and reconnects right after.
    if (this.closed || this.userStopped || this.retooling) return;
    // A non-normal close carries the server's reason (e.g. 1007 = the setup
    // payload was rejected — typically an MCP tool schema Gemini can't parse).
    // Log it and hand it to the browser, otherwise the call ends with no clue.
    const code = event?.code;
    const reason = event?.reason ? String(event.reason) : '';
    if (code && code !== 1000 && code !== 1005) {
      console.error(`[callgemini] Gemini socket closed (code ${code})${reason ? `: ${reason}` : ''}`);
    }
    if (code === 1007 || code === 1008 || code === 1003) {
      this.emit({ type: 'status', state: 'error', message: `Gemini rejected the session (${code}): ${reason || 'no reason given'}` });
      this.emit({ type: 'status', state: 'ended' });
      return;
    }
    if (this.resumeHandle && this.reconnectTries < 2) {
      this.reconnectTries += 1;
      this.emit({ type: 'status', state: 'reconnecting' });
      console.log(`[callgemini] Gemini socket dropped — resuming (try ${this.reconnectTries})`);
      this.connectGemini(this.resumeHandle).catch((err) => {
        console.error('[callgemini] session resume failed:', err?.message ?? err);
        this.emit({ type: 'status', state: 'ended' });
      });
      return;
    }
    this.emit({ type: 'status', state: 'ended' });
  }

  onServerMessage(message) {
    // Track the latest resumable state token; goAway means the server is about
    // to drop us — the subsequent onclose auto-resumes with this handle.
    const sru = message?.sessionResumptionUpdate;
    if (sru?.resumable && sru.newHandle) {
      if (!this.resumeHandle) console.log('[callgemini] resumption handle received');
      this.resumeHandle = sru.newHandle;
      this.persistHandle();
    }
    if (message?.goAway) {
      console.log('[callgemini] Gemini goAway received (timeLeft:', message.goAway.timeLeft ?? '?', ') — will auto-resume');
    }

    const sc = message?.serverContent;
    if (sc?.inputTranscription?.text) {
      this.seen.note(sc.inputTranscription.text); // what the user said is never "invented"
      this.emit({ type: 'transcript', role: 'user', text: sc.inputTranscription.text });
      this.accrue('user', sc.inputTranscription.text);
    }
    if (sc?.outputTranscription?.text) {
      this.emit({ type: 'transcript', role: 'model', text: sc.outputTranscription.text });
      this.accrue('model', sc.outputTranscription.text);
    }
    if (sc?.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        const inline = part?.inlineData;
        if (inline?.data) this.emitAudio(Buffer.from(inline.data, 'base64'));
        // Text parts are rare in AUDIO mode (transcription covers it) but forward if present.
        else if (part?.text) { this.emit({ type: 'transcript', role: 'model', text: part.text }); this.accrue('model', part.text); }
      }
    }
    if (sc?.interrupted) this.emit({ type: 'interrupted' });
    if (sc?.turnComplete) { this.emit({ type: 'turnComplete' }); this.flushTurn(); }

    if (message?.toolCall?.functionCalls?.length) {
      this.handleToolCalls(message.toolCall.functionCalls);
    }
  }

  /** Accumulate transcript chunks into the current turn; a role switch closes
   * the previous one (user speaks → model replies → user speaks again). */
  accrue(role, text) {
    if (this.accrual.role && this.accrual.role !== role) this.flushTurn();
    this.accrual.role = role;
    this.accrual.text += text;
  }

  /** Persist the accumulated turn to the conversation store (fire-and-forget)
   * and let the browser refresh the sidebar (title may have just been set). */
  flushTurn() {
    const { role, text } = this.accrual;
    this.accrual = { role: null, text: '' };
    if (!role || !text.trim() || !this.convId) return;
    const id = this.convId;
    conversations.appendTurn(id, { role, text: text.trim(), ts: Date.now() })
      .then((conv) => { if (conv) this.emit({ type: 'conversation', id, title: conv.title }); })
      .catch((err) => console.error('[callgemini] appendTurn failed:', err?.message ?? err));
  }

  /**
   * Note a tool call for the repeat log. A model that asks for the same thing
   * over and over is looping; this is what makes that visible here rather
   * than only in the MCP server's log.
   */
  noteToolCall(name) {
    const now = Date.now();
    this.recentTools = (this.recentTools ?? []).filter((t) => now - t.at < 30_000);
    this.recentTools.push({ name, at: now });
    const n = this.recentTools.filter((t) => t.name === name).length;
    if (n > 3) console.warn(`[callgemini/tool] ${name} called ${n}× in 30s — the model may be looping`);
  }

  /** Route each Gemini functionCall to its MCP server; respond as each resolves. */
  handleToolCalls(functionCalls) {
    // dispatchBatch resolves placeholder args (ids of pending calls) before
    // dispatching — see mcp.mjs. Without an MCP bridge every call just errors.
    const outcomes = this.mcp?.dispatchBatch
      ? this.mcp.dispatchBatch(functionCalls)
      : functionCalls.map(() => Promise.resolve({ error: 'no tools' }));
    // The call ids belong to THIS Gemini session; after a tool-change re-dial
    // they'd be unknown to the new one, so the response must be dropped then.
    const session = this.session;
    functionCalls.forEach((fc, i) => {
      this.emit({ type: 'tool', name: fc.name, phase: 'running' });
      this.noteToolCall(fc.name);
      console.log(`[callgemini/tool] ${fc.name} args:`, JSON.stringify(fc.args ?? {}).slice(0, 300));
      outcomes[i]
        .then((response) => {
          // Server-side trace of every tool round-trip: the outcome otherwise
          // only reaches Gemini (and the transcript chip), so a failing tool is
          // invisible in the app logs.
          if (response?.error) console.error(`[callgemini/tool] ${fc.name} failed:`, String(response.error).slice(0, 300));
          else console.log(`[callgemini/tool] ${fc.name} ok (${String(response?.result ?? '').length} chars)`);
          this.emit({ type: 'tool', name: fc.name, phase: 'done', error: response?.error });
          if (!this.session || this.session !== session) return;
          try {
            // No `scheduling`: tools are BLOCKING (see mcp.mjs), so Gemini is
            // waiting for this and the field is ignored. It mattered while
            // they were NON_BLOCKING, and neither value worked — WHEN_IDLE
            // never delivered to a model that kept generating, INTERRUPT
            // delivered but cancelled the turn that was about to emit the
            // next call. If a tool is ever made NON_BLOCKING again, it needs
            // a scheduling choice made with both failures in mind.
            this.session.sendToolResponse({
              functionResponses: [{ id: fc.id, name: fc.name, response }],
            });
          } catch (err) {
            console.error('[callgemini] sendToolResponse failed:', err?.message ?? err);
          }
        });
    });
  }

  sendText(text) {
    if (!this.session || !text) return;
    // Mirror the user's typed turn into the transcript + store, then feed Gemini.
    this.seen.note(text); // a typed id/token is the user's, not invented
    this.emit({ type: 'transcript', role: 'user', text });
    this.accrue('user', text);
    this.flushTurn();
    try {
      this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }] });
    } catch (err) {
      console.error('[callgemini] sendClientContent failed:', err?.message ?? err);
    }
  }

  /** End the Gemini side of the call but keep the WS open for a new call. */
  stopGemini(_reason) {
    this.userStopped = true; // intentional — onGeminiClose must not auto-resume
    this.flushTurn(); // persist any in-progress turn before tearing down
    this.persistHandle(true); // so "continue" can pick the context back up
    try { this.session?.close?.(); } catch { /* noop */ }
    this.session = null;
    this.mcp?.close?.().catch(() => {});
    this.mcp = null;
    this.emit({ type: 'status', state: 'idle' });
  }

  /** Full teardown — Gemini, MCP, and the browser socket. */
  close(_reason) {
    if (this.closed) return;
    this.closed = true;
    this.flushTurn(); // don't lose the last utterance on a hard socket drop
    this.persistHandle(true);
    try { this.session?.close?.(); } catch { /* noop */ }
    this.session = null;
    this.mcp?.close?.().catch(() => {});
    this.mcp = null;
    try { this.ws.close(); } catch { /* noop */ }
    unregister(this);
  }
}

/**
 * Attach the CallGemini WS server to the app's Node HTTP server. Called from
 * the Vite plugin in astro.config.mjs with `server.httpServer`.
 */
export function attachCallBridge(httpServer) {
  if (!httpServer || httpServer.__callGeminiAttached) return;
  httpServer.__callGeminiAttached = true;

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/ws') return; // let other upgrade listeners (if any) handle it
    wss.handleUpgrade(req, socket, head, (ws) => new CallSession(ws));
  });

  console.log('[callgemini] WS bridge attached on /ws');
}
