/**
 * Capture worklet variant with an RNNoise AI-denoise stage (the "Noise
 * reduction: AI" setting loads THIS module instead of capture-worklet.js).
 *
 * Pipeline position matters: RNNoise operates on 480-sample (10 ms) frames at
 * 48 kHz with samples scaled to Int16 range, so it runs in `preprocess()` at
 * the CONTEXT rate — before the base class resamples to 16 kHz for Gemini.
 * `rnnoise_process_frame` also returns a speech probability per frame; the max
 * since the last posted 20 ms frame rides along as `np` and upgrades the
 * main-thread VAD tiers (that's what stops keyboard clicks from reading as
 * speech).
 *
 * Around the RNNoise core, two DSP stages target what RNNoise alone handles
 * poorly:
 *
 * — WIND: buffeting is low-frequency-dominated turbulence RNNoise wasn't
 *   trained on. A per-frame detector (strong energy whose spectrum is almost
 *   entirely below ~300 Hz while RNNoise says "not speech") accumulates a
 *   windness score that slides an in-worklet highpass from 100 Hz up to
 *   300 Hz. Speech intelligibility lives above 300 Hz, so under wind this
 *   trades a little voice body for a lot of rumble. No wind → the filter
 *   rests at 100 Hz (stacking with the 100 Hz native biquad ≈ 24 dB/oct).
 *
 * — RESIDUAL NOISE: RNNoise attenuates but never fully mutes steady noise.
 *   An expander driven by RNNoise's own speech probability closes the gap:
 *   full gain during speech (with a 300 ms hangover so unvoiced consonants
 *   and pauses inside a word are never chopped), −6 dB in the uncertain
 *   band, −18 dB floor on confident non-speech. Fast attack (~10 ms) so
 *   onsets survive; slow release so the tail never pumps; per-sample gain
 *   ramp so there are no zipper clicks.
 *
 * The glue is @jitsi/rnnoise-wasm's SINGLE_FILE synchronous build (wasm
 * embedded — worklets can't fetch, and Chrome worklets only support static
 * imports). Non-SIMD on purpose: it must run on Android WebViews where the
 * SIMD-only ort build already failed. If init fails we post {denoiseError}
 * once and stay a passthrough — a broken denoiser must never break the call.
 */
import { CaptureProcessor } from './capture-worklet.js';
import createRNNWasmModuleSync from './rnnoise-sync.js';

const RN_FRAME = 480;   // 10 ms @ 48 kHz — fixed by the model
const RN_SCALE = 32768; // RNNoise expects float samples in Int16 range

// Wind detector: a frame is "windish" when it has real energy but its
// spectrum is LF-dominated (first-difference energy ratio ~ (2·sin(πf/fs))²
// — ≈2e-4 for a 100 Hz rumble, ~1 for broadband noise like typing) AND
// RNNoise's previous frame said non-speech. Voiced speech is ALSO LF-heavy
// by this metric (≈2e-3 for a deep vowel), so the prob gate — not the
// ratio — is what keeps speech out; the ratio's job is only to exclude
// broadband noise from counting as wind.
const WIND_HF_RATIO = 0.02;
const WIND_MIN_RMS = 0.005;
const WIND_RISE = 0.06;     // ~0.8 s of sustained buffeting to full score
const WIND_DECAY = 0.985;   // ~2–3 s to relax after the gust ends
const HP_BASE_HZ = 100;
const HP_WIND_HZ = 200;     // added on top at windness=1 → 300 Hz max

// Expander (per 10 ms frame).
const EXP_HOLD_FRAMES = 30; // 300 ms hangover after confident speech
const EXP_FLOOR = 0.12;     // −18 dB on confident non-speech
const EXP_MID = 0.5;        // −6 dB in the uncertain band
const EXP_ATTACK = 0.6;     // per-frame move toward a HIGHER target (~10–20 ms)
const EXP_RELEASE = 0.05;   // per-frame move toward a LOWER target (~200 ms+)

class DenoiseCaptureProcessor extends CaptureProcessor {
  constructor() {
    super();
    this.ready = false;
    this.inBuf = new Float32Array(0);
    // Adaptive highpass (RBJ biquad, DF2T) state + current cutoff.
    this.hpB0 = 0; this.hpB1 = 0; this.hpB2 = 0; this.hpA1 = 0; this.hpA2 = 0;
    this.hpS1 = 0; this.hpS2 = 0;
    this.hpFc = 0;
    this.setHighpass(HP_BASE_HZ);
    this.windness = 0;
    this.lastProb = 0;
    // Expander state.
    this.gain = 1;
    this.hold = 0;
    this.initRnnoise();
  }

