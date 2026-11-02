import { expect, test } from "bun:test"
import { createLogExperimentTool } from "../../../../../../src/orchestration/modules/experiments/tools/log-experiment.js"
import { ExperimentExecutionState, type PendingExperimentResult } from "../../../../../../src/orchestration/modules/experiments/execution-state.js"
import { keepExperimentChanges } from "../../../../../../src/orchestration/modules/experiments/git-operations.js"
import { createExperimentGitSettlement } from "../../../../../../src/orchestration/modules/experiments/git-settlement.js"
import { EXPERIMENT_OPERATION_KIND, createExperimentOperationOwner, experimentInterruptionMessage } from "../../../../../../src/orchestration/modules/experiments/operation-owner.js"
import type { OwnedCommandRunner } from "../../../../../../src/infra/owned-command.js"
import type { InFlightRecord } from "../../../../../../src/infra/event-store-types.js"
import type { ExperimentSnapshot } from "../../../../../../src/orchestration/modules/experiments/projection.js"
import type { ExperimentRunRecordedFact } from "../../../../../../src/orchestration/modules/experiments/facts.js"
import { makeContext, testExperimentOperation } from "../../../agent-runtime/tools/_fixtures.js"

const configuration = {
  segment: 0,
  name: "latency",
  metricName: "latency",
  metricUnit: "ms",
  direction: "lower" as const,
  measureCommand: "measure",
  checksCommand: "checks",
  workDir: "/worktree",
  maxIterations: 1,
  protectedPaths: [],
  sealedPaths: [],
}
const snapshot: ExperimentSnapshot = {
  mode: { active: true, workDir: "/worktree" },
  configuration,
  segments: [configuration],
  runs: [],
  currentSegment: 0,
  secondaryMetrics: [],
  resumedTurns: 0,
  baselineMetric: null,
  bestMetric: null,
  confidence: null,
  protectedPaths: [],
  sealedPaths: [],
}
const context = makeContext({ executionCwd: "/worktree", projectRoot: "/worktree" })

function pending(status: PendingExperimentResult["status"] = "passed", tree = "measured-tree") {
  const state = new ExperimentExecutionState<PendingExperimentResult>()
  state.start("measure")
  state.finish({
    status,
    metrics: { latency: 8, memory: 2 },
    durationMs: 1234,
    measurementOutput: "",
    checksOutput: status === "checks_failed" ? "bad" : "ok",
    modelOutput: "",
    measuredTree: tree,
    resultTree: tree,
  })
  return state
}

test("rejects keep when candidate content changed after measurement and preserves pending", async () => {
  const state = pending()
  const tool = createLogExperimentTool({
    replay: async () => snapshot,
    executionState: state,
    operation: testExperimentOperation(),
    captureTree: async () => "edited-tree",
    settle: async () => { throw new Error("must not settle") },
  })

  expect(await tool.execute({ metric: 8, status: "keep", description: "stale result" }, context)).toEqual({
    outcome: "error",
    content: "Cannot keep experiment: candidate tree changed after measurement (measured-tree != edited-tree). Restore the captured tree before settling the pending result.",
  })
  expect(state.snapshot().status).toBe("pending")
})

test("rejects keep when measurement or checks changed candidate content", async () => {
  const state = pending()
  const value = state.pending()!
  state.clear()
  state.start("measure")
  state.finish({ ...value, resultTree: "checks-mutated-tree" })
  const tool = createLogExperimentTool({
    replay: async () => snapshot,
    executionState: state,
    operation: testExperimentOperation(),
    captureTree: async () => "checks-mutated-tree",
    settle: async () => { throw new Error("must not settle") },
  })

  expect((await tool.execute({ metric: 8, status: "keep", description: "mutated" }, context)).outcome).toBe("error")
  expect(state.snapshot().status).toBe("pending")
})

test("requires a pending result and refuses keep after failed checks", async () => {
  const idle = new ExperimentExecutionState<PendingExperimentResult>()
  const idleTool = createLogExperimentTool({ replay: async () => snapshot, executionState: idle, operation: testExperimentOperation(), captureTree: async () => "measured-tree", settle: async () => {} })
  expect(await idleTool.execute({ commit: "ignored", metric: 8, status: "discard", description: "none" }, context))
    .toEqual({ outcome: "error", content: "No experiment result is pending." })

  const failed = pending("checks_failed")
  const tool = createLogExperimentTool({ replay: async () => snapshot, executionState: failed, operation: testExperimentOperation(), captureTree: async () => "measured-tree", settle: async () => {} })
  const response = await tool.execute({ commit: "ignored", metric: 8, status: "keep", description: "unsafe" }, context)
  expect(response).toEqual({ outcome: "error", content: "Cannot keep an experiment whose checks failed." })
  expect(failed.snapshot().status).toBe("pending")
})

test("preserves measured metrics and ASI, derives analysis, and deactivates at the cap", async () => {
  const state = pending()
  const settled: unknown[] = []
  const tool = createLogExperimentTool({
    replay: async () => snapshot,
    executionState: state,
    operation: testExperimentOperation(),
    captureTree: async () => "measured-tree",
    settle: async (_cwd, fact, deactivate) => {
      settled.push([fact, deactivate])
    },
  })

  const response = await tool.execute({
    commit: "ignored",
    metric: 8,
    metrics: { allocations: 3 },
    status: "keep",
    description: "faster",
    asi: { cause: "cache" },
  }, context)

  expect(response.outcome).toBe("ok")
  expect(settled).toEqual([[
    {
      type: "experiment.run.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        run: 1,
        segment: 0,
        commit: "pending",
        metric: 8,
        metrics: { memory: 2, allocations: 3 },
        status: "keep",
        description: "faster",
        asi: { cause: "cache" },
        confidence: null,
        durationMs: 1234,
      },
    },
    true,
  ]])
  expect(state.snapshot()).toEqual({ status: "idle" })
})

