import { expect, test } from "bun:test"
import type { OwnedCommandRunner } from "../../../../../../src/infra/owned-command.js"
import { createRunExperimentTool } from "../../../../../../src/orchestration/modules/experiments/tools/run-experiment.js"
import { createExperimentOperation, experimentInterruptionMessage } from "../../../../../../src/orchestration/modules/experiments/operation-owner.js"
import type { ExperimentRun } from "../../../../../../src/orchestration/modules/experiments/types.js"
import type { ExperimentSnapshot } from "../../../../../../src/orchestration/modules/experiments/projection.js"
import { makeContext, testExperimentOperation } from "../../../agent-runtime/tools/_fixtures.js"

const snapshot: ExperimentSnapshot = {
  mode: { active: true, workDir: "/experiment" },
  configuration: {
    segment: 1,
    name: "speed",
    metricName: "latency",
    metricUnit: "ms",
    direction: "lower",
    measureCommand: "measure",
    checksCommand: "checks",
    workDir: "/experiment",
    maxIterations: 2,
    protectedPaths: [],
    sealedPaths: [],
  },
  segments: [],
  runs: [],
  currentSegment: 0,
  secondaryMetrics: [],
  resumedTurns: 0,
  baselineMetric: 10,
  bestMetric: 10,
  confidence: null,
  protectedPaths: [],
  sealedPaths: [],
}

const context = makeContext({ executionCwd: "/experiment", projectRoot: "/experiment" })

function cappedRun(runNumber: number): ExperimentRun {
  return { run: runNumber, segment: 1, commit: "abc", metric: 10, metrics: {}, status: "keep", description: "kept", timestamp: runNumber, confidence: null, durationMs: null }
}

test("replays state, measures recorded commands, and retains the complete pending result", async () => {
  const operation = testExperimentOperation()
  const commands: string[][] = []
  const responses = ["METRIC latency=9\nMETRIC memory=4", "ok"]
  const run: OwnedCommandRunner = async (command) => {
    commands.push([...command])
    const stdout = responses.shift()!
    return { exitCode: 0, stdout, stderr: "", stdoutBytes: new TextEncoder().encode(stdout), timedOut: false }
  }
  const tool = createRunExperimentTool({ replay: async () => snapshot, operation, run, platform: "linux", scratchDir: "/scratch", prepareScratch: async () => {}, captureTree: async () => "tree-before" })

  const response = await tool.execute({}, context)

  expect(response.outcome).toBe("ok")
  expect(commands).toEqual([["bash", "-lc", "measure"], ["bash", "-lc", "checks"]])
  expect(operation.snapshot()).toEqual({
    status: "pending",
    value: {
      status: "passed",
      metrics: { latency: 9, memory: 4 },
      durationMs: expect.any(Number),
      measurementOutput: "METRIC latency=9\nMETRIC memory=4",
      checksOutput: "ok",
      modelOutput: "METRIC latency=9\nMETRIC memory=4",
      measuredTree: "tree-before",
      resultTree: "tree-before",
    },
  })
})

test("refuses an exhausted cap without running a command", async () => {
  let ran = false
  const tool = createRunExperimentTool({
    replay: async () => ({ ...snapshot, runs: [cappedRun(1), cappedRun(2)] }),
    operation: testExperimentOperation(),
    run: async () => {
      ran = true
      throw new Error("unexpected")
    },
    platform: "linux",
    scratchDir: "/scratch",
    prepareScratch: async () => {},
    captureTree: async () => "tree",
  })

  const response = await tool.execute({}, context)
  expect(response).toEqual({ outcome: "error", content: "Experiment iteration limit reached (2)." })
  expect(ran).toBe(false)
})

test("a successful command without the primary metric fails and interrupts the operation", async () => {
  const operation = testExperimentOperation()
  const tool = createRunExperimentTool({
    replay: async () => snapshot,
    operation,
    run: async () => ({ exitCode: 0, stdout: "METRIC memory=4", stderr: "", stdoutBytes: new Uint8Array(), timedOut: false }),
    platform: "linux",
    scratchDir: "/scratch",
    prepareScratch: async () => {},
    captureTree: async () => "tree",
  })

  const response = await tool.execute({}, context)
  expect(response).toEqual({ outcome: "error", content: 'Measurement succeeded but did not emit primary METRIC "latency".' })
  expect(operation.snapshot()).toEqual({ status: "interrupted" })
  expect(await operation.blocker()).toBe(experimentInterruptionMessage)
})

test("requires the primary metric even when later checks fail", async () => {
  const operation = testExperimentOperation()
  const responses = [
    { exitCode: 0, stdout: "METRIC memory=4", stderr: "", stdoutBytes: new Uint8Array(), timedOut: false },
    { exitCode: 1, stdout: "failed", stderr: "", stdoutBytes: new Uint8Array(), timedOut: false },
  ]
  const tool = createRunExperimentTool({
    replay: async () => snapshot,
    operation,
    run: async () => responses.shift()!,
    platform: "linux",
    scratchDir: "/scratch",
    prepareScratch: async () => {},
    captureTree: async () => "tree",
  })

  const response = await tool.execute({}, context)
  expect(response.outcome).toBe("error")
  expect(operation.snapshot()).toEqual({ status: "interrupted" })
})

test("retains the measured tree when measurement or checks change candidate content", async () => {
  const operation = testExperimentOperation()
  const trees = ["measured-tree", "changed-tree"]
  const tool = createRunExperimentTool({
    replay: async () => snapshot,
    operation,
    run: async (command) => ({
      exitCode: 0,
      stdout: command.includes("measure") ? "METRIC latency=8" : "ok",
      stderr: "",
      stdoutBytes: new Uint8Array(),
      timedOut: false,
    }),
    platform: "linux",
    scratchDir: "/scratch",
    prepareScratch: async () => {},
    captureTree: async () => trees.shift()!,
  })

  expect((await tool.execute({}, context)).outcome).toBe("ok")
  expect(operation.snapshot()).toMatchObject({ status: "pending", value: { measuredTree: "measured-tree", resultTree: "changed-tree" } })
})

test("records the operation marker before commands and blocks redispatch after an unknown outcome", async () => {
  const order: string[] = []
  const operation = createExperimentOperation({
    listInFlight: async () => [],
    putInFlight: async () => { order.push("marker") },
    record: async () => { throw new Error("unexpected experiment fact") },
  })
  const tool = createRunExperimentTool({
    replay: async () => snapshot,
    operation,
    run: async () => {
      order.push("command")
      throw new Error("command outcome unavailable")
    },
    platform: "linux",
    scratchDir: "/scratch",
    prepareScratch: async () => {},
    captureTree: async () => {
      order.push("tree")
      return "tree"
    },
  })

  expect(await tool.execute({}, context)).toEqual({ outcome: "error", content: "command outcome unavailable" })
  expect(order).toEqual(["marker", "tree", "command"])
  expect(await operation.blocker()).toBe(experimentInterruptionMessage)
  expect(await tool.execute({}, context)).toEqual({ outcome: "error", content: experimentInterruptionMessage })
  expect(order).toEqual(["marker", "tree", "command"])
})
