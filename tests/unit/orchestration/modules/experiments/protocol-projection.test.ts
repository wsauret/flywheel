import { composeModuleRuntimes } from "../../../../../src/infra/module-runtime.js"
import { experimentsRuntime } from "../../../../../src/orchestration/modules/experiments/runtime.js"
import { afterEach, describe, expect, it } from "bun:test"
import { asAsyncEventReadSurface, type EventReader, type StoredFact } from "../../../../../src/infra/event-store-types.js"
import { releaseHeldProjections } from "../../../../../src/infra/projection-registry.js"
import { createExperimentViewProtocolProjection, createExperimentViewProtocolReader, experimentViewFromSnapshot } from "../../../../../src/orchestration/modules/experiments/protocol.js"
import { createRuntimeUiPatchSequencer } from "../../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { createExperimentOperation, type ExperimentOperation, type PendingExperimentResult } from "../../../../../src/orchestration/modules/experiments/operation-owner.js"
import type { ChatRunner } from "../../../../../src/orchestration/chat/runner-types.js"
import type { ExperimentFact } from "../../../../../src/orchestration/modules/experiments/facts.js"
import type { SessionEntry } from "../../../../../src/orchestration/session-store/types.js"
import type { ViewedSessionStore } from "../../../../../src/orchestration/app-service/session-view-projection.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js"
import { chatEntry } from "../../app-service/app-service-doubles.js"
import { chatRunner } from "../../app-service/_frontend-projection-fixtures.js"
import { storedExperimentFact } from "../../agent-runtime/tools/_fixtures.js"

// Settle asynchronous replay and the publisher's microtask batch.
const flush = () => new Promise<void>((resolve) => { setImmediate(resolve) })

const readers: EventReader[] = []
afterEach(() => {
  for (const reader of readers) releaseHeldProjections(asAsyncEventReadSurface(reader))
  readers.length = 0
})

function mode(active: boolean): ExperimentFact {
  return { type: "experiment.mode.changed", version: 1, actor: "flywheel", payload: { active, workDir: active ? "/repo" : null } }
}

function initialized(segment: number, name = `segment-${segment}`): ExperimentFact {
  return {
    type: "experiment.initialized", version: 1, actor: "flywheel",
    payload: { segment, name, metricName: "latency_ms", metricUnit: "ms", direction: "lower", measureCommand: "measure", checksCommand: null, workDir: "/repo", maxIterations: null, protectedPaths: [], sealedPaths: [] },
  }
}

function run(runNumber: number, segment: number, metric: number, status: "keep" | "discard" | "crash" | "checks_failed" = "keep"): ExperimentFact {
  return {
    type: "experiment.run.recorded", version: 1, actor: "flywheel",
    payload: { run: runNumber, segment, commit: `commit${runNumber}`, metric, metrics: { memory_mb: 20 + runNumber }, status, description: `run ${runNumber}`, confidence: null, durationMs: 100 * runNumber },
  }
}

class FactLog {
  readonly events: StoredFact[] = []
  private readonly listeners = new Set<(events: readonly StoredFact[]) => void>()
  readonly reader: EventReader

  constructor() {
    this.reader = inMemoryEventReader(this.events)
    readers.push(this.reader)
  }

