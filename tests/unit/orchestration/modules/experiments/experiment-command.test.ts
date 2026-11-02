import { describe, expect, test } from "bun:test"

import type { CommandMethod, CommandPrompt } from "../../../../../src/orchestration/app-service/command-host.js"
import type { CommandOutcome } from "../../../../../src/protocol/command-catalog-protocol-types.js"
import { executeExperimentCommand, type ExperimentCommandDeps } from "../../../../../src/orchestration/modules/experiments/experiment-command.js"
import type { ExperimentModeChangedFact } from "../../../../../src/orchestration/modules/experiments/facts.js"

const charter = `# Experiment charter

\`\`\`toml
name = "Speed"
metric_name = "latency"
metric_unit = "ms"
direction = "lower"
measure_command = "./.experiment/measure.sh"
checks_command = "./.experiment/checks.sh"
work_dir = "."
max_iterations = 5
protected_paths = ["src/protected.ts"]
sealed_paths = ["secrets/**"]
\`\`\`

## Objective
Fast.
## Metrics
Latency.
## Hard gates
Tests pass.
## Anti-gaming rules
No shortcuts.
## Files in scope
src/**
## Protected paths
Charter and scripts.
## Sealed paths
Secrets.
## Commands
Run scripts.
## Baseline
METRIC latency=10
## Search strategy
Measure one change.
`

function harness(overrides: Partial<ExperimentCommandDeps> = {}) {
  const facts: ExperimentModeChangedFact[] = []
  const prompts: CommandPrompt[] = []
  const methods: CommandMethod[] = []
  let interrupted = false
  let cleared = false
  const deps = {
    executionCwd: "/repo",
    projectRoot: "/repo",
    snapshot: async () => ({ mode: { active: false, workDir: null } }),
    readCharter: async () => charter,
    validateWorktree: async () => "/repo",
    trackedFilesAreClean: async () => true,
    recordMode: async (active: boolean, workDir: string | null) => { facts.push({ type: "experiment.mode.changed", version: 1, actor: "flywheel", payload: { active, workDir } }) },
    prompt: async (input: CommandPrompt) => { prompts.push(input); return true },
    startMethod: async (input: CommandMethod): Promise<CommandOutcome> => { methods.push(input); return { kind: "none" } },
    clearPending: () => { cleared = true },
    interrupt: () => { interrupted = true },
    interruption: async () => undefined,
    ...overrides,
  }
  return { deps, facts, prompts, methods, interrupted: () => interrupted, cleared: () => cleared }
}

describe("experiment command", () => {
  test("design starts the charter method with the goal as its argument, without activation", async () => {
    const h = harness()
    expect(await executeExperimentCommand("design make it fast", h.deps)).toEqual({ kind: "none" })
    expect(h.facts).toEqual([])
    expect(h.prompts).toEqual([])
    expect(h.methods).toEqual([{ skill: "experiment-charter", label: "/experiment design", args: "make it fast" }])
  })

  test("finalize starts the finalize method with no argument", async () => {
    const h = harness()
    expect(await executeExperimentCommand("finalize", h.deps)).toEqual({ kind: "none" })
    expect(h.methods).toEqual([{ skill: "experiment-finalize", label: "/experiment finalize" }])
  })

  test("start validates the approved charter and records mode before the prompt", async () => {
    const order: string[] = []
    const prompts: CommandPrompt[] = []
    const h = harness({
      recordMode: async () => { order.push("mode") },
      prompt: async (input) => { order.push("prompt"); prompts.push(input); return true },
    })
    expect(await executeExperimentCommand("start", h.deps)).toEqual({ kind: "none" })
    expect(order).toEqual(["mode", "prompt"])
    expect(prompts).toEqual([{ text: expect.any(String), label: "/experiment start", context: expect.any(String) }])
  })

  test("start refuses invalid state and off and clear preserve distinct workDir semantics", async () => {
    const missing = harness({ readCharter: async () => null })
    expect(await executeExperimentCommand("start", missing.deps)).toEqual({ kind: "warning", message: "No committed .experiment/charter.md exists in this session's execution directory." })

    const active = harness({ snapshot: async () => ({ mode: { active: true, workDir: "/repo" } }) })
    expect(await executeExperimentCommand("start", active.deps)).toEqual({ kind: "warning", message: "Experiment mode is already active." })
    expect(await executeExperimentCommand("off", active.deps)).toEqual({ kind: "none" })
    expect(await executeExperimentCommand("clear", active.deps)).toEqual({ kind: "none" })
    expect(active.facts.map((fact) => fact.payload)).toEqual([{ active: false, workDir: "/repo" }, { active: false, workDir: null }])
    expect(active.cleared()).toBe(true)
    expect(active.interrupted()).toBe(true)
  })

  test("interrupted work blocks new activation but not off or clear", async () => {
    const h = harness({ interruption: async () => "Inspect the unresolved experiment operation." })
    expect(await executeExperimentCommand("start", h.deps)).toEqual({ kind: "warning", message: "Inspect the unresolved experiment operation." })
    expect(await executeExperimentCommand("off", h.deps)).toEqual({ kind: "none" })
    expect(await executeExperimentCommand("clear", h.deps)).toEqual({ kind: "none" })
  })

  test("help, unknown syntax, and dashboard are deterministic", async () => {
    const h = harness()
    const help = await executeExperimentCommand(undefined, h.deps)
    expect(help.kind).toBe("message")
    expect(help.kind === "message" ? help.message : "").toContain("Usage: /experiment")
    expect(help.kind === "message" ? help.message : "").toContain("finalize turns the kept experiments into clean, reviewable branches.")
    expect(await executeExperimentCommand("wat", h.deps)).toEqual({ kind: "warning", message: "Usage: /experiment [design <goal>|start|off|clear|finalize|dashboard]" })
    expect(await executeExperimentCommand("dashboard", h.deps)).toEqual({ kind: "open", surface: "experiment-dashboard" })
  })
})
