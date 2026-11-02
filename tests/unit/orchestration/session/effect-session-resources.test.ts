/**
 * Tests for acquireSessionResources — the actual service, not the Effect pattern.
 *
 * Injects fake factories via AcquireSessionResourcesDeps.factories, then
 * exercises acquireSessionResources directly and asserts:
 * 1. LIFO disposal order matches documented protocol.
 * 2. All finalizers run even when the main body fails.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types.js"
import { EventReaderService, EventStoreWriterLaneService, EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { createEventStoreWriterLane } from "../../../../src/infra/event-store-writer-lane.js"
import type { EventStoreWriterLane } from "../../../../src/infra/event-store-writer-lane-types.js"
import { acquireSessionResources } from "../../../../src/orchestration/session/session-resources-service.js"
import type { AcquireSessionResourcesDeps } from "../../../../src/orchestration/session/session-resources-service.js"
import type { SessionBudgetStore } from "../../../../src/orchestration/session/budget-store-types.js"
import type { SessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import type { SessionToolExecutionStore } from "../../../../src/orchestration/session/tool-execution-types.js"
import type { WorkflowContextStore } from "../../../../src/workflows/context-bundle/context-store.js"
import type { WorkflowViewStore } from "../../../../src/workflows/view/view-store.js"
import { acquireChildExecutionResources } from "../../../../src/orchestration/session/child-execution-resources.js"
import { readBackgroundCommands } from "../../../../src/orchestration/session/background-index-projection.js"
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js"
import { skillLoadedFact } from "../../../../src/workflows/skill-facts.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { createEmit, EventBus } from "../../../../src/infra/event-bus.js"
import { wireSessionSubscribers, type MetricsWriter } from "../../../../src/orchestration/session/create-session-infra.js"

// ---------------------------------------------------------------------------
// Shared state per test — reset in beforeEach
// ---------------------------------------------------------------------------

let callLog: string[]
let eventStores: EventStore[]
let writerLanes: EventStoreWriterLane[]
let storeDirectories: string[]
let queueStoreCreations: number
let contextStoreCreations: number

function record(label: string): void {
  callLog.push(label)
}

beforeEach(() => {
  callLog = []
  eventStores = []
  writerLanes = []
  storeDirectories = []
  queueStoreCreations = 0
  contextStoreCreations = 0
})

afterEach(async () => {
  for (const lane of writerLanes) await lane.dispose()
  for (const store of eventStores) store.close()
  for (const dir of storeDirectories) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Fake factories — satisfy the real interfaces, record disposal calls
// ---------------------------------------------------------------------------

function fakeCreateSessionBudgetStore(): SessionBudgetStore {
  return {
    recordRuntimeEvent: async () => {},
    applyStoredFact: async () => {},
    getTotalCost: async () => 0,
    recordInvocation: async () => {},
    getInvocationsUsed: async () => 0,
    getTokensUsed: async () => 0,
    getOutputTokensUsed: async () => 0,
    metrics: async () => ({ tokens: 0, cost: 0, billedCost: 0, priceUnavailable: false, contextPercent: 0, contextPromptTokens: 0 }),
    recordContextUtilization: async () => {},
    getContextUtilization: async () => ({ promptTokens: 0, contextWindow: 0, percent: 0 }),
    isExhausted: async () => false,
    recordProcessStarted: async () => {},
    dispose: () => record("budget.dispose"),
  }
}

function fakeCreateSessionFactWriter(): SessionFactWriter {
  return {
    record: async () => null,
    recordBatch: async () => null,
    recordGuarded: async () => null,
    transaction: async (fn) => { fn() },
    dispose: () => record("sessionEvents.dispose"),
  }
}

function fakeCreateSessionToolExecutionStore(): SessionToolExecutionStore {
  return {
    applyStoredFact: async () => {},
    loadTimeline: async () => [],
    dispose: () => record("toolExecution.dispose"),
  }
}

function fakeCreateWorkflowViewStore(): WorkflowViewStore {
  queueStoreCreations += 1
  return {
    loadQueue: async () => null,
    applyStoredFact: async () => {},
    dispose: () => record("queue.dispose"),
  }
}

function fakeCreateWorkflowContextStore(): WorkflowContextStore {
  contextStoreCreations += 1
  return {
    loadState: async () => null,
    getContext: async () => ({ request: null, priorHandoff: null, reads: [], artifacts: [], exclusions: [], earlierRounds: [] }),
    applyStoredFact: async () => {},
    dispose: () => record("context.dispose"),
  }
}


// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function createTempEventStore(): EventStore {
  const dir = mkdtempSync(join(tmpdir(), "fw-sessres-"))
  storeDirectories.push(dir)
  const store = createSqliteEventStore(join(dir, "flywheel.sqlite"))
  eventStores.push(store)
  return store
}

function createWriterLane(store: EventStore): EventStoreWriterLane {
  const lane = createEventStoreWriterLane(store)
  writerLanes.push(lane)
  return lane
}

function localAsyncWriter(store: EventStore): AsyncEventWriter {
  return {
    append: async (event) => store.append(event),
    appendBatch: async (events) => store.appendBatch(events),
    pruneSupersededEvents: async (aggregateId, eventType) => store.pruneSupersededEvents(aggregateId, eventType),
  }
}

function provideEventStoreServices<A, E, R>(effect: Effect.Effect<A, E, R>, store: EventStore) {
  return Effect.provideService(
    Effect.provideService(
      Effect.provideService(effect, EventReaderService, asAsyncEventReadSurface(store)),
      EventStoreWriterService,
      localAsyncWriter(store),
    ),
    EventStoreWriterLaneService,
    createWriterLane(store),
  )
}

function makeDeps(store: EventStore): AcquireSessionResourcesDeps {
  const emitter: import("../../../../src/infra/event-bus").EmitFn = () => {}
  return {
    sessionId: "test-session",
    projectRoot: "/scratch/test-project",
    emitter,
    projectionReader: asAsyncEventReadSurface(store),
    factories: {
      createSessionBudgetStore: fakeCreateSessionBudgetStore,
      createSessionFactWriter: fakeCreateSessionFactWriter,
      createSessionToolExecutionStore: fakeCreateSessionToolExecutionStore,
      createWorkflowViewStore: fakeCreateWorkflowViewStore,
      createWorkflowContextStore: fakeCreateWorkflowContextStore,
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acquireSessionResources", () => {
  it("disposes in LIFO order", async () => {
    const store = createTempEventStore()
    await Effect.runPromise(Effect.scoped(provideEventStoreServices(acquireSessionResources(makeDeps(store)), store)))

    expect(callLog).toEqual([
      "context.dispose",
      "queue.dispose",
      "toolExecution.dispose",
      "budget.dispose",
      "sessionEvents.dispose",
    ])
  })

  it("owns exactly one workflow queue and context projection pair", async () => {
    const store = createTempEventStore()
    await Effect.runPromise(Effect.scoped(provideEventStoreServices(acquireSessionResources(makeDeps(store)), store)))

    expect(queueStoreCreations).toBe(1)
    expect(contextStoreCreations).toBe(1)
    expect(callLog.filter((entry) => entry === "queue.dispose")).toHaveLength(1)
    expect(callLog.filter((entry) => entry === "context.dispose")).toHaveLength(1)
  })

  it("does not close the borrowed event store on success or failure", async () => {
    const realStoreDirectory = mkdtempSync(join(tmpdir(), "fw-sessres-borrowed-"))
    const realStore = createSqliteEventStore(join(realStoreDirectory, "flywheel.sqlite"))
    let closeCount = 0
    const eventStore: EventStore = { ...realStore, close: () => { closeCount += 1 } }

    try {
      await Effect.runPromise(Effect.scoped(provideEventStoreServices(acquireSessionResources(makeDeps(eventStore)), eventStore)))
      expect(closeCount).toBe(0)

      const program = provideEventStoreServices(
        Effect.scoped(
          Effect.gen(function* () {
            yield* acquireSessionResources(makeDeps(eventStore))
            yield* Effect.fail(new Error("simulated failure"))
          }),
        ),
        eventStore,
      )

      await Effect.runPromise(program).catch(() => {})
      expect(closeCount).toBe(0)
    } finally {
      realStore.close()
      rmSync(realStoreDirectory, { recursive: true, force: true })
    }
  })

  it("error path still runs all finalizers", async () => {
    const store = createTempEventStore()
    const program = provideEventStoreServices(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireSessionResources(makeDeps(store))
          yield* Effect.fail(new Error("simulated failure"))
        }),
      ),
      store,
    )

    await Effect.runPromise(program).catch(() => {})

    expect(callLog).toContain("context.dispose")
    expect(callLog).toContain("queue.dispose")
    expect(callLog).toContain("toolExecution.dispose")
    expect(callLog).toContain("budget.dispose")
    expect(callLog).toContain("sessionEvents.dispose")
  })

  it("records facts that cannot change the budget without a state read, and a budget fact updates the metrics with one read", async () => {
    const store = createTempEventStore()
    const counter = countStateRequests(asAsyncEventReadSurface(store))
    const bus = new EventBus()
    const metrics: Parameters<MetricsWriter>[0][] = []
    const deps: AcquireSessionResourcesDeps = {
      sessionId: "test-session", projectRoot: "/scratch/test-project", emitter: createEmit(bus), projectionReader: counter.reader,
    }
    await Effect.runPromise(Effect.scoped(provideEventStoreServices(Effect.gen(function* () {
      const resources = yield* acquireSessionResources(deps)
      yield* Effect.promise(async () => {
        const wired = wireSessionSubscribers(bus, resources, (patch) => { metrics.push(patch) }, "test-session")
        const emit = createEmit(bus)
        try {
          counter.take()
          // The main chat records most facts directly through its writer, and
          // runtime events reach the same writer through the durable subscriber.
          for (const name of ["first", "second", "third"]) await resources.sessionEventWriter.record(skillLoadedFact({ name }))
          emit("agent.waiting_on_subagents.recorded", { sessionId: "test-session", data: { type: "agent.waiting_on_subagents.recorded", count: 1 } })
          await wired.awaitDurableFacts()
          expect(counter.take()).toEqual([])

          emit("model.context.measured", { sessionId: "test-session", data: { type: "model.context.measured", context_prompt_tokens: 500, context_window: 1000 } })
          await wired.awaitDurableFacts()
          await bus.drain()
          expect(counter.take().map((request) => request.method)).toEqual(["readPage"])
          expect(metrics).toEqual([{ tokens: 0, cost: 0, billedCost: 0, priceUnavailable: false, contextPercent: 50, contextPromptTokens: 500 }])
        } finally {
          for (const unsubscribe of wired.unsubscribes) unsubscribe()
          await bus.dispose()
        }
      })
    }), store)))
  })
})

describe("child execution resources", () => {
  it("propagates a final tree flush failure after closing the projection", async () => {
    const store = createTempEventStore()
    const writer = asAsyncEventWriter(store)
    let failFlush = false
    let closed = false
    const resources = await acquireChildExecutionResources({
      sessionId: "child", conversationId: "child-conversation", description: "child", executionCwd: "/scratch",
      projectRoot: storeDirectories.at(-1)!,
      eventStore: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store),
      writer: {
        ...writer,
        appendBatchGuarded: async (events) => {
          if (failFlush) throw new Error("tree flush failed")
          return writer.appendBatchGuarded(events)
        },
      },
      recall: async () => ({ hits: [] }),
      attachProjection: async () => ({
        onEvent() {}, queueUserMessage() {}, lifecycle: {}, updateMetrics() {}, updateBackgroundCommands() {}, updateForegroundBash() {}, updateOperations() {},
        async dispose() { closed = true },
      }),
    })
    try {
      await resources.conversation.commitSystemTurn("child task")
      resources.conversation.beginTurn()
      await resources.conversation.recordCanonicalMessage({ kind: "assistant", content: [{ type: "text", text: "pending answer" }] })
      failFlush = true
      const result = await Promise.allSettled([resources.settle()])
      expect(result[0]).toMatchObject({
        status: "rejected", reason: expect.objectContaining({ errors: [expect.objectContaining({ message: expect.stringContaining("tree flush failed") })] }),
      })
      expect(closed).toBe(true)
    } finally {
      await resources.settle().catch(() => {})
    }
  })

  it.each([false, true])("joins repeated disposal and propagates projection close failure: %s", async (failClose) => {
    const store = createTempEventStore()
    const closing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let closeCount = 0
    const resources = await acquireChildExecutionResources({
      sessionId: "child", conversationId: "child-conversation", description: "child", executionCwd: "/scratch",
      projectRoot: storeDirectories.at(-1)!,
      eventStore: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store),
      writer: localAsyncWriter(store), recall: async () => ({ hits: [] }),
      attachProjection: async () => ({
        onEvent() {}, queueUserMessage() {}, lifecycle: {}, updateMetrics() {}, updateBackgroundCommands() {}, updateForegroundBash() {}, updateOperations() {},
        async dispose() {
          closeCount += 1
          closing.resolve()
          await release.promise
          if (failClose) throw new Error("projection close failed")
        },
      }),
    })
    try {
      const first = resources.settle()
      const second = resources.settle()
      expect(second).toBe(first)
      let settled = false
      const joined = Promise.allSettled([first, second]).then((results) => { settled = true; return results })
      await closing.promise
      expect(settled).toBe(false)
      release.resolve()
      const results = await joined
      expect(closeCount).toBe(1)
      expect(results.map((result) => result.status)).toEqual(failClose ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"])
      if (failClose) await expect(resources.settle()).rejects.toThrow("Child execution disposal failed")
    } finally {
      release.resolve()
      await resources.settle().catch(() => {})
    }
  })

  it("records a fact that cannot change the budget without a state read, and a budget fact still updates the card", async () => {
    const store = createTempEventStore()
    const counter = countStateRequests(asAsyncEventReadSurface(store))
    const contextPercents: number[] = []
    const resources = await acquireChildExecutionResources({
      sessionId: "child", conversationId: "child-conversation", description: "child", executionCwd: "/scratch",
      projectRoot: storeDirectories.at(-1)!,
      eventStore: asAsyncEventReadSurface(store), projectionReader: counter.reader,
      writer: localAsyncWriter(store), recall: async () => ({ hits: [] }),
      attachProjection: async () => ({
        onEvent() {}, queueUserMessage() {}, lifecycle: {}, updateBackgroundCommands() {}, updateForegroundBash() {}, updateOperations() {},
        updateMetrics(metrics) { contextPercents.push(metrics.contextPercent) },
        async dispose() {},
      }),
    })
    try {
      counter.take()
      // Every skill load, tool result, and stream summary of an agent records
      // through this writer. Under a large workflow the state reads queue
      // behind every agent's writes, so each read here delays the record.
      for (const name of ["first", "second", "third"]) await resources.eventWriter.record(skillLoadedFact({ name }))
      expect(counter.take()).toEqual([])
      await resources.eventWriter.record({ type: "model.context.measured", version: 1, actor: "provider", payload: { promptTokens: 500, contextWindow: 1000 } })
      expect(contextPercents.at(-1)).toBe(50)
    } finally {
      await resources.settle()
    }
  })

  // The background index of the child's session lists the commands its own
  // registry records, and the record schema refuses a key it does not declare.
  it("records a child's background command in its own session", async () => {
    const store = createTempEventStore()
    const resources = await acquireChildExecutionResources({
      sessionId: "child", conversationId: "child-conversation", description: "child", executionCwd: "/scratch",
      projectRoot: storeDirectories.at(-1)!,
      eventStore: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store),
      writer: localAsyncWriter(store), recall: async () => ({ hits: [] }),
      attachProjection: async () => ({
        onEvent() {}, queueUserMessage() {}, lifecycle: {}, updateMetrics() {}, updateBackgroundCommands() {}, updateForegroundBash() {}, updateOperations() {},
        async dispose() {},
      }),
    })
    try {
      resources.onEvent(createRuntimeEvent("tool.background_command.recorded", { toolUseId: "toolu_wait", processId: "bash-bg-1", description: "wait for the gate", startedAtMs: 1, state: "running" }))
      await resources.awaitDurableFacts()
      const commands = await readBackgroundCommands(asAsyncEventReadSurface(store), "child")
      expect(commands.get("toolu_wait")?.state).toBe("running")
    } finally {
      await resources.settle()
    }
  })

  it("closes acquired resources when projection initialization fails", async () => {
    const store = createTempEventStore()
    let closed = false
    await expect(acquireChildExecutionResources({
      sessionId: "child", conversationId: "child-conversation", description: "child", executionCwd: "/scratch",
      projectRoot: storeDirectories.at(-1)!,
      eventStore: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store),
      writer: localAsyncWriter(store), recall: async () => ({ hits: [] }),
      attachProjection: async () => ({
        onEvent() {}, queueUserMessage() {}, lifecycle: {}, updateBackgroundCommands() {}, updateForegroundBash() {}, updateOperations() {},
        updateMetrics() { throw new Error("initial metrics failed") },
        async dispose() { closed = true },
      }),
    })).rejects.toThrow("initial metrics failed")
    expect(closed).toBe(true)
  })
})
