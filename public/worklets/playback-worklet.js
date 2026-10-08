/**
 * Speaker playback worklet: plays Gemini's 24 kHz Int16 PCM output. The host
 * AudioContext uses the device rate and is shared with microphone capture.
 * A fractional source cursor resamples 24 kHz PCM across network chunks.
 *
 * ADAPTIVE jitter cushion: each burst of speech only STARTS playing once the
 * cushion is queued (or the stream pauses), absorbing uneven WebSocket packet
 * arrival that would otherwise cause audible gaps/crackle mid-sentence. Once a
 * burst is playing we drain continuously; when the queue runs dry the cushion
 * re-arms for the next burst. The cushion starts at ~80 ms (fast first word)
 * and GROWS +60 ms after every mid-burst underrun — a dry-out while audibly
 * mid-sentence, the thing the listener hears as a cut — up to ~300 ms, so a
 * call on a jittery network trades a little latency for stability while a
 * clean call stays snappy. A drain right after 'flush' (end of turn) is
 * normal and never counts as an underrun.
 *
 * Declick: dry-outs used to jump from a live sample straight to 0 and resume
 * with another hard edge — two clicks framing every hole. Now a dry-out decays
 * the last rendered sample exponentially (~2 ms tail, no lookahead needed) and
 * every resume ramps in from the remaining tail over ~5 ms.
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
 *   • { t:'level', v } — RMS of the samples actually rendered, every 8 blocks
 *     (~43 ms) while playing (one final 0 on idle). Drives the call button's
 *     audio-reactive glow; throttled so it stays cheap.
 *   • { t:'underrun', cushionMs } — a mid-burst dry-out happened and the
 *     cushion grew; lets the page surface jitter without devtools.
 */
