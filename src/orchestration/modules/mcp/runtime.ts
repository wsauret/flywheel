import { moduleRuntimeHandle } from "../../../infra/definitions/modules/module-runtime.js"
import type { ModuleRuntimeServices } from "../../agent-runtime/request/module-services/module-runtime-services.js"
import type { RuntimeTool } from "../../agent-runtime/tools/types.js"
import { createMcpNestedTool } from "./nested-tool.js"
import { mcpService } from "./service.js"

/** What one runner holds of MCP: the code-only tools the connected servers
 *  list now, built from the process service's ports, the configured servers
 *  whether they have connected or not, and the generation of both lists. A
 *  runner in a composition without the service has no runtime and so exposes
 *  no server tool. */
export interface McpRuntime {
  readonly nestedTools: () => readonly RuntimeTool[]
  readonly namespaces: () => readonly string[]
  readonly toolsGeneration: () => number
}

export const mcpRuntime = moduleRuntimeHandle<McpRuntime>("mcp")

export function createMcpRuntime(services: Pick<ModuleRuntimeServices, "modules">): McpRuntime | undefined {
  const ports = services.modules.get(mcpService)?.ports
  if (!ports) return undefined
  return {
    nestedTools: () => ports.tools().map((hit) => createMcpNestedTool(ports, hit)),
    namespaces: () => ports.servers(),
    toolsGeneration: () => ports.toolsGeneration(),
  }
}
