import { MCP_SURFACE } from "../../../protocol/modules/mcp.js"
import type { TuiModule } from "../../tui-module.js"

export const mcpTui = {
  id: "mcp",
  surfaces: [{
    id: MCP_SURFACE,
    loadController: async () => (await import("./surface.js")).createMcpSurface,
  }],
} as const satisfies TuiModule
