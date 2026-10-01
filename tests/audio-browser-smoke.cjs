// Run in an environment with puppeteer-core and Chromium. Exercises the real
// app controller/worklets with a synthetic microphone and a fake Gemini WS.
// No credentials, recorded audio, or real call/conversation writes are used.
const puppeteer = require('puppeteer-core');
const assert = require('node:assert/strict');

(async () => {
  const origin = process.env.AUDIO_TEST_ORIGIN || 'http://aura-io.lakner.callgemini:4004';
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--no-proxy-server', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--unsafely-treat-insecure-origin-as-secure=${origin}`] });
  try {
    for (const profile of ['desktop', 'apple-route', 'android-route', 'ai-48k', 'frozen']) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const url = new URL(req.url());
        if (url.pathname.includes('/api/kv/')) {
          return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ value: {
            apiKey: 'synthetic-test', vadMode: 'server', noiseReduction: profile === 'desktop' ? 'browser' : 'ai', mcpServers: [],
          } }) });
        }
        if (url.pathname.includes('/api/conversations')) return req.respond({ status: 200, contentType: 'application/json', body: '[]' });
        return req.continue();
      });
      await page.evaluateOnNewDocument((profile) => {
        if (profile === 'apple-route') {
          Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' });
          Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5 });
        }
        if (profile === 'android-route') Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Linux; Android 14; wv) Chrome/130.0' });
        const NativeContext = window.AudioContext;
        window.__audioTest = { contexts: [], streams: [], sentFrames: 0, started: 0 };
        window.AudioContext = class extends NativeContext {
          constructor(options) { super(profile === 'ai-48k' ? { ...options, sampleRate: 48000 } : options); window.__audioTest.contexts.push(this); }
        };
        if (profile === 'frozen') {
          // Reproduce the observed boundary: running context, but no capture
          // frames delivered. Chromium may auto-start despite a fake resume.
          const NativeWorklet = window.AudioWorkletNode;
          window.AudioWorkletNode = class extends NativeWorklet {
            constructor(context, name, ...args) {
              super(context, name, ...args);
              if (name.startsWith('capture-')) Object.defineProperty(this.port, 'onmessage', { set() {} });
            }
          };
        }
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (...args) => {
          const stream = await getUserMedia(...args);
          window.__audioTest.streams.push(stream);
          return stream;
        };
        const NativeWS = window.WebSocket;
        window.WebSocket = class FakeWS extends EventTarget {
          static OPEN = 1;
          constructor(url, ...args) {
            super();
            if (!url.endsWith('/ws')) return new NativeWS(url, ...args);
            this.readyState = 0;
            setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 0);
          }
          send(data) {
            if (typeof data !== 'string') { window.__audioTest.sentFrames++; return; }
            if (JSON.parse(data).type === 'start') {
              window.__audioTest.started++;
              this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'status', state: 'live' }) }));
            }
          }
          close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
        };
      }, profile);
      await page.goto(origin, { waitUntil: 'networkidle0' });
      await page.click('[data-action="toggle-call"]');
      if (profile === 'frozen') {
        await page.waitForFunction(() => document.body.textContent.includes('browser produced no audio'), { timeout: 12000 });
        assert.equal(await page.evaluate(() => window.__audioTest.started), 0);
        await page.waitForFunction(() => window.__audioTest.contexts.every((c) => c.state === 'closed'));
        console.log(JSON.stringify({ profile, noFalseCallStart: true, cleanup: 'passed' }));
        await ctx.close();
        continue;
      }
      await page.waitForFunction(() => window.__audioTest.sentFrames > 20, { timeout: 12000 });
      const running = await page.evaluate(() => ({ contexts: window.__audioTest.contexts.length,
        state: window.__audioTest.contexts[0].state, time: window.__audioTest.contexts[0].currentTime,
        sampleRate: window.__audioTest.contexts[0].sampleRate, frames: window.__audioTest.sentFrames,
        started: window.__audioTest.started }));
      assert.equal(running.contexts, 1);
      assert.equal(running.state, 'running');
      assert.ok(running.time > 0);
      assert.equal(running.started, 1);
      if (profile === 'apple-route') assert.equal(running.sampleRate, 24000);
      if (profile === 'ai-48k') assert.equal(running.sampleRate, 48000);
      await page.click('[data-action="toggle-call"]');
      await page.waitForFunction(() => window.__audioTest.contexts.every((c) => c.state === 'closed'));
      assert.equal(await page.evaluate(() => window.__audioTest.streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))), true);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ profile, ...running, cleanup: 'passed' }));
      await ctx.close();
    }
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
