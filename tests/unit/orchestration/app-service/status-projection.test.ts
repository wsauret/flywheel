import { afterAll, describe, expect, mock, spyOn, test } from "bun:test"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedRuntime, Schema } from "effect"
import { createStatusProjection } from "../../../../src/orchestration/app-service/status-projection.js"
import { createOutputProjection } from "../../../../src/orchestration/app-service/output-projection.js"
import { createShippedOutput } from "../../../../src/orchestration/app-service/shipped-output.js"
import { RuntimeStatusSnapshotResultSchema, StatusPatchPayloadSchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import type { StatusPatchPayload, StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { replyWaitLabel, WAITING_ON_PARENT } from "../../../../src/protocol/client/session-controls.js"
import { createSessionStore } from "../../../../src/orchestration/session-store/store.js"
import { EventReaderService, EventStoreLive } from "../../../../src/infra/event-store-effect.js"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import type { StoredFact } from "../../../../src/infra/event-store-types.js"
import { NO_CHANGED_TOOLS, type OutputChangeBatch } from "../../../../src/infra/output/output-block-delta.js"
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { entry, flush, NOTHING_OWED, sink, store, until } from "./_status-projection-fixtures.js"
import { createProcessorClaims } from "../../../../src/orchestration/agent-runtime/tools/processor-claims.js"
import { makeMockOwnedProcess } from "../agent-runtime/tools/_bash-fixtures.js"

const dbDirectory = mkdtempSync(join(tmpdir(), "fw-status-projection-"))
const dbFile = join(dbDirectory, "flywheel.sqlite")
const runtime = ManagedRuntime.make(EventStoreLive(dbFile))
afterAll(async () => {
  await runtime.dispose()
  rmSync(dbDirectory, { recursive: true, force: true })
})

describe("status projection", () => {
  test("runnerState/streamPhase/connectionState changes publish one coalesced status patch", async () => {
    const s = store({ "chat-1": entry() })
    const out = sink()
    const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...NOTHING_OWED })

    s.set("chat-1", entry({ runnerState: "streaming", streamPhase: "thinking", connectionState: "retrying" }))
    s.set("chat-1", entry({ runnerState: "streaming", streamPhase: "generating", connectionState: "connected", streamingOutputChars: 12 }))
    await flush()

    expect(out.patches).toHaveLength(1)
    expect(out.patches[0]!.cursor).toEqual({ scope: "session", domain: "status", sessionId: "chat-1" })
    expect(out.patches[0]!.payload).toEqual({
      kind: "status.updated",
      status: expect.objectContaining({ activity: "generating", connectionState: "connected" }),
    })
    projection.dispose()
  })

  test("background descriptor changes publish regardless of runner activity", async () => {
    const s = store({ "chat-1": entry({ runnerState: "idle" }) })
    const out = sink()
    const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...NOTHING_OWED })

    s.set("chat-1", entry({
      runnerState: "idle",
      activeBackgroundCommands: [{ id: "bg-1", description: "server", toolUseId: "toolu_bg", startedAtMs: 123 }],
    }))
    await flush()

    const payload = out.patches.at(-1)?.payload
    expect(payload).toMatchObject({
      kind: "status.updated",
      status: { activeSubagentCount: 0, activeBackgroundCommands: [{ toolUseId: "toolu_bg" }] },
    })
    expect(payload).toEqual(Schema.decodeUnknownSync(StatusPatchPayloadSchema, { onExcessProperty: "error" })(payload))
    projection.dispose()
  })

  test("a replacement parent's running snapshot publishes zero when its last child settles during seeding", async () => {
    const s = store({ "chat-1": entry() })
    const out = sink()
    const seeding = Promise.withResolvers<void>()
    let reads = 0
    const projection = createStatusProjection({
      sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...NOTHING_OWED,
      replyWaits: { ...NOTHING_OWED.replyWaits, addressees: async () => { if (++reads === 1) await seeding.promise; return [] } },
    })
    const tasks = createBackgroundWorkRegistry({
      kind: "chat", enqueueNotification: () => {},
      onChange: (commands) => s.set("chat-1", entry({ activeBackgroundCommands: commands })),
    })
    const done = Promise.withResolvers<BackgroundWorkResult>()
    try {
      await Promise.resolve()
      tasks.track({
        done: done.promise, hostClose: "detach", kill: { run: () => {} },
        meta: { id: "child", type: "workflow", toolUseId: "launch", description: "Surviving child", settlementOwner: "child_session" },
      })
      const snapshot = projection.snapshot("chat-1").then(async (status) => {
        expect(status?.activeBackgroundCommands).toHaveLength(1)
        done.resolve({ status: "completed", content: "" })
        expect(await tasks.waitProcess("child")).toBe(true)
        return status
      })
      await flush()
      seeding.resolve()
      await snapshot
      await flush()
      expect(tasks.activeBackgroundCommands()).toEqual([])
      expect(out.patches.at(-1)?.payload).toMatchObject({
        kind: "status.updated", status: { activeBackgroundCommands: [] },
      })
    } finally {
      seeding.resolve()
      done.resolve({ status: "completed", content: "" })
      await tasks.terminateAll()
      projection.dispose()
    }
  })

  test("foreground Bash hold changes coalesce and remain session-specific", async () => {
    const s = store({ "chat-1": entry(), "chat-2": entry() })
    const out = sink()
    const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...NOTHING_OWED })

    s.set("chat-1", entry({ activeForegroundBashToolCallIds: ["toolu_1"] }))
    s.set("chat-1", entry({ activeForegroundBashToolCallIds: ["toolu_1", "toolu_2"] }))
    s.set("chat-1", entry({ activeForegroundBashToolCallIds: ["toolu_2"] }))
    await flush()

    expect(out.patches).toHaveLength(1)
    expect(out.patches[0]?.cursor).toEqual({ scope: "session", domain: "status", sessionId: "chat-1" })
    expect(out.patches[0]?.payload).toMatchObject({
      kind: "status.updated",
      status: { activeForegroundBashToolCallIds: ["toolu_2"] },
    })
    expect((await projection.snapshot("chat-2"))?.activeForegroundBashToolCallIds).toEqual([])
    projection.dispose()
  })

  test("a processor hold change republishes the held tool calls of its session only", async () => {
    const s = store({ "chat-1": entry({ runnerState: "streaming" }), "chat-2": entry({ runnerState: "streaming" }) })
    const out = sink()
    const claims = createProcessorClaims()
    const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...NOTHING_OWED, processorHolds: claims })
    claims.claim(makeMockOwnedProcess({ token: "owned:a", exited: new Promise(() => {}) }), { order: 1, exempt: false, sessionId: "chat-1", toolUseId: "toolu_1" })
    expect((await projection.snapshot("chat-1"))?.processorHeldToolCallIds).toEqual([])

    claims.applyHolds([{ token: "owned:a", ahead: 2 }])
    await until("the held patch", () => out.patches.length === 1)
    expect(out.patches[0]?.cursor).toEqual({ scope: "session", domain: "status", sessionId: "chat-1" })
    expect(out.patches[0]?.payload).toMatchObject({ kind: "status.updated", status: { processorHeldToolCallIds: ["toolu_1"] } })
    expect((await projection.snapshot("chat-2"))?.processorHeldToolCallIds).toEqual([])

    claims.applyHolds([])
    await until("the released patch", () => out.patches.length === 2)
    expect(out.patches[1]?.payload).toMatchObject({ kind: "status.updated", status: { processorHeldToolCallIds: [] } })
    projection.dispose()
  })

  test("a store mutation with no status-field change publishes no patch", async () => {
    const s = store({ "chat-1": entry() })
    const out = sink()
    const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...NOTHING_OWED })

    s.set("chat-1", entry({ tokens: 99, cost: 0.42, contextPercent: 50 }))
    await flush()

    expect(out.patches).toHaveLength(0)
    projection.dispose()
  })

  test("a streamed character count publishes no status for any number of sessions or changes, and an activity change still publishes one", async () => {
    const streaming = (chars: number, streamPhase: "generating" | "thinking" = "generating") => entry({ runnerState: "streaming", streamPhase, streamingOutputChars: chars })
    for (const sessions of [1, 8]) {
      const ids = Array.from({ length: sessions }, (_, index) => `chat-${index}`)
      const s = store(Object.fromEntries(ids.map((id) => [id, streaming(0)])))
      const out = sink()
      const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...NOTHING_OWED })
      for (const id of ids) await projection.snapshot(id)
      const before = out.patches.length

      for (let chars = 1; chars <= 20; chars++) for (const id of ids) s.set(id, streaming(chars))
      await flush()
      expect(out.patches.length - before).toBe(0)

      s.set("chat-0", streaming(21, "thinking"))
      await flush()
      expect(out.patches.slice(before)).toEqual([expect.objectContaining({ payload: { kind: "status.updated", status: expect.objectContaining({ activity: "thinking" }) } })])
      projection.dispose()
    }
  })

  test("only exact idle reads and publishes the output position", async () => {
    const s = store({ "chat-1": entry({ runnerState: "streaming", streamPhase: "thinking" }) })
    const out = sink()
    let reads = 0
    let flushes = 0
    const projection = createStatusProjection({
      sessionStore: s.store,
      publish: out.publish,
      flushOutput: async () => { flushes += 1 },
      outputPosition: (sessionId) => {
        reads += 1
        return out.outputPosition(sessionId)
      },
      ...NOTHING_OWED,
    })

    expect((await projection.snapshot("chat-1"))?.settledOutputPosition).toBeNull()
    expect(reads).toBe(0)
    expect(flushes).toBe(0)
    s.set("chat-1", entry({ runnerState: "idle" }))
    await flush()
    expect((await projection.snapshot("chat-1"))?.settledOutputPosition).toBe(0)
    expect(reads).toBeGreaterThan(0)
    expect(flushes).toBeGreaterThan(0)
    projection.dispose()
  })

  test("schema round-trips status snapshot/patch and rejects budget fields", () => {
    const status: StatusView = { activity: "thinking", activityStartedAt: 2, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 1, activeBackgroundCommands: [{ id: "subagent", description: "review", toolUseId: "toolu_sub", startedAtMs: 1, model: "claude-opus-4-6", effort: "xhigh", roleSessionId: "child-review" }, { id: "bg", description: "server", toolUseId: "toolu_bg", startedAtMs: 2 }], activeForegroundBashToolCallIds: ["toolu_fg"], processorHeldToolCallIds: ["toolu_bg"], waitingOnBackgroundWork: false, startedAt: 1, streamingStartedAt: 2, accumulatedActiveMs: 3, compactionStartedAt: null, replyWaits: [{ sessionId: "parent", name: "Design chat" }] }
    const snapshot = { snapshotPosition: 1, views: [{ sessionId: "s1", view: status }] }
    const patch: StatusPatchPayload = { kind: "status.updated", status }

    expect(Schema.decodeUnknownSync(RuntimeStatusSnapshotResultSchema)(snapshot)).toEqual(snapshot)
    expect(Schema.decodeUnknownSync(StatusPatchPayloadSchema)(patch)).toEqual(patch)
    expect(() => Schema.decodeUnknownSync(StatusPatchPayloadSchema)({ kind: "status.updated", status: { ...status, settledOutputPosition: undefined } })).toThrow()
    expect(() => Schema.decodeUnknownSync(StatusPatchPayloadSchema)({ kind: "status.updated", status: { ...status, activeForegroundBashToolCallIds: undefined } })).toThrow()
    expect(() => Schema.decodeUnknownSync(StatusPatchPayloadSchema)({ kind: "status.updated", status: { ...status, activeBackgroundCommands: [{ id: "invalid", description: "invalid", toolUseId: "toolu_invalid" }] } })).toThrow()
    expect(() => Schema.decodeUnknownSync(StatusPatchPayloadSchema)({ kind: "status.updated", status: { ...status, activeBackgroundCommands: [{ id: "invalid", description: "invalid", toolUseId: "toolu_invalid", model: "claude-opus-4-6" }] } })).toThrow()
    expect(() => Schema.decodeUnknownSync(StatusPatchPayloadSchema)({ kind: "status.updated", status: { ...status, activeBackgroundCommands: [{ id: "invalid", description: "invalid", toolUseId: "toolu_invalid", startedAtMs: 1, effort: "high" }] } }, { onExcessProperty: "error" })).toThrow()
    expect(() => Schema.decodeUnknownSync(StatusPatchPayloadSchema)({ kind: "status.updated", status: { ...status, cost: 1, contextPercent: 1 } }, { onExcessProperty: "error" })).toThrow()
  })

  test.each(["snapshot", "store", "refresh"] as const)("idle status anchors after deferred output publication through %s", async (source) => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const out = sink()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const published = Promise.withResolvers<void>()
    const initialized = Promise.withResolvers<void>()
    const outputProjection = createOutputProjection({
      sessionStore, shipped: createShippedOutput({ publish: out.publish }),
      projectBlock: async (_sessionId, block) => {
        started.resolve()
        await release.promise
        return block
      },
    })
    const statusProjection = createStatusProjection({
      sessionStore,
      publish: (input) => {
        const patch = out.publish(input)
        if (input.payload.kind === "status.updated") initialized.resolve()
        if (input.payload.kind === "status.updated" && input.payload.status.settledOutputPosition !== null
          && out.patches.some((item) => item.payload.kind === "output.delta")) published.resolve()
        return patch
      },
      flushOutput: outputProjection.flush, outputPosition: out.outputPosition, ...NOTHING_OWED,
    })
    sessionStore.openSessionRuntime({ sessionId: "chat-order", conversationId: "conv-order" })
    sessionStore.updateChatEntry("chat-order", { runnerState: "idle" })
    await initialized.promise
    await statusProjection.snapshot("chat-order")
    out.patches.length = 0
    const block: AnyBlock = { kind: "text", id: "answer", content: "done", timestamp: 1 }
    const outputChanges: OutputChangeBatch = { changes: [{ kind: "upsert", index: 0, block }], fullResync: false, changedTools: NO_CHANGED_TOOLS }
    sessionStore.updateChatEntry("chat-order", { outputBlocks: [block], visibleMessageCountSuffix: 1, outputChanges })
    const pending = source === "snapshot" ? statusProjection.snapshot("chat-order") : undefined
    if (source === "refresh") statusProjection.refresh("chat-order")
    await started.promise
    expect(out.patches).toEqual([])
    sessionStore.openSessionRuntime({ sessionId: "chat-independent", conversationId: "conv-independent" })
    sessionStore.updateChatEntry("chat-independent", { runnerState: "streaming", streamPhase: "generating" })
    let independentStatus: StatusView | null | undefined
    const independent = statusProjection.snapshot("chat-independent").then((status) => { independentStatus = status })
    await flush()
    try {
      expect(independentStatus).toMatchObject({ activity: "generating", settledOutputPosition: null })
    } finally {
      release.resolve()
    }
    await independent
    const snapshot = await pending
    await published.promise
    const ordered = out.patches.filter((patch) => patch.cursor.scope === "session" && patch.cursor.sessionId === "chat-order")
    expect(ordered.map((patch) => patch.payload.kind)).toEqual(["output.delta", "status.updated"])
    const outputPatch = ordered[0]!
    if (source === "snapshot") expect(snapshot?.settledOutputPosition).toBe(outputPatch.position)
    expect(out.patches.some((patch) => patch.payload.kind === "status.updated"
      && patch.cursor.scope === "session"
      && patch.cursor.sessionId === "chat-order"
      && patch.payload.status.settledOutputPosition === outputPatch.position)).toBe(true)
    outputProjection.dispose()
    statusProjection.dispose()
  })

  test("a streaming child's card refreshes delay neither the idle status of its parent nor the status of another session", async () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const out = sink()
    const storedListeners = new Set<(facts: readonly StoredFact[]) => void>()
    const childFact: StoredFact = { id: "child-fact", position: 1, seq: 0, timestamp: 1, actor: "flywheel", aggregateId: "session:child", sessionId: "child", type: "chat.entries.appended", version: 3, payload: {} }
    const childStreams = { now: true }
    let cardProjections = 0
    const outputProjection = createOutputProjection({
      sessionStore, shipped: createShippedOutput({ publish: out.publish }),
      onStored: (listener) => { storedListeners.add(listener); return () => { storedListeners.delete(listener) } },
      // A projection of the child's card takes longer than the child takes
      // to change again, as a child that streams does many times a second.
      projectBlock: async (_sessionId, block) => {
        if (block.kind !== "tool" || block.id !== "card") return block
        cardProjections += 1
        await Bun.sleep(2)
        return { kind: "agentGroup", containerKind: "subagent", id: "card", toolUseId: "launch", label: "Explorer", description: "Searching", agentType: "explorer", status: "active", children: [], totalToolCount: 0, timestamp: 1, linkUri: "flywheel://session/child" }
      },
    })
    const statusProjection = createStatusProjection({ sessionStore, publish: out.publish, flushOutput: outputProjection.flush, outputPosition: out.outputPosition, ...NOTHING_OWED })
    const child = (async () => {
      while (childStreams.now) {
        for (const listener of storedListeners) listener([childFact])
        await Bun.sleep(1)
      }
    })()
    const statusOf = (sessionId: string, activity: StatusView["activity"]) => out.patches.find((patch) => patch.cursor.scope === "session"
      && patch.cursor.sessionId === sessionId && patch.payload.kind === "status.updated" && patch.payload.status.activity === activity)
    try {
      const card: AnyBlock = { kind: "tool", id: "card", name: "subagent", presentation: { name: "Subagent", detail: "explore" }, status: "streaming", timestamp: 1 }
      sessionStore.openSessionRuntime({ sessionId: "parent", conversationId: "conv-parent" })
      sessionStore.updateChatEntry("parent", { runnerState: "streaming", streamPhase: "generating", outputBlocks: [card], visibleMessageCountSuffix: 1, outputChanges: { changes: [{ kind: "upsert", index: 0, block: card }], fullResync: false, changedTools: NO_CHANGED_TOOLS } })
      // The child's changes keep the parent's card projecting.
      await until("the card to project three times", () => cardProjections >= 3)

      // Another session starts and comes to rest while the child streams.
      sessionStore.openSessionRuntime({ sessionId: "other", conversationId: "conv-other" })
      sessionStore.updateChatEntry("other", { runnerState: "streaming", streamPhase: "generating" })
      await until("the other session's working status", () => statusOf("other", "generating") !== undefined)
      sessionStore.updateChatEntry("other", { runnerState: "idle", streamPhase: null })
      await until("the other session's idle status", () => statusOf("other", "idle") !== undefined)
      expect(childStreams.now).toBe(true)

      const answer: AnyBlock = { kind: "text", id: "answer", content: "done", timestamp: 2 }
      sessionStore.updateChatEntry("parent", { runnerState: "idle", streamPhase: null, outputBlocks: [card, answer], visibleMessageCountSuffix: 2, outputChanges: { changes: [{ kind: "upsert", index: 1, block: answer }], fullResync: false, changedTools: NO_CHANGED_TOOLS } })
      await until("the parent's idle status", () => statusOf("parent", "idle") !== undefined)
      const idle = statusOf("parent", "idle")
      // The child still streams, and the parent's own output was published before its idle status.
      expect(childStreams.now).toBe(true)
      expect(idle?.payload).toMatchObject({ status: { settledOutputPosition: expect.any(Number) } })
      const answered = out.patches.find((patch) => patch.payload.kind === "output.delta" && patch.payload.delta.blocks.some((delta) => delta.blockId.includes("answer")))
      expect(answered && idle && answered.position < idle.position).toBe(true)
    } finally {
      childStreams.now = false
      await child
      outputProjection.dispose()
      statusProjection.dispose()
    }
  })

  test("a session whose output cannot be projected still shows idle, after its output cursor is invalidated", async () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const out = sink()
    const outputProjection = createOutputProjection({
      sessionStore, shipped: createShippedOutput({ publish: out.publish }),
      projectBlock: async () => { throw new Error("state read refused") },
    })
    const statusProjection = createStatusProjection({ sessionStore, publish: out.publish, flushOutput: outputProjection.flush, outputPosition: out.outputPosition, ...NOTHING_OWED })
    sessionStore.openSessionRuntime({ sessionId: "chat-failed", conversationId: "conv-failed" })
    sessionStore.updateChatEntry("chat-failed", { runnerState: "streaming", streamPhase: "generating" })
    await statusProjection.snapshot("chat-failed")
    await flush()
    out.patches.length = 0
    const block: AnyBlock = { kind: "text", id: "answer", content: "done", timestamp: 1 }
    const outputChanges: OutputChangeBatch = { changes: [{ kind: "upsert", index: 0, block }], fullResync: false, changedTools: NO_CHANGED_TOOLS }
    sessionStore.updateChatEntry("chat-failed", { runnerState: "idle", streamPhase: null, outputBlocks: [block], visibleMessageCountSuffix: 1, outputChanges })
    await Bun.sleep(5)

    expect(out.patches.map((patch) => patch.payload.kind)).toEqual(["runtime.invalidate", "status.updated"])
    expect(out.patches[1]?.payload).toMatchObject({ status: { activity: "idle", settledOutputPosition: out.patches[0]?.position } })
    outputProjection.dispose()
    statusProjection.dispose()
  })
})

