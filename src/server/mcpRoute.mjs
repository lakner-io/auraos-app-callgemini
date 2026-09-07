/**
 * MCP over HTTP for this app — same plumbing the Settings app uses for its
 * Interface Registry MCP (apps/com.aura.settings/src/mcp/serve.ts):
 *
 *   • STATELESS: `sessionIdGenerator: undefined` disables MCP sessions, so
 *     every request builds a fresh server + transport and throws both away.
 *     An Astro dev route has nowhere durable for a session table (the app
 *     restarts whenever its files change), and the tools are plain
 *     request/response, so sessions would only add "session not found" errors.
 *   • JSON RESPONSES, not SSE: each POST is answered with one JSON body —
 *     inspectable with curl, nothing to keep alive through the shell proxy.
 *
 * The transport speaks Streamable HTTP over Web-standard Request/Response,
 * which is exactly what an Astro API route receives and returns.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

/** Turn a Server factory into an Astro `ALL` handler. */
export function createMcpRoute(build) {
  return async ({ request }) => {
    const server = build();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      void server.close().catch(() => { /* already closed */ });
    }
  };
}
