import { composeModuleServices } from "../../src/infra/module-service.js";
import type { McpCallResult, McpToolHit } from "../../src/orchestration/modules/mcp/connection.js";
import type { McpPorts } from "../../src/orchestration/modules/mcp/manager.js";
import { createMcpRuntime, type McpRuntime } from "../../src/orchestration/modules/mcp/runtime.js";
import type { McpService } from "../../src/orchestration/modules/mcp/service.js";

/** Ports over a fixed catalog; `call` answers every tool the same way. */
export function mcpPortsOver(hits: readonly McpToolHit[], call: McpPorts["call"] = async () => { throw new Error("unused in this test"); }): McpPorts {
  return { servers: () => [...new Set(hits.map((hit) => hit.server))], tools: () => hits, call };
}

/** The module's real per-runner runtime over one process service that holds only `ports`. */
export function mcpRuntimeOver(ports: McpPorts): McpRuntime {
  const runtime = createMcpRuntime({ modules: composeModuleServices([["mcp", { ports } satisfies Partial<McpService>]]) });
  if (!runtime) throw new Error("the MCP runtime builds whenever its service is present");
  return runtime;
}

export const MCP_RESULT: McpCallResult = { content: [], isError: false };
