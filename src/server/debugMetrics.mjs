/**
 * Call telemetry behind the `callgemini-debug` MCP (mcpDebug.mjs, /mcp/debug):
 * metrics, logs and per-turn traces of the live voice pipeline.
 *
 *   mic (browser) → uplink WS → bridge → Gemini → downlink WS → playback worklet
 *
 * Always on, and cheap: a few integer adds per audio frame plus small ring
 * buffers. The detailed browser stats (mic level, VAD, jitter cushion, RTT)
 * and the periodic console trace only flow after `set_debug_logging` turns
 * them on for a conversation. Memory only — gone after an app restart.
 *
 * Anchored on globalThis like sessions.mjs: the WS bridge and the Astro MCP
 * route load this file through different module loaders.
 */

const G = (globalThis.__callgeminiDebug ??= {
  trackers: new Map(),                                     // convId → Tracker
  defaults: { enabled: false, intervalMs: 1000, console: false },
  logs: [],                                                // captured [callgemini…] console lines
  consolePatched: false,
});

const EVENT_CAP = 2000;
const TURN_CAP = 100;
const GAP_CAP = 600;
const LOG_CAP = 3000;
const TRACKER_CAP = 20;          // conversations kept after their call ended
/** Int16 RMS above which a mic frame counts as voice (~ -34 dBFS). Coarse on
 * purpose: it only dates the END of the user's speech for TTFA. */
const VOICE_RMS = 650;
/** Gemini output is PCM16 mono @24 kHz → 48 bytes per ms of audio. */
const DOWN_BYTES_PER_MS = 48;

function push(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

/** p50/p95/max/avg of a list of numbers (null when empty). */
export function percentiles(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  const avg = v.reduce((s, x) => s + x, 0) / v.length;
  return { n: v.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(v[v.length - 1]), avg: round(avg) };
}
const round = (x) => (x == null ? x : Math.round(x * 10) / 10);

/** RMS of an Int16 PCM buffer (Buffer / ArrayBuffer / typed array). */
export function int16Rms(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const n = buf.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i * 2); sum += s * s; }
  return Math.sqrt(sum / n);
}

export class Tracker {
  constructor(convId) {
    this.convId = convId;
    this.createdAt = Date.now();
    this.debug = { ...G.defaults };
    this.events = [];
    this.turns = [];
    this.turnSeq = 0;
    this.cur = null;            // open turn trace
    this.mic = { frames: 0, bytes: 0, dropped: 0, lastAt: 0, gaps: [], lastVoiceAt: 0, rmsSum: 0, rmsN: 0 };
    this.down = { chunks: 0, bytes: 0, lastAt: 0, gaps: [] };
    this.conn = { connects: [], closes: [], reconnects: [], dialAt: 0, droppedAt: 0, tools: 0, sysChars: 0 };
    this.tools = [];            // { name, ms, chars, ok, at }
    this.client = null;         // latest browser stats frame
    this.clientAt = 0;
    this.rtt = [];
  }

  event(kind, data = {}) {
    push(this.events, { at: Date.now(), kind, ...data }, EVENT_CAP);
  }

  // ── uplink ────────────────────────────────────────────────────────────────
  micFrame(data, live) {
    const now = Date.now();
    const m = this.mic;
    if (!live) { m.dropped++; return; }
    if (m.lastAt) push(m.gaps, now - m.lastAt, GAP_CAP);
    m.lastAt = now;
    m.frames++;
    m.bytes += data.length ?? data.byteLength ?? 0;
    const rms = int16Rms(data);
    m.rmsSum += rms; m.rmsN++;
    if (rms >= VOICE_RMS) m.lastVoiceAt = now;
  }

  // ── turn tracing ──────────────────────────────────────────────────────────
  /** The turn being traced, opened on the first sign of a new exchange. */
  turn() {
    if (!this.cur) {
      this.cur = {
        n: ++this.turnSeq, openedAt: Date.now(),
        userTranscriptAt: 0, vadEndAt: 0, speechEndAt: 0,
        speechEndSrc: null, firstChunkAt: 0, lastChunkAt: 0, audibleAt: 0, completeAt: 0,
        audioBytes: 0, chunks: 0, maxGap: 0, tools: [], interrupted: false,
      };
    }
    return this.cur;
  }

  userTranscript() { const t = this.turn(); if (!t.firstChunkAt) t.userTranscriptAt = Date.now(); }
  vad(ev) {
    this.event('vad', { ev });
    if (ev === 'end') { const t = this.turn(); if (!t.firstChunkAt) t.vadEndAt = Date.now(); }
    if (ev === 'start' && this.cur?.completeAt) this.cur = null;
  }

