import { expect, test } from "bun:test"
import type { InFlightRecord, InFlightWrite } from "../../../../../src/infra/event-store-types.js"
import {
  EXPERIMENT_GIT_SETTLEMENT_KIND,
  EXPERIMENT_OPERATION_KIND,
  createExperimentOperationOwner,
  experimentInterruptionMessage,
} from "../../../../../src/orchestration/modules/experiments/operation-owner.js"

function row(kind: string, key = "run"): InFlightRecord {
  return { kind, key, payload: {}, raw: "{}" }
}

test("a rebuilt owner rejects interrupted experiment work without deleting or redispatching it", async () => {
  const writes: string[] = []
  const existing = [row(EXPERIMENT_OPERATION_KIND)]
  const owner = createExperimentOperationOwner({
    listInFlight: async () => existing,
    putInFlight: async () => { writes.push("put") },
  })

  expect(await owner.blocker()).toBe(experimentInterruptionMessage)
  await expect(owner.begin("measure", "/worktree")).rejects.toThrow(experimentInterruptionMessage)
  expect(writes).toEqual([])
  expect(existing).toHaveLength(1)
})

test("legacy Git settlement evidence also blocks a rebuilt owner", async () => {
  const owner = createExperimentOperationOwner({
    listInFlight: async () => [row(EXPERIMENT_GIT_SETTLEMENT_KIND, "0:1")],
    putInFlight: async () => {},
  })

  expect(await owner.blocker()).toBe(experimentInterruptionMessage)
})

test("one live owner keeps its marker through measurement and exposes atomic retirement", async () => {
  const writes: Array<{ kind: string; key: string; payload: unknown }> = []
  const owner = createExperimentOperationOwner({
    listInFlight: async () => [],
    putInFlight: async (kind, key, payload) => { writes.push({ kind, key, payload }) },
  })

  await owner.begin("measure", "/worktree")

  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ kind: EXPERIMENT_OPERATION_KIND, key: "run", payload: { state: "running", command: "measure", cwd: "/worktree" } })
  expect(await owner.blocker()).toBeUndefined()
  expect(owner.retirement()).toEqual([{ op: "drop", kind: EXPERIMENT_OPERATION_KIND, key: "run" } satisfies InFlightWrite])

  owner.complete()
  expect(owner.retirement()).toEqual([])
})

test("an uncertain outcome blocks the same owner and retains retirement evidence", async () => {
  const owner = createExperimentOperationOwner({
    listInFlight: async () => [],
    putInFlight: async () => {},
  })
  await owner.begin("measure", "/worktree")

  owner.interrupt()

  expect(await owner.blocker()).toBe(experimentInterruptionMessage)
  expect(owner.retirement()).toEqual([{ op: "drop", kind: EXPERIMENT_OPERATION_KIND, key: "run" }])
})

test("the owner reads interrupted work on first use, retries a failed read, and reads once after it succeeds", async () => {
  let reads = 0
  const owner = createExperimentOperationOwner({
    listInFlight: async () => {
      reads += 1
      if (reads === 1) throw new Error("state read refused")
      return []
    },
    putInFlight: async () => {},
  })
  await Bun.sleep(0)
  expect(reads).toBe(0)

  await expect(owner.blocker()).rejects.toThrow("state read refused")
  expect(await owner.blocker()).toBeUndefined()
  await owner.begin("measure", "/worktree")
  expect(reads).toBe(2)
})