const PRIME_START = 1920;     // ~80 ms @ 24 kHz — first-word latency floor
const PRIME_STEP = 1440;      // +60 ms per mid-burst underrun
const PRIME_MAX = 7200;       // ~300 ms cap
const STALL_BLOCKS = Math.ceil(sampleRate * 0.16 / 128);
const FADE_IN = Math.round(128 * sampleRate / 24000);
const TAIL_DECAY = Math.pow(0.9, 24000 / sampleRate);

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.queued = 0;      // total samples waiting in this.queue
    this.cur = null;
    this.curPos = 0;
    this.sourceStep = 24000 / sampleRate;
    this.prime = PRIME_START; // adaptive cushion size, grows on underruns
    this.primed = false;  // burst gate: wait for the cushion before starting
    this.flushed = false; // last drain was an intentional end-of-turn flush
    this.stall = 0;       // blocks without new input while audio is queued
    this.playing = false; // audible right now — transitions posted to main
    this.last = 0;        // last rendered sample — decayed through dry-outs
    this.fadeFrom = 0;    // continuity anchor when resuming a short gap
    this.ramp = 0;        // samples since resume, for the fade-in
    this.lvlSum = 0;      // level accumulator (sum of squares / sample count)
    this.lvlN = 0;
    this.lvlBlocks = 0;
    // Debug counters — read only on a { t:'stats?' } request (debug MCP).
    this.underruns = 0;   // mid-burst dry-outs, including those at the cap
    this.dryBlocks = 0;   // blocks rendered with nothing to play mid-burst
    this.bursts = 0;      // bursts started (cushion filled → playing)
    this.port.onmessage = (e) => {
      if (e.data && e.data.t === 'stats?') {
        this.port.postMessage({
          t: 'stats', queuedMs: Math.round(this.queued / 24), cushionMs: Math.round(this.prime / 24),
          primed: this.primed, playing: this.playing, underruns: this.underruns,
          dryMs: Math.round(this.dryBlocks * 128 * 1000 / sampleRate), bursts: this.bursts,
        });
        return;
      }
      if (e.data === 'clear') {
        this.queue = [];
        this.queued = 0;
        this.cur = null;
        this.curPos = 0;
        this.primed = false;
        this.flushed = true; // intentional drain — never an underrun
        this.stall = 0;
        this.ramp = 0;
        this.setPlaying(false);
        return;
      }
      if (e.data === 'flush') {
        this.flushed = true;
        if (this.queued > 0) this.primed = true;
        return;
      }
      const i16 = new Int16Array(e.data);
      const f = new Float32Array(i16.length);
      for (let k = 0; k < i16.length; k++) f[k] = i16[k] / 0x8000;
      this.queue.push(f);
      this.queued += f.length;
      this.flushed = false;
      // The short-tail failsafe measures delivery silence, not total buffering
      // time. Otherwise it bypasses an adaptive 200–300 ms cushion at 160 ms
      // even while chunks keep arriving, causing repeated premature restarts.
      this.stall = 0;
      if (this.queued >= this.prime) this.primed = true;
    };
  }

  setPlaying(v) {
    if (this.playing === v) return;
    this.playing = v;
    this.port.postMessage(v ? 'playing' : 'idle');
    if (!v) { this.port.postMessage({ t: 'level', v: 0 }); this.lvlSum = 0; this.lvlN = 0; this.lvlBlocks = 0; }
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    // Failsafe for a short tail with no 'flush': start after ~160 ms without
    // new input. Active delivery continues to build the full adaptive cushion.
    if (!this.primed && this.queue.length) {
      if (++this.stall >= STALL_BLOCKS) this.primed = true;
    } else {
      this.stall = 0;
    }
    for (let n = 0; n < out.length; n++) {
      while (!this.cur || this.curPos >= this.cur.length) {
        if (this.primed && this.queue.length) {
          const carry = this.cur ? this.curPos - this.cur.length : 0;
          this.cur = this.queue.shift();
          this.queued -= this.cur.length;
          this.curPos = carry;
        } else {
          if (this.cur) {
            // Just ran out. Mid-burst (no flush/clear) = a real underrun the
            // listener would hear as a cut — grow the cushion for this call.
            if (!this.flushed) this.underruns++;
            if (!this.flushed && this.prime < PRIME_MAX) {
              this.prime = Math.min(PRIME_MAX, this.prime + PRIME_STEP);
              this.port.postMessage({ t: 'underrun', cushionMs: Math.round(this.prime / 24) });
            }
          }
          this.cur = null;
          // Queue dry: re-arm the cushion so the next burst buffers before
          // resuming instead of stuttering chunk-by-chunk.
          if (this.queue.length === 0) this.primed = false;
          this.curPos = 0;
          break;
        }
      }
      let s;
      if (this.cur) {
        const index = Math.floor(this.curPos);
        const fraction = this.curPos - index;
        const a = this.cur[index];
        const b = index + 1 < this.cur.length ? this.cur[index + 1]
          : (this.queue[0]?.[0] ?? a);
        s = a + (b - a) * fraction;
        this.curPos += this.sourceStep;
        // Resume from the actual decaying tail, not from an artificial zero.
        // A brief underrun can leave a large tail; dropping it to zero at
        // the next chunk's first sample creates the very click we avoid.
        if (this.ramp === 0) this.fadeFrom = this.last;
        if (this.ramp < FADE_IN) {
          const mix = this.ramp / FADE_IN;
          s = this.fadeFrom * (1 - mix) + s * mix;
          this.ramp++;
        }
        this.last = s;
      } else {
        // Dry declick: decay the last sample toward 0 instead of jumping.
        this.last *= TAIL_DECAY;
        if (Math.abs(this.last) < 1e-4) this.last = 0;
        s = this.last;
        this.ramp = 0;
      }
      out[n] = s;
      this.lvlSum = (this.lvlSum ?? 0) + s * s;
    }
    this.lvlN = (this.lvlN ?? 0) + out.length;
    if (this.cur === null && this.queue.length && !this.flushed) this.dryBlocks++;
    if (this.cur !== null && !this.playing) this.bursts++;
    this.setPlaying(this.cur !== null);
    // Throttled level report (~43 ms) while audible — drives the button glow.
    if (this.playing && ++this.lvlBlocks >= Math.ceil(sampleRate * 0.043 / 128)) {
      this.port.postMessage({ t: 'level', v: Math.sqrt(this.lvlSum / this.lvlN) });
      this.lvlSum = 0; this.lvlN = 0; this.lvlBlocks = 0;
    }
    return true;
  }
}

registerProcessor('playback-worklet', PlaybackProcessor);
