// /mcp/control — CallGemini's general control MCP server (live-call controls
// such as silencing the speaker). Advertised by the `provides` entry `control`
// in app.manifest.json; the OS Interface Registry turns that into a live address.
// @ts-expect-error — plain .mjs modules shared with the WS bridge (no d.ts).
import { createMcpRoute } from '../../server/mcpRoute.mjs';
// @ts-expect-error — see above.
import { buildServer } from '../../server/mcpControl.mjs';

export const ALL = createMcpRoute(buildServer);
