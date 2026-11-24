import type { ToolDeclaration } from "../../module-seams.js"
import type { FirstPartyModule } from "../../modules.js"
import { codeModeRuntime, createCodeModeRuntime } from "./runtime.js"
import { codeModeService, createCodeModeService } from "./service.js"

const code = {
  category: "opt-in",
  action: "shell_exec",
  cloneInheritance: "inherit",
  learningReviewExecutable: false,
  semanticBundle: null,
  personaBaseline: true,
  personaOrder: 11,
  registryOrder: 16,
  shortForm: { trees: "always", summary: "Run JavaScript that calls external tools and composes their results." },
  registrations: {
    code: {
      capabilities: [],
      create: ({ kernel, modules }) => {
        const runtime = modules.get(codeModeRuntime)
        if (!runtime) return { reason: "code mode is not wired" }
        const codeTools = kernel.moduleSnapshot.contributions.flatMap((contribution) => contribution.domain === "codeTools" ? [contribution] : [])
        // Each contribution's generation names its tool and namespace lists in
        // the composition, so the module ids with their generations name the
        // whole surface. One contribution with no generation leaves it unnamed.
        const parts = codeTools.map((contribution) => {
          const generation = contribution.value.generation?.({ kernel, modules })
          return generation === undefined ? undefined : `${contribution.module}:${generation}`
        })
        const revision = parts.every((part) => part !== undefined) ? parts.join(" ") : undefined
        return { deferred: runtime.createTool({ nestedTools: codeTools.length > 0, bash: kernel.treeCapabilities("bash"), revision }) }
      },
    },
  },
} as const satisfies ToolDeclaration<never>

/** Scripts that orchestrate external tools: the `code` tool over each
 *  request's code-only tools, run one invocation at a time on each Worker of
 *  a pool of reusable Workers behind the executor's four-invocation
 *  admission (ARCH-TOOLS-042, ARCH-TOOLS-009). */
export const codeModeModule = {
  id: "code-mode",
  dependencies: [],
  service: { handle: codeModeService, portable: true, create: () => createCodeModeService() },
  runtime: { handle: codeModeRuntime, create: createCodeModeRuntime },
  contributions: [
    { domain: "tools", id: "code", value: { kind: "tool", name: "code", declaration: code } },
    { domain: "settings", id: "code-mode", value: { control: "binary", group: "Tools", label: "Code mode", description: "Run supported external tools through JavaScript." } },
  ],
} as const satisfies FirstPartyModule