  downChunk(bytes) {
    const now = Date.now();
    const d = this.down;
    const t = this.turn();
    if (!t.firstChunkAt) {
      t.firstChunkAt = now;
      // Speech end as best known when the reply started: browser VAD end,
      // else the last loud mic frame, else the last input transcription.
      const micEnd = this.mic.lastVoiceAt > t.openedAt - 30_000 ? this.mic.lastVoiceAt : 0;
      [t.speechEndAt, t.speechEndSrc] = t.vadEndAt ? [t.vadEndAt, 'browser_vad']
        : micEnd ? [micEnd, 'mic_energy']
        : t.userTranscriptAt ? [t.userTranscriptAt, 'transcript'] : [0, null];
      d.lastAt = 0; // gaps are measured within a turn's stream only
    }
    if (d.lastAt) {
      const gap = now - d.lastAt;
      push(d.gaps, gap, GAP_CAP);
      if (gap > t.maxGap) t.maxGap = gap;
    }
    d.lastAt = now;
    d.chunks++; d.bytes += bytes;
    t.chunks++; t.audioBytes += bytes; t.lastChunkAt = now;
  }

  /** Browser playback became audible / went idle. */
  playback(state) {
    this.event('playback', { state });
    if (state === 'playing' && this.cur?.firstChunkAt && !this.cur.audibleAt) this.cur.audibleAt = Date.now();
  }

  interrupted() { this.event('interrupted'); if (this.cur) this.cur.interrupted = true; }

  turnComplete() {
    const t = this.cur;
    this.cur = null;
    if (!t) return;
    t.completeAt = Date.now();
    push(this.turns, t, TURN_CAP);
    this.event('turn', { n: t.n, ...summarizeTurn(t) });
  }

  // ── tools ─────────────────────────────────────────────────────────────────
  toolStart(name) { this.event('tool_start', { name }); return Date.now(); }
  toolEnd(name, startedAt, response) {
    const ms = Date.now() - startedAt;
    const chars = String(response?.result ?? response?.error ?? '').length;
    const rec = { name, ms, chars, ok: !response?.error, at: Date.now() };
    push(this.tools, rec, 500);
    this.turn().tools.push(rec);
    this.event('tool_end', rec);
  }

  // ── Gemini socket ─────────────────────────────────────────────────────────
  dial({ resumed, tools, sysChars }) {
    this.conn.dialAt = Date.now();
    this.conn.tools = tools; this.conn.sysChars = sysChars;
    this.event('dial', { resumed, tools, sysChars });
  }
  live() {
    const now = Date.now();
    const c = this.conn;
    const setupMs = c.dialAt ? now - c.dialAt : null;
    push(c.connects, { at: now, setupMs, tools: c.tools, sysChars: c.sysChars }, 200);
    if (c.droppedAt) { push(c.reconnects, { at: now, ms: now - c.droppedAt }, 200); c.droppedAt = 0; }
    this.event('live', { setupMs });
  }
  closed(code, reason) {
    push(this.conn.closes, { at: Date.now(), code: code ?? null, reason: reason || '' }, 200);
    if (code && code !== 1000 && code !== 1005) this.conn.droppedAt = Date.now();
    this.event('close', { code, reason });
    this.cur = null; // a turn cut by a drop never completes
  }

  // ── browser stats ─────────────────────────────────────────────────────────
  clientStats(stats) {
    this.client = stats; this.clientAt = Date.now();
    if (Number.isFinite(stats?.rttMs)) push(this.rtt, stats.rttMs, GAP_CAP);
  }
}

/** Derived latencies of one traced turn (ms; null when a stage never happened). */
export function summarizeTurn(t) {
  const d = (a, b) => (a && b ? b - a : null);
  const streamMs = d(t.firstChunkAt, t.lastChunkAt);
  const audioMs = Math.round(t.audioBytes / DOWN_BYTES_PER_MS);
  const toolMs = t.tools.reduce((s, x) => s + x.ms, 0);
  return {
    speech_end_to_first_chunk_ms: d(t.speechEndAt, t.firstChunkAt),
    first_chunk_to_audible_ms: d(t.firstChunkAt, t.audibleAt),
    speech_end_to_audible_ms: d(t.speechEndAt, t.audibleAt),
    speech_end_source: t.speechEndSrc ?? null,
    total_ms: d(t.speechEndAt || t.openedAt, t.completeAt),
    audio_ms: audioMs,
    stream_ms: streamMs,
    // >1 = Gemini sends audio faster than real time (healthy); <1 = playback will starve.
    stream_speed: streamMs > 200 ? round(audioMs / streamMs) : null,
    max_chunk_gap_ms: t.maxGap,
    chunks: t.chunks,
    tool_ms: toolMs || 0,
    tools: t.tools.map((x) => `${x.name}:${x.ms}ms${x.ok ? '' : ':failed'}`),
    interrupted: t.interrupted,
  };
}

