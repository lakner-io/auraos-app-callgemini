/**
 * Conversation store — server-authoritative transcripts on the app's writable
 * `/data`. The WS bridge (callBridge.mjs) writes turns as a call unfolds; the
 * Astro API routes (api/conversations/*) read/list/delete. Both run in the SAME
 * app Node process, so this module is a shared singleton (same pattern as
 * sessions.mjs).
 *
 * Layout under `${AURA_DATA_DIR||'/data'}/conversations/`:
 *   <id>.json   { id, title, createdAt, updatedAt, turns:[{role,text,ts}],
 *                 mcpDisabled:[url], mcpSkipped:[url],     (per-conversation MCP toggles)
 *                 mcpTemporary:[{url,transport,name,addedAt,toolCount}]  (extra MCP servers for
 *                                                           this conversation only — added/removed
 *                                                           at runtime via the app's own MCP server)
 *                 resumeHandle, resumeHandleAt }           (Gemini Live resumption token — lets
 *                                                           "continue" restore the model's real context)
 *   index.json  [{ id, title, updatedAt, turnCount }]   (newest-first on read)
 *
 * Only text is stored — never audio.
 *
 * Concurrency: several activities each run their own CallSession in this one
 * process, and a single call flushes turns back-to-back (user turn, model turn,
 * typed turn). So EVERY mutation is serialized through one promise queue
 * (`mutate`) to avoid lost updates, and every write is atomic (temp file +
 * rename) so a concurrent reader never sees a half-written file.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.AURA_DATA_DIR || '/data';
const CONV_DIR = path.join(DATA_DIR, 'conversations');
const INDEX_FILE = path.join(CONV_DIR, 'index.json');
const UNTITLED = 'New conversation';

let dirReady = null;
function ensureDir() {
  if (!dirReady) dirReady = fs.mkdir(CONV_DIR, { recursive: true }).then(() => {});
  return dirReady;
}

/** Ids are server-minted UUIDs; guard against traversal from an API caller anyway. */
const convFile = (id) => path.join(CONV_DIR, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

/** Atomic write: full file lands via rename, so readers see old-or-new, never partial. */
async function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), 'utf-8');
  await fs.rename(tmp, file);
}

// Serialize every mutation (create/appendTurn/remove/rebuild). One process, tiny
// throughput — a single chain is plenty and removes all read-modify-write races.
// The chain lives on globalThis: this module is instantiated twice in the
// process (Node import for the WS bridge, Vite SSR import for the API routes —
// see sessions.mjs), and both must queue on the SAME chain or a route write
// can race a bridge write.
const shared = (globalThis.__callgeminiConversations ??= { opChain: Promise.resolve() });
function mutate(fn) {
  const run = shared.opChain.then(fn, fn);
  shared.opChain = run.then(() => undefined, () => undefined); // keep the chain alive past a rejection
  return run;
}

async function loadIndex() {
  const idx = await readJson(INDEX_FILE, null);
  return Array.isArray(idx) ? idx : [];
}

function upsertIndexEntry(idx, conv) {
  const entry = { id: conv.id, title: conv.title || UNTITLED, updatedAt: conv.updatedAt, turnCount: conv.turns.length };
  const i = idx.findIndex((e) => e.id === conv.id);
  if (i >= 0) idx[i] = entry; else idx.push(entry);
  return idx;
}

/** Per-conversation MCP toggles are lists of server URLs (the only identity a
 * configured server has). Anything else in the input is dropped. */
function urlList(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim()))];
}

/** Temporary MCP servers: `{ url, transport, name, addedAt, toolCount }`, one
 * per URL, http(s) only. Anything malformed is dropped. */
export function temporaryList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const e of v) {
    const url = typeof e?.url === 'string' ? e.url.trim() : '';
    if (!url || seen.has(url)) continue;
    try { if (!/^https?:$/.test(new URL(url).protocol)) continue; } catch { continue; }
    seen.add(url);
    out.push({
      url,
      transport: e.transport === 'sse' ? 'sse' : 'http',
      name: typeof e.name === 'string' && e.name.trim() ? e.name.trim().slice(0, 80) : '',
      addedAt: Number.isFinite(e.addedAt) ? e.addedAt : Date.now(),
      toolCount: Number.isFinite(e.toolCount) ? e.toolCount : null,
    });
  }
  return out;
}

