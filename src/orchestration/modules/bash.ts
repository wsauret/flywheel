import { bashShellCommand, createBashDefinition } from "../agent-runtime/tools/bash.js"
import type { KernelToolDeps } from "../agent-runtime/tools/kernel-tool-deps.js"
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js"
import type { FirstPartyModule } from "../modules.js"
import { backgroundShellModuleRequirements } from "../module-requirements.js"

function holdMs(kernel: KernelToolDeps): number | undefined {
  const seconds = kernel.foregroundBashHoldSeconds
  return seconds === undefined ? undefined : seconds * 1_000
}

const bash = {
  category: "core",
  action: "shell_exec",
  cloneInheritance: "inherit",
  learningReviewExecutable: false,
  semanticBundle: null,
  personaBaseline: true,
  personaOrder: 0,
  registryOrder: 0,
  registrations: {
    bash: {
      capabilities: [],
      shellCommand: bashShellCommand,
      create: ({ kernel }) => {
        const foreground = !backgroundShellModuleRequirements().every((id) => kernel.capabilities.available(id))
        // Every agent of a chat tree gets the same bash bytes, because its shared
        // Claude host fixes them at launch (ARCH-CONTEXT-018). The persona flags
        // only decide which advertised inputs execution refuses. Of the surface
        // flags, `headless` is fixed for the whole runtime, and the tree
        // captures the described write guard once for all its agents
        // (`SharedTreeCapture`); execution enforces the current one.
        return {
          tool: createBashDefinition({
            totalYieldMs: holdMs(kernel),
            backgroundCommands: !foreground,
            persistentProcesses: !foreground && kernel.persistentProcesses === true,
            backgroundTasks: kernel.backgroundTasks,
            foregroundBashHold: kernel.foregroundBashHold,
            requireManagedExecution: true,
            fileEditTool: kernel.fileEditContract ?? "edit",
            readOnly: kernel.readOnly === true,
            writeGuard: kernel.shellWriteGuard,
            ...(kernel.enforcedShellWriteGuard ? { enforcedWriteGuard: kernel.enforcedShellWriteGuard } : {}),
            mutatingDeclaration: kernel.headless !== true,
          }),
        }
      },
    },
  },
} as const satisfies ToolDeclaration

export const bashModule = {
  id: "bash",
  headless: { order: 0 },
  dependencies: [],
  availability: { kind: "available" },
  contributions: [
    { domain: "tools", id: "bash", value: { kind: "tool", name: "bash", declaration: bash } },
    { domain: "settings", id: "bash", value: { control: "binary", group: "Tools", label: "Bash", description: "Warning: disabling Bash removes subprocess execution." } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
