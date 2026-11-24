import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createSessionStore } from "../../../../../src/orchestration/session-store/store"
import { EventReaderService } from "../../../../../src/infra/event-store-effect.js"
import type { SessionManager, SessionMetadataChange } from "../../../../../src/orchestration/session/manager"
import { createRuntimeUiPatchSequencer } from "../../../../../src/orchestration/app-service/projections/runtime-ui-patch-sequencer"
import type { ChildSessionRow, SessionCatalogRow } from "../../../../../src/protocol/app-service-types"
import type { RuntimeConfigView } from "../../../../../src/protocol/runtime-config-protocol-types"
import { createShellState } from "../../../../../src/tui/hooks/state/shell-state"
import { fakeLanes } from "../../../../helpers/fake-lanes.js"
import { runtimeDispatch, runtimeQuery } from "../../../../helpers/runtime-dispatch.js"
import { configView, detailView } from "../../../../helpers/runtime-views.js"
import { snapshotResult } from "../../../../helpers/session-catalog.js"
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

  it("sessionRow returns the catalog row, then the held detail row when the catalog lacks it, and undefined otherwise", async () => {
    const listed: SessionCatalogRow = {
      id: "listed", kind: "chat", title: "Listed chat", lifecycleState: "active", notices: [], inputMode: { kind: "chat" },
      lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/scratch/flywheel-test", totalsLoading: true,
    }
    const child: ChildSessionRow = {
      id: "child", kind: "subagent", title: "Child", lifecycleState: "active", notices: [], inputMode: { kind: "message" },
      admittedActions: ["session.send"], parentSessionId: "listed",
      lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/scratch/flywheel-test", totalsLoading: true,
    }
    const sequencer = createRuntimeUiPatchSequencer()
    const query = runtimeQuery({
      snapshot: async () => snapshotResult([listed], sequencer.snapshotPosition({ kind: "workspace", domains: ["session"] })),
      // A child is never listed; only a held detail read knows its row.
      sessionDetailSnapshot: async (request) => ({
        snapshotPosition: sequencer.snapshotPosition({ kind: "workspace", domains: ["session_detail"] }),
        views: request.sessionIds.map((sessionId) => ({ sessionId, view: sessionId === child.id ? detailView(child) : null })),
      }),
    })
    await createRoot(async (dispose) => {
      try {
        const { signals, services } = createShellState({
          appService: { query, dispatch: runtimeDispatch({}), subscribe: () => () => {}, ...fakeLanes().client },
          runtimeConfig: { view: () => undefined, settlePublication: async () => false },
          now: () => 0, projectRoot: "/scratch/project", setTerminalTitle: () => {}, showToast: () => {},
        })
        await waitForAssertion(() => expect(signals.sessionRow("listed")).toEqual(listed))
        expect(signals.sessionRow("child")).toBeUndefined()

        services.sessionDetails.retain("child")
        await waitForAssertion(() => expect(signals.sessionRow("child")).toEqual(child))
        expect(signals.sessionRow("unknown")).toBeUndefined()
      } finally {
        dispose()
      }
    })
  })

  it("The display view applies defaults once: showBuild false and fontTipDismissed false for an empty config", () => {
    createRoot((dispose) => {
      try {
        const [view, setView] = createSignal<RuntimeConfigView | undefined>()
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
        const { signals } = buildShellState(sessionStore, () => 0, {}, { view, settlePublication: async () => false })
        // The context gauge waits for the person's threshold, so it has no default.
        expect({ ...signals.display }).toEqual({ showBuild: false, fontTipDismissed: false, showThinking: false, diffColors: "theme", compactionThreshold: undefined })

        setView(configView({ showBuild: true, fontTipDismissed: true, showThinking: true, diffColors: "standard", proactiveCompactionThreshold: 150_000 }))
        expect({ ...signals.display }).toEqual({ showBuild: true, fontTipDismissed: true, showThinking: true, diffColors: "standard", compactionThreshold: 150_000 })
      } finally {
        dispose()
      }
    })
  })

  it("The display view shows what the Settings modal shows: the defaults once the configuration owner is disposed", () => {
    createRoot((dispose) => {
      try {
        const disposed: RuntimeConfigView = {
          ...configView({ showBuild: true, fontTipDismissed: true, showThinking: true, diffColors: "standard", proactiveCompactionThreshold: 150_000 }),
          status: { kind: "disposed", message: "The configuration owner is disposed." },
        }
        const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
        const { signals } = buildShellState(sessionStore, () => 0, {}, { view: () => disposed, settlePublication: async () => false })
        expect({ ...signals.display }).toEqual({ showBuild: false, fontTipDismissed: false, showThinking: false, diffColors: "theme", compactionThreshold: undefined })
      } finally {
        dispose()
      }
    })
  })
})
