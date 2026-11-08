import { afterEach, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import { asAsyncEventWriter, type InFlightRecord } from "../../../../../src/infra/event-store-types.js"
import { Log } from "../../../../../src/infra/log.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import {
  EXPERIMENT_GIT_SETTLEMENT_KIND,
  EXPERIMENT_OPERATION_KIND,
  createExperimentOperation,
  experimentInterruptionMessage,
  experimentStopRetirement,
  findExperimentInterruption,
  type PendingExperimentResult,
} from "../../../../../src/orchestration/modules/experiments/operation-owner.js"
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()
const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
})

function row(kind: string, key = "run"): InFlightRecord {
  return { kind, key, payload: { state: "running" }, raw: "{\"state\":\"running\"}" }
}

const unexpectedRecord = async () => { throw new Error("unexpected experiment fact") }
const admit = (command = "measure") => async () => ({ command })
const result = (latency: number): PendingExperimentResult => ({ status: "passed", metrics: { latency }, durationMs: 10, measuredTree: "tree", resultTree: "tree" })

test("a rebuilt owner rejects interrupted experiment work without deleting or redispatching it", async () => {
  const writes: string[] = []
  const existing = [row(EXPERIMENT_OPERATION_KIND)]
  const owner = createExperimentOperation({
    listInFlight: async () => existing,
    putInFlight: async () => { writes.push("put") },
    record: unexpectedRecord,
  })

  expect(await owner.blocker()).toBe(experimentInterruptionMessage)
  await expect(owner.begin(async () => { throw new Error("must not admit") })).rejects.toThrow(experimentInterruptionMessage)
  expect(writes).toEqual([])
  expect(existing).toHaveLength(1)
})

test("legacy Git settlement evidence also blocks a rebuilt owner", async () => {
  const owner = createExperimentOperation({
    listInFlight: async () => [row(EXPERIMENT_GIT_SETTLEMENT_KIND, "0:1")],
    putInFlight: async () => {},
    record: unexpectedRecord,
  })

  expect(await owner.blocker()).toBe(experimentInterruptionMessage)
})

test("one owner writes its hold before running, holds one result, and refuses work that is not idle", async () => {
  const writes: Array<{ kind: string; key: string; payload: unknown }> = []
  const owner = createExperimentOperation({
    listInFlight: async () => [],
    putInFlight: async (kind, key, payload) => { writes.push({ kind, key, payload }) },
    record: unexpectedRecord,
  })
  const observed: string[] = []
  const unsubscribe = owner.subscribe((state) => observed.push(state.status))

  expect(await owner.begin(admit())).toEqual({ command: "measure" })
  expect(writes).toEqual([{ kind: EXPERIMENT_OPERATION_KIND, key: "run", payload: { state: "running" } }])
  await expect(owner.begin(admit("again"))).rejects.toThrow("Experiment execution is not idle.")
  await owner.measured(result(4))
  await owner.measured(result(5))
  expect(owner.snapshot()).toEqual({ status: "pending", value: result(4) })
  expect(writes.slice(1)).toEqual([{ kind: EXPERIMENT_OPERATION_KIND, key: "run", payload: { state: "pending", result: result(4) } }])
  expect(await owner.settle(async (pending) => ({ outcome: "settled", result: pending.metrics.latency }))).toBe(4)
  expect(writes.slice(2)).toEqual([{ kind: EXPERIMENT_OPERATION_KIND, key: "run", payload: { state: "settling" } }])
  await expect(owner.settle(async () => ({ outcome: "settled", result: 0 }))).rejects.toThrow("No experiment result is pending.")
  unsubscribe()

  expect(owner.snapshot()).toEqual({ status: "idle" })
  expect(observed).toEqual(["running", "pending", "idle"])
  expect(await owner.blocker()).toBeUndefined()
})

test("an uncertain outcome blocks the same owner", async () => {
  const owner = createExperimentOperation({
    listInFlight: async () => [],
    putInFlight: async () => {},
    record: unexpectedRecord,
  })
  await owner.begin(admit())

  owner.failed()

  expect(owner.snapshot()).toEqual({ status: "interrupted" })
  expect(await owner.blocker()).toBe(experimentInterruptionMessage)
})

test("the owner reads interrupted work on first use, retries a failed read, and reads once after it succeeds", async () => {
  let reads = 0
  const owner = createExperimentOperation({
    listInFlight: async () => {
      reads += 1
      if (reads === 1) throw new Error("state read refused")
      return []
    },
    putInFlight: async () => {},
    record: unexpectedRecord,
  })
  await Bun.sleep(0)
  expect(reads).toBe(0)

  await expect(owner.blocker()).rejects.toThrow("state read refused")
  expect(await owner.blocker()).toBeUndefined()
  await owner.begin(admit())
  expect(reads).toBe(2)
})

/** An owner over a real store and session fact writer. `holdNextAppend`
 *  stops the next append before it reaches the store until the case
 *  releases it into the store or refuses it. */
