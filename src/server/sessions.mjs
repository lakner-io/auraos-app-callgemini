/**
 * Process-wide registry of live CallSessions.
 *
 * The WS bridge (loaded by the Vite plugin in astro.config.mjs) and the
 * lifecycle HTTP routes (Astro API routes) both run inside the SAME app Node
 * process, so a plain module-scope Set is shared between them. Lifecycle
 * `onStop` / `onDestroy` import this to force-close any live calls; each WS
 * close already tears its own session down, so this is belt-and-suspenders for
 * an OS-initiated stop where the browser socket didn't close first.
 */

/** @type {Set<{ close: (reason?: string) => void }>} */
const active = new Set();

/** Register a session so lifecycle teardown can reach it. */
export function register(session) {
  active.add(session);
}

/** Deregister a session once it has closed. */
export function unregister(session) {
  active.delete(session);
}

/** Force-close every live session (called from onStop / onDestroy). */
export function closeAllSessions(reason = 'os-teardown') {
  for (const s of [...active]) {
    try {
      s.close(reason);
    } catch {
      /* already gone */
    }
  }
  active.clear();
}

/** How many calls are live right now (diagnostics). */
export function activeCount() {
  return active.size;
}
