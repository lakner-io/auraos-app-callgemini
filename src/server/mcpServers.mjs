/**
 * `callgemini-mcp-servers` — CallGemini's special-purpose MCP server for its MCP servers.
 *
 * Lets another agent or app manage a conversation's TEMPORARY MCP servers:
 * list them, add one, remove one. Temporary servers are extra, per
 * conversation, on top of the ones configured in Settings (which this server
 * only reports — they are changed in the Settings dialog). Adding or removing
 * one while that conversation's call is live re-dials the Gemini leg with the
 * new tool list (the model's context is carried over via the Live API
 * resumption handle), the same path the drawer's ON/OFF toggle uses.
 *
 * Advertised by the `provides` entry `mcp-servers` in app.manifest.json
 * (kind mcp, address /mcp/servers) — the OS Interface Registry materialises it
 * as a live address whenever this app is up.
 *
 * Call controls (speaker silence, …) live in the general control server,
 * `mcpControl.mjs` at /mcp/control. Shared plumbing: `mcpCommon.mjs`.
 */
import * as conversations from './conversations.mjs';
import { findByConversation } from './sessions.mjs';
import { CONVERSATION_ID_DESC, ToolError, ok, createToolServer, resolveConversation } from './mcpCommon.mjs';
import { probeServer } from './mcp.mjs';
import { getLastConfiguredServers } from './callBridge.mjs';

const TOOLS = [
  {
    name: 'list_mcp_servers',
    title: 'List MCP servers',
    description:
      "A conversation's MCP servers: the ones configured in CallGemini's Settings (read-only here) and " +
      'the temporary ones added at runtime for this conversation. Also tells whether that conversation ' +
      'has a live call.',
    inputSchema: {
      type: 'object',
      properties: { conversation_id: { type: 'string', description: CONVERSATION_ID_DESC } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: 'add_mcp_server',
    title: 'Add a temporary MCP server',
    description:
      'Add a remote MCP server (Streamable HTTP or SSE) to a conversation for as long as it is not ' +
      'removed. The server is probed first — an unreachable URL is refused with the reason. If the ' +
      "conversation's call is live, Gemini is re-dialed with the new tools right away (context kept).",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'MCP endpoint URL (http or https).' },
        transport: { type: 'string', enum: ['http', 'sse'], description: 'Transport; default http (Streamable HTTP).' },
        behavior: {
          type: 'string', enum: ['non-blocking', 'blocking'],
          description: "Tool-call behavior. 'non-blocking' (default): a slow tool immediately answers " +
            "\"working on it\" so the conversation continues, and the real result is announced later. " +
            "'blocking': Gemini waits for the full result of every call.",
        },
        name: { type: 'string', description: 'Display name shown in CallGemini (optional).' },
        conversation_id: { type: 'string', description: CONVERSATION_ID_DESC },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'remove_mcp_server',
    title: 'Remove a temporary MCP server',
    description:
      'Remove a temporary MCP server from a conversation. Servers configured in Settings cannot be ' +
      "removed here. If the conversation's call is live, Gemini is re-dialed without those tools.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the temporary server to remove.' },
        conversation_id: { type: 'string', description: CONVERSATION_ID_DESC },
      },
      required: ['url'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
];

function normalizeUrl(raw) {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) throw new ToolError('url is required.');
  let parsed;
  try { parsed = new URL(url); } catch { throw new ToolError(`"${url}" is not a valid URL.`); }
  if (!/^https?:$/.test(parsed.protocol)) throw new ToolError('url must use http or https.');
  return url;
}

/** Write the new temporary list: through the live session when there is one
 * (persists + re-dials), else straight to the record. */
async function commit(conv, temporary) {
  const session = findByConversation(conv.id);
  if (session) {
    const { redialed } = await session.setTemporaryServers(temporary, 'temporary server change');
    return { redialed };
  }
  await conversations.update(conv.id, { mcpTemporary: temporary });
  return { redialed: false };
}

function view(conv) {
  return { id: conv.id, title: conv.title, live: !!findByConversation(conv.id) };
}

const handlers = {
  async list_mcp_servers(args) {
    const conv = await resolveConversation(args.conversation_id);
    return ok({
      conversation: view(conv),
      configured: getLastConfiguredServers(),
      temporary: conversations.temporaryList(conv.mcpTemporary),
    });
  },

  async add_mcp_server(args) {
    const url = normalizeUrl(args.url);
    const transport = args.transport === 'sse' ? 'sse' : 'http';
    const conv = await resolveConversation(args.conversation_id);
    if (getLastConfiguredServers().some((s) => s.url === url)) {
      throw new ToolError(`${url} is already configured in CallGemini's Settings for every conversation.`);
    }
    const current = conversations.temporaryList(conv.mcpTemporary);
    if (current.some((s) => s.url === url)) {
      throw new ToolError(`${url} is already a temporary server of this conversation.`);
    }
    let tools;
    try {
      ({ tools } = await probeServer({ url, transport }));
    } catch (err) {
      throw new ToolError(`Could not connect to ${url} (${transport}): ${err?.message ?? err}. Nothing was added.`);
    }
    const behavior = args.behavior === 'blocking' ? 'blocking' : 'non-blocking';
    const entry = { url, transport, behavior, name: typeof args.name === 'string' ? args.name : '', addedAt: Date.now(), toolCount: tools.length };
    const { redialed } = await commit(conv, [...current, entry]);
    return ok({ added: entry, tools, redialed, conversation: view(conv) });
  },

  async remove_mcp_server(args) {
    const url = normalizeUrl(args.url);
    const conv = await resolveConversation(args.conversation_id);
    if (getLastConfiguredServers().some((s) => s.url === url)) {
      throw new ToolError(`${url} is configured in CallGemini's Settings; remove it there, or turn it OFF for this conversation in the app.`);
    }
    const current = conversations.temporaryList(conv.mcpTemporary);
    const next = current.filter((s) => s.url !== url);
    if (next.length === current.length) return ok({ removed: false, redialed: false, conversation: view(conv) });
    const { redialed } = await commit(conv, next);
    return ok({ removed: true, redialed, conversation: view(conv) });
  },
};

export const buildServer = createToolServer({
  name: 'callgemini-mcp-servers',
  instructions:
    "Manage the MCP servers CallGemini hands to Gemini. Servers configured in Settings apply to every " +
    'conversation and are read-only here; temporary servers belong to one conversation and stay until ' +
    'removed. Tools default to the conversation of the single live call; pass conversation_id otherwise.',
  tools: TOOLS,
  handlers,
});
