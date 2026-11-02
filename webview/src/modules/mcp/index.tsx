import { MCP_SURFACE } from "../../../../src/protocol/modules/mcp.js"
import type { WebModule } from "../../web-module.js"
import { McpSheet } from "./sheet.js"

export const mcpWeb = {
  id: "mcp",
  surfaces: [{ id: MCP_SURFACE, sheet: McpSheet }],
} as const satisfies WebModule
