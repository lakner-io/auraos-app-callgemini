# Audio regression checks

Run `node --test tests/audio-startup.test.mjs tests/audio-worklets.test.mjs`.
These cover activation in the Call gesture, permission/cancellation cleanup,
resume timeouts, PCM capture rates, and playback speed/pitch across device rates.

`audio-browser-smoke.cjs` runs the real app controller in isolated Chromium
using puppeteer-core, a synthetic microphone, and a fake Gemini WebSocket.
Set `AUDIO_TEST_ORIGIN` to the running app URL. It never starts a real Gemini
call. Profiles exercise desktop/Apple/Android routing, 48 kHz AI denoising,
and detection/cleanup when microphone frames never arrive. Apple/Android
routing in Chromium is not an actual Safari/Android engine test.

On the affected iPad, 48 kHz capture reported `running` but its audio clock
stayed at zero and produced no frames. Sharing a native-rate 48 kHz context
did not fix it. The confirmed working combination is one shared 24 kHz
context with the existing media-element playback route: 208 captured frames
in five seconds, advancing clock, nonzero speech levels, and user-confirmed
conversation. iOS uses browser noise reduction because RNNoise expects
48 kHz; other devices retain their native rate and RNNoise where compatible.
