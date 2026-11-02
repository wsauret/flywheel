import { moduleRuntimeHandle } from "../../../infra/module-runtime.js"
import type { ModuleRuntimeServices } from "../../agent-runtime/module-runtime-services.js"
import type { RuntimeTool } from "../../agent-runtime/tools/types.js"
import { createMcpNestedTool } from "./nested-tool.js"
import { mcpService } from "./service.js"

/** What one runner holds of MCP: the code-only tools the connected servers
 *  list now, built from the process service's ports, and the configured
 *  servers whether they have connected or not. A runner in a composition
 *  without the service has no runtime and so exposes no server tool. */
export interface McpRuntime {
  readonly nestedTools: () => readonly RuntimeTool[]
  readonly namespaces: () => readonly string[]
}

export const mcpRuntime = moduleRuntimeHandle<McpRuntime>("mcp")

export function createMcpRuntime(services: Pick<ModuleRuntimeServices, "modules">): McpRuntime | undefined {
  const ports = services.modules.get(mcpService)?.ports
  if (!ports) return undefined
  return {
    nestedTools: () => ports.tools().map((hit) => createMcpNestedTool(ports, hit)),
    namespaces: () => ports.servers(),
  }
}
