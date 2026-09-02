/**
 * Mic capture worklet: resamples the mic (context sample rate, usually 48 kHz)
 * down to 16 kHz mono Int16 PCM — the format Gemini Live expects for input —
 * and posts each chunk's ArrayBuffer to the main thread, which forwards it over
 * the WebSocket as a binary frame.
 *
 * Linear interpolation with a persistent fractional read cursor so resampling
 * stays continuous across process() calls (no clicks at block boundaries).
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRate = sampleRate; // AudioWorkletGlobalScope global
    this.outRate = 16000;
    this.ratio = this.inRate / this.outRate;
    this.buf = new Float32Array(0);
    this.pos = 0; // fractional read cursor into this.buf
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;

    // Append the new block to whatever tail we kept for interpolation.
    const merged = new Float32Array(this.buf.length + ch.length);
    merged.set(this.buf, 0);
    merged.set(ch, this.buf.length);
    this.buf = merged;

    const out = [];
    let i = this.pos;
    while (i < this.buf.length - 1) {
      const i0 = i | 0;
      const frac = i - i0;
      const s = this.buf[i0] * (1 - frac) + this.buf[i0 + 1] * frac;
      const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
      out.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
      i += this.ratio;
    }

    // Keep the unconsumed tail (and the fractional remainder) for next call.
    const keepFrom = i | 0;
    this.buf = this.buf.slice(keepFrom);
    this.pos = i - keepFrom;

    if (out.length) {
      const pcm = new Int16Array(out.length);
      for (let k = 0; k < out.length; k++) pcm[k] = out[k];
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('capture-worklet', CaptureProcessor);