function storedOwner() {
  const store = createSqliteEventStore(join(temporaryDirectory("flywheel-experiment-operation-"), "flywheel.sqlite"))
  closers.push(() => store.close())
  const actual = asAsyncEventWriter(store)
  let held: (() => Promise<void>) | undefined
  const writer = createSessionFactWriter({ sessionId: "test", writer: { ...actual, append: async (event) => {
    const hold = held
    held = undefined
    await hold?.()
    return actual.append(event)
  } } })
  const putInFlight = writer.putInFlight
  if (!putInFlight) throw new Error("expected in-flight authority")
  const listInFlight = async (kinds: readonly string[]) => store.readInFlight("test", kinds)
  /** An owner over the store, as a runner builds it; a second one is a reopened runner. */
  const reopened = () => createExperimentOperation({
    listInFlight,
    putInFlight: (kind, key, payload) => putInFlight(kind, key, payload),
    record: (fact, inFlight) => writer.record(fact, undefined, inFlight),
  })
  const owner = reopened()
  const holds = () => store.readInFlight("test", EXPERIMENT_OPERATION_KIND).length
  const holdNextAppend = () => {
    let release: (error?: Error) => void = () => {}
    let stateAtWrite = ""
    const entered = new Promise<void>((resolve) => {
      held = () => {
        stateAtWrite = owner.snapshot().status
        resolve()
        return new Promise<void>((proceed, refuse) => { release = (error) => error ? refuse(error) : proceed() })
      }
    })
    return { entered, release: (error?: Error) => release(error), stateAtWrite: () => stateAtWrite }
  }
  const hold = () => store.readInFlight("test", EXPERIMENT_OPERATION_KIND)[0]?.payload
  return { owner, writer, holds, hold, holdNextAppend, putInFlight, reopened, listInFlight }
}

test("the current running hold opens as interrupted", async () => {
  const { owner, reopened } = storedOwner()
  const warn = spyOn(Log.create({ service: "experiment-operation" }), "warn")
  await owner.begin(admit())

  expect(await reopened().blocker()).toBe(experimentInterruptionMessage)
  expect(warn).not.toHaveBeenCalled()
  warn.mockRestore()
})

test("an unknown hold shape opens as interrupted, warns once across every reader, and keeps the row", async () => {
  const { putInFlight, holds, reopened, listInFlight } = storedOwner()
  const warn = spyOn(Log.create({ service: "experiment-operation" }), "warn").mockImplementation(() => {})
  await putInFlight(EXPERIMENT_OPERATION_KIND, "run", { state: "running", command: 1 })
  const owner = reopened()

  expect(await owner.blocker()).toBe(experimentInterruptionMessage)
  await expect(owner.begin(async () => { throw new Error("must not admit") })).rejects.toThrow(experimentInterruptionMessage)
  // Two `/experiment clear` commands, each as the command runs them: the
  // interruption check, then the stop, on the owner and with no live runner.
  for (let clear = 0; clear < 2; clear++) {
    expect(await findExperimentInterruption(listInFlight)).toBe(experimentInterruptionMessage)
    await owner.stop(null)
    expect(await experimentStopRetirement(listInFlight, false)).toBeUndefined()
  }
  expect(owner.snapshot()).toEqual({ status: "interrupted" })
  expect(warn).toHaveBeenCalledTimes(1)
  expect(holds()).toBe(1)
  warn.mockRestore()
})

test("a refused settlement writes the pending hold again, which a reopened owner restores", async () => {
  const { owner, hold, reopened } = storedOwner()
  await owner.begin(admit())
  await owner.measured(result(4))

  expect(await owner.settle(async () => ({ outcome: "kept-pending", result: "refused" }))).toBe("refused")

  expect(hold()).toEqual({ state: "pending", result: result(4) })
  const restored = reopened()
  expect(await restored.blocker()).toBeUndefined()
  expect(restored.snapshot()).toEqual({ status: "pending", value: result(4) })
})

for (const delivery of ["measured", "failed"] as const) {
  for (const write of ["commits", "rejects"] as const) {
    test(`a stop whose write is in flight when the run is ${delivery} ends consistent when the write ${write}`, async () => {
      const { owner, holds, holdNextAppend } = storedOwner()
      await owner.begin(admit())
      const stopWrite = holdNextAppend()

      const stopping = owner.stop("/worktree").then(() => "stopped", (error: unknown) => error instanceof Error ? error.message : String(error))
      await stopWrite.entered
      // `measured` queues behind the stop's write; `failed` applies at once.
      const delivered = delivery === "measured" ? owner.measured(result(4)) : owner.failed()
      stopWrite.release(write === "rejects" ? new Error("store refused") : undefined)
      await delivered

      expect(stopWrite.stateAtWrite()).toBe("running")
      if (write === "commits") {
        expect(await stopping).toBe("stopped")
        expect(owner.snapshot()).toEqual({ status: "idle" })
        expect(holds()).toBe(0)
      } else {
        expect(await stopping).toBe("store refused")
        expect(owner.snapshot().status).toBe(delivery === "measured" ? "pending" : "interrupted")
        expect(holds()).toBe(1)
      }
    })
  }
}

test("a stop on a disposed writer is refused and keeps the result and its hold", async () => {
  const { owner, writer, holds } = storedOwner()
  await owner.begin(admit())
  await owner.measured(result(4))
  writer.dispose()

  await expect(owner.stop("/worktree")).rejects.toThrow("Experiment mode could not be recorded.")
  expect(owner.snapshot()).toEqual({ status: "pending", value: result(4) })
  expect(holds()).toBe(1)
})
