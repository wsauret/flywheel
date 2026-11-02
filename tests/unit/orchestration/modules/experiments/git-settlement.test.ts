import { expect, test } from "bun:test"
import type { ExperimentRunRecordedFact } from "../../../../../src/orchestration/modules/experiments/facts.js"
import { createExperimentGitSettlement } from "../../../../../src/orchestration/modules/experiments/git-settlement.js"

const runFact: ExperimentRunRecordedFact = {
  type: "experiment.run.recorded",
  version: 1,
  actor: "flywheel",
  payload: {
    run: 1,
    segment: 0,
    commit: "pending",
    metric: 8,
    metrics: { memory: 2 },
    status: "keep",
    description: "faster",
    asi: { cause: "cache" },
    confidence: null,
    durationMs: null,
  },
}

test("retires the operation marker with exactly one run fact after keep", async () => {
  const order: string[] = []
  const recorded: unknown[] = []
  const settlement = createExperimentGitSettlement({
    record: async (fact, retirement) => {
      order.push("record")
      recorded.push([fact, retirement])
    },
    retirement: () => [{ op: "drop", kind: "experiment.operation", key: "run" }],
    complete: () => { order.push("complete") },
    keep: async () => {
      order.push("keep")
      return "abcdef1"
    },
    revert: async () => {
      throw new Error("unexpected")
    },
    head: async () => "1234567",
  })

  await settlement.settle("/worktree", runFact)

  expect(order).toEqual(["keep", "record", "complete"])
  expect(recorded[0]).toEqual([
    { ...runFact, payload: { ...runFact.payload, commit: "abcdef1" } },
    [{ op: "drop", kind: "experiment.operation", key: "run" }],
  ])
})

test("a successful commit whose run fact fails retains the operation marker", async () => {
  let completed = false
  const settlement = createExperimentGitSettlement({
    record: async () => { throw new Error("fact failed") },
    retirement: () => [{ op: "drop", kind: "experiment.operation", key: "run" }],
    complete: () => { completed = true },
    keep: async () => "committed",
    revert: async () => { throw new Error("unexpected") },
    head: async () => "original",
  })

  await expect(settlement.settle("/worktree", runFact)).rejects.toThrow("fact failed")

  expect(completed).toBe(false)
})

test("publishes the capped run and deactivation in one transaction", async () => {
  const facts: unknown[] = []
  let transactions = 0
  const settlement = createExperimentGitSettlement({
    record: async (fact, retirement) => {
      facts.push([fact, retirement])
    },
    retirement: () => [{ op: "drop", kind: "experiment.operation", key: "run" }],
    complete: () => {},
    transaction: async (publish) => {
      transactions++
      publish()
    },
    keep: async () => "abcdef1",
    revert: async () => {},
    head: async () => "1234567",
  })

  await settlement.settle("/worktree", runFact, true)

  expect(transactions).toBe(1)
  expect(facts).toEqual([
    [{ ...runFact, payload: { ...runFact.payload, commit: "abcdef1" } }, undefined],
    [
      { type: "experiment.mode.changed", version: 1, actor: "flywheel", payload: { active: false, workDir: null } },
      [{ op: "drop", kind: "experiment.operation", key: "run" }],
    ],
  ])
})
