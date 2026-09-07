import type { APIRoute } from 'astro';
// @ts-expect-error — plain .mjs store shared with the WS bridge (no d.ts).
import { get, remove, update, temporaryList } from '../../../server/conversations.mjs';
// @ts-expect-error — plain .mjs registry shared with the WS bridge (no d.ts).
import { findByConversation } from '../../../server/sessions.mjs';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// GET /api/conversations/<id> → full conversation (turns) or 404.
export const GET: APIRoute = async ({ params }) => {
  const conv = await get(params.id);
  return conv ? json(conv) : json({ error: 'not found' }, 404);
};

// PATCH /api/conversations/<id> { mcpDisabled?, mcpSkipped?, mcpTemporary? } →
// update the per-conversation MCP toggles (arrays of server URLs) and/or the
// temporary server list. Used by the browser when no call is live (during a
// call the same state travels over the app WS). A temporary-list change for a
// conversation whose call IS live is routed through that session so Gemini is
// re-dialed with the new tools.
export const PATCH: APIRoute = async ({ params, request }) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const isUrlList = (v: unknown) => Array.isArray(v) && v.every((u) => typeof u === 'string');
  const patch: Record<string, unknown> = {};
  for (const key of ['mcpDisabled', 'mcpSkipped'] as const) {
    if (!(key in body)) continue;
    if (!isUrlList(body[key])) return json({ error: `${key} must be an array of strings` }, 400);
    patch[key] = body[key] as string[];
  }
  if ('mcpTemporary' in body) {
    if (!Array.isArray(body.mcpTemporary)) return json({ error: 'mcpTemporary must be an array' }, 400);
    patch.mcpTemporary = temporaryList(body.mcpTemporary);
  }
  if (!Object.keys(patch).length) return json({ error: 'nothing to update' }, 400);
  const live = 'mcpTemporary' in patch ? findByConversation(params.id) : null;
  if (live) {
    const { mcpTemporary, ...rest } = patch;
    if (Object.keys(rest).length) await update(params.id, rest);
    await live.setTemporaryServers(mcpTemporary, 'ui');
    const conv = await get(params.id);
    return conv ? json(conv) : json({ error: 'not found' }, 404);
  }
  const conv = await update(params.id, patch);
  return conv ? json(conv) : json({ error: 'not found' }, 404);
};

// DELETE /api/conversations/<id> → remove it.
export const DELETE: APIRoute = async ({ params }) => {
  await remove(params.id);
  return json({ removed: true });
};
