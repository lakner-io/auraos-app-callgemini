/** One native-rate audio engine per call. Construct synchronously from the
 * user's tap: iOS must see resume() before permission/network awaits. */
export function createCallAudio({
  micDeviceId = '',
  sampleRate,
  Context = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  mediaDevices = globalThis.navigator?.mediaDevices,
} = {}) {
  if (!Context || !mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot capture audio. Open the app over HTTPS in a browser with microphone support.');
  }
  const context = new Context({ latencyHint: 'interactive', ...(sampleRate ? { sampleRate } : {}) });
  let closed = false;
  let stream = null;
  const abortError = () => Object.assign(new Error('Call ended during audio startup.'), { name: 'AbortError' });
  let cancel;
  const cancelled = new Promise((_, reject) => { cancel = reject; });
  cancelled.catch(() => {});
  const assertActive = () => { if (closed) throw abortError(); };
  function close() {
    if (closed) return;
    closed = true;
    cancel(abortError());
    stream?.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => {});
  }
  let initialResume;
  let microphone;
  try {
    initialResume = context.resume();
    initialResume.catch(() => {});
    microphone = mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      ...(micDeviceId ? { deviceId: { ideal: micDeviceId } } : {}),
    } }).then((result) => {
      if (closed) {
        result.getTracks().forEach((track) => track.stop());
        throw abortError();
      }
      stream = result;
      return result;
    });
    microphone.catch(() => {});
  } catch (error) {
    close();
    throw error;
  }
  return {
    context,
    assertActive,
    close,
    waitFor(promise) {
      assertActive();
      return Promise.race([promise, cancelled]);
    },
    async microphone() {
      assertActive();
      return Promise.race([microphone, cancelled]);
    },
    async resume(timeoutMs = 8000) {
      assertActive();
      if (context.state === 'running') return;
      let timer;
      try {
        // Reissue in a fresh user gesture if iOS interrupted the call.
        const resumed = context.resume();
        await Promise.race([resumed, cancelled, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Audio is paused by the browser. Tap Call again to activate it.')), timeoutMs);
        })]);
        assertActive();
        if (context.state !== 'running') throw new Error('The browser could not start its audio engine.');
      } finally { clearTimeout(timer); }
    },
  };
}
