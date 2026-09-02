/**
 * Speaker playback worklet: plays Gemini's 24 kHz Int16 PCM output. The host
 * AudioContext is created at sampleRate 24000, so source and output rates match
 * and no resampling is needed — we just queue and drain.
 *
 * Messages from the main thread:
 *   • ArrayBuffer  — a chunk of Int16 PCM @24 kHz to enqueue.
 *   • 'clear'      — flush the queue immediately (barge-in / interruption).
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.cur = null;
    this.curPos = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'clear') {
        this.queue = [];
        this.cur = null;
        this.curPos = 0;
        return;
      }
      const i16 = new Int16Array(e.data);
      const f = new Float32Array(i16.length);
      for (let k = 0; k < i16.length; k++) f[k] = i16[k] / 0x8000;
      this.queue.push(f);
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    for (let n = 0; n < out.length; n++) {
      if (!this.cur || this.curPos >= this.cur.length) {
        this.cur = this.queue.shift() || null;
        this.curPos = 0;
      }
      out[n] = this.cur ? this.cur[this.curPos++] : 0;
    }
    return true;
  }
}

registerProcessor('playback-worklet', PlaybackProcessor);
