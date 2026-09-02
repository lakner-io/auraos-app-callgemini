/**
 * Remote MCP → Gemini bridge.
 *
 * Connects to user-configured remote MCP servers (Streamable HTTP or SSE),
 * lists their tools, and exposes them to a Gemini Live session as
 * `functionDeclarations`. When Gemini emits a tool call, `dispatch()` routes it
 * to the owning MCP client and returns a plain `{ result }` / `{ error }` object
 * suitable for `session.sendToolResponse()`.
 *
 * Tools are declared NON_BLOCKING so Gemini keeps the conversation going while a
 * slow tool runs — the behaviour the ADK write-up wanted ("notify the user, then
 * answer when the result lands"), which the Live API supports natively.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

/** Gemini function names must match this; MCP names occasionally don't. */
function sanitizeName(name) {
  const cleaned = String(name).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return /^[a-zA-Z_]/.test(cleaned) ? cleaned : `t_${cleaned}`;
}

/**
 * Trim a JSON Schema to what Gemini accepts as function parameters. MCP
 * `inputSchema` is JSON Schema; Gemini rejects a few meta keys. Anything without
 * a usable object schema becomes a no-arg tool.
 */
function toParameters(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object') return undefined;
  const strip = (node) => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema' || k === 'additionalProperties' || k === '$id') continue;
      out[k] = strip(v);
    }
    return out;
  };
  const schema = strip(inputSchema);
  if (schema.type == null && schema.properties == null) return undefined;
  return schema;
}

function makeTransport(server) {
  const url = new URL(server.url);
  const transport = (server.transport ?? 'http').toLowerCase();
  if (transport === 'sse') return new SSEClientTransport(url);
  return new StreamableHTTPClientTransport(url);
}

/**
 * Connect every configured MCP server and build the Gemini tool surface.
 * Returns a handle with the aggregated `functionDeclarations`, a `dispatch`
 * for tool calls, and a `close` for teardown. One server failing to connect is
 * logged and skipped — it never aborts the call.
 *
 * @param {Array<{ url: string, transport?: 'http'|'sse', name?: string }>} servers
 */
export async function connectAll(servers = []) {
  /** @type {Array<import('@modelcontextprotocol/sdk/client/index.js').Client>} */
  const clients = [];
  /** @type {Map<string, { client: any, toolName: string }>} */
  const routes = new Map();
  const functionDeclarations = [];

  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    if (!server?.url) continue;
    const client = new Client({ name: 'callgemini', version: '0.1.0' }, { capabilities: {} });
    try {
      await client.connect(makeTransport(server));
      const { tools = [] } = await client.listTools();
      clients.push(client);
      for (const tool of tools) {
        // Keep the natural name; on collision across servers, disambiguate.
        let fnName = sanitizeName(tool.name);
        if (routes.has(fnName)) fnName = `s${i}_${fnName}`;
        routes.set(fnName, { client, toolName: tool.name });
        functionDeclarations.push({
          name: fnName,
          description: tool.description ?? tool.title ?? tool.name,
          parameters: toParameters(tool.inputSchema),
          behavior: 'NON_BLOCKING',
        });
      }
      console.log(`[callgemini/mcp] connected ${server.url} (${tools.length} tools)`);
    } catch (err) {
      console.error(`[callgemini/mcp] failed to connect ${server.url}:`, err?.message ?? err);
      try { await client.close(); } catch { /* noop */ }
    }
  }

  return {
    functionDeclarations,

    /**
     * Run one Gemini functionCall against its MCP server.
     * @param {{ name: string, args?: Record<string, unknown> }} fc
     * @returns {Promise<{ result: string } | { error: string }>}
     */
    async dispatch(fc) {
      const route = routes.get(fc.name);
      if (!route) return { error: `unknown tool: ${fc.name}` };
      try {
        const res = await route.client.callTool({
          name: route.toolName,
          arguments: fc.args ?? {},
        });
        const text = (res?.content ?? [])
          .map((c) => (c?.type === 'text' ? c.text : JSON.stringify(c)))
          .join('\n');
        if (res?.isError) return { error: text || 'tool reported an error' };
        return { result: text || 'ok' };
      } catch (err) {
        return { error: err?.message ?? String(err) };
      }
    },

    async close() {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