// ── registry ────────────────────────────────────────────────────────────────

/** Tracker of a conversation; created on first use. Old ones are evicted. */
export function tracker(convId) {
  if (!convId) return null;
  let t = G.trackers.get(convId);
  if (!t) {
    t = new Tracker(convId);
    G.trackers.set(convId, t);
    while (G.trackers.size > TRACKER_CAP) G.trackers.delete(G.trackers.keys().next().value);
  }
  return t;
}
export function existingTracker(convId) { return G.trackers.get(convId) ?? null; }
export function trackedConversations() {
  return [...G.trackers.values()].map((t) => ({ id: t.convId, since: new Date(t.createdAt).toISOString(), turns: t.turns.length, debug: t.debug.enabled }));
}
export function defaults() { return G.defaults; }
export function setDefaults(patch) { Object.assign(G.defaults, patch); return G.defaults; }

// ── snapshots ───────────────────────────────────────────────────────────────

export function snapshot(t) {
  const now = Date.now();
  const m = t.mic, d = t.down, c = t.conn;
  const turns = t.turns.map(summarizeTurn);
  const pick = (k) => percentiles(turns.map((x) => x[k]));
  return {
    conversation_id: t.convId,
    debug: t.debug,
    uplink: {
      frames: m.frames, dropped_before_live: m.dropped, kbytes: Math.round(m.bytes / 1024),
      frame_gap_ms: percentiles(m.gaps),
      avg_rms: m.rmsN ? Math.round(m.rmsSum / m.rmsN) : null,
      last_voice_ago_ms: m.lastVoiceAt ? now - m.lastVoiceAt : null,
    },
    downlink: { chunks: d.chunks, kbytes: Math.round(d.bytes / 1024), chunk_gap_ms: percentiles(d.gaps) },
    latency: {
      speech_end_to_first_chunk_ms: pick('speech_end_to_first_chunk_ms'),
      first_chunk_to_audible_ms: pick('first_chunk_to_audible_ms'),
      speech_end_to_audible_ms: pick('speech_end_to_audible_ms'),
      stream_speed: pick('stream_speed'),
      turns: turns.length,
    },
    connection: {
      declared_tools: c.tools, system_instruction_chars: c.sysChars,
      connects: c.connects.length, setup_ms: percentiles(c.connects.map((x) => x.setupMs)),
      closes_by_code: c.closes.reduce((acc, x) => { acc[x.code ?? 'none'] = (acc[x.code ?? 'none'] ?? 0) + 1; return acc; }, {}),
      reconnect_ms: percentiles(c.reconnects.map((x) => x.ms)),
    },
    tools: percentiles(t.tools.map((x) => x.ms)),
    client: t.client ? { ...t.client, age_ms: now - t.clientAt } : null,
    rtt_ms: percentiles(t.rtt),
  };
}

/** One-line trace for the console (enabled per conversation). */
export function consoleLine(t) {
  const s = snapshot(t);
  const cl = s.client ?? {};
  const f = (p) => (p ? `${p.p50}/${p.p95}` : '-');
  return `[callgemini/debug ${t.convId.slice(0, 8)}] ` +
    `mic rms=${cl.micRms ?? s.uplink.avg_rms ?? '-'} vad=${cl.vadSpeaking ? 'speech' : 'quiet'}(${cl.vadEngine ?? 'server'}) ` +
    `up gap p50/95=${f(s.uplink.frame_gap_ms)}ms ` +
    `down gap=${f(s.downlink.chunk_gap_ms)}ms speed=${f(s.latency.stream_speed)}x ` +
    `cushion=${cl.playback?.cushionMs ?? '-'}ms q=${cl.playback?.queuedMs ?? '-'}ms underruns=${cl.playback?.underruns ?? '-'} ` +
    `ttfa=${f(s.latency.speech_end_to_first_chunk_ms)}ms audible=${f(s.latency.speech_end_to_audible_ms)}ms ` +
    `rtt=${f(s.rtt_ms)}ms tools=${s.connection.declared_tools}`;
}

