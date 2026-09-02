import type { APIRoute } from 'astro';
// @ts-expect-error — plain .mjs store shared with the WS bridge (no d.ts).
import { get, remove } from '../../../server/conversations.mjs';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// GET /api/conversations/<id> → full conversation (turns) or 404.
export const GET: APIRoute = async ({ params }) => {
  const conv = await get(params.id);
  return conv ? json(conv) : json({ error: 'not found' }, 404);
};

// DELETE /api/conversations/<id> → remove it.
export const DELETE: APIRoute = async ({ params }) => {
  await remove(params.id);
  return json({ removed: true });
};
