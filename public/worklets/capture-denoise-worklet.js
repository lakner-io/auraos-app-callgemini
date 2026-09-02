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

class DenoiseCaptureProcessor extends CaptureProcessor {
  constructor() {
    super();
    this.ready = false;
    this.inBuf = new Float32Array(0);
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
      // Re-read the heap each frame — wasm memory growth detaches old views.
      let heap = this.m.HEAPF32;
      for (let k = 0; k < RN_FRAME; k++) heap[base + k] = this.inBuf[off + k] * RN_SCALE;
      const prob = this.m._rnnoise_process_frame(this.state, this.ptr, this.ptr);
      if (prob > this.npAcc) this.npAcc = prob;
      heap = this.m.HEAPF32;
      for (let k = 0; k < RN_FRAME; k++) out[off + k] = heap[base + k] / RN_SCALE;
    }
    this.inBuf = this.inBuf.slice(outLen);
    return out;
  }
}

registerProcessor('capture-worklet-denoise', DenoiseCaptureProcessor);
