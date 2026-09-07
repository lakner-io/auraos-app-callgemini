// /mcp/servers — CallGemini's own MCP server (manage a conversation's temporary
// MCP servers). Advertised by the `provides` entry `mcp-servers` in
// app.manifest.json; the OS Interface Registry turns that into a live address.
// @ts-expect-error — plain .mjs modules shared with the WS bridge (no d.ts).
import { createMcpRoute } from '../../server/mcpRoute.mjs';
// @ts-expect-error — see above.
import { buildServer } from '../../server/mcpServers.mjs';

export const ALL = createMcpRoute(buildServer);
