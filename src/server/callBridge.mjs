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
 *   { type:'start', config, conversationId? }   { type:'text', text }   { type:'stop' }
 *   (conversationId set → resume that saved conversation with its history as context)
 * TEXT event frames to the browser:
 *   { type:'status', state }   { type:'transcript', role, text }
 *   { type:'tool', name, phase }   { type:'interrupted' }   { type:'turnComplete' }
 *   { type:'conversation', id, title }   (the conversation being recorded / its title)
 */

import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from '@google/genai';
import { connectAll } from './mcp.mjs';
import { register, unregister } from './sessions.mjs';
import * as conversations from './conversations.mjs';

/**
 * End-of-speech silence window per "Responsiveness" preset (Settings). Lower =
 * Gemini commits end-of-speech sooner → the input transcript prints and the
 * reply starts faster, at the cost of possibly cutting off mid-pause.
 */
const RESPONSIVENESS_MS = { snappy: 350, balanced: 600, relaxed: 1000 };

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

/** Native-audio Live dialog model. Date-versioned & preview — keep configurable. */
export const DEFAULT_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
export const DEFAULT_VOICE = 'Kore';
const DEFAULT_SYSTEM_INSTRUCTION =
  'You are a helpful, friendly voice assistant. Keep replies concise and ' +
  'conversational. When you trigger a tool that may take a while, briefly tell ' +
  "the user you're looking into it and keep the conversation going, then share " +
  'the result once it arrives.';

export class CallSession {
  /** @param {import('ws').WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.session = null; // Gemini Live session
    this.mcp = null;      // MCP bridge handle
    this.closed = false;
    this.convId = null;                       // conversation being recorded
    this.accrual = { role: null, text: '' };  // in-progress turn (chunks accumulate)
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
      case 'start':   await this.start(msg.config ?? {}, msg.conversationId); break;
      case 'text':    this.sendText(msg.text ?? ''); break;
      case 'vad':     this.sendActivitySignal(msg.event); break;
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

  async start(config, conversationId) {
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

    this.emit({ type: 'status', state: 'connecting' });

    // Resolve the conversation being recorded: resume an existing one (and
    // gather its history to seed context) or create a fresh one.
    let priorTurns = [];
    try {
      if (conversationId) {
        this.convId = conversationId;
        priorTurns = (await conversations.get(conversationId))?.turns ?? [];
      } else {
        const conv = await conversations.create({});
        this.convId = conv.id;
        this.emit({ type: 'conversation', id: conv.id, title: conv.title });
      }
    } catch (err) {
      console.error('[callgemini] conversation setup failed:', err?.message ?? err);
    }

    // Bridge MCP servers first so their tools are known at connect time.
    try {
      this.mcp = await connectAll(config.mcpServers ?? []);
    } catch (err) {
      console.error('[callgemini] MCP connect error:', err?.message ?? err);
      this.mcp = { functionDeclarations: [], dispatch: async () => ({ error: 'mcp unavailable' }), close: async () => {} };
    }
    const decls = this.mcp.functionDeclarations;
    if (decls.length) this.emit({ type: 'status', state: 'connecting', message: `${decls.length} MCP tool(s) ready` });

    const liveConfig = {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      systemInstruction,
      inputAudioTranscription: {},
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
      ...(decls.length ? { tools: [{ functionDeclarations: decls }] } : {}),
    };

    try {
      const genai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } });
      const callbacks = {
        onopen: () => this.emit({ type: 'status', state: 'live' }),
        onmessage: (message) => this.onServerMessage(message),
        onerror: (e) => this.emit({ type: 'status', state: 'error', message: e?.message ?? 'Gemini stream error' }),
        onclose: () => { if (!this.closed) this.emit({ type: 'status', state: 'ended' }); },
      };
      try {
        this.session = await genai.live.connect({ model, callbacks, config: liveConfig });
      } catch (err) {
        // The thinking guard keys off the model id; if this id doesn't actually
        // support thinking the API rejects the config — retry once without it.
        if (!liveConfig.thinkingConfig) throw err;
        console.error('[callgemini] connect with thinkingConfig failed, retrying without:', err?.message ?? err);
        const { thinkingConfig, ...rest } = liveConfig;
        this.session = await genai.live.connect({ model, callbacks, config: rest });
      }

      // Resume: replay prior turns as context WITHOUT eliciting a reply
      // (turnComplete:false) so Gemini continues where the conversation left off
      // once the user speaks.
      if (priorTurns.length) {
        try {
          this.session.sendClientContent({
            turns: capTurns(priorTurns).map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
            turnComplete: false,
          });
        } catch (err) {
          console.error('[callgemini] resume seed failed:', err?.message ?? err);
        }
      }
    } catch (err) {
      console.error('[callgemini] live.connect failed:', err?.message ?? err);
      this.emit({ type: 'status', state: 'error', message: err?.message ?? 'Failed to connect to Gemini' });
      await this.mcp?.close?.();
      this.mcp = null;
    }
  }

  onServerMessage(message) {
    const sc = message?.serverContent;
    if (sc?.inputTranscription?.text) {
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

  /** Route each Gemini functionCall to its MCP server; respond as each resolves. */
  handleToolCalls(functionCalls) {
    for (const fc of functionCalls) {
      this.emit({ type: 'tool', name: fc.name, phase: 'running' });
      Promise.resolve(this.mcp?.dispatch(fc) ?? { error: 'no tools' })
        .then((response) => {
          this.emit({ type: 'tool', name: fc.name, phase: 'done', error: response?.error });
          if (!this.session) return;
          try {
            this.session.sendToolResponse({
              functionResponses: [{ id: fc.id, name: fc.name, response, scheduling: 'WHEN_IDLE' }],
            });
          } catch (err) {
            console.error('[callgemini] sendToolResponse failed:', err?.message ?? err);
          }
        });
    }
  }

  sendText(text) {
    if (!this.session || !text) return;
    // Mirror the user's typed turn into the transcript + store, then feed Gemini.
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
    this.flushTurn(); // persist any in-progress turn before tearing down
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