test("a restart after measurement refuses log without deleting or replaying the checkpoint", async () => {
  const checkpoint: InFlightRecord = { kind: EXPERIMENT_OPERATION_KIND, key: "run", payload: { state: "running" }, raw: "{}" }
  let settled = false
  const tool = createLogExperimentTool({
    replay: async () => snapshot,
    executionState: new ExperimentExecutionState(),
    operation: createExperimentOperationOwner({
      listInFlight: async () => [checkpoint],
      putInFlight: async () => { throw new Error("must not redispatch") },
    }),
    captureTree: async () => { throw new Error("must not inspect") },
    settle: async () => { settled = true },
  })

  expect(await tool.execute({ metric: 8, status: "discard", description: "unknown" }, context))
    .toEqual({ outcome: "error", content: experimentInterruptionMessage })
  expect(settled).toBe(false)
  expect(checkpoint.kind).toBe(EXPERIMENT_OPERATION_KIND)
})

test("a pre-settlement tree mismatch keeps pending and refuses destructive discard", async () => {
  const state = pending()
  const operation = createExperimentOperationOwner({ listInFlight: async () => [], putInFlight: async () => {} })
  await operation.begin("measure", "/worktree")
  const settlements: string[] = []
  const tool = createLogExperimentTool({
    replay: async () => snapshot,
    executionState: state,
    operation,
    captureTree: async () => "edited-tree",
    settle: async (_cwd, fact) => { settlements.push(fact.payload.status) },
  })

  expect((await tool.execute({ metric: 8, status: "keep", description: "stale" }, context)).outcome).toBe("error")
  expect(await operation.blocker()).toBeUndefined()
  expect(await tool.execute({ metric: 8, status: "discard", description: "discard stale result" }, context)).toEqual({
    outcome: "error",
    content: "Cannot discard experiment: candidate tree changed after the result was captured (measured-tree != edited-tree). Restore the captured tree before settling the result.",
  })
  expect(settlements).toEqual([])
  expect(state.snapshot().status).toBe("pending")
})

test("a keep-boundary candidate mismatch permits explicit discard without publishing a keep", async () => {
  const state = pending()
  const operation = createExperimentOperationOwner({ listInFlight: async () => [], putInFlight: async () => {} })
  await operation.begin("measure", "/worktree")
  const facts: ExperimentRunRecordedFact[] = []
  const commands: string[] = []
  const tree = "measured-tree"
  const changedTree = "b".repeat(40)
  const run: OwnedCommandRunner = async (command) => {
    const subcommand = command[3] ?? ""
    commands.push(subcommand)
    if (subcommand === "rev-parse") {
      return { exitCode: 0, stdout: "1234567\n", stderr: "", stdoutBytes: new Uint8Array(), timedOut: false }
    }
    if (subcommand === "write-tree") {
      return { exitCode: 0, stdout: `${changedTree}\n`, stderr: "", stdoutBytes: new Uint8Array(), timedOut: false }
    }
    return { exitCode: 0, stdout: "", stderr: "", stdoutBytes: new Uint8Array(), timedOut: false }
  }
  const settlement = createExperimentGitSettlement({
    record: async (fact) => { if (fact.type === "experiment.run.recorded") facts.push(fact) },
    retirement: () => operation.retirement(),
    complete: () => operation.complete(),
    keep: ({ cwd, description, result }) => keepExperimentChanges({
      cwd,
      scratchDir: "/scratch",
      description,
      result,
      measuredTree: tree,
      run,
    }),
    revert: async (cwd) => {
      for (const args of [
        ["git", "-C", cwd, "reset"],
        ["git", "-C", cwd, "checkout"],
        ["git", "-C", cwd, "clean"],
      ]) await run(args)
    },
    head: async (cwd) => {
      const result = await run(["git", "-C", cwd, "rev-parse", "--short=7", "HEAD"])
      return result.stdout.trim()
    },
  })
  const tool = createLogExperimentTool({
    replay: async () => ({ ...snapshot, configuration: { ...configuration, maxIterations: null } }),
    executionState: state,
    operation,
    captureTree: async () => tree,
    settle: (cwd, fact, deactivate) => settlement.settle(cwd, fact, deactivate),
  })

  const keep = await tool.execute({ metric: 8, status: "keep", description: "stale at keep" }, context)
  expect(keep).toEqual({
    outcome: "error",
    content: `Experiment tree mismatch at keep staging boundary: measured ${tree}, found ${changedTree}.`,
  })
  expect(await operation.blocker()).toBeUndefined()
  expect(state.snapshot().status).toBe("pending")

  expect((await tool.execute({ metric: 8, status: "discard", description: "discard stale result" }, context)).outcome).toBe("ok")
  expect(facts.map((fact) => fact.payload.status)).toEqual(["discard"])
  expect(commands).not.toContain("commit")
})
