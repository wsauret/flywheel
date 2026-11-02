import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { createSessionStore } from "../../../../src/orchestration/session-store/store"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import type { SessionManager, SessionMetadataChange } from "../../../../src/orchestration/session/manager"
import {
  attachChat,
  buildShellState,
  createMockChatRunner,
  runtime,
  waitForAssertion,
} from "./shell-state-harness"


describe("Shell state derived memos", () => {
  it("outputTranscript has no window when no foreground session", () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const { signals } = buildShellState(sessionStore)
    expect(signals.outputTranscript().visibleRange()).toBeUndefined()
  })

  it("foregroundRevision advances on every foreground write, same value included", () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const { signals } = buildShellState(sessionStore)

    const start = signals.foregroundRevision()
    signals.setForegroundId("a")
    expect(signals.foregroundRevision()).toBe(start + 1)

    signals.setForegroundId("b")
    signals.setForegroundId("a")
    expect(signals.foregroundId()).toBe("a")
    expect(signals.foregroundRevision()).toBe(start + 3)

    signals.setForegroundId("a")
    expect(signals.foregroundRevision()).toBe(start + 4)
  })

  it("counts exactly the sessions the Sessions list shows, which leaves out the foreground's empty new chat", async () => {
    await createRoot(async (dispose) => {
      try {
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
        const { signals } = buildShellState(sessionStore)
        attachChat(sessionStore, "kept", createMockChatRunner("kept"), "New Chat")
        attachChat(sessionStore, "prior", createMockChatRunner("prior"), "Prior chat")
        attachChat(sessionStore, "startup", createMockChatRunner("startup"), "New Chat")
        signals.setForegroundId("startup")
        await waitForAssertion(() => expect(signals.sessionCatalogRows().length).toBe(3))

        // An empty chat that is not in front stays listed and counted.
        expect(signals.sessionCount()).toBe(2)
        expect(signals.listedSessions().map((row) => row.id).toSorted()).toEqual(["kept", "prior"])

        // The foreground chat is listed and counted once it has content.
        sessionStore.updateChatEntry("startup", { outputBlocks: [{ kind: "userMessage", id: "user-1", content: "hello", timestamp: 1, pending: false, injected: false }], visibleMessageCountSuffix: 1 })
        await waitForAssertion(() => expect(signals.sessionCount()).toBe(3))
        expect(signals.listedSessions().map((row) => row.id).toSorted()).toEqual(["kept", "prior", "startup"])
      } finally {
        dispose()
      }
    })
  })

  it("agentState defaults to idle when no foreground session", () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const { signals } = buildShellState(sessionStore)
    expect(signals.agentState()).toBe("idle")
  })

  it("updates active foreground roles from the ordered cache", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
        sessionStore.openSessionRuntime({ sessionId: "chat-roles", conversationId: "conversation-roles" })
        sessionStore.attachChatRunner("chat-roles", createMockChatRunner("chat-roles"))
        let model = "gpt-5.5"
        let reads = 0
        const listeners = new Set<(change: SessionMetadataChange) => void>()
        const session = () => ({
          kind: "chat" as const,
          command: "chat" as const,
          conversationId: "conversation-roles",
          label: "Chat roles",
          lifecycleState: "active" as const,
          name: "Chat roles",
          lastUpdated: "2026-06-19T00:00:00.000Z",
          executionCwd: "/scratch/flywheel-test",
          roleAssignments: { defaults: {}, overrides: { chat: { model, effort: "medium" } } },
        })
        const manager: Partial<SessionManager> = {
          read: async (id) => {
            reads++
            return id === "chat-roles" ? session() : null
          },
          listMetadata: async () => ({
            sessions: [{
              id: "chat-roles",
              name: "Chat roles",
              label: "Chat roles",
              lifecycleState: "active",
              kind: "chat",
              command: "chat",
              totalCost: 0,
              totalTokens: 0,
              contextPercent: 0,
              lastUpdated: "2026-06-19T00:00:00.000Z",
              executionCwd: "/scratch/flywheel-test",
              conversationId: "conversation-roles",
            }],
            errors: [],
          }),
          subscribe: (listener) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
          },
        }

        const { signals } = buildShellState(sessionStore, () => 0, manager)
        signals.setForegroundId("chat-roles")
        await waitForAssertion(() => {
          expect(signals.roleView("chat-roles")?.assignments.chat?.model).toBe("gpt-5.5")
        })
        await Bun.sleep(1)

        const readsAfterJoin = reads
        sessionStore.updateChatEntry("chat-roles", { outputBlocks: [{ kind: "text", id: "t1", content: "hello", timestamp: 1 }], visibleMessageCountSuffix: 1 })
        await waitForAssertion(() => {
          expect(signals.outputTranscript().visibleRange()?.blocks).toHaveLength(1)
        })
        expect(reads).toBe(readsAfterJoin)

        model = "gpt-6"
        for (const listener of listeners) listener({ kind: "changed", sessionIds: ["chat-roles"] })
        await waitForAssertion(() => {
          expect(signals.roleView("chat-roles")?.assignments.chat?.model).toBe("gpt-6")
        })
        expect(reads).toBeGreaterThan(readsAfterJoin)

        dispose()
        resolve()
      })
    })
  })

  it("outputTranscript reads published live deltas from the live output projector", async () => {
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    attachChat(sessionStore, "chat-live")

    await createRoot(async (dispose) => {
      try {
        const { signals } = buildShellState(sessionStore)
        signals.setForegroundId("chat-live")
        const blocks = () => signals.outputTranscript().visibleRange()?.blocks ?? []

        // Output renders through the transcript store, fed by the live projector
        // from the output-projection
        // observing SessionStore output. Driving the store mirror is the real
        // production path. The async query boundary means the cache may first
        // seed from outputWindow; live deltas then coalesce on the frame timer.

        sessionStore.updateChatEntry("chat-live", { outputBlocks: [{ kind: "text", id: "t1", content: "turn one", timestamp: 1 }], visibleMessageCountSuffix: 1 })
        await waitForAssertion(() => expect(blocks().length).toBe(1))

        sessionStore.updateChatEntry("chat-live", { outputBlocks: [
          { kind: "text", id: "t1", content: "turn one", timestamp: 1 },
          { kind: "text", id: "t2", content: "turn two", timestamp: 2 },
        ], visibleMessageCountSuffix: 2 })

        await waitForAssertion(() => {
          expect(blocks().length).toBe(2)
        })
      } finally {
        dispose()
      }
    })
  })

})
