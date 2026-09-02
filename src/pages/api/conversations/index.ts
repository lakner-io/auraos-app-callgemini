import type { APIRoute } from 'astro';
// @ts-expect-error — plain .mjs store shared with the WS bridge (no d.ts).
import { list } from '../../../server/conversations.mjs';

// GET /api/conversations → lightweight, newest-first list of saved conversations.
export const GET: APIRoute = async () => {
  const items = await list();
  return new Response(JSON.stringify(items), {
    headers: { 'Content-Type': 'application/json' },
  });
};