describe("status of a session a planned replacement cut", () => {
  /** A runtime in which a successor owes a continuation to each session in
   *  `owed`, and whose store holds the rows of the commands `handedOver`
   *  names by session. */
  function owing(owed: Set<string>, handedOver = new Map<string, StatusView["activeBackgroundCommands"]>(), storedWaits = new Map<string, readonly { sessionId: string; name: string; openedAtMs: number; isParent: boolean }[]>()) {
    const stored = new Set<(facts: readonly StoredFact[]) => void>()
    const keptListeners = new Set<(sessionId: string) => void>()
    let reads = 0
    return {
      deps: {
        awaitsContinuation: async (sessionId: string) => { reads += 1; return owed.has(sessionId) },
        recordedActiveMs: async () => 4_000,
        onStored(listener: (facts: readonly StoredFact[]) => void) {
          stored.add(listener)
          return () => { stored.delete(listener) }
        },
        handedOver: {
          commands: async (sessionId: string) => handedOver.get(sessionId) ?? [],
          onChange(listener: (sessionId: string) => void) {
            keptListeners.add(listener)
            return () => { keptListeners.delete(listener) }
          },
        },
        replyWaits: { ...NOTHING_OWED.replyWaits, addressees: async (sessionId: string) => storedWaits.get(sessionId) ?? [] },
        processorHolds: NOTHING_OWED.processorHolds,
      },
      handedOverChanged(sessionId: string): void {
        for (const listener of keptListeners) listener(sessionId)
      },
      reads: () => reads,
      store(sessionId: string): void {
        const fact: StoredFact = { id: `fact-${sessionId}`, position: 1, seq: 0, aggregateId: `session:${sessionId}`, sessionId, timestamp: 1, actor: "flywheel", type: "chat.entries.appended", version: 1, payload: {} }
        for (const listener of stored) listener([fact])
      },
    }
  }

  test.each([false, true])("a session at rest that a successor will continue shows waiting, with no settlement barrier, until nothing owes it (background work: %s)", async (waitingOnBackgroundWork) => {
    const owed = new Set(["chat-1"])
    const successor = owing(owed)
    const s = store({ "chat-1": entry({ runnerState: "idle", waitingOnBackgroundWork }), "chat-2": entry({ runnerState: "idle" }) })
    const out = sink()
    const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...successor.deps })
    await flush()

    expect(await projection.snapshot("chat-1")).toMatchObject({ activity: "waiting", activityStartedAt: null, settledOutputPosition: null })
    expect(await projection.snapshot("chat-2")).toMatchObject({ activity: "idle" })
    owed.delete("chat-1")
    projection.refresh("chat-1")
    await flush()
    expect(out.patches.at(-1)?.payload).toMatchObject({ kind: "status.updated", status: { activity: "idle" } })
    projection.dispose()
  })

  test("a turn-end record that lands after the runner rested shows the session working, and a running session's facts read nothing", async () => {
    const owed = new Set<string>()
    const successor = owing(owed)
    const s = store({ "chat-1": entry({ runnerState: "idle" }), "chat-2": entry({ runnerState: "streaming", streamPhase: "thinking" }) })
    const out = sink()
    const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...successor.deps })
    await flush()
    const readsAtRest = successor.reads()

    owed.add("chat-1")
    owed.add("chat-2")
    successor.store("chat-1")
    successor.store("chat-2")
    await flush()

    expect(out.patches.map((patch) => [patch.cursor.scope === "session" ? patch.cursor.sessionId : undefined, patch.payload])).toEqual([
      ["chat-1", { kind: "status.updated", status: expect.objectContaining({ activity: "waiting" }) }],
    ])
    expect(successor.reads()).toBe(readsAtRest + 1)
    projection.dispose()
  })

  test("the session keeps a working status parked on its stored reply waits after its runner is released, and a session no runner holds answers while it is owed", async () => {
    const owed = new Set(["chat-1", "chat-3"])
    const waits = [{ sessionId: "parent", name: "Design chat", openedAtMs: 1234, isParent: true }]
    const publishedWaits = [{ sessionId: "parent", name: "Design chat" }]
    // chat-2 is a waiter a person interrupted: nothing owes it a turn.
    const successor = owing(owed, new Map(), new Map([["chat-1", waits], ["chat-2", waits], ["chat-3", waits]]))
    const s = store({ "chat-1": entry({ runnerState: "idle" }), "chat-2": entry({ runnerState: "idle" }) })
    const out = sink()
    const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...successor.deps })
    await flush()
    // The turn a successor resumes reads as parked on its stored wait, so its
    // card names the wait, before its run parks on the wait again.
    expect(replyWaitLabel(await projection.snapshot("chat-1") ?? undefined, "parent")).toBe(WAITING_ON_PARENT)
    expect((await projection.snapshot("chat-1"))?.activityStartedAt).toBe(1234)
    expect(replyWaitLabel(await projection.snapshot("chat-2") ?? undefined, "parent")).toBeUndefined()

    s.delete("chat-1")
    s.delete("chat-2")
    await flush()

    const released = new Map(out.patches.map((patch) => [patch.cursor.scope === "session" ? patch.cursor.sessionId : undefined, patch.payload]))
    expect(released.get("chat-1")).toEqual({ kind: "status.updated", status: expect.objectContaining({ activity: "waiting", settledOutputPosition: null, accumulatedActiveMs: 4_000, waitingOnBackgroundWork: true, replyWaits: publishedWaits }) })
    expect(released.get("chat-2")).toEqual({ kind: "status.removed" })
    expect(await projection.snapshot("chat-3")).toMatchObject({ activity: "waiting", activityStartedAt: 1234, accumulatedActiveMs: 4_000, waitingOnBackgroundWork: true, replyWaits: publishedWaits })
    expect(await projection.snapshot("chat-4")).toBeNull()

    // The successor's resume of chat-3 was refused before a runner held it:
    // the status its snapshot delivered is withdrawn.
    owed.delete("chat-3")
    projection.refresh("chat-3")
    await flush()
    expect(out.patches.at(-1)).toMatchObject({ cursor: { sessionId: "chat-3" }, payload: { kind: "status.removed" } })
    projection.dispose()
  })

  test("a fact of a session no runner holds withdraws the working status it was shown once nothing owes it, and reads nothing for a session shown none", async () => {
    const owed = new Set(["chat-1", "chat-2"])
    const successor = owing(owed)
    const s = store({ "chat-2": entry({ runnerState: "idle" }) })
    const out = sink()
    const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...successor.deps })
    await flush()
    // chat-1's working status went out in a snapshot reply, and chat-2's
    // when its runner was released.
    expect(await projection.snapshot("chat-1")).toMatchObject({ activity: "waiting" })
    s.delete("chat-2")
    await flush()
    const reads = successor.reads()

    // A person's interrupt records their turn end over each cut.
    owed.clear()
    successor.store("chat-1")
    successor.store("chat-2")
    successor.store("chat-5")
    await flush()

    const withdrawn = out.patches.slice(-2).map((patch) => [patch.cursor.scope === "session" ? patch.cursor.sessionId : undefined, patch.payload])
    expect(withdrawn).toEqual([["chat-1", { kind: "status.removed" }], ["chat-2", { kind: "status.removed" }]])
    expect(successor.reads()).toBe(reads + 2)
    projection.dispose()
  })

  test("a session no runner holds shows the command handed to it with Stop while its row stands, and withdraws it when the keeper says it changed", async () => {
    const server = { id: "bash-bg-server", description: "bun run dev", toolUseId: "toolu_server", startedAtMs: 7 }
    const handedOver = new Map([["workflow-paused", [server]]])
    const successor = owing(new Set(), handedOver)
    const s = store({})
    const out = sink()
    const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...successor.deps })
    await flush()

    expect(await projection.snapshot("workflow-paused")).toMatchObject({ activity: "idle", activeBackgroundCommands: [server] })
    handedOver.delete("workflow-paused")
    successor.handedOverChanged("workflow-paused")
    await flush()
    expect(out.patches.at(-1)).toMatchObject({ cursor: { sessionId: "workflow-paused" }, payload: { kind: "status.removed" } })
    projection.dispose()
  })
  test("a refresh whose reads fail is recorded at WARN, and a later refresh still publishes", async () => {
    spyOn(DebugLog, "isOpen").mockReturnValue(true)
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    const server = { id: "bash-bg-server", description: "bun run dev", toolUseId: "toolu_server", startedAtMs: 7 }
    const successor = owing(new Set(), new Map([["workflow-paused", [server]]]))
    let refuse = true
    const s = store({})
    const out = sink()
    const projection = createStatusProjection({ sessionStore: s.store, publish: out.publish, flushOutput: async () => {}, outputPosition: out.outputPosition, ...successor.deps, handedOver: {
      ...successor.deps.handedOver,
      commands: async (sessionId) => {
        if (refuse) throw new Error("state read refused")
        return successor.deps.handedOver.commands(sessionId)
      },
    } })
    try {
      successor.handedOverChanged("workflow-paused")
      await flush()
      refuse = false
      successor.handedOverChanged("workflow-paused")
      await flush()

      expect(record.mock.calls.map(([input]) => input).filter((input) => input.type === "log.warn")).toEqual([
        expect.objectContaining({ sessionId: "workflow-paused", payload: expect.objectContaining({ message: "status refresh failed", error: "state read refused" }) }),
      ])
      expect(out.patches.at(-1)).toMatchObject({ cursor: { sessionId: "workflow-paused" }, payload: { kind: "status.updated", status: { activeBackgroundCommands: [server] } } })
    } finally {
      projection.dispose()
      mock.restore()
    }
  })
})