/** Create a fresh, empty conversation. */
export async function create({ title, mcpDisabled, mcpSkipped } = {}) {
  await ensureDir();
  const now = Date.now();
  const conv = {
    id: randomUUID(), title: title || UNTITLED, createdAt: now, updatedAt: now, turns: [],
    mcpDisabled: urlList(mcpDisabled), mcpSkipped: urlList(mcpSkipped), mcpTemporary: [],
  };
  return mutate(async () => {
    await writeJsonAtomic(convFile(conv.id), conv);
    await writeJsonAtomic(INDEX_FILE, upsertIndexEntry(await loadIndex(), conv));
    return conv;
  });
}

/** Full conversation record, or null if absent. */
export async function get(id) {
  await ensureDir();
  return readJson(convFile(id), null);
}

/** Lightweight list, newest-first. Rebuilds from files if the index is missing. */
export async function list() {
  await ensureDir();
  let idx = await loadIndex();
  if (idx.length === 0) idx = await rebuildIndex();
  return [...idx].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

async function rebuildIndex() {
  const files = (await fs.readdir(CONV_DIR).catch(() => []))
    .filter((f) => f.endsWith('.json') && f !== 'index.json');
  const entries = [];
  for (const f of files) {
    const conv = await readJson(path.join(CONV_DIR, f), null);
    if (conv?.id) entries.push({ id: conv.id, title: conv.title || UNTITLED, updatedAt: conv.updatedAt, turnCount: conv.turns?.length ?? 0 });
  }
  await mutate(() => writeJsonAtomic(INDEX_FILE, entries));
  return entries;
}

/**
 * Append one turn `{ role, text, ts }` to a conversation and refresh the index.
 * Titles itself from the first user turn if still untitled. Returns the updated
 * conversation (or null if the id is unknown).
 */
export async function appendTurn(id, turn) {
  await ensureDir();
  return mutate(async () => {
    const conv = await readJson(convFile(id), null);
    if (!conv) return null;
    const ts = turn.ts ?? Date.now();
    conv.turns.push({ role: turn.role, text: turn.text, ts });
    conv.updatedAt = ts;
    if ((!conv.title || conv.title === UNTITLED) && turn.role === 'user') {
      conv.title = turn.text.trim().slice(0, 40) || UNTITLED;
    }
    await writeJsonAtomic(convFile(id), conv);
    await writeJsonAtomic(INDEX_FILE, upsertIndexEntry(await loadIndex(), conv));
    return conv;
  });
}

/**
 * Update per-conversation settings: the MCP toggles (`mcpDisabled` /
 * `mcpSkipped`, arrays of server URLs), the temporary MCP servers
 * (`mcpTemporary`) and the Gemini Live resumption handle
 * (`resumeHandle`, string or null, stamped with `resumeHandleAt`). Only those
 * keys are accepted. Deliberately does NOT bump `updatedAt` — none of these
 * should reorder the conversation list. Returns the updated conversation, or
 * null if the id is unknown.
 */
export async function update(id, patch = {}) {
  await ensureDir();
  return mutate(async () => {
    const conv = await readJson(convFile(id), null);
    if (!conv) return null;
    if ('mcpDisabled' in patch) conv.mcpDisabled = urlList(patch.mcpDisabled);
    if ('mcpSkipped' in patch) conv.mcpSkipped = urlList(patch.mcpSkipped);
    if ('mcpTemporary' in patch) conv.mcpTemporary = temporaryList(patch.mcpTemporary);
    if ('resumeHandle' in patch) {
      const h = patch.resumeHandle;
      conv.resumeHandle = typeof h === 'string' && h ? h : null;
      conv.resumeHandleAt = conv.resumeHandle ? Date.now() : null;
    }
    await writeJsonAtomic(convFile(id), conv);
    return conv;
  });
}

/** Delete a conversation and drop it from the index. */
export async function remove(id) {
  await ensureDir();
  return mutate(async () => {
    await fs.rm(convFile(id), { force: true });
    await writeJsonAtomic(INDEX_FILE, (await loadIndex()).filter((e) => e.id !== id));
    return true;
  });
}
