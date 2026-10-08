// /mcp/debug — CallGemini's debug MCP server: metrics, logs and per-turn traces
// of the live voice pipeline (see src/server/mcpDebug.mjs). Advertised by the
// `provides` entry `debug` in app.manifest.json. Not given to Gemini itself.
// @ts-expect-error — plain .mjs modules shared with the WS bridge (no d.ts).
import { createMcpRoute } from '../../server/mcpRoute.mjs';
// @ts-expect-error — see above.
import { buildServer } from '../../server/mcpDebug.mjs';

export const ALL = createMcpRoute(buildServer);
