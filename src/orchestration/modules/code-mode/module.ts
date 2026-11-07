import type { ToolDeclaration } from "../../agent-runtime/tools/tool-registry.js"
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
  registrations: {
    code: {
      capabilities: [],
      create: ({ kernel, modules }) => {
        const runtime = modules.get(codeModeRuntime)
        if (!runtime) return { reason: "code mode is not wired" }
        const nestedTools = kernel.moduleSnapshot.contributions.some((contribution) => contribution.domain === "codeTools")
        return { deferred: runtime.createTool({ nestedTools, bash: kernel.treeCapabilities("bash") }) }
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
  availability: { kind: "available" },
  service: { handle: codeModeService, portable: true, create: () => createCodeModeService() },
  runtime: { handle: codeModeRuntime, create: createCodeModeRuntime },
  contributions: [
    { domain: "tools", id: "code", value: { kind: "tool", name: "code", declaration: code } },
    { domain: "settings", id: "code-mode", value: { control: "binary", group: "Tools", label: "Code mode", description: "Run supported external tools through JavaScript." } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
