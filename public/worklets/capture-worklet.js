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
 */
const FRAME = 320; // 20 ms @ 16 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRate = sampleRate; // AudioWorkletGlobalScope global
    this.outRate = 16000;
    this.ratio = this.inRate / this.outRate;
    this.buf = new Float32Array(0);
    this.pos = 0;                       // fractional read cursor into this.buf
    this.frame = new Int16Array(FRAME); // accumulates one 20 ms output frame
    this.fill = 0;                      // samples currently in this.frame
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;

    // Append the new block to whatever tail we kept for interpolation.
    const merged = new Float32Array(this.buf.length + ch.length);
    merged.set(this.buf, 0);
    merged.set(ch, this.buf.length);
    this.buf = merged;

    let i = this.pos;
    while (i < this.buf.length - 1) {
      const i0 = i | 0;
      const frac = i - i0;
      const s = this.buf[i0] * (1 - frac) + this.buf[i0 + 1] * frac;
      const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
      this.frame[this.fill++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      if (this.fill === FRAME) {
        // Post a copy so the next frame can keep reusing this.frame's buffer.
        this.port.postMessage(this.frame.slice().buffer);
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
