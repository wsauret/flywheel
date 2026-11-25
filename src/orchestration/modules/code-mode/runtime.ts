import { moduleRuntimeHandle } from "../../../infra/module-runtime.js"
import type { ModuleRuntimeServices } from "../../agent-runtime/request/module-services/module-runtime-services.js"
import type { DeferredToolFactory } from "../../module-contract/module-seams.js"
import { createCatalogRenderer } from "./catalog.js"
import { describeCodeModeTools } from "./descriptors.js"
import { codeModeService } from "./service.js"
import { createCodeTool } from "./tool.js"

/** What the `code` tool's text may name. Every answer comes from the tree's
 *  capture, so every agent of one tree advertises the same bytes
 *  (ARCH-CONTEXT-018). */
interface CodeToolSurface {
  /** Whether the capture contributes code-only tools, which scripts call
   *  through `tools` and the catalog lists. */
  readonly nestedTools: boolean
  /** Whether the tree check holds `bash`. */
  readonly bash: boolean
  /** The revision of the code-only tools and namespaces that the capture's
   *  contributions give (`CodeModeToolSet.revision`). */
  readonly revision: string | undefined
}

/** What one runner holds of Code Mode: the deferred `code` factory over the
 *  process service, with this runner's own catalog renderer. A process
 *  without the service has no runtime, so its runners plan no `code` tool. */
export interface CodeModeRuntime {
  readonly createTool: (surface: CodeToolSurface) => DeferredToolFactory
}

export const codeModeRuntime = moduleRuntimeHandle<CodeModeRuntime>("code-mode")

export function createCodeModeRuntime(services: Pick<ModuleRuntimeServices, "modules">): CodeModeRuntime | undefined {
  const service = services.modules.get(codeModeService)
  if (!service) return undefined
  const renderCatalog = createCatalogRenderer()
  return {
    createTool: (surface) => (eligible, namespaces) => {
      const tools = describeCodeModeTools(eligible, surface.revision)
      const catalog = surface.nestedTools ? renderCatalog(tools, namespaces) : undefined
      return {
        tool: createCodeTool({ catalog, tools, service, bash: surface.bash }),
        omissions: tools.omissions.map(({ path, reason }) => ({ name: path, reason })),
      }
    },
  }
}
