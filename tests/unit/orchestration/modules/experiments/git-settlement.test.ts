import { expect, test } from "bun:test"
import type { ExperimentRunRecordedFact } from "../../../../../src/orchestration/modules/experiments/facts.js"
import { createExperimentGitSettlement } from "../../../../../src/orchestration/modules/experiments/git-settlement.js"
import { storedExperimentFact } from "../../agent-runtime/tools/_fixtures.js"

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
      return storedExperimentFact(fact)
    },
    keep: async ({ measuredTree }) => {
      order.push(`keep ${measuredTree}`)
      return "abcdef1"
    },
    revert: async () => {
      throw new Error("unexpected")
    },
    head: async () => "1234567",
  })

  await settlement.settle("/worktree", runFact, false, "measured-tree")

  expect(order).toEqual(["keep measured-tree", "record"])
  expect(recorded[0]).toEqual([
    { ...runFact, payload: { ...runFact.payload, commit: "abcdef1" } },
    [{ op: "drop", kind: "experiment.operation", key: "run" }],
  ])
})

for (const [label, record] of [
  ["fails", async () => { throw new Error("fact failed") }],
  ["is not acknowledged", async () => null],
] as const) {
  test(`a successful commit whose run fact ${label} rejects the settlement`, async () => {
    const settlement = createExperimentGitSettlement({
      record,
      keep: async () => "committed",
      revert: async () => { throw new Error("unexpected") },
      head: async () => "original",
    })

    await expect(settlement.settle("/worktree", runFact, false, "measured-tree")).rejects.toThrow(label === "fails" ? "fact failed" : "Experiment run could not be recorded.")
  })
}

test("publishes the capped run and deactivation in one transaction", async () => {
  const facts: unknown[] = []
  let transactions = 0
  const settlement = createExperimentGitSettlement({
    // Inside a transaction the writer queues each fact and acknowledges none.
    record: async (fact, retirement) => {
      facts.push([fact, retirement])
      return null
    },
    transaction: async (publish) => {
      transactions++
      publish()
    },
    keep: async () => "abcdef1",
    revert: async () => {},
    head: async () => "1234567",
  })

  await settlement.settle("/worktree", runFact, true, "measured-tree")

  expect(transactions).toBe(1)
  expect(facts).toEqual([
    [{ ...runFact, payload: { ...runFact.payload, commit: "abcdef1" } }, undefined],
    [
      { type: "experiment.mode.changed", version: 1, actor: "flywheel", payload: { active: false, workDir: null } },
      [{ op: "drop", kind: "experiment.operation", key: "run" }],
    ],
  ])
})