/** Rule-based findings over a tracker — the starting point for "why is it slow". */
export function diagnose(t) {
  const s = snapshot(t);
  const out = [];
  const add = (severity, area, finding, hint) => out.push({ severity, area, finding, hint });
  const lat = s.latency;
  if (lat.speech_end_to_first_chunk_ms?.p50 > 1500) {
    add('high', 'model', `Gemini needs ${lat.speech_end_to_first_chunk_ms.p50} ms (p50) / ${lat.speech_end_to_first_chunk_ms.p95} ms (p95) from end of speech to first audio.`,
      'Model-side: fewer declared tools, shorter system instruction/history, smaller tool results, thinking off, Responsiveness "snappy".');
  }
  if (lat.first_chunk_to_audible_ms?.p50 > 400) {
    add('medium', 'playback', `First audio chunk takes ${lat.first_chunk_to_audible_ms.p50} ms to become audible.`,
      'Jitter cushion or output latency too large — check client.playback.cushionMs and client.outputLatencyMs.');
  }
  if (lat.stream_speed?.p50 != null && lat.stream_speed.p50 < 1.05) {
    add('high', 'downlink', `Gemini streams audio at ${lat.stream_speed.p50}× real time — playback can starve.`, 'Network or model throughput; expect underruns.');
  }
  const pb = s.client?.playback;
  if (pb && pb.cushionMs >= 300) add('medium', 'jitter', `Jitter cushion is at its 300 ms cap (${pb.underruns} underruns).`, 'Every reply now starts ≥300 ms later; the cushion never shrinks during a call.');
  if (s.downlink.chunk_gap_ms?.p95 > 250) add('medium', 'downlink', `Downlink chunk gaps p95 ${s.downlink.chunk_gap_ms.p95} ms (max ${s.downlink.chunk_gap_ms.max}).`, 'Bursty delivery from Gemini or the proxy.');
  if (s.uplink.frame_gap_ms?.p95 > 120) add('medium', 'uplink', `Mic frames arrive with p95 gap ${s.uplink.frame_gap_ms.p95} ms.`, 'Browser throttled (background tab / mobile) or WS backpressure — check client.wsBufferedBytes.');
  if (s.client && s.client.wsBufferedBytes > 32_000) add('high', 'uplink', `Browser WS send buffer holds ${s.client.wsBufferedBytes} bytes.`, 'Uplink congested: audio reaches Gemini late.');
  if (s.rtt_ms?.p95 > 300) add('medium', 'network', `Browser↔app RTT p95 ${s.rtt_ms.p95} ms.`, 'Slow link between device and Aura.');
  const errs = Object.entries(s.connection.closes_by_code).filter(([k]) => !['1000', '1005', 'none'].includes(k));
  if (errs.length) add('high', 'connection', `Gemini socket errors: ${errs.map(([k, v]) => `${k}×${v}`).join(', ')}; reconnects ${s.connection.reconnect_ms ? `p50 ${s.connection.reconnect_ms.p50} ms` : 'n/a'}.`, '1011 = Gemini internal error; each one is a silent gap while resuming.');
  if (s.connection.declared_tools > 60) add('medium', 'model', `${s.connection.declared_tools} tools declared.`, 'Large tool lists slow every turn; turn off unused MCP servers for this conversation.');
  if (s.connection.system_instruction_chars > 12_000) add('low', 'model', `System instruction is ${s.connection.system_instruction_chars} chars (incl. replayed history).`, 'Start a new conversation or trim history.');
  const bigTools = t.tools.filter((x) => x.chars > 5000);
  if (bigTools.length) add('low', 'tools', `${bigTools.length} tool result(s) over 5000 chars (largest ${Math.max(...bigTools.map((x) => x.chars))}).`, 'Large results stay in context and slow later turns.');
  if (s.tools?.p95 > 3000) add('medium', 'tools', `Tool calls take ${s.tools.p95} ms (p95).`, 'The model waits for BLOCKING tools before speaking.');
  if (s.uplink.avg_rms != null && s.uplink.avg_rms < 60 && s.uplink.frames > 200) add('medium', 'mic', `Average mic RMS is very low (${s.uplink.avg_rms}).`, 'Wrong input device or too much gating/denoise — VAD may miss speech ends.');
  if (!out.length) add('info', 'all', 'No problems detected in the recorded data.', s.latency.turns ? '' : 'No complete turns yet — talk a few turns first.');
  return { findings: out, metrics: s };
}

// ── log capture ─────────────────────────────────────────────────────────────

/** Mirror the app's own `[callgemini…]` console lines into a ring buffer. */
export function captureConsole() {
  if (G.consolePatched) return;
  G.consolePatched = true;
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      try {
        if (typeof args[0] === 'string' && args[0].startsWith('[callgemini')) {
          const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : safeJson(a))).join(' ');
          push(G.logs, { at: Date.now(), level, text: text.slice(0, 2000) }, LOG_CAP);
        }
      } catch { /* logging must never throw */ }
    };
  }
}
function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

export function logs({ since = 0, grep, level, limit = 200 } = {}) {
  let re = null;
  if (grep) { try { re = new RegExp(grep, 'i'); } catch { re = null; } }
  return G.logs
    .filter((l) => l.at > since && (!level || l.level === level) && (!grep || (re ? re.test(l.text) : l.text.includes(grep))))
    .slice(-limit)
    .map((l) => ({ at: new Date(l.at).toISOString(), level: l.level, text: l.text }));
}
