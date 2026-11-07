import { fileURLToPath } from "node:url"
import { bashShellCommand, createBashDefinition } from "../../agent-runtime/tools/bash.js"
import type { KernelToolDeps } from "../../agent-runtime/tools/kernel-tool-deps.js"
import type { ToolDeclaration } from "../../agent-runtime/tools/tool-registry.js"
import type { FirstPartyModule } from "../../modules.js"
import { backgroundShellModuleRequirements } from "../../module-requirements.js"
import { moduleDisabledReason } from "../../../protocol/module-ids.js"

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
        const backgroundOff = backgroundShellModuleRequirements().filter((id) => !kernel.capabilities.available(id))
        const backgroundCommands = backgroundOff.length === 0
        // Every agent of a chat tree gets the same bash bytes, because its shared
        // Claude host fixes them at launch (ARCH-CONTEXT-018). What the tool
        // advertises reads only the tree's capture: its module snapshot, its
        // tree check, its captured persistent-process policy, and its write
        // guard (`SharedTreeCapture`); `headless` is fixed for the whole runtime.
        // This agent's own selection and persona decide only which advertised
        // inputs execution refuses.
        const advertisesBackground = kernel.moduleSnapshot.contributions.some((entry) => entry.domain === "shellOperations" && entry.value.background)
        return {
          // The modules whose advertised part of this tool, its background input, this agent may not use.
          ...(advertisesBackground && !backgroundCommands ? { turnedOff: backgroundOff } : {}),
          tool: createBashDefinition({
            totalYieldMs: holdMs(kernel),
            ...(backgroundCommands ? {} : { backgroundRefusal: moduleDisabledReason(backgroundOff) }),
            persistentProcesses: backgroundCommands && kernel.persistentProcesses === true,
            backgroundTasks: kernel.backgroundTasks,
            foregroundBashHold: kernel.foregroundBashHold,
            requireManagedExecution: true,
            fileEditTool: kernel.fileEditContract ?? "edit",
            readOnly: kernel.readOnly === true,
            writeGuard: kernel.shellWriteGuard,
            mutatingDeclaration: kernel.headless !== true,
            advertised: { background: advertisesBackground, persistence: kernel.persistentProcessesAdvertised, has: kernel.treeCapabilities },
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
    // Methods that only a shell can run, such as the worktree lifecycle that the shell's worktree gate names (ARCH-STRUCTURE-031).
    { domain: "definitions", id: "bash", value: { kind: "bundle", root: fileURLToPath(new URL("definitions", import.meta.url)) } },
    { domain: "settings", id: "bash", value: { control: "binary", group: "Tools", label: "Bash", description: "Warning: disabling Bash removes subprocess execution." } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
