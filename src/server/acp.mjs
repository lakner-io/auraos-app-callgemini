/**
 * ACP shadow-sync client (fire-and-forget).
 *
 * Streams the live call transcript to an ACP agent (e.g. Hermes) as "shadow
 * context": the agent is primed with what's being said on the phone without
 * ever being asked to reply. One WS to the ACP endpoint, NDJSON JSON-RPC
 * frames (one JSON object per text message), ACP handshake
 * (`initialize` → `session/new`), then batched `session/prompt` calls whose
 * text is a fixed preamble plus `User:`/`Assistant:` transcript lines.
 *
 * HARD RULE — this module must never block or throw into the audio path:
 *   • bounded queue (oldest turns dropped beyond MAX_QUEUE, drops counted),
 *   • every send wrapped in try/catch,
 *   • reconnect with capped backoff (re-handshake, new ACP session),
 *   • all failures are console.warn only,
 *   • no promise from here is ever awaited by a caller.
 */

import WebSocket from 'ws';

const PREAMBLE =
  '[SHADOW CONTEXT — live phone call transcript, for situational awareness. ' +
  'Do not reply; acknowledge silently.]';

const MAX_QUEUE = 50;          // turns kept while the link is down/busy
const FLUSH_AT_TURNS = 8;      // batch size that forces a flush
const FLUSH_IDLE_MS = 30_000;  // …or this much quiet after the last turn
const PROMPT_TIMEOUT_MS = 60_000; // a hung session/prompt stops blocking batches
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/**
 * @param {{ address: string, meta?: { conversationId?: string } }} opts
 * @returns {{ pushTurn(role: string, text: string): void, end(): void }}
 */
