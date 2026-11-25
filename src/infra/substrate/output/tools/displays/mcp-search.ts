import { singleLine, strField, type ToolInput } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

function mcpSearchDetail(input: ToolInput): string {
  const query = singleLine(strField(input, "query"));
  return query ? `"${query}"` : "server catalog";
}

export const mcpSearchDisplay: ToolDisplay = {
  name: "mcp_search",
  action: "search",
  displayName: "MCP Search",
  verbs: { progressive: "Searching", past: "Searched" },
  isOptimistic: true,
  getDetail: mcpSearchDetail,
};
