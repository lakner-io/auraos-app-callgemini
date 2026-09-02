import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { auraAppIntegration } from '@aura/app-sdk/integration';

const port = Number(process.env['APP_PORT'] ?? 4001);

/**
 * Vite plugin: own `server.httpServer.on('upgrade')` for the app's `/ws` path
 * and hand each browser socket to the CallGemini bridge (Gemini Live glue).
 * The shell proxies `/api/proxy/<id>/ws` here as bare `/ws` — see
 * packages/shell/astro.config.mjs → wsProxyPlugin. The bridge is imported
 * dynamically so its npm deps load in the plain Node context, not through
 * Vite's SSR transform.
 */
function geminiWsPlugin() {
  return {
    name: 'callgemini-ws',
    async configureServer(server) {
      if (!server.httpServer) return;
      const bridgeUrl = new URL('./src/server/callBridge.mjs', import.meta.url).href;
      const { attachCallBridge } = await import(/* @vite-ignore */ bridgeUrl);
      attachCallBridge(server.httpServer);
    },
  };
}

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  security: { checkOrigin: false },
  server: { port, host: true },
  devToolbar: { enabled: false },
  // Wires up identity headers, injects /api/lifecycle/health, and logs the
  // app id at server start. Apps that need to extend any of these can still
  // ship their own files — Astro's filesystem routes win on collision.
  integrations: [auraAppIntegration()],
  vite: {
    // Disable HMR: the app runs inside the shell's iframe and its dev port
    // (e.g. 4001) is not reachable from the browser. Iframe reload picks up
    // code changes; we accept that over a broken WebSocket reconnect loop.
    server: { hmr: false },
    plugins: [geminiWsPlugin()],
  },
});
