/**
 * Plumbing shared by CallGemini's own MCP servers (`mcpServers.mjs` at
 * /mcp/servers, `mcpControl.mjs` at /mcp/control): result shapes, the
 * "which conversation?" resolution, and the low-level Server wiring.
 *
 * Built on the SDK's low-level `Server` with JSON Schema tool definitions:
 * `zod` is not resolvable from app code here (it only exists inside the SDK's
 * own dependency tree), so the `McpServer` + zod style is not an option.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as conversations from './conversations.mjs';
import { liveConversations } from './sessions.mjs';

export const CONVERSATION_ID_DESC =
  'Conversation to act on. Optional: defaults to the conversation of the one live call. ' +
  'Required when no call or several calls are live (the error then lists the live conversation ids).';

/** A refusal the caller should see verbatim (bad input, nothing live, …). */
export class ToolError extends Error {}

/** Tool result carrying the payload as text (any client) and as structured content. */
export function ok(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}
export function fail(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** The conversation to act on: explicit id, or the single live call. */
export async function resolveConversation(conversationId) {
  if (conversationId) {
    const conv = await conversations.get(String(conversationId));
    if (!conv) throw new ToolError(`No conversation with id "${conversationId}".`);
    return conv;
  }
  const live = liveConversations();
  if (live.length === 1) {
    const conv = await conversations.get(live[0]);
    if (conv) return conv;
  }
  if (live.length === 0) {
    throw new ToolError('No call is live right now. Pass conversation_id (the id of a CallGemini conversation).');
  }
  const titled = await Promise.all(live.map(async (id) => ({ id, title: (await conversations.get(id))?.title ?? '' })));
  throw new ToolError(`Several calls are live — pass conversation_id. Live: ${JSON.stringify(titled)}.`);
}

/** A Server factory for `createMcpRoute`: lists `tools`, dispatches to
 * `handlers[name](args)`; a ToolError becomes an isError result. */
export function createToolServer({ name, version = '1.0.0', instructions, tools, handlers }) {
  return () => {
    const server = new Server({ name, version }, { capabilities: { tools: {} }, instructions });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const handler = handlers[params.name];
      if (!handler) return fail(`Unknown tool: ${params.name}`);
      try {
        return await handler(params.arguments ?? {});
      } catch (err) {
        if (err instanceof ToolError) return fail(err.message);
        console.error(`[${name}] ${params.name} failed:`, err?.message ?? err);
        return fail(`${params.name} failed: ${err?.message ?? err}`);
      }
    });
    return server;
  };
}
