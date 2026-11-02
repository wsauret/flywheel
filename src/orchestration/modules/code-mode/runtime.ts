import { moduleRuntimeHandle } from "../../../infra/module-runtime.js"
import type { ModuleRuntimeServices } from "../../agent-runtime/module-runtime-services.js"
import type { DeferredToolFactory } from "../../agent-runtime/tools/tool-registry.js"
import { createCatalogRenderer } from "./catalog.js"
import { catalogOnlyCall, describeCodeModeTools, toolTrie } from "./descriptors.js"
import { codeModeService } from "./service.js"
import { createCodeTool } from "./tool.js"

/** What one runner holds of Code Mode: the deferred `code` factory over the
 *  process service, with this runner's own catalog memo. A process without
 *  the service has no runtime, so its runners plan no `code` tool. */
export interface CodeModeRuntime {
  readonly createTool: DeferredToolFactory
}

export const codeModeRuntime = moduleRuntimeHandle<CodeModeRuntime>("code-mode")

export function createCodeModeRuntime(services: Pick<ModuleRuntimeServices, "modules">): CodeModeRuntime | undefined {
  const service = services.modules.get(codeModeService)
  if (!service) return undefined
  const renderCatalog = createCatalogRenderer()
  return {
    createTool: (eligible, namespaces) => {
      const tools = describeCodeModeTools(eligible)
      return {
        tool: createCodeTool({ catalog: renderCatalog(toolTrie(tools.descriptors, catalogOnlyCall), namespaces), tools, service }),
        omissions: tools.omissions.map(({ path, reason }) => ({ name: path, reason })),
      }
    },
  }
}
