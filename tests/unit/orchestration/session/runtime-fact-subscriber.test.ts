import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "bun:test"
import { DebugLog, scanDebugLogFiles } from "../../../../src/infra/debug-log.js"
import { createEmit, EventBus } from "../../../../src/infra/event-bus.js"
import { PersistenceWriteRefused, type StoredFact } from "../../../../src/infra/event-store-types.js"
import type { SessionBudgetStore } from "../../../../src/orchestration/session/budget-store-types.js"
import {
  subscribeSessionRuntimeFacts,
  wireSessionSubscribers,
} from "../../../../src/orchestration/session/create-session-infra.js"
import type { SessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import type { SessionRuntimeFact } from "../../../../src/orchestration/session/session-runtime-event-types.js"
import type { SessionToolExecutionStore } from "../../../../src/orchestration/session/tool-execution-types.js"
import { presentationChannel } from "../../../../src/infra/error-presentation.js"
import {
  disposeHeadlessRuntimeEvents,
  disposeHeadlessTaskResources,
} from "../../../../src/orchestration/headless/run-headless-task.js"

function fakeWriter(record: (fact: SessionRuntimeFact) => Promise<StoredFact | null>): SessionFactWriter {
  return {
    record,
    recordBatch: async () => null,
    recordGuarded: async () => null,
    flush: async () => ({ kind: "drained", acked: [] }),
    drain: async () => { throw new Error("mid-session durability must not close the writer lane") },
    transaction: async (fn) => { fn() },
    dispose() {},
  }
}

function stored(fact: SessionRuntimeFact, position: number): StoredFact {
  return {
    aggregateId: "session:s1",
    sessionId: "s1",
    id: `event-${position}`,
    position,
    seq: position - 1,
    timestamp: position,
    type: fact.type,
    version: fact.version,
    actor: fact.actor,
    payload: fact.payload,
  }
}

function budgetStore(applied: StoredFact[]): SessionBudgetStore {
  return {
    recordRuntimeEvent: async () => {},
    applyStoredFact: async (event) => { applied.push(event) },
    getTotalCost: async () => 0,
    recordInvocation: async () => {},
    getInvocationsUsed: async () => 0,
    getTokensUsed: async () => 0,
    getOutputTokensUsed: async () => 0,
    metrics: async () => ({ tokens: 0, cost: 0, billedCost: 0, priceUnavailable: false, contextPercent: 0, contextPromptTokens: 0 }),
    recordContextUtilization: async () => {},
    getContextUtilization: async () => ({ promptTokens: 0, contextWindow: 0, percent: 0 }),
    isExhausted: async () => false,
    dispose() {},
    recordProcessStarted: async () => {},
  }
}

function toolStore(applied: StoredFact[]): SessionToolExecutionStore {
  return { applyStoredFact: async (event) => { applied.push(event) }, loadTimeline: async () => [], dispose() {} }
}

describe("session runtime fact subscription", () => {
  it("records bus-delivered tool input and result facts in event order", async () => {
    const bus = new EventBus()
    const facts: SessionRuntimeFact[] = []
    const subscription = subscribeSessionRuntimeFacts(bus, {
      sessionEventWriter: fakeWriter(async (fact) => {
        facts.push(fact)
        return stored(fact, facts.length)
      }),
    })
    const emit = createEmit(bus)

    emit("tool.input.completed", {
      sessionId: "s1",
      data: {
        type: "tool.input.completed",
        model_request_id: "request-1",
        tool_use: {
          id: "tool-1",
          name: "read",
          provider_call_id: "call-1",
          provider_tool_name: "read",
          executable_tool_name: "read",
          input: { path: "src/example.ts" },
          execution: { mode: "foreground", trace_kind: "tool" },
        },
      },
    })
    emit("tool.result.recorded", {
      sessionId: "s1",
      data: {
        type: "tool.result.recorded",
        tool_use_id: "tool-1",
        content: [{ type: "text", text: "ok" }],
        is_error: false,
      },
    })

    await bus.drain()

    expect(facts.map((fact) => fact.type)).toEqual(["tool.input.completed", "tool.result.recorded"])
    expect(subscription.getPersistenceFailure()).toBeNull()
    subscription.unsubscribe()
    await bus.dispose()
  })

  it("projects tool facts while budget publication belongs to the writer", async () => {
    const bus = new EventBus()
    const budgetApplied: StoredFact[] = []
    const toolApplied: StoredFact[] = []
    let position = 0
    const wiring = wireSessionSubscribers(bus, {
      budgetStore: budgetStore(budgetApplied),
      sessionEventWriter: fakeWriter(async (fact) => stored(fact, ++position)),
      toolExecutionStore: toolStore(toolApplied),
    })

    createEmit(bus)("agent.error.observed", {
      sessionId: "s1",
      data: { message: "boom" },
    })
    await bus.drain()

    expect(budgetApplied).toEqual([])
    expect(toolApplied.map((event) => event.type)).toEqual(["agent.error.observed"])
    for (const unsub of wiring.unsubscribes) unsub()
    await bus.dispose()
  })


  it("awaits durable subscriber delivery before reporting command facts available", async () => {
    const bus = new EventBus()
    const budgetApplied: StoredFact[] = []
    const toolApplied: StoredFact[] = []
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const wiring = wireSessionSubscribers(bus, {
      budgetStore: budgetStore(budgetApplied),
      sessionEventWriter: fakeWriter(async (fact) => {
        started.resolve()
        await release.promise
        return stored(fact, 1)
      }),
      toolExecutionStore: toolStore(toolApplied),
    })

    createEmit(bus)("agent.error.observed", { sessionId: "s1", data: { message: "boom" } })
    const barrier = wiring.awaitDurableFacts()
    await started.promise
    expect(toolApplied).toEqual([])
    release.resolve()
    await barrier
    expect(toolApplied.map((event) => event.type)).toEqual(["agent.error.observed"])

    for (const unsub of wiring.unsubscribes) unsub()
    await bus.dispose()
  })

  it.each([new Error("disk unavailable"), new PersistenceWriteRefused(129, 128)])("surfaces durable subscriber persistence failure through the evidence barrier: %s", async (failure) => {
    const bus = new EventBus()
    const wiring = wireSessionSubscribers(bus, {
      budgetStore: budgetStore([]),
      sessionEventWriter: fakeWriter(async () => { throw failure }),
      toolExecutionStore: toolStore([]),
    })

    createEmit(bus)("agent.error.observed", { sessionId: "s1", data: { message: "lost" } })
    if (failure instanceof PersistenceWriteRefused) await expect(wiring.awaitDurableFacts()).rejects.toBe(failure)
    else await expect(wiring.awaitDurableFacts()).rejects.toThrow("disk unavailable")

    for (const unsub of wiring.unsubscribes) unsub()
    await bus.dispose()
  })
  it("raises persistence failure as a transient emergency toast", async () => {
    const bus = new EventBus()
    const presentations: string[] = []
    bus.subscribeToType("agent.notice.changed", (event) => {
      if (event.data.operation.type === "upsert") presentations.push(presentationChannel(event.data.operation.notice.presentation))
    }, { deliveryClass: "ui", label: "runtime-fact-drop-test" })
    const writer = fakeWriter(async () => { throw new Error("disk unavailable") })
    const subscription = subscribeSessionRuntimeFacts(bus, { sessionEventWriter: writer })

    createEmit(bus)("agent.error.observed", {
      sessionId: "s1",
      data: { message: "lost" },
    })
    await bus.drain()

    expect(presentations).toEqual(["toast"])
    expect(subscription.getPersistenceFailure()?.message).toBe("disk unavailable")
    subscription.unsubscribe()
    await bus.dispose()
  })

  it("resolves the dropped-write notice once persistence recovers", async () => {
    const bus = new EventBus()
    const operations: Array<{ type: string; id?: string; message?: string }> = []
    bus.subscribeToType("agent.notice.changed", (event) => {
      const operation = event.data.operation
      operations.push(operation.type === "upsert"
        ? { type: operation.type, id: operation.notice.id, message: operation.notice.message }
        : operation.type === "resolve"
          ? { type: operation.type, id: operation.id }
          : { type: operation.type })
    }, { deliveryClass: "ui", label: "runtime-fact-recovery-test" })
    let fail = true
    let position = 0
    const writer = fakeWriter(async (fact) => {
      if (fail) throw new Error("database is locked")
      position += 1
      return stored(fact, position)
    })
    const subscription = subscribeSessionRuntimeFacts(bus, { sessionEventWriter: writer })
    const emit = createEmit(bus)

    emit("agent.error.observed", {
      sessionId: "s1",
      data: { message: "lost" },
    })
    await bus.drain()
    fail = false
    emit("agent.error.observed", {
      sessionId: "s1",
      data: { message: "recovered" },
    })
    await bus.drain()
    // A drop after recovery starts a fresh streak with a fresh count.
    fail = true
    emit("agent.error.observed", {
      sessionId: "s1",
      data: { message: "lost again" },
    })
    await bus.drain()

    expect(operations).toEqual([
      { type: "upsert", id: "runtime-fact-persistence-drop", message: "1 runtime fact was dropped after persistence retries: database is locked" },
      { type: "resolve", id: "runtime-fact-persistence-drop" },
      { type: "upsert", id: "runtime-fact-persistence-drop", message: "1 runtime fact was dropped after persistence retries: database is locked" },
    ])
    // The accessor still reports the first drop for headless evidence checks.
    expect(subscription.getPersistenceFailure()?.message).toBe("database is locked")
    subscription.unsubscribe()
    await bus.dispose()
  })

  it("reports a missing stored-event acknowledgement when the caller requires durable evidence", async () => {
    const bus = new EventBus()
    const subscription = subscribeSessionRuntimeFacts(bus, {
      sessionEventWriter: fakeWriter(async () => null),
      requireStoredFacts: true,
    })

    createEmit(bus)("agent.error.observed", {
      sessionId: "s1",
      data: { message: "not acknowledged" },
    })
    await bus.drain()

    expect(subscription.getPersistenceFailure()?.message).toContain("was not acknowledged")
    subscription.unsubscribe()
    await bus.dispose()
  })

  it("reports strict runtime-event mapping failures", async () => {
    const bus = new EventBus()
    const subscription = subscribeSessionRuntimeFacts(bus, {
      sessionEventWriter: fakeWriter(async (fact) => stored(fact, 1)),
      requireStoredFacts: true,
    })

    createEmit(bus)("budget.stream.completed", { sessionId: "s1", data: {} })
    await bus.drain()

    expect(subscription.getPersistenceFailure()?.message).toContain("budget.stream.completed missing stream identity")
    subscription.unsubscribe()
    await bus.dispose()
  })

  it("awaits bus delivery before headless writer disposal", async () => {
    const bus = new EventBus()
    const timeline: string[] = []
    let releaseRecord: (() => void) | undefined
    const recordGate = new Promise<void>((resolve) => { releaseRecord = resolve })
    const writer = fakeWriter(async (fact) => {
      timeline.push(`record:${fact.type}:started`)
      await recordGate
      timeline.push(`record:${fact.type}:finished`)
      return null
    })
    subscribeSessionRuntimeFacts(bus, { sessionEventWriter: writer })
    createEmit(bus)("agent.error.observed", {
      sessionId: "s1",
      data: { message: "pending" },
    })

    const disposing = disposeHeadlessRuntimeEvents(bus, {
      ...writer,
      dispose() { timeline.push("writer:disposed") },
    })
    await Promise.resolve()
    expect(timeline).not.toContain("writer:disposed")

    releaseRecord?.()
    await disposing

    expect(timeline).toEqual([
      "record:agent.error.observed:started",
      "record:agent.error.observed:finished",
      "writer:disposed",
    ])
  })

  it("keeps message content out of the debug log and the store, and routes a breadcrumb to the debug log", async () => {
    const baseDir = path.join(os.tmpdir(), `flywheel-runtime-fact-debug-${process.pid}-${crypto.randomUUID()}`)
    fs.mkdirSync(baseDir, { recursive: true })
    try {
      await DebugLog.init({ dir: baseDir })
      const bus = new EventBus()
      const facts: SessionRuntimeFact[] = []
      const subscription = subscribeSessionRuntimeFacts(bus, {
        sessionEventWriter: fakeWriter(async (fact) => {
          facts.push(fact)
          return stored(fact, facts.length)
        }),
      })
      const emit = createEmit(bus)

      emit("model.user_message.recorded", {
        sessionId: "s1",
        data: { message: { content: "pasted text that belongs to the conversation", origin: "user" } },
      })
      emit("model.assistant_message.recorded", {
        sessionId: "s1",
        data: { message: { content: [{ type: "text", text: "assistant text that belongs to the conversation" }] } },
      })
      emit("agent.workflow_link.published", {
        sessionId: "s1",
        data: { tool_use_id: "tool-1", link_uri: "flywheel://session/child" },
      })
      await bus.drain()

      // Nothing durable was recorded for any of the three families.
      expect(facts).toEqual([])
      expect(subscription.getPersistenceFailure()).toBeNull()
      subscription.unsubscribe()
      await bus.dispose()
      await DebugLog.close()

      const logDir = path.join(baseDir, ".flywheel", "log")
      const files = fs.readdirSync(logDir).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(logDir, name))
      const records = [...scanDebugLogFiles(files, { sessionId: "s1" })]
      expect(records.map((record) => record.type)).toEqual(["agent.workflow_link.published"])
      expect(files.map((file) => fs.readFileSync(file, "utf8")).join("")).not.toContain("belongs to the conversation")
    } finally {
      await DebugLog.close()
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it("attempts every cleanup stage but skips lifecycle publication after failure", async () => {
    const timeline: string[] = []

    await expect(disposeHeadlessTaskResources({
      closeBackground: async () => { timeline.push("background"); throw new Error("background failed") },
      awaitForegroundBash: async () => { timeline.push("bash-settlement") },
      disposeForegroundBash: () => { timeline.push("bash-dispose"); throw new Error("bash dispose failed") },
      awaitTurnFlush: async () => { timeline.push("turn-flush") },
      disposeTree: async () => { timeline.push("tree") },
      disposeRecallIndex: async () => { timeline.push("recall-index") },
      disposeRuntimeEvents: async () => { timeline.push("runtime-events") },
      updateLifecycle: async () => { timeline.push("lifecycle") },
      getPersistenceFailure: () => new Error("fact failed"),
    })).rejects.toThrow("background failed; bash dispose failed; fact failed")

    expect(timeline).toEqual(["background", "bash-settlement", "bash-dispose", "turn-flush", "tree", "recall-index", "runtime-events"])
  })

  it("publishes inactive after every required stage succeeds", async () => {
    let lifecyclePublications = 0
    await disposeHeadlessTaskResources({
      closeBackground: async () => {},
      awaitForegroundBash: async () => {},
      disposeForegroundBash: () => {},
      awaitTurnFlush: async () => {},
      disposeTree: async () => {},
      disposeRecallIndex: async () => {},
      disposeRuntimeEvents: async () => {},
      updateLifecycle: async () => { lifecyclePublications += 1 },
      getPersistenceFailure: () => null,
    })
    expect(lifecyclePublications).toBe(1)
  })
})