  async initRnnoise() {
    try {
      // MODULARIZE factory — depending on emscripten vintage the factory
      // returns the module or a promise, and `ready` resolves with the module.
      let m = await createRNNWasmModuleSync();
      if (m && m.ready) m = await m.ready;
      this.m = m;
      this.state = m._rnnoise_create(0);
      this.ptr = m._malloc(RN_FRAME * 4);
      this.ready = true;
      this.denoiseActive = true;
      this.npAcc = 0;
      this.port.postMessage({ denoiseReady: true });
    } catch (err) {
      this.port.postMessage({ denoiseError: String(err && err.message ? err.message : err) });
    }
  }

  setHighpass(fc) {
    if (Math.abs(fc - this.hpFc) < 10) return; // avoid churning coefficients
    this.hpFc = fc;
    const w = (2 * Math.PI * fc) / sampleRate;
    const cosw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * 0.707);
    const a0 = 1 + alpha;
    this.hpB0 = (1 + cosw) / 2 / a0;
    this.hpB1 = -(1 + cosw) / a0;
    this.hpB2 = (1 + cosw) / 2 / a0;
    this.hpA1 = (-2 * cosw) / a0;
    this.hpA2 = (1 - alpha) / a0;
  }

  /** One RN_FRAME slice: wind tracking → adaptive HP (in place, pre-RNNoise
   * so the model sees the cleaned band too). Returns nothing; mutates buf. */
  windAndFilter(buf, off) {
    let e = 0, d = 0;
    for (let k = 1; k < RN_FRAME; k++) {
      const s = buf[off + k];
      e += s * s;
      const dd = s - buf[off + k - 1];
      d += dd * dd;
    }
    const rms = Math.sqrt(e / RN_FRAME);
    const hfRatio = d / (e + 1e-9);
    const windish = rms > WIND_MIN_RMS && hfRatio < WIND_HF_RATIO && this.lastProb < 0.5;
    this.windness = windish
      ? Math.min(1, this.windness + WIND_RISE)
      : this.windness * WIND_DECAY;
    this.setHighpass(HP_BASE_HZ + HP_WIND_HZ * this.windness);
    let s1 = this.hpS1, s2 = this.hpS2;
    for (let k = 0; k < RN_FRAME; k++) {
      const x = buf[off + k];
      const y = this.hpB0 * x + s1;
      s1 = this.hpB1 * x - this.hpA1 * y + s2;
      s2 = this.hpB2 * x - this.hpA2 * y;
      buf[off + k] = y;
    }
    this.hpS1 = s1; this.hpS2 = s2;
  }

  /** Post-RNNoise expander for one frame: prob → target gain, smoothed
   * per-frame, ramped per-sample. */
  expand(out, off, prob) {
    if (prob >= 0.5) this.hold = EXP_HOLD_FRAMES;
    else if (this.hold > 0) this.hold--;
    let target;
    if (prob >= 0.5 || this.hold > 0) target = 1;
    else target = prob >= 0.25 ? EXP_MID : EXP_FLOOR;
    // Wind cap: while buffeting is active, non-speech gain stays clamped even
    // if the prob flickers — RNNoise misreads gusts as speech-ish.
    if (this.windness > 0.5 && prob < 0.85 && this.hold === 0) {
      target = Math.min(target, 0.25);
    }
    const coef = target > this.gain ? EXP_ATTACK : EXP_RELEASE;
    const next = this.gain + (target - this.gain) * coef;
    const step = (next - this.gain) / RN_FRAME;
    let g = this.gain;
    for (let k = 0; k < RN_FRAME; k++) {
      g += step;
      out[off + k] *= g;
    }
    this.gain = next;
  }

  preprocess(block) {
    if (!this.ready) return block; // passthrough until the model is up (or failed)

    const merged = new Float32Array(this.inBuf.length + block.length);
    merged.set(this.inBuf, 0);
    merged.set(block, this.inBuf.length);
    this.inBuf = merged;

    const outLen = Math.floor(this.inBuf.length / RN_FRAME) * RN_FRAME;
    if (outLen === 0) return new Float32Array(0);

    const out = new Float32Array(outLen);
    const base = this.ptr >> 2;
    for (let off = 0; off < outLen; off += RN_FRAME) {
      this.windAndFilter(this.inBuf, off);
      // Re-read the heap each frame — wasm memory growth detaches old views.
      let heap = this.m.HEAPF32;
      for (let k = 0; k < RN_FRAME; k++) heap[base + k] = this.inBuf[off + k] * RN_SCALE;
      const prob = this.m._rnnoise_process_frame(this.state, this.ptr, this.ptr);
      this.lastProb = prob;
      if (prob > this.npAcc) this.npAcc = prob;
      heap = this.m.HEAPF32;
      for (let k = 0; k < RN_FRAME; k++) out[off + k] = heap[base + k] / RN_SCALE;
      this.expand(out, off, prob);
    }
    this.inBuf = this.inBuf.slice(outLen);
    return out;
  }
}

registerProcessor('capture-worklet-denoise', DenoiseCaptureProcessor);
