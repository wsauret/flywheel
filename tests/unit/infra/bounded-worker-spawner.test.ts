import { afterEach, describe, expect, test } from "bun:test"
import {
  createBoundedWorkerSpawner,
  WORKER_GENERATION_BUDGETS,
  WorkerGenerationBudgetExhausted,
  WorkerRoleAlreadyLive,
  type WorkerRole,
} from "../../../src/infra/bounded-worker-spawner.js"

const originalWorker = globalThis.Worker
let workersCreated = 0

class RecordingWorker extends EventTarget {
  constructor() {
    super()
    workersCreated += 1
  }

  terminate(): void {
    this.dispatchEvent(new Event("close"))
  }
}

afterEach(() => {
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker })
  workersCreated = 0
})

function isWorkerRole(role: string): role is WorkerRole {
  return role in WORKER_GENERATION_BUDGETS
}

describe("bounded Worker spawner", () => {
  test("every registered role stops before one more native allocation", () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: RecordingWorker })

    for (const [role, budget] of Object.entries(WORKER_GENERATION_BUDGETS)) {
      if (!isWorkerRole(role)) throw new Error(`Unknown Worker role in registry: ${role}`)
      const spawn = createBoundedWorkerSpawner(role)
      for (let generation = 0; generation < budget; generation += 1) spawn("worker.ts").terminate()
      expect(() => spawn("worker.ts")).toThrow(WorkerGenerationBudgetExhausted)
    }

    expect(workersCreated).toBe(Object.values(WORKER_GENERATION_BUDGETS).reduce((sum, budget) => sum + budget, 0))
  })

  test("project state permits replacement only after observed close", () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: RecordingWorker })
    const spawn = createBoundedWorkerSpawner("project-state")
    const first = spawn("worker.ts")
    expect(() => spawn("worker.ts")).toThrow(WorkerRoleAlreadyLive)
    first.dispatchEvent(new Event("close"))
    expect(() => spawn("worker.ts")).not.toThrow()
  })
})
