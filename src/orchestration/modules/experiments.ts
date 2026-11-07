import { ExperimentFactSchemas } from "./experiments/facts.js"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ToolDeclaration } from "../agent-runtime/tools/tool-registry.js"
import type { FirstPartyModule } from "../modules.js"
import { createExperimentChatObserver } from "./experiments/chat-observer.js"
import { executeExperimentCommand } from "./experiments/experiment-command.js"
import { validateExperimentWorktree } from "./experiments/git-worktree.js"
import { findExperimentInterruption } from "./experiments/operation-owner.js"
import { createExperimentProjection } from "./experiments/projection.js"
import { renderExperimentSystemPromptFragment } from "./experiments/system-prompt-fragment.js"
import { experimentToolExecutionGate, experimentToolOmissions } from "./experiments/tool-execution-gate.js"
import { experimentsProtocol } from "../../protocol/modules/experiments.js"
import { moduleProtocol } from "../app-service/module-protocol-host.js"
import { createExperimentsProtocol, experimentsBackgroundReaders } from "./experiments/protocol.js"
import { createExperimentsRuntime, experimentsRuntime, type ExperimentsRuntime } from "./experiments/runtime.js"

function declaration(name: string, action: "shell_exec" | "ui_meta", tool: keyof ExperimentsRuntime["tools"], registryOrder: number): ToolDeclaration {
  return {
    category: "ambient",
    action,
    cloneInheritance: "reconstruct",
    learningReviewExecutable: false,
    semanticBundle: null,
    personaBaseline: false,
    registryOrder,
    registrations: {
      [name]: {
        capabilities: [],
        create: ({ modules }) => {
          const runtime = modules.get(experimentsRuntime)
          return runtime ? { tool: runtime.tools[tool] } : { reason: "no experiment session available" }
        },
      },
    },
  }
}

export const experimentsModule = {
  id: "experiments",
  dependencies: [],
  availability: { kind: "available" },
  runtime: { handle: experimentsRuntime, create: createExperimentsRuntime },
  protocol: moduleProtocol({ contract: experimentsProtocol, create: createExperimentsProtocol, background: experimentsBackgroundReaders }),
  facts: { prefixes: ["experiment."], sessionSchemas: () => ExperimentFactSchemas },
  contributions: [
    { domain: "skillChildGrants", id: "experiments-finalize", value: { order: 0, create: ({ modules, revision }) => modules.get(experimentsRuntime)?.finalizeGrant(revision) } },
    { domain: "tools", id: "init_experiment", value: { kind: "tool", name: "init_experiment", declaration: declaration("init_experiment", "ui_meta", "initExperiment", 92) } },
    { domain: "tools", id: "run_experiment", value: { kind: "tool", name: "run_experiment", declaration: declaration("run_experiment", "shell_exec", "runExperiment", 93) } },
    { domain: "tools", id: "log_experiment", value: { kind: "tool", name: "log_experiment", declaration: declaration("log_experiment", "ui_meta", "logExperiment", 94) } },
    { domain: "promptFragments", id: "experiments-active", value: {
      order: 1,
      render: async ({ modules }) => {
        const snapshot = await modules.get(experimentsRuntime)?.snapshot()
        return snapshot?.mode.active === true
          ? renderExperimentSystemPromptFragment({ checksCommand: snapshot.configuration?.checksCommand ?? null })
          : undefined
      },
    } },
    { domain: "commands", id: "experiment", value: {
      id: "experiment",
      title: "Experiment",
      description: "Run an experiment loop: design <goal>, start, off, clear, finalize, or dashboard",
      aliases: [],
      execute: async (host, argument) => {
        const session = host.session
        if (!session) return { kind: "warning", message: "The experiment command requires an active chat session." }
        const run = host.runOwnedCommand
        if (!run) return { kind: "warning", message: "Experiment command execution is unavailable." }
        const { executionCwd } = session
        const { projectRoot } = host.directories
        const projection = createExperimentProjection(host.projectionReader, session.id)
        return executeExperimentCommand(argument, {
          executionCwd,
          projectRoot,
          snapshot: () => projection.replay(),
          readCharter: async () => {
            const file = Bun.file(join(executionCwd, ".experiment", "charter.md"))
            return await file.exists() ? file.text() : null
          },
          validateWorktree: (workDir) => validateExperimentWorktree({ workDir, executionCwd, projectRoot, run }),
          trackedFilesAreClean: async (workDir) => {
            const result = await run(["git", "-C", workDir, "ls-files", "--error-unmatch", "--", ".experiment/charter.md", ".experiment/measure.sh", ".experiment/checks.sh"])
            return result.exitCode === 0
          },
          recordMode: async (active, workDir) => {
            const stored = await session.facts().record({ type: "experiment.mode.changed", version: 1, actor: "flywheel", payload: { active, workDir } })
            if (!stored) throw new Error("Experiment mode could not be recorded.")
            await projection.apply(stored)
          },
          prompt: (input) => session.prompt(input),
          startMethod: (input) => session.startMethod(input),
          clearPending: () => { session.runtime(experimentsRuntime)?.execution.clear() },
          interrupt: () => { session.interrupt() },
          interruption: () => findExperimentInterruption((kinds) => session.readInFlight(kinds)),
        })
      },
    } },
    // The experiment-charter and experiment-finalize methods run only on this module's tools (ARCH-STRUCTURE-031).
    { domain: "definitions", id: "experiments", value: { kind: "bundle", root: fileURLToPath(new URL("experiments/definitions", import.meta.url)) } },
    { domain: "settings", id: "experiments", value: { control: "binary", group: "Tools", label: "Experiments", description: "Allow agents to run autonomous experiment loops" } },
  ],
  observers: [{
    seam: "chat",
    observer: (context) => {
      const projection = createExperimentProjection(context.projectionReader, context.sessionId)
      return createExperimentChatObserver({
        replay: () => projection.replay(),
        record: async (fact) => { await context.writer.record(fact) },
        enqueueSilentSystem: context.enqueueSilentSystem,
        showSystemMessage: context.showSystemMessage,
      })
    },
  }],
  transformers: [],
  gates: [
    { seam: "toolExecution", gate: experimentToolExecutionGate },
    { seam: "toolExposure", gate: async ({ modules }) => {
      const guard = await modules.get(experimentsRuntime)?.guard()
      return guard?.active ? experimentToolOmissions(guard) : new Map()
    } },
  ],
} as const satisfies FirstPartyModule
