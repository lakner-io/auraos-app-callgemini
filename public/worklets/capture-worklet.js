/**
 * Mic capture worklet: resamples the mic (context sample rate, usually 48 kHz)
 * down to 16 kHz mono Int16 PCM — the format Gemini Live expects for input —
 * and posts it to the main thread, which forwards it over the WebSocket.
 *
 * Batched to 20 ms frames (320 samples @16 kHz = 640 bytes): posting the ~43
 * samples produced each render quantum meant ~375 tiny WS frames/sec through
 * the double proxy hop — pure overhead. 20 ms is the Gemini Live sweet spot and
 * adds at most 20 ms of buffering.
 *
 * Linear interpolation with a persistent fractional read cursor keeps resampling
 * continuous across process() calls (no clicks at block boundaries).
 *
 * Message shape to the main thread: { buf, np } where `buf` is the transferred
 * 640-byte Int16 frame and `np` is the RNNoise speech probability accumulated
 * since the previous frame (-1 when no denoiser is active — this base class).
 *
 * Subclass hook: capture-denoise-worklet.js extends this with an RNNoise stage
 * via `preprocess()` (runs at CONTEXT rate, before resampling — RNNoise wants
 * 48 kHz). The base class is deliberately import-free so calls with noise
 * reduction off never download the ~2 MB wasm module.
 */
export class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRate = sampleRate; // AudioWorkletGlobalScope global
    this.outRate = 16000;
    this.ratio = this.inRate / this.outRate;
    this.buf = new Float32Array(0);
    this.pos = 0;                       // fractional read cursor into this.buf
    this.frame = new Int16Array(320);   // accumulates one 20 ms output frame
    this.fill = 0;                      // samples currently in this.frame
    this.npAcc = -1;                    // set by the denoise subclass
    this.denoiseActive = false;
  }

  /** Denoise hook — subclass returns whatever processed samples are READY
   * (variable length; it buffers to the model's frame size internally). The
   * base class is a passthrough. */
  preprocess(block) {
    return block;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;

    const cleaned = this.preprocess(ch);
    if (cleaned.length === 0) return true;

    // Append the new block to whatever tail we kept for interpolation.
    const merged = new Float32Array(this.buf.length + cleaned.length);
    merged.set(this.buf, 0);
    merged.set(cleaned, this.buf.length);
    this.buf = merged;

    let i = this.pos;
    while (i < this.buf.length - 1) {
      const i0 = i | 0;
      const frac = i - i0;
      const s = this.buf[i0] * (1 - frac) + this.buf[i0 + 1] * frac;
      const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
      this.frame[this.fill++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.fill === 320) {
        // Post a copy so the next frame can keep reusing this.frame's buffer.
        const out = this.frame.slice().buffer;
        this.port.postMessage({ buf: out, np: this.npAcc }, [out]);
        this.npAcc = this.denoiseActive ? 0 : -1;
        this.fill = 0;
      }
      i += this.ratio;
    }

    // Keep the unconsumed tail (and the fractional remainder) for next call.
    const keepFrom = i | 0;
    this.buf = this.buf.slice(keepFrom);
    this.pos = i - keepFrom;
    return true;
  }
}

registerProcessor('capture-worklet', CaptureProcessor);
