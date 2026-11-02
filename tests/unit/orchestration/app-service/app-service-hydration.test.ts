import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import type { FrontendEvent, FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import type { OutputRangeRequest, OutputWindowRequest } from "../../../../src/protocol/transcript-protocol-types.js"
import type { FlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { SessionForkRefusal } from "../../../../src/orchestration/session/manager.js"
import type { Session } from "../../../../src/orchestration/session/schemas.js"
import type { SessionEntry } from "../../../../src/orchestration/session-store/types.js"
import { chatEntry, fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"
import { durableRow, managerWithSessions } from "./_frontend-projection-fixtures.js"

function projectionsFor(entries: Map<string, SessionEntry>) {
  const projections = fakeProjections()
  return {
    projectRoot: tmpdir(),
    ...projections,
    historyProjection: {
      ...projections.historyProjection,
      outputWindow: async (sessionId: string, request: OutputWindowRequest["range"]) => {
        const blocks = entries.get(sessionId)?.outputBlocks() ?? []
        return {
          totalBlocks: blocks.length,
          visibleMessageCount: blocks.filter((block) => block.kind === "text" || (block.kind === "userMessage" && !block.pending)).length,
          range: {
            kind: "ok" as const,
            consistencyToken: "test:v1",
            anchor: request.anchor,
            window: windowFor(blocks),
            blocks,
            streamingToolText: {},
            streamingOutputChars: 0,
          },
        }
      },
      outputRange: async (sessionId: string, request: OutputRangeRequest) => {
        const blocks = entries.get(sessionId)?.outputBlocks() ?? []
        return {
          kind: "ok" as const,
          consistencyToken: "test:v1",
          anchor: request.anchor,
          window: windowFor(blocks),
          blocks,
          streamingToolText: {},
          streamingOutputChars: 0,
        }
      },
    },
  }
}

async function outputBlocks(service: FlywheelAppService, sessionId: string): Promise<readonly FrontendOutputBlock[]> {
  const result = await service.query({ type: "outputWindow", sessionId, request: {
    range: { anchor: { kind: "tail" }, maxBlocks: 80, maxRows: 800, maxBytes: 1024 * 1024 },
  } })
  if (result.range.kind !== "ok") throw new Error("expected output window")
  return result.range.blocks
}

function windowFor(blocks: readonly FrontendOutputBlock[]) {
  return {
    startBlockIndex: blocks.length > 0 ? 0 : null,
    endBlockIndex: blocks.length > 0 ? blocks.length - 1 : null,
    hasBefore: false,
    hasAfter: false,
    contentBytes: blocks.reduce((sum, block) => sum + ("content" in block && typeof block.content === "string" ? block.content.length : 0), 0),
  }
}


async function eventually(fn: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (fn()) return
    await Bun.sleep(1)
  }
}

describe("FlywheelAppService session hydration", () => {
  test("chat.open publishes a session catalog row and leaves output hydration to outputWindow", async () => {
    const entries = new Map<string, SessionEntry>()
    const store = fakeSessionStore(entries)
    const manager = managerWithSessions([durableRow("chat-new")])
    const service = createFlywheelAppService({
      projection: createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager }),
      bus: createRuntimeUiBus(),
      ...projectionsFor(entries),
      runtimeSupervisor: runtimeSupervisor({
        openSessionRuntime: async () => {
          entries.set("chat-new", chatEntry({ outputBlocks: () => [{ kind: "userMessage", id: "message-1", content: "hi", timestamp: 1, pending: false, injected: false }] }))
          return "chat-new"
        },
      }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })
    events.length = 0

    await expect(service.dispatch({ type: "chat.open" })).resolves.toEqual({
      ok: true,
      sessionId: "chat-new",
      sessionCatalogRow: expect.objectContaining({ id: "chat-new", kind: "chat", title: "Chat title" }),
    })

    const patches = events.filter((event): event is Extract<FrontendEvent, { type: "patch" }> => event.type === "patch")
    expect(patches.map((event) => event.patch.payload.kind)).toEqual(["session.added"])
    expect((await outputBlocks(service, "chat-new"))[0]).toMatchObject({ kind: "userMessage", content: "hi" })
  })

  test("session.fork returns and publishes the inactive destination exactly once", async () => {
    const entries = new Map<string, SessionEntry>()
    const store = fakeSessionStore(entries)
    const durableRows = [durableRow("source")]
    const manager = managerWithSessions(durableRows)
    const service = createFlywheelAppService({
      projection: createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager }),
      bus: createRuntimeUiBus(),
      ...projectionsFor(entries),
      runtimeSupervisor: runtimeSupervisor({
        forkSession: async (sourceSessionId) => {
          expect(sourceSessionId).toBe("source")
          durableRows.push({ ...durableRow("destination"), lifecycleState: "inactive" })
          return "destination"
        },
      }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })
    events.length = 0

    await expect(service.dispatch({ type: "session.fork", sessionId: "source" })).resolves.toEqual({
      ok: true,
      sessionId: "destination",
      sessionCatalogRow: expect.objectContaining({ id: "destination", lifecycleState: "inactive" }),
    })
    expect(events.filter((event) => event.type === "patch").map((event) => event.patch.payload))
      .toEqual([{ kind: "session.added", row: expect.objectContaining({ id: "destination", lifecycleState: "inactive" }) }])
  })

  test("session.fork rejection preserves the error and publishes no patch", async () => {
    const entries = new Map<string, SessionEntry>()
    const store = fakeSessionStore(entries)
    const manager = managerWithSessions([durableRow("source")])
    const service = createFlywheelAppService({
      projection: createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager }),
      bus: createRuntimeUiBus(),
      ...projectionsFor(entries),
      runtimeSupervisor: runtimeSupervisor({
        forkSession: async () => { throw new Error("fork rejected") },
      }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })
    events.length = 0

    await expect(service.dispatch({ type: "session.fork", sessionId: "source" })).resolves.toEqual({
      ok: false,
      error: "Unable to fork this conversation",
    })
    expect(events.filter((event) => event.type === "patch")).toEqual([])
  })

  test("session.fork preserves an expected refusal and publishes no patch", async () => {
    const entries = new Map<string, SessionEntry>()
    const store = fakeSessionStore(entries)
    const manager = managerWithSessions([durableRow("source")])
    const service = createFlywheelAppService({
      projection: createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager }),
      bus: createRuntimeUiBus(),
      ...projectionsFor(entries),
      runtimeSupervisor: runtimeSupervisor({
        forkSession: async () => { throw new SessionForkRefusal("There is no committed conversation to fork") },
      }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })
    events.length = 0

    await expect(service.dispatch({ type: "session.fork", sessionId: "source" })).resolves.toEqual({
      ok: false,
      error: "There is no committed conversation to fork",
    })
    expect(events.filter((event) => event.type === "patch")).toEqual([])
  })

  test("session.activate activates the session so its tab holds a runner", async () => {
    const entries = new Map<string, SessionEntry>()
    const store = fakeSessionStore(entries)
    const manager = managerWithSessions([durableRow("chat-1")])
    let activationCalls = 0
    const service = createFlywheelAppService({
      projection: createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager }),
      bus: createRuntimeUiBus(),
      ...projectionsFor(entries),
      runtimeSupervisor: runtimeSupervisor({
        activateSession: async () => {
          activationCalls += 1
          return true
        },
      }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })
    events.length = 0

    await expect(service.dispatch({ type: "session.activate", sessionId: "chat-1" })).resolves.toMatchObject({ ok: true, sessionId: "chat-1" })

    expect(activationCalls).toBe(1)
    expect(entries.size).toBe(0)
    // The activated row is published so every client sees the tab served.
    expect(events.map((event) => event.type)).toEqual(["patch"])
  })

  test("a recovered session.send does not publish projection-sourced output corrections", async () => {
    const entries = new Map<string, SessionEntry>()
    const store = fakeSessionStore(entries)
    const manager = managerWithSessions([durableRow("chat-1")])
    const service = createFlywheelAppService({
      projection: createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager }),
      bus: createRuntimeUiBus(),
      ...projectionsFor(entries),
      runtimeSupervisor: runtimeSupervisor({
        sendChat: async (sessionId) => {
          entries.set(sessionId, chatEntry({ outputBlocks: () => [{ kind: "userMessage", id: "message-1", content: "continue", timestamp: 1, pending: false, injected: false }] }))
          return { ok: true }
        },
      }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })
    events.length = 0

    await expect(service.dispatch({ type: "session.send", sessionId: "chat-1", input: "continue" })).resolves.toEqual({
      ok: true,
      sessionId: "chat-1",
      sessionCatalogRow: expect.objectContaining({ id: "chat-1", kind: "chat", title: "Chat title" }),
    })

    const patches = events
      .filter((event): event is Extract<FrontendEvent, { type: "patch" }> => event.type === "patch")
      .map((event) => event.patch.payload)
    expect(patches.map((payload) => payload.kind)).toEqual(["session.updated"])
    expect((await outputBlocks(service, "chat-1"))[0]).toMatchObject({ kind: "userMessage", content: "continue" })
  })

  test("successful session commands publish session catalog rows only", async () => {
    const entries = new Map<string, SessionEntry>([["chat-1", chatEntry({ outputBlocks: () => [] })]])
    const store = fakeSessionStore(entries)
    const manager = managerWithSessions([durableRow("chat-1")])
    const service = createFlywheelAppService({
      projection: createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager }),
      bus: createRuntimeUiBus(),
      ...projectionsFor(entries),
      runtimeSupervisor: runtimeSupervisor({
        compactChat: async (sessionId) => {
          entries.set(sessionId, chatEntry({ outputBlocks: () => [{ kind: "text", id: "compact", content: "compacted", timestamp: 1 }] }))
          return true
        },
      }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })
    events.length = 0

    await expect(service.dispatch({ type: "chat.compact", sessionId: "chat-1" })).resolves.toEqual({
      ok: true,
      sessionId: "chat-1",
      sessionCatalogRow: expect.objectContaining({ id: "chat-1", kind: "chat", title: "Chat title" }),
    })

    const patches = events
      .filter((event): event is Extract<FrontendEvent, { type: "patch" }> => event.type === "patch")
      .map((event) => event.patch.payload)
    expect(patches.map((payload) => payload.kind)).toEqual(["session.updated"])
    expect((await outputBlocks(service, "chat-1"))[0]).toMatchObject({ kind: "text", content: "compacted" })
  })

  test("recallQueuedMessage resolves the supervisor's async recall payload", async () => {
    const entries = new Map<string, SessionEntry>([["chat-1", chatEntry()]])
    const store = fakeSessionStore(entries)
    const manager = fakeManager()
    const service = createFlywheelAppService({
      projectRoot: tmpdir(),
      projection: createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(),
      runtimeSupervisor: runtimeSupervisor({
        recallQueuedMessage: async (sessionId) => sessionId === "chat-1" ? "recalled draft" : null,
      }),
    })

    await expect(service.query({ type: "recallQueuedMessage", sessionId: "chat-1" })).resolves.toBe("recalled draft")
    await expect(service.query({ type: "recallQueuedMessage", sessionId: "absent" })).resolves.toBeNull()
  })

  test("session.close publishes an inactive row when the chat remains durable", async () => {
    const entries = new Map<string, SessionEntry>([["chat-1", chatEntry()]])
    const store = fakeSessionStore(entries)
    let lifecycleState: Session["lifecycleState"] = "active"
    const manager = fakeManager({
      read: async (sessionId) => sessionId === "chat-1" ? durableChatSession(lifecycleState) : null,
    })
    const service = createFlywheelAppService({
      projectRoot: tmpdir(),
      projection: createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(),
      runtimeSupervisor: runtimeSupervisor({
        closeChat: async (sessionId) => {
          entries.delete(sessionId ?? "")
          lifecycleState = "inactive"
          return true
        },
      }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })
    events.length = 0

    await expect(service.dispatch({ type: "session.close", sessionId: "chat-1" })).resolves.toEqual({
      ok: true,
      sessionId: "chat-1",
      sessionCatalogRow: expect.objectContaining({ id: "chat-1", lifecycleState: "inactive" }),
    })

    const patches = events
      .filter((event): event is Extract<FrontendEvent, { type: "patch" }> => event.type === "patch")
      .map((event) => event.patch.payload)
    expect(patches).toEqual([
      { kind: "session.updated", row: expect.objectContaining({ id: "chat-1", lifecycleState: "inactive" }) },
    ])
  })

  test("session.close publishes removal when the chat is tombstoned", async () => {
    const entries = new Map<string, SessionEntry>([["chat-1", chatEntry()]])
    const store = fakeSessionStore(entries)
    // A tombstone drops the durable metadata row together with the live entry,
    // so the catalog loses the session instead of keeping a durable row.
    const durableRows = [durableRow("chat-1")]
    const manager = managerWithSessions(durableRows)
    const service = createFlywheelAppService({
      projectRoot: tmpdir(),
      projection: createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(),
      runtimeSupervisor: runtimeSupervisor({
        closeChat: async (sessionId) => {
          durableRows.length = 0
          await store.remove(sessionId ?? "")
          return true
        },
      }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })
    events.length = 0

    await expect(service.dispatch({ type: "session.close", sessionId: "chat-1" })).resolves.toEqual({
      ok: true,
      sessionId: "chat-1",
    })
    await eventually(() => events.some((event) => event.type === "patch" && event.patch.payload.kind === "session.removed"))

    const patches = events
      .filter((event): event is Extract<FrontendEvent, { type: "patch" }> => event.type === "patch")
      .map((event) => event.patch.payload)
    expect(patches).toEqual([{ kind: "session.removed" }])
  })

  test("session.close does not synthesize removal when the closed row cannot be reprojected", async () => {
    const entries = new Map<string, SessionEntry>([["chat-1", chatEntry()]])
    const store = fakeSessionStore(entries)
    const manager = fakeManager()
    const service = createFlywheelAppService({
      projectRoot: tmpdir(),
      projection: createFrontendProjection({ projectRoot: tmpdir(), sessionStore: store, manager }),
      bus: createRuntimeUiBus(),
      ...fakeProjections(),
      runtimeSupervisor: runtimeSupervisor({
        closeChat: async (sessionId) => {
          entries.delete(sessionId ?? "")
          return true
        },
      }),
    })
    const events: FrontendEvent[] = []
    service.subscribe((event) => { events.push(event) })
    events.length = 0

    await expect(service.dispatch({ type: "session.close", sessionId: "chat-1" })).resolves.toEqual({
      ok: true,
      sessionId: "chat-1",
    })

    expect(events.filter((event) => event.type === "patch")).toEqual([])
  })
})

function durableChatSession(lifecycleState: Session["lifecycleState"]): Session {
  return {
    kind: "chat",
    command: "chat",
    name: "Chat title",
    label: "Chat title",
    lastUpdated: lifecycleState === "active" ? "2026-06-24T00:00:00.000Z" : "2026-06-24T00:00:01.000Z",
    executionCwd: "/workspace",
    lifecycleState,
    conversationId: "conv-1",
  }
}
