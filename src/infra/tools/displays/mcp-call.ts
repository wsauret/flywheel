import { strField, type ToolInput } from "../detail-helpers.js";
import type { ToolDisplay } from "../types.js";

function mcpCallDetail(input: ToolInput): string | null {
  const server = strField(input, "server");
  const tool = strField(input, "tool");
  if (!server || !tool) return null;
  return `${server}:${tool}`;
}

export const mcpCallDisplay: ToolDisplay = {
  name: "mcp_call",
  action: "shell_exec",
  preservesResultContent: true,
  displayName: "MCP",
  verbs: { progressive: "Run", past: "Ran" },
  isOptimistic: false,
  getDetail: mcpCallDetail,
};
