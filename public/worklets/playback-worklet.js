/**
 * Speaker playback worklet: plays Gemini's 24 kHz Int16 PCM output. The host
 * AudioContext is created at sampleRate 24000, so source and output rates match
 * and no resampling is needed — we just queue and drain.
 *
 * Dynamic jitter cushion: each burst of speech only STARTS playing once ~80 ms
 * of audio is queued (or the stream pauses), absorbing uneven WebSocket packet
 * arrival that would otherwise cause audible gaps/crackle mid-sentence. Once a
 * burst is playing we drain continuously; when the queue runs dry the cushion
 * re-arms for the next burst. Costs at most ~80 ms on first audio of each turn.
 *
 * Messages from the main thread:
 *   • ArrayBuffer  — a chunk of Int16 PCM @24 kHz to enqueue.
 *   • 'clear'      — flush the queue immediately (barge-in / interruption).
 *   • 'flush'      — play out whatever is queued now (end of a model turn,
 *                    where the final burst may be smaller than the cushion).
 * Messages to the main thread:
 *   • 'playing' / 'idle' — posted on transitions so the controller knows
 *     EXACTLY when model audio is audible (drives the software echo guard:
 *     stricter barge-in / mic gating while Gemini is speaking).
 */
const PRIME_SAMPLES = 1920;   // ~80 ms @ 24 kHz
const STALL_BLOCKS = 30;      // failsafe: force-start after ~160 ms of waiting

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.queued = 0;      // total samples waiting in this.queue
    this.cur = null;
    this.curPos = 0;
    this.primed = false;  // burst gate: wait for the cushion before starting
    this.stall = 0;       // blocks spent waiting while audio is queued
    this.playing = false; // audible right now — transitions posted to main
    this.port.onmessage = (e) => {
      if (e.data === 'clear') {
        this.queue = [];
        this.queued = 0;
        this.cur = null;
        this.curPos = 0;
        this.primed = false;
        this.stall = 0;
        this.setPlaying(false);
        return;
      }
      if (e.data === 'flush') {
        if (this.queued > 0) this.primed = true;
        return;
      }
      const i16 = new Int16Array(e.data);
      const f = new Float32Array(i16.length);
      for (let k = 0; k < i16.length; k++) f[k] = i16[k] / 0x8000;
      this.queue.push(f);
      this.queued += f.length;
      if (this.queued >= PRIME_SAMPLES) this.primed = true;
    };
  }

  setPlaying(v) {
    if (this.playing === v) return;
    this.playing = v;
    this.port.postMessage(v ? 'playing' : 'idle');
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    // Failsafe: if audio is queued but the cushion never fills (a tail burst
    // with no 'flush'), start anyway after ~160 ms rather than sitting silent.
    if (!this.primed && this.queue.length) {
      if (++this.stall >= STALL_BLOCKS) this.primed = true;
    } else {
      this.stall = 0;
    }
    for (let n = 0; n < out.length; n++) {
      if (!this.cur || this.curPos >= this.cur.length) {
        if (this.primed && this.queue.length) {
          this.cur = this.queue.shift();
          this.queued -= this.cur.length;
          this.curPos = 0;
        } else {
          this.cur = null;
          // Queue dry mid-call: re-arm the cushion so the next burst buffers
          // ~80 ms before resuming instead of stuttering chunk-by-chunk.
          if (this.queue.length === 0) this.primed = false;
        }
      }
      out[n] = this.cur ? this.cur[this.curPos++] : 0;
    }
    this.setPlaying(this.cur !== null);
    return true;
  }
}

registerProcessor('playback-worklet', PlaybackProcessor);