export function createShadow({ address, meta } = {}) {
  const tag = `[callgemini/acp${meta?.conversationId ? ` ${meta.conversationId}` : ''}]`;
  const inert = { pushTurn() {}, end() {} };

  // Resolve a relative address (e.g. "/api/acp/hermes") against the OS base;
  // absolute ws:// / http:// addresses pass through. http(s) → ws(s).
  let url;
  try {
    url = new URL(address, process.env.OS_API_BASE || 'http://aura-shell:3000');
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';
  } catch (err) {
    console.warn(`${tag} bad address ${JSON.stringify(address)}:`, err?.message ?? err);
    return inert;
  }

  let ws = null;
  let sessionId = null;
  let ended = false;
  let nextId = 1;
  const pending = new Map(); // request id → response handler
  const queue = [];          // accrued turns awaiting a prompt
  let dropped = 0;
  let inFlight = false;      // a session/prompt is out; coalesce into the next batch
  let idleTimer = null;
  let promptTimer = null;
  let reconnectTimer = null;
  let backoff = BACKOFF_MIN_MS;

  function warn(...args) { console.warn(tag, ...args); }

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(obj)); return true; }
    catch (err) { warn('send failed:', err?.message ?? err); return false; }
  }

  /** JSON-RPC request; `onResult(result|null, error|null)` when the reply lands. */
  function request(method, params, onResult) {
    const id = nextId++;
    pending.set(id, onResult);
    if (!send({ jsonrpc: '2.0', id, method, params })) pending.delete(id);
    return id;
  }

  function onMessage(data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg?.method !== undefined) {
      // Agent-initiated traffic. Notifications (session/update etc.) are
      // ignored; unknown requests get method-not-found so the agent isn't
      // left hanging on us.
      if (msg.id !== undefined && msg.id !== null) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `shadow client does not handle ${msg.method}` } });
      }
      return;
    }
    if (msg?.id === undefined || !pending.has(msg.id)) return;
    const handler = pending.get(msg.id);
    pending.delete(msg.id);
    try { handler(msg.result ?? null, msg.error ?? null); }
    catch (err) { warn('response handler failed:', err?.message ?? err); }
  }

  function handshake() {
    request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, (result, error) => {
      if (ended) return;
      if (error) { warn('initialize rejected:', JSON.stringify(error).slice(0, 200)); return; }
      request('session/new', { cwd: '/', mcpServers: [] }, (res, err) => {
        if (ended) return;
        if (err || !res?.sessionId) { warn('session/new rejected:', err ? JSON.stringify(err).slice(0, 200) : 'no sessionId'); return; }
        sessionId = res.sessionId;
        backoff = BACKOFF_MIN_MS;
        console.log(`${tag} shadow session ${sessionId} on ${url.href}`);
        maybeFlush();
      });
    });
  }

  function connect() {
    if (ended) return;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      warn('dial failed:', err?.message ?? err);
      scheduleReconnect();
      return;
    }
    ws.on('open', () => { if (!ended) handshake(); });
    ws.on('message', (data) => onMessage(data));
    ws.on('error', (err) => warn('socket error:', err?.message ?? err));
    ws.on('close', () => {
      sessionId = null;
      inFlight = false;
      clearTimer('promptTimer');
      pending.clear();
      if (!ended) scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (ended || reconnectTimer) return;
    warn(`link down — reconnecting in ${backoff / 1000}s (${queue.length} turn(s) queued)`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoff);
    reconnectTimer.unref?.();
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  function clearTimer(which) {
    if (which === 'idleTimer' && idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (which === 'promptTimer' && promptTimer) { clearTimeout(promptTimer); promptTimer = null; }
  }

  /** Fire the queued turns as ONE session/prompt if the link is free. */
  function maybeFlush() {
    if (!queue.length || inFlight || !sessionId || !ws || ws.readyState !== WebSocket.OPEN) return;
    clearTimer('idleTimer');
    const batch = queue.splice(0, queue.length);
    const lines = batch.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`);
    inFlight = true;
    // A hung prompt must not dam up the batches forever.
    promptTimer = setTimeout(() => { promptTimer = null; inFlight = false; maybeFlush(); }, PROMPT_TIMEOUT_MS);
    promptTimer.unref?.();
    request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `${PREAMBLE}\n\n${lines.join('\n')}` }],
    }, (_result, error) => {
      clearTimer('promptTimer');
      inFlight = false;
      if (error) warn('session/prompt rejected:', JSON.stringify(error).slice(0, 200));
      maybeFlush(); // turns that accrued while this one was in flight
    });
  }

  connect();

  return {
    /** Queue one finished transcript turn. Never blocks, never throws. */
    pushTurn(role, text) {
      try {
        if (ended || !text) return;
        queue.push({ role, text });
        if (queue.length > MAX_QUEUE) {
          queue.shift();
          dropped += 1;
          warn(`queue full — dropped oldest turn (${dropped} dropped total)`);
        }
        if (queue.length >= FLUSH_AT_TURNS) { maybeFlush(); return; }
        clearTimer('idleTimer');
        idleTimer = setTimeout(() => { idleTimer = null; maybeFlush(); }, FLUSH_IDLE_MS);
        idleTimer.unref?.();
      } catch (err) {
        warn('pushTurn failed:', err?.message ?? err);
      }
    },

    /** Final best-effort flush, then tear the link down. Never throws. */
    end() {
      try {
        if (ended) return;
        // Force the last batch out even if a prompt is in flight — this is
        // the only chance it gets; `ws.close()` still delivers buffered frames.
        if (queue.length && sessionId && ws?.readyState === WebSocket.OPEN) {
          const batch = queue.splice(0, queue.length);
          const lines = batch.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`);
          send({ jsonrpc: '2.0', id: nextId++, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: `${PREAMBLE}\n\n${lines.join('\n')}` }] } });
        }
        ended = true;
        clearTimer('idleTimer');
        clearTimer('promptTimer');
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        pending.clear();
        if (dropped) warn(`ended with ${dropped} dropped turn(s)`);
        try { ws?.close(); } catch { /* socket gone */ }
        ws = null;
      } catch (err) {
        warn('end failed:', err?.message ?? err);
      }
    },
  };
}
