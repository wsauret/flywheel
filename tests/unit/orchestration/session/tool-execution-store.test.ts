import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { EventBus, createEmit } from "../../../../src/infra/event-bus"
import type { FlywheelEvent } from "../../../../src/infra/events"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface } from "../../../../src/infra/event-store-types"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import type { SessionRuntimeFact } from "../../../../src/orchestration/session/session-runtime-event-types"
import { createSessionToolExecutionStore, repairInterruptedToolExecutions } from "../../../../src/orchestration/session/tool-execution-store"
import { createToolExecutionProjection } from "../../../../src/orchestration/session/tool-execution-projection"

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-tool-execution-store-test-${process.pid}-${Date.now()}`,
)

let tmpDir: string

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

beforeEach(() => {
  tmpDir = makeTmpDir()
})

afterEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe("tool execution store", () => {
  it("emits trace tool events from stored tool facts", async () => {
    const sessionId = "tool-trace-1"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
    const bus = new EventBus()
    const emit = createEmit(bus)
    const events: FlywheelEvent[] = []
    bus.subscribe((event) => events.push(event))

    const toolStore = createSessionToolExecutionStore({ sessionId, projectionReader: asAsyncEventReadSurface(store), emitter: emit })

    await recordFact(writer, toolStore, toolCalledFact("tool-1", "read", { path: "a.ts" }))
    await recordFact(writer, toolStore, toolCompletedFact("tool-1", "ok"))

    toolStore.dispose()
    writer.dispose()
    store.close()

    const toolStarted = events.find((event) => event.type === "trace.tool.started")
    const toolCompleted = events.find((event) => event.type === "trace.tool.completed")
    expect(toolStarted).toMatchObject({
      type: "trace.tool.started",
      sessionId,
      data: {
        toolUseId: "tool-1",
        toolName: "read",
      },
    })
    expect(toolCompleted).toMatchObject({
      type: "trace.tool.completed",
      sessionId,
      data: {
        toolUseId: "tool-1",
        isError: false,
      },
    })
  })

  it("emits a tool's start once when a replay folds its fact while the store applies it", async () => {
    const sessionId = "tool-trace-replay-race"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
    const bus = new EventBus()
    const events: FlywheelEvent[] = []
    bus.subscribe((event) => events.push(event))
    const base = asAsyncEventReadSurface(store)
    const reading = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    // Every projection read waits until the test releases it.
    const reader: AsyncEventStateReadSurface = {
      ...base,
      readPage: async (...args) => {
        reading.resolve()
        await released.promise
        return base.readPage(...args)
      },
    }
    const toolStore = createSessionToolExecutionStore({ sessionId, projectionReader: reader, emitter: createEmit(bus) })
    try {
      const called = await writer.record(toolCalledFact("tool-race", "read", { path: "a.ts" }))
      if (!called) throw new Error("expected stored input")
      // Another holder of the session's projection starts a replay that folds
      // the fact before the store applies it.
      const replaying = toolStore.loadTimeline()
      await reading.promise
      const applying = toolStore.applyStoredFact(called)
      released.resolve()
      await Promise.all([applying, replaying])
      expect(await bus.drain()).toEqual({ kind: "drained" })
      expect(events.filter((event) => event.type === "trace.tool.started")).toHaveLength(1)
    } finally {
      toolStore.dispose()
      writer.dispose()
      store.close()
    }
  })

  it("emits a complete trace span for a terminal validation failure", async () => {
    const sessionId = "tool-trace-validation"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
    const bus = new EventBus()
    const emit = createEmit(bus)
    const events: FlywheelEvent[] = []
    bus.subscribe((event) => events.push(event))

    const toolStore = createSessionToolExecutionStore({ sessionId, projectionReader: asAsyncEventReadSurface(store), emitter: emit })

    await recordFact(writer, toolStore, {
      type: "tool.validation.failed",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "tool-blocked",
        toolName: "write",
        input: { path: "blocked.ts" },
        inputBytes: 21,
        inputSha256: "blocked-input-hash",
        inputPreview: "{\"path\":\"blocked.ts\"}",
        executionMode: "foreground",
        traceKind: "tool",
        childHasOwnViewport: false,
        reason: "blocked by policy",
      },
    })
    expect(await bus.drain()).toEqual({ kind: "drained" })

    toolStore.dispose()
    writer.dispose()
    store.close()

    expect(events.map((event) => event.type)).toEqual([
      "trace.tool.started",
      "trace.tool.completed",
    ])
    expect(events[1]).toMatchObject({
      type: "trace.tool.completed",
      data: {
        toolUseId: "tool-blocked",
        isError: true,
      },
    })
  })

  it("classifies subagent tools from stored runtime execution metadata", async () => {
    const sessionId = "subagent-trace-1"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
    const bus = new EventBus()
    const emit = createEmit(bus)
    const events: FlywheelEvent[] = []
    bus.subscribe((event) => events.push(event))

    const toolStore = createSessionToolExecutionStore({ sessionId, projectionReader: asAsyncEventReadSurface(store), emitter: emit })

    await recordFact(writer, toolStore, toolCalledFact("tool-sub", "subagent", {
      description: "write tests",
      prompt: "add coverage",
    }))
    await recordFact(writer, toolStore, toolCompletedFact("tool-sub", "tests written"))

    toolStore.dispose()
    writer.dispose()
    store.close()

    expect(events.map((event) => event.type)).toEqual([
      "trace.subagent.started",
      "trace.subagent.completed",
    ])
    expect(events[0]).toMatchObject({
      type: "trace.subagent.started",
      data: {
        toolUseId: "tool-sub",
        agentType: "subagent",
        description: "write tests",
      },
    })
  })

  it("does not let out-of-order irrelevant facts keep completed subagents active", async () => {
    const sessionId = "subagent-active-out-of-order"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
    const activeChanges: string[][] = []

    const toolStore = createSessionToolExecutionStore({
      sessionId,
      projectionReader: asAsyncEventReadSurface(store),
      onActiveSubagentsChanged: (ids) => activeChanges.push([...ids].sort()),
    })

    const called = await writer.record(toolCalledFact("sub-1", "subagent", {
      description: "review",
      prompt: "check it",
    }))
    const completed = await writer.record(toolCompletedFact("sub-1", "done"))
    const ignored = await writer.record({
      type: "model.assistant_message.recorded",
      version: 1,
      actor: "agent",
      payload: { content: [] },
    })
    if (!called || !completed || !ignored) throw new Error("expected stored events")

    await toolStore.applyStoredFact(called)
    await toolStore.applyStoredFact(ignored)
    await toolStore.applyStoredFact(completed)

    toolStore.dispose()
    writer.dispose()
    store.close()

    expect(activeChanges).toEqual([["sub-1"], []])
  })

  it("repairs crash-orphaned in-flight tool calls at runner start with input identity", async () => {
    const sessionId = "subagent-orphan-repair"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })

    await writer.record(toolCalledFact("sub-done", "subagent", { description: "done", prompt: "p" }))
    await writer.record(toolCompletedFact("sub-done", "finished"))
    await writer.record({
      type: "tool.result.acknowledged",
      version: 1,
      actor: "provider",
      payload: { toolUseId: "sub-done" },
    })
    await writer.record(toolCalledFact("sub-orphan", "subagent", { description: "orphan", prompt: "p" }, {
      parentToolUseId: "outer-code",
      modelRequestId: "request-1",
    }))
    await writer.record(toolCalledFact("ask-pending", "ask_user", {}))

    const activeChanges: string[][] = []
    const toolStore = createSessionToolExecutionStore({
      sessionId,
      projectionReader: asAsyncEventReadSurface(store),
      onActiveSubagentsChanged: (ids) => activeChanges.push([...ids].sort()),
    })
    const repaired: SessionRuntimeFact[] = []
    const repairWriter = {
      record: async (fact: SessionRuntimeFact) => {
        repaired.push(fact)
        return writer.record(fact)
      },
      transaction: writer.transaction,
    }
    await repairInterruptedToolExecutions(toolStore, repairWriter, new Set(["ask-pending"]))

    const timeline = await toolStore.loadTimeline()
    expect(timeline.find((e) => e.toolUseId === "sub-orphan")?.status).toBe("interrupted")
    expect(timeline.find((e) => e.toolUseId === "sub-done")?.status).toBe("completed")
    expect(timeline.find((e) => e.toolUseId === "sub-done")?.ackEventId).toBeDefined()
    expect(timeline.find((e) => e.toolUseId === "ask-pending")?.status).toBe("called")
    expect(repaired[0]).toMatchObject({
      type: "tool.result.recorded",
      payload: { parentToolUseId: "outer-code", modelRequestId: "request-1" },
    })
    expect(activeChanges).toEqual([[]])

    await repairInterruptedToolExecutions(toolStore, writer)

    expect(repaired).toHaveLength(1)
    toolStore.dispose()
    writer.dispose()
    store.close()
  })

  it("establishes history silently and publishes each awaited live transition once", async () => {
    const sessionId = "subagent-history-baseline"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
    await writer.record(toolCalledFact("historical", "subagent", {}))
    const activeChanges: string[][] = []
    const events: FlywheelEvent[] = []
    const bus = new EventBus()
    bus.subscribe((event) => events.push(event))
    const toolStore = createSessionToolExecutionStore({
      sessionId,
      projectionReader: asAsyncEventReadSurface(store),
      emitter: createEmit(bus),
      onActiveSubagentsChanged: (ids) => activeChanges.push([...ids]),
    })
    try {
      await toolStore.loadTimeline()
      await toolStore.loadTimeline()
      expect(activeChanges).toEqual([])
      expect(events).toEqual([])
      const called = await writer.record(toolCalledFact("live", "subagent", {}))
      if (!called) throw new Error("expected stored input")
      await toolStore.applyStoredFact(called)
      expect(activeChanges).toEqual([["historical", "live"]])
      await toolStore.applyStoredFact(called)
      const completed = await writer.record(toolCompletedFact("live", "done"))
      if (!completed) throw new Error("expected stored result")
      await toolStore.applyStoredFact(completed)
      expect(activeChanges).toEqual([["historical", "live"], ["historical"]])
      await toolStore.applyStoredFact(completed)
      await toolStore.loadTimeline()
      expect(activeChanges).toHaveLength(2)
      expect(await bus.drain()).toEqual({ kind: "drained" })
      expect(events.map((event) => event.type)).toEqual([
        "trace.subagent.started",
        "trace.subagent.completed",
      ])
    } finally {
      toolStore.dispose()
      writer.dispose()
      store.close()
    }
  })

  it("updates active subagents without scanning the tools index per fact", async () => {
    const sessionId = "subagent-active-scale"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
    const activeChanges: ReadonlySet<string>[] = []
    const toolStore = createSessionToolExecutionStore({
      sessionId,
      projectionReader: asAsyncEventReadSurface(store),
      onActiveSubagentsChanged: (ids) => activeChanges.push(ids),
    })
    const state = createToolExecutionProjection(asAsyncEventReadSurface(store), sessionId).getState()
    let toolsIndexScans = 0
    state.tools = new Proxy(state.tools, {
      ownKeys(target) {
        toolsIndexScans += 1
        return Reflect.ownKeys(target)
      },
    })

    try {
      const seedFacts = Array.from({ length: 1_000 }, (_, index) =>
        toolCalledFact(`tool-${index}`, "read", { path: `${index}.ts` }))
      const stored = await writer.recordBatch(seedFacts)
      if (!stored) throw new Error("expected session events")
      for (const fact of stored) await toolStore.applyStoredFact(fact)
      await recordFact(writer, toolStore, toolCalledFact("sub-scale", "subagent", { description: "scale", prompt: "test" }))
      await recordFact(writer, toolStore, toolCompletedFact("sub-scale", "done"))
      const beforeTimeline = toolsIndexScans
      expect(await toolStore.loadTimeline()).toHaveLength(1_001)
      expect(toolsIndexScans).toBe(beforeTimeline + 1)
    } finally {
      toolStore.dispose()
      writer.dispose()
      store.close()
    }

    expect(toolsIndexScans).toBeLessThan(10)
    expect(activeChanges.map((ids) => [...ids])).toEqual([["sub-scale"], []])
    expect(activeChanges[0]).not.toBe(activeChanges[1])
  })

  it("commits startup repairs in one ordered transaction", async () => {
    const timeline = Array.from({ length: 1_000 }, (_, index) => ({
      toolUseId: `tool-${index}`,
      toolName: "read",
      status: "called" as const,
      executionMode: "foreground" as const,
      traceKind: "tool" as const,
      childHasOwnViewport: false,
    }))
    const calls: string[] = []
    let transactions = 0
    await repairInterruptedToolExecutions({
      loadTimeline: async () => timeline,
      applyStoredFact: async () => {},
      dispose: () => {},
    }, {
      record: async (fact) => {
        const toolUseId = "toolUseId" in fact.payload ? fact.payload.toolUseId : undefined
        if (typeof toolUseId !== "string") throw new Error(`repair fact ${fact.type} has no toolUseId`)
        calls.push(toolUseId)
        return null
      },
      transaction: async (fn) => {
        transactions += 1
        fn()
      },
    })

    expect(transactions).toBe(1)
    expect(calls).toHaveLength(1_000)
    expect(calls[0]).toBe("tool-0")
    expect(calls.at(-1)).toBe("tool-999")
  })

  it("rejects terminal parent identity that conflicts with the input", async () => {
    const sessionId = "tool-parent-conflict"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
    const toolStore = createSessionToolExecutionStore({ sessionId, projectionReader: asAsyncEventReadSurface(store) })
    await recordFact(writer, toolStore, toolCalledFact("child", "read", { path: "a.ts" }, { parentToolUseId: "outer-a" }))
    const stored = await writer.record(toolCompletedFact("child", "done", { parentToolUseId: "outer-b" }))
    if (!stored) throw new Error("expected stored event")

    await expect(toolStore.applyStoredFact(stored)).rejects.toThrow("parentToolUseId")

    toolStore.dispose()
    writer.dispose()
    store.close()
  })
})

async function recordFact(
  writer: ReturnType<typeof createSessionFactWriter>,
  toolStore: ReturnType<typeof createSessionToolExecutionStore>,
  fact: SessionRuntimeFact,
): Promise<void> {
  const event = await writer.record(fact)
  if (!event) throw new Error("expected session event")
  await toolStore.applyStoredFact(event)
}

interface ToolCallIdentity {
  readonly parentToolUseId?: string
  readonly modelRequestId?: string
}

function toolCalledFact(
  toolUseId: string,
  toolName: string,
  input: { [key: string]: unknown },
  identity: ToolCallIdentity = {},
): SessionRuntimeFact {
  const inputJson = JSON.stringify(input) ?? "{}"
  return {
    type: "tool.input.completed",
    version: 1,
    actor: "agent",
    payload: {
      toolUseId,
      toolName,
      input,
      inputBytes: inputJson.length,
      inputSha256: `${toolUseId}-input-hash`,
      inputPreview: inputJson,
      executionMode: toolName === "subagent" ? "background" : "foreground",
      traceKind: toolName === "subagent" ? "subagent" : "tool",
      childHasOwnViewport: false,
      ...identity,
    },
  }
}

function toolCompletedFact(
  toolUseId: string,
  content: string,
  identity: ToolCallIdentity = {},
): SessionRuntimeFact {
  return {
    type: "tool.result.recorded",
    version: 1,
    actor: "flywheel",
    payload: {
      toolUseId,
      outcome: "ok",
      contentBytes: content.length,
      contentSha256: `${toolUseId}-content-hash`,
      contentPreview: content,
      contentTruncated: false,
      originalContentBytes: content.length,
      originalContentSha256: `${toolUseId}-content-hash`,
      ...identity,
    },
  }
}
