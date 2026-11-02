import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { FrontendEvent, RuntimeChatDefault, SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { runtimeQueryResultSchema, type RuntimeBackgroundSummaryResult } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { workspaceDomainCursor } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection, type FrontendProjection, type SessionChange } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { runRuntimeShutdownBarrier } from "../../../../src/orchestration/app-service/runtime-shutdown.js"
import { chatEntry, fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"
import { durableRow, durableSessionFromCatalogRow, managerWithSessions } from "./_frontend-projection-fixtures.js"
import { readyCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import type { SessionEntry } from "../../../../src/orchestration/session-store/types.js"
import { FIXTURE_EXECUTION_CWD } from "../../../helpers/directories.js";
const noopOutputProjection = { flush: async () => {}, watch: () => {}, dispose: () => {} }
const awaitProjectionFlush = (): Promise<void> => Bun.sleep(1)

function readyRow(row: SessionCatalogRow, overrides: Partial<Extract<SessionCatalogRow, { readonly totalsLoading: false }>> = {}): Extract<SessionCatalogRow, { readonly totalsLoading: false }> {
  return readyCatalogRow(row, {
    totalCost: 0,
    totalBilledCost: 0,
    priceUnavailable: false,
    totalTokens: 0,
    contextPercent: 0,
    contextPromptTokens: 0,
    durationMs: 0,
    ...overrides,
  })
}

describe("FlywheelAppService", () => {
  test("an internal bus listener attached before the first client does not disable catalog publication", async () => {
    let sessions = [durableRow("chat-1")]
    const store = fakeSessionStore(new Map<string, SessionEntry>())
    const manager = fakeManager({
      listMetadata: async () => ({ sessions, errors: [] }),
      listForIds: async (ids) => ({ sessions: sessions.filter((session) => ids.includes(session.id)), errors: [] }),
      read: async (id) => durableSessionFromCatalogRow(sessions.find((session) => session.id === id)),
    })
    const projection = createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD, maxSnapshotHz: 1000 })
    const bus = createRuntimeUiBus()
    // Mirror runtime-composition: an internal consumer (the spend-consent
    // notification materializer) subscribes at build time, before any client.
    bus.addListener(() => {})
    const service = createFlywheelAppService({ projection, runtimeSupervisor: runtimeSupervisor(), bus, projectRoot: FIXTURE_EXECUTION_CWD, ...fakeProjections() })
    const events: FrontendEvent[] = []
    const unsubscribe = service.subscribe((event) => { events.push(event) })

    sessions = [...sessions, durableRow("chat-1", { kind: "chat", command: "chat" })]
    manager.emitChange(["chat-1"])
    await Bun.sleep(5)
    await bus.drain()

    const added = events.filter((event) => event.type === "patch" && event.patch.payload.kind === "session.added" && event.patch.cursor.scope === "session" && event.patch.cursor.sessionId === "chat-1")
    expect(added).toHaveLength(1)
    unsubscribe()
  })

  test("snapshot returns plain serializable catalog rows without foreground id or outputBlocks", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const projection = createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD })
    const service = createFlywheelAppService({ projectRoot: FIXTURE_EXECUTION_CWD, projection, runtimeSupervisor: runtimeSupervisor(), bus: createRuntimeUiBus(), ...fakeProjections(), outputProjection: noopOutputProjection })

    const snapshot = await service.query({ type: "snapshot" })

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
    expect("foregroundId" in snapshot).toBe(false)
    expect("activeSessionId" in snapshot).toBe(false)
    expect(snapshot.rows).toHaveLength(1)
    expect(snapshot.rows[0]?.title).toBe("Chat title")
    expect("outputBlocks" in snapshot.rows[0]!).toBe(false)
  })

  test("snapshot and chat default patches carry the same canonical assignment", async () => {
    const chatDefault = { kind: "model", model: "anthropic/claude-sonnet-4", effort: "high" as const } as const
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      runtimeSupervisor: runtimeSupervisor(),
      bus: createRuntimeUiBus(),
      ...fakeProjections(),
      outputProjection: noopOutputProjection,
      chatDefault: () => chatDefault,
    })
    const patches: FrontendEvent[] = []
    service.subscribe((event) => patches.push(event))

    service.publish({ cursor: workspaceDomainCursor("chat_default"), payload: { kind: "chat_default.changed", chatDefault } })
    const snapshot = await service.query({ type: "snapshot" })
    const decoded = Schema.decodeUnknownSync(runtimeQueryResultSchema("snapshot"))(JSON.parse(JSON.stringify(snapshot)))

    expect(decoded).toEqual(snapshot)
    expect(snapshot.chatDefault).toEqual(chatDefault)
    expect(patches).toContainEqual(expect.objectContaining({
      type: "patch",
      patch: expect.objectContaining({ payload: { kind: "chat_default.changed", chatDefault } }),
    }))
  })

  test("snapshot round-trips a canonical none chat default", async () => {
    const store = fakeSessionStore(new Map())
    const manager = managerWithSessions([])
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      runtimeSupervisor: runtimeSupervisor(),
      bus: createRuntimeUiBus(),
      ...fakeProjections(),
      outputProjection: noopOutputProjection,
      chatDefault: (): RuntimeChatDefault => ({ kind: "none" }),
    })

    const snapshot = await service.query({ type: "snapshot" })
    expect(Schema.decodeUnknownSync(runtimeQueryResultSchema("snapshot"))(snapshot)).toEqual(snapshot)
    expect(snapshot.chatDefault).toEqual({ kind: "none" })
  })

  test("budgetSnapshot keeps the durable budget and sessionDetail uses the whole latest live status", async () => {
    const store = fakeSessionStore(new Map());
    const manager = fakeManager();
    const projections = fakeProjections();
    const budget = { totalsLoading: false as const, tokens: 250, cost: 12, billedCost: 5, priceUnavailable: true, contextPercent: 40, contextPromptTokens: 2_000 };
    let historyRead = false
    let live = false
    const latestStatus = {
      activity: "generating" as const, activityStartedAt: 2000, settledOutputPosition: null, connectionState: "connected" as const,
      activeSubagentCount: 0, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false,
      startedAt: 0, streamingStartedAt: 2000, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
    }
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      runtimeSupervisor: runtimeSupervisor(),
      bus: createRuntimeUiBus(),
      ...projections,
      statusProjection: { ...projections.statusProjection, snapshot: async () => {
        if (!live) return null
        expect(historyRead).toBe(true)
        return latestStatus
      } },
      historyProjection: {
        ...projections.historyProjection,
        sessionDetail: async (sessionId) => {
          historyRead = true
          return ({
          view: {
            source: "durable",
            id: sessionId,
            kind: "chat",
            conversationId: "conv-old",
            row: {
              id: sessionId,
              kind: "chat",
              title: "Old chat",
              lifecycleState: "inactive",
              notices: [],
              inputMode: { kind: "chat" },
              lastUpdated: "2026-01-01T00:00:00.000Z",
              executionCwd: FIXTURE_EXECUTION_CWD,
              totalsLoading: true,
            },
            status: {
              activity: "thinking",
              settledOutputPosition: null,
              activityStartedAt: 1000,
              connectionState: "connected",
              activeSubagentCount: 0,
              activeBackgroundCommands: [],
              activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
              waitingOnBackgroundWork: false,
              startedAt: 0,
              streamingStartedAt: null,
              accumulatedActiveMs: 0,
              compactionStartedAt: null,
              replyWaits: [],
            },
            budget,
          },
        })
        },
      },
    });

    await expect(service.query({ type: "budgetSnapshot", sessionIds: ["old-chat"] })).resolves.toEqual({
      views: [{ sessionId: "old-chat", view: budget }],
      snapshotPosition: 0,
    });
    expect((await service.query({ type: "sessionDetail", sessionId: "old-chat" })).view?.status).toMatchObject({ activity: "thinking", activityStartedAt: 1000 })
    historyRead = false
    live = true
    expect((await service.query({ type: "sessionDetail", sessionId: "old-chat" })).view?.status).toEqual(latestStatus)
  });

  test("subscribe emits an ordered session patch when state changes, and stops after unsubscribe", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor(),
    })
    const events: FrontendEvent[] = []

    const unsubscribe = service.subscribe((event) => { events.push(event) })
    await store.remove("chat-1")
    await awaitProjectionFlush()
    unsubscribe()
    store.emitChange()

    expect(events.map((e) => e.type)).toEqual(["patch"])
    // The durable metadata row outlives the live entry, so losing the store
    // entry is a live-to-durable transition, not a catalog removal.
    const transition = events[0]
    if (transition?.type !== "patch") throw new Error("expected a patch event")
    expect(transition.patch.cursor).toEqual({ scope: "session", domain: "session", sessionId: "chat-1" })
    expect(transition.patch.payload).toEqual({ kind: "session.updated", row: expect.objectContaining({ id: "chat-1", lifecycleState: "inactive" }) })
    expect(transition.patch.position).toBeGreaterThan(transition.patch.prevPosition)
  })


  test("subscribe acquires the underlying subscription before it returns", async () => {
    // A state change made the instant subscribe returns must still be
    // observed. A lazy subscription would lose it to the race the protocol
    // forbids.
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor(),
    })
    const events: string[] = []

    service.subscribe((event) => { events.push(event.type) })
    void store.remove("chat-1")
    await awaitProjectionFlush()

    expect(events).toEqual(["patch"])
  })

  test("catalog subscription remains owned until shutdown after the last client detaches", async () => {
    const store = fakeSessionStore(new Map())
    const manager = managerWithSessions([durableRow("cold")])
    const baseProjection = createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD })
    let acquisitions = 0
    let releases = 0
    let publishChanges: ((changes: readonly SessionChange[]) => void) | undefined
    const projection: FrontendProjection = {
      ...baseProjection,
      subscribe: (listener) => {
        acquisitions += 1
        publishChanges = listener
        return () => { releases += 1 }
      },
    }
    const delayedSnapshot = Promise.withResolvers<RuntimeBackgroundSummaryResult>()
    const projections = fakeProjections()
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection,
      bus: createRuntimeUiBus(),
      ...projections,
      backgroundLane: { ...projections.backgroundLane, snapshot: () => delayedSnapshot.promise },
      runtimeSupervisor: runtimeSupervisor(),
    })

    const warm = service.dispatch({ type: "background.warm" })
    const detach = service.subscribe(() => {})
    detach()
    detach()
    const initial = (await baseProjection.snapshot()).rows[0]
    if (!initial) throw new Error("expected initial catalog row")
    publishChanges?.([{
      kind: "updated",
      row: readyRow(initial, { totalCost: 1.5, totalBilledCost: 1.5, totalTokens: 42, durationMs: 250, diffStats: { added: 3, modified: 1, removed: 2 } }),
    }])
    const events: FrontendEvent[] = []
    const detachAgain = service.subscribe((event) => { events.push(event) })
    delayedSnapshot.resolve({
      rows: [readyRow(initial, { totalCost: 0.1, totalBilledCost: 0.1, totalTokens: 1, durationMs: 10 })],
      errors: [],
      totalsLoading: false,
      generationSpeeds: {},
    })
    await warm
    expect(events.some((event) => event.type === "patch"
      && event.patch.payload.kind === "session.updated"
      && event.patch.payload.row.totalCost !== 1.5)).toBe(false)
    detachAgain()

    expect(acquisitions).toBe(1)
    expect(releases).toBe(0)
    // The projection still loads the session's totals; the runtime keeps
    // the ones it published rather than a loading row (PI-INTERACTION-006).
    const snapshot = await service.query({ type: "snapshot" })
    expect(snapshot).toEqual(expect.objectContaining({
      rows: [expect.objectContaining({ id: "cold", totalsLoading: false, totalCost: 1.5, totalTokens: 42, durationMs: 250, diffStats: { added: 3, modified: 1, removed: 2 } })],
    }))
    await runRuntimeShutdownBarrier(service.shutdown)
    expect(releases).toBe(1)
  })

  test("a catalog row change for one session yields exactly one ordered updated patch carrying that one row", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor(),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })

    store.updateChatEntry("chat-1", { description: "Renamed" })
    await awaitProjectionFlush()

    const patches = events.filter((e) => e.type === "patch")
    expect(patches).toHaveLength(1)
    if (patches[0]?.type !== "patch") throw new Error("expected a patch event")
    expect(patches[0].patch.payload).toEqual({ kind: "session.updated", row: expect.objectContaining({ id: "chat-1", title: "Renamed" }) })
  })

  test("a telemetry-only change that is not UI-visible produces no patch", () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor(),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })

    // streamingToolText is not part of the catalog row; mutating it must
    // not mint a session patch.
    store.updateChatEntry("chat-1", { streamingToolText: { "tool-1": { content: "partial" } } })

    expect(events.filter((e) => e.type === "patch")).toEqual([])
  })

  test("snapshot carries a snapshotPosition minted by the app-service cursor, idempotent across repeated reads", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor(),
    })

    service.subscribe(() => {})
    const first = await service.query({ type: "snapshot" })
    const second = await service.query({ type: "snapshot" })
    expect(JSON.parse(JSON.stringify(first))).toEqual(first)
    expect(typeof first.snapshotPosition).toBe("number")
    // No session publish between the two reads: the session domain snapshot is a
    // high-water mark, so a second consumer (a pane, diagnostic, retry) gets the
    // same baseline and the first consumer's cursor chain stays valid.
    expect(second.snapshotPosition).toBe(first.snapshotPosition)

    // A session change broadcasts a session patch, advancing the domain; the next
    // snapshot then re-mints past it.
    store.updateChatEntry("chat-1", { description: "Renamed" })
    await awaitProjectionFlush()
    expect((await service.query({ type: "snapshot" })).snapshotPosition).toBeGreaterThan(first.snapshotPosition)
  })

  test("publish mints position and prevPosition; the input type omits both so a publisher cannot supply them", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor(),
    })

    const first = service.publish({ cursor: { scope: "session", domain: "output", sessionId: "chat-1" }, payload: { kind: "output.delta", delta: { visibleMessageCount: 0, blocks: [] } } })
    const second = service.publish({ cursor: { scope: "session", domain: "output", sessionId: "chat-1" }, payload: { kind: "output.delta", delta: { visibleMessageCount: 0, blocks: [] } } })

    expect(first.cursor).toEqual({ scope: "session", domain: "output", sessionId: "chat-1" })
    expect(typeof first.position).toBe("number")
    expect(typeof first.prevPosition).toBe("number")
    expect(second.prevPosition).toBe(first.position)
    expect(second.position).toBeGreaterThan(first.position)
  })

  test("chat.open returns the created session id and delegates through the runtime supervisor", async () => {
    const store = fakeSessionStore(new Map())
    const manager = fakeManager()
    let opened = 0
    const sent: string[] = []
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor({
        openSessionRuntime: async () => {
          opened += 1
          return "chat-opened"
        },
        sendChat: async (sessionId, input) => {
          sent.push(`${sessionId}:${typeof input === "string" ? input : input.text}`)
          return { ok: true }
        },
      }),
    })

    await expect(service.dispatch({ type: "chat.open", initialMessage: "hi" })).resolves.toEqual({ ok: true, sessionId: "chat-opened" })
    expect(opened).toBe(1)
    expect(sent).toEqual(["chat-opened:hi"])
  })

  test("session.reorder delegates through the runtime supervisor", async () => {
    const store = fakeSessionStore(new Map([[
      "chat-1",
      chatEntry(),
    ]]))
    const manager = managerWithSessions([durableRow("chat-1")])
    const calls: Array<{ sessionId: string; beforeSessionId: string | null }> = []
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor({
        reorderSession: (sessionId, beforeSessionId) => {
          calls.push({ sessionId, beforeSessionId })
          return true
        },
      }),
    })

    await expect(service.dispatch({ type: "session.reorder", sessionId: "chat-1", beforeSessionId: null })).resolves.toEqual({ ok: true, sessionId: "chat-1", sessionCatalogRow: expect.objectContaining({ id: "chat-1", kind: "chat", title: "Chat title" }) })
    expect(calls).toEqual([{ sessionId: "chat-1", beforeSessionId: null }])
  })

  test("the workflow controller is fully internal: no public workflows field and no startWorkflow seam; dispatchWorkflow is the only surface", () => {
    const store = fakeSessionStore(new Map())
    const manager = fakeManager()
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor(),
    })

    expect("workflows" in service).toBe(false)
    expect("startWorkflow" in service).toBe(false)
    expect(typeof service.dispatch).toBe("function")
  })

  test("auth.refresh republishes the profile that changed", async () => {
    const store = fakeSessionStore(new Map())
    const manager = fakeManager()
    const refreshedProfiles: Array<string | undefined> = []
    const service = createFlywheelAppService({
      projectRoot: FIXTURE_EXECUTION_CWD,
      projection: createFrontendProjection({ sessionStore: store, manager, projectRoot: FIXTURE_EXECUTION_CWD }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(), outputProjection: noopOutputProjection,
      runtimeSupervisor: runtimeSupervisor(),
      authProfileSelection: {
        previewDelete: async (id) => ({ kind: "fresh-default", source: { id, displayName: "Work" } }),
        refresh: async () => {},
        settle: async (profileId) => { refreshedProfiles.push(profileId) },
        mutate: async () => { throw new Error("not used") },
      },
    })

    await expect(service.dispatch({ type: "auth.refresh", profileId: "work", operationId: "test-refresh" })).resolves.toEqual({ ok: true })
    expect(refreshedProfiles).toEqual(["work"])
    expect(await service.query({ type: "authProfileDeletionPreview", id: "work" })).toEqual({ kind: "fresh-default", source: { id: "work", displayName: "Work" } })
  })

})
