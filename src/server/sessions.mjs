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

/**
 * One Set for the whole process — anchored on globalThis ON PURPOSE. The WS
 * bridge is loaded with a plain Node `import()` (astro.config.mjs) while the
 * Astro API routes load this file through Vite's SSR module loader, so a bare
 * module-scope Set would exist twice and the routes would never see the
 * bridge's sessions.
 * @type {Set<{ close: (reason?: string) => void }>}
 */
const active = (globalThis.__callgeminiSessions ??= new Set());

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

/** The live session recording a conversation, or null. (A conversation is
 * recorded by at most one session at a time.) */
export function findByConversation(convId) {
  for (const s of active) if (s.convId && s.convId === convId && s.session) return s;
  return null;
}

/** Conversations with a live Gemini call right now — for "which one?" hints. */
export function liveConversations() {
  return [...active].filter((s) => s.convId && s.session).map((s) => s.convId);
}

/** How many calls are live right now (diagnostics). */
export function activeCount() {
  return active.size;
}