  onStored = (listener: (events: readonly StoredFact[]) => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Append durably, then broadcast like the store's post-commit hook. */
  commit(sessionId: string, fact: ExperimentFact, overrides: Partial<StoredFact> = {}): StoredFact {
    const position = this.events.length + 1
    const stored: StoredFact = {
      aggregateId: `session:${sessionId}`, type: fact.type, version: fact.version, timestamp: position, actor: fact.actor,
      sessionId, payload: fact.payload, position, id: `${sessionId}-${position}`, seq: this.events.filter((event) => event.sessionId === sessionId).length,
      ...overrides,
    }
    this.events.push(stored)
    for (const listener of this.listeners) listener([stored])
    return stored
  }
}

function sessionStore(entries: Map<string, SessionEntry>) {
  const listeners = new Set<(changed: ReadonlySet<string> | undefined) => void>()
  const revisions = new Map<string, number>()
  const store = {
    get: (sessionId: string) => entries.get(sessionId),
    allIds: () => [...entries.keys()],
    revision: (sessionId: string) => revisions.get(sessionId) ?? 0,
    onChange: (listener: (changed: ReadonlySet<string> | undefined) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } satisfies ViewedSessionStore
  return {
    store,
    subscribers: () => listeners.size,
    set(sessionId: string, entry: SessionEntry | null) {
      if (entry) entries.set(sessionId, entry)
      else entries.delete(sessionId)
      revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1)
      for (const listener of listeners) listener(undefined)
    },
  }
}

const result = (latency: number): PendingExperimentResult => ({ status: "passed", metrics: { latency }, durationMs: 0, measuredTree: "tree", resultTree: "tree" })

function experimentOperation(): ExperimentOperation {
  return createExperimentOperation({ listInFlight: async () => [], putInFlight: async () => {}, record: async (fact) => storedExperimentFact(fact) })
}

async function begin(operation: ExperimentOperation, command: string): Promise<void> {
  await operation.begin(async () => ({ command }))
}

function runnerWith(operation: ExperimentOperation): ChatRunner {
  return { ...chatRunner("chat-1"), moduleRuntimes: composeModuleRuntimes([[experimentsRuntime.moduleId, { operation }]]) }
}

/** The reader with every fact-reading entry point counted. */
function countingReader(reader: EventReader, onRead: () => void): EventReader {
  return {
    ...reader,
    read: (...args) => { onRead(); return reader.read(...args) },
    readTolerant: (...args) => { onRead(); return reader.readTolerant(...args) },
    currentPosition: () => { onRead(); return reader.currentPosition() },
  }
}

function harness(entries: Map<string, SessionEntry>, log = new FactLog()) {
  const store = sessionStore(entries)
  const inputs: RuntimeUiPatchInput[] = []
  const sequencer = createRuntimeUiPatchSequencer()
  const projection = createExperimentViewProtocolProjection({
    sessionStore: store.store,
    reader: asAsyncEventReadSurface(log.reader),
    onStored: log.onStored,
    publish: (input) => { inputs.push(input); return sequencer.publish(input) },
  })
  const kinds = () => inputs.map((input) => input.payload.kind)
  const views = () => inputs.flatMap((input) => input.payload.kind === "experiment_view.updated" ? [input.payload.experimentView] : [])
  return { store, log, inputs, projection, kinds, views }
}

describe("experiment view protocol projection", () => {
  it("builds nothing before the first snapshot and exactly one owner after it", async () => {
    const log = new FactLog()
    let reads = 0
    const reader = countingReader(log.reader, () => { reads += 1 })
    readers.push(reader)
    const store = sessionStore(new Map([["chat-1", chatEntry()]]))
    const projection = createExperimentViewProtocolProjection({ sessionStore: store.store, reader: asAsyncEventReadSurface(reader), onStored: log.onStored, publish: createRuntimeUiPatchSequencer().publish })

    expect(reads).toBe(0)
    expect(store.subscribers()).toBe(0)

    await projection.snapshot("chat-1")
    await projection.snapshot("chat-1")
    expect(reads).toBeGreaterThan(0)
    expect(store.subscribers()).toBe(1)
    projection.dispose()
    expect(store.subscribers()).toBe(0)
  })

  it("returns null for a session without experiment history and a history view with running false", async () => {
    const log = new FactLog()
    log.commit("chat-2", mode(true))
    log.commit("chat-2", initialized(0))
    log.commit("chat-2", run(1, 0, 10))
    log.commit("chat-2", run(2, 0, 12, "discard"))
    const { projection } = harness(new Map([["chat-1", chatEntry()], ["chat-2", chatEntry()]]), log)

    expect(await projection.snapshot("chat-1")).toBeNull()
    expect(await projection.snapshot("chat-2")).toEqual({
      name: "segment-0",
      metric: { name: "latency_ms", unit: "ms" },
      secondaryMetrics: [{ name: "memory_mb", unit: "mb" }],
      direction: "lower",
      segment: 0,
      baseline: 10,
      best: 10,
      confidence: null,
      runCounts: { total: 2, kept: 1, discarded: 1, crashed: 0, checksFailed: 0 },
      runs: [
        { run: 1, segment: 0, commit: "commit1", metric: 10, metrics: { memory_mb: 21 }, status: "keep", description: "run 1", confidence: null, durationMs: 100 },
        { run: 2, segment: 0, commit: "commit2", metric: 12, metrics: { memory_mb: 22 }, status: "discard", description: "run 2", confidence: null, durationMs: 200 },
      ],
      active: true,
      running: false,
    })
    projection.dispose()
  })

  it("running follows the live operation exactly and never tool facts", async () => {
    const execution = experimentOperation()
    const entry = chatEntry({ runner: runnerWith(execution) })
    const log = new FactLog()
    log.commit("chat-1", mode(true))
    log.commit("chat-1", initialized(0))
    const { projection, views, kinds } = harness(new Map([["chat-1", entry]]), log)
    // Serving the snapshot is the delivery baseline; it publishes nothing.
    expect((await projection.snapshot("chat-1"))?.running).toBe(false)
    await flush()
    expect(kinds()).toEqual([])

    await begin(execution, "measure")
    await flush()
    expect(views().map((view) => view.running)).toEqual([true])

    await execution.measured(result(8))
    await flush()
    expect(views().map((view) => view.running)).toEqual([true, false])

    // A recorded run is history, not execution: the row lands, running stays false.
    log.commit("chat-1", run(1, 0, 8))
    await flush()
    const last = views().at(-1)
    expect(last?.running).toBe(false)
    expect(last?.runs).toHaveLength(1)

    await execution.settle(async () => ({ outcome: "settled", result: undefined }))
    await flush()
    expect(views()).toHaveLength(3)

    // A stopped run's command still executes in the worktree until it returns.
    await begin(execution, "again")
    await execution.stop(null)
    await flush()
    expect(views().map((view) => view.running).slice(3)).toEqual([true])
    await execution.measured(result(9))
    await flush()
    expect(views().map((view) => view.running).slice(3)).toEqual([true, false])
    projection.dispose()
  })

  it("follows module runtime generations on the same chat runner and releases the old owner", async () => {
    const first = experimentOperation()
    const second = experimentOperation()
    let modules = composeModuleRuntimes([[experimentsRuntime.moduleId, { operation: first }]])
    const listeners = new Set<(value: typeof modules) => void>()
    const runner: ChatRunner = {
      ...chatRunner("chat-1"),
      get moduleRuntimes() { return modules },
      onModuleRuntimesChange(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    }
    const { projection, log, views } = harness(new Map([["chat-1", chatEntry({ runner })]]))
    log.commit("chat-1", initialized(0))
    expect((await projection.snapshot("chat-1"))?.running).toBe(false)
    await begin(first, "first")
    await flush()
    expect(views().at(-1)?.running).toBe(true)
    modules = composeModuleRuntimes([[experimentsRuntime.moduleId, { operation: second }]])
    for (const listener of listeners) listener(modules)
    await flush()
    expect(views().at(-1)?.running).toBe(false)
    const published = views().length
    await first.measured(result(8))
    await flush()
    expect(views()).toHaveLength(published)
    await begin(second, "second")
    await flush()
    expect(views().at(-1)?.running).toBe(true)
    projection.dispose()
    expect(listeners.size).toBe(0)
  })

  it("publishes ordered updates per commit and isolates a malformed session as a removal", async () => {
    const log = new FactLog()
    log.commit("good", initialized(0))
    log.commit("bad", initialized(0))
    const { projection, kinds, views } = harness(new Map([["good", chatEntry()], ["bad", chatEntry()]]), log)
    expect((await projection.snapshot("good"))?.name).toBe("segment-0")
    expect((await projection.snapshot("bad"))?.name).toBe("segment-0")

    log.commit("good", run(1, 0, 10))
    await flush()
    log.commit("good", run(2, 0, 9))
    await flush()
    expect(views().map((view) => view.runs.length)).toEqual([1, 2])
    expect(views().map((view) => view.best)).toEqual([10, 9])

    log.commit("bad", run(1, 0, 10), { payload: { ...run(1, 0, 10).payload, status: "invented" } })
    await flush()
    expect(kinds().at(-1)).toBe("experiment_view.removed")
    expect(await projection.snapshot("bad")).toBeNull()
    expect((await projection.snapshot("good"))?.runs).toHaveLength(2)
    projection.dispose()
  })

  it("keeps durable rows with running false when a session departs, then releases its subscription", async () => {
    const execution = experimentOperation()
    await begin(execution, "measure")
    const { projection, store, log, views } = harness(new Map([["chat-1", chatEntry({ runner: runnerWith(execution) })]]))
    log.commit("chat-1", initialized(0))
    log.commit("chat-1", run(1, 0, 10))
    expect((await projection.snapshot("chat-1"))?.running).toBe(true)

    store.set("chat-1", null)
    await flush()
    expect(views().at(-1)).toMatchObject({ running: false, runs: [{ run: 1 }] })
    expect(await projection.snapshot("chat-1")).toBeNull()

    execution.failed()
    await flush()
    expect(views()).toHaveLength(1)
    projection.dispose()
  })

  it("does not publish an update when unrelated session fields move", async () => {
    const log = new FactLog()
    log.commit("chat-1", initialized(0))
    const { projection, store, inputs } = harness(new Map([["chat-1", chatEntry()]]), log)
    const first = await projection.snapshot("chat-1")
    store.set("chat-1", chatEntry({ tokens: 99 }))
    await flush()
    expect(await projection.snapshot("chat-1")).toEqual(first)
    expect(inputs).toHaveLength(0)
    projection.dispose()
  })

  it("the background reader serves history with running false and holds one projection per session", async () => {
    const log = new FactLog()
    log.commit("old", mode(true))
    log.commit("old", initialized(0))
    log.commit("old", run(1, 0, 10))
    log.commit("old", initialized(1, "second"))
    log.commit("old", run(2, 1, 20, "crash"))
    const read = createExperimentViewProtocolReader(asAsyncEventReadSurface(log.reader))

    const view = await read("old")
    expect(view).toMatchObject({ name: "second", segment: 1, running: false, runCounts: { total: 1, kept: 0, crashed: 1 } })
    expect(view?.runs.map((row) => row.segment)).toEqual([0, 1])
    log.commit("old", run(3, 1, 18))
    expect((await read("old"))?.runs).toHaveLength(3)
    expect(await read("never")).toBeNull()
  })

  it("publishes the experiment of a session that goes live when no read of it reached this process", async () => {
    // The control client answers a read of a session that has no runtime from
    // history, so the session's runtime is the first sign of it here.
    const { store, log, views, projection } = harness(new Map())
    store.set("chat-1", chatEntry())
    await flush()
    log.commit("chat-1", mode(true))
    log.commit("chat-1", initialized(0, "speed"))
    await flush()
    await flush()

    expect(views().at(-1)).toMatchObject({ name: "speed", active: true, running: false })
    projection.dispose()
  })

  it("shows an active mode without initialization as an empty view", () => {
    const view = experimentViewFromSnapshot({
      mode: { active: true, workDir: "/repo" }, configuration: null, segments: [], runs: [], currentSegment: 0, secondaryMetrics: [],
      resumedTurns: 0, baselineMetric: null, bestMetric: null, confidence: null, protectedPaths: [], sealedPaths: [],
    }, false)
    expect(view).toMatchObject({ name: null, metric: { name: "metric", unit: "" }, active: true, running: false, runs: [] })
  })
})
