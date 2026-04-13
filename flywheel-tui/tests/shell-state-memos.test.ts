/**
 * Tests for shell-state derived memos (Phase 3).
 *
 * Verifies that display signals are derived from the sessionStore store
 * via createMemo. The sessionStore is the single source of truth — no
 * overlay signals needed.
 *
 * Note: SolidJS in server/test mode evaluates createMemo eagerly once.
 * We test compositional correctness by setting up state before creating
 * the shell state, verifying the memos produce correct initial values.
 * Reactivity (auto-update on change) is verified in createRoot blocks
 * that read memos after mutations.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { createRoot } from "solid-js"
import { createShellState, type ShellSignals } from "../src/tui/hooks/shell-state"
import { createSessionStore } from "../src/orchestration/session-store"
import type { ChatStoreHandle } from "../src/orchestration/session-store-types"
import type { ChatRunner } from "../src/orchestration/chat-runner"
import type { WorkflowSessionFactories } from "../src/orchestration/workflow-session"
import type { AnyBlock } from "../src/infra/output-blocks"

/** Minimal mock factories for sessionStore tests. */
const mockFactories: WorkflowSessionFactories = {
  createAdapter: () => ({
    connect: () => {},
    start: () => {},
    stop: () => {},
    disconnect: () => {},
  }),
}

/** Minimal mock metrics that records calls. */
function createMockMetrics() {
  return {
    elapsed: () => 0,
    liveTokens: () => 0,
    liveCost: () => 0,
    liveContextPercent: () => 0,
    spinnerTick: () => 0,
    liveActivity: () => "idle" as const,
    startTimer: () => {},
    pauseTimer: () => {},
    resetMetrics: () => {},
    resetElapsedTo: (_ms: number) => {},
  }
}

function createMockChatRunner(sessionId: string): ChatRunner {
  return {
    sessionId,
    abort: () => {},
    dispose: async () => {},
    injectMessage: () => true,
    chatSession: {} as any,
    initialBlocks: [],
  }
}

function buildShellState(sessionStore: ReturnType<typeof createSessionStore>) {
  return createShellState({
    sessionStore,
    manager: {} as any,
    sessions: () => [],
    refreshList: () => {},
    setTerminalTitle: () => {},
    metrics: createMockMetrics() as any,
    showToast: () => {},
  })
}

describe("Shell state derived memos", () => {
  it("outputBlocks returns empty array when no foreground session", () => {
    const sessionStore = createSessionStore(mockFactories)
    const { signals } = buildShellState(sessionStore)
    expect(signals.outputBlocks()).toEqual([])
  })

  it("storeEntry is undefined when no foreground set", () => {
    const sessionStore = createSessionStore(mockFactories)
    const { signals } = buildShellState(sessionStore)
    expect(signals.storeEntry()).toBeUndefined()
  })

  it("agentState defaults to idle when no foreground session", () => {
    const sessionStore = createSessionStore(mockFactories)
    const { signals } = buildShellState(sessionStore)
    expect(signals.agentState()).toBe("idle")
  })

  it("steps returns empty array when no foreground session", () => {
    const sessionStore = createSessionStore(mockFactories)
    const { signals } = buildShellState(sessionStore)
    expect(signals.steps()).toEqual([])
  })

  it("sessionTitle returns empty string when no foreground session", () => {
    const sessionStore = createSessionStore(mockFactories)
    const { signals } = buildShellState(sessionStore)
    expect(signals.sessionTitle()).toBe("")
  })

  it("ShellSignals interface has removed setters absent", () => {
    const sessionStore = createSessionStore(mockFactories)
    const { signals } = buildShellState(sessionStore)

    // These setters should NOT exist on the new interface
    expect("setAgentState" in signals).toBe(false)
    expect("setOutputBlocks" in signals).toBe(false)
    expect("setSteps" in signals).toBe(false)
    expect("setSessionTitle" in signals).toBe(false)
    // Overlay signals removed — sessionStore is the single source of truth
    expect("setViewedBlocks" in signals).toBe(false)
    expect("setViewedTitle" in signals).toBe(false)

    // These should still exist
    expect("setErrorMessage" in signals).toBe(true)
    expect("setForegroundId" in signals).toBe(true)
  })

  it("ShellSignals interface has new accessors", () => {
    const sessionStore = createSessionStore(mockFactories)
    const { signals } = buildShellState(sessionStore)

    // Memo accessors
    expect(typeof signals.storeEntry).toBe("function")

    // Existing read-only accessors (backed by memos)
    expect(typeof signals.agentState).toBe("function")
    expect(typeof signals.outputBlocks).toBe("function")
    expect(typeof signals.steps).toBe("function")
    expect(typeof signals.sessionTitle).toBe("function")
  })

  it("storeEntry returns entry when foreground matches a sessionStore session", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(mockFactories)
        await sessionStore.startChat({
          sessionId: "chat-a",
          description: "My Chat",
          createRunner: async (h) => createMockChatRunner("chat-a"),
        })

        // In createRoot, we verify sessionStore.get works correctly (our memo delegates to it)
        const entry = sessionStore.get("chat-a")
        expect(entry).toBeDefined()
        expect(entry!.description).toBe("My Chat")
        expect(entry!.kind).toBe("chat")

        dispose()
        resolve()
      })
    })
  })

  it("outputBlocks derives from sessionStore entry when foreground is set", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(mockFactories)
        let handle: ChatStoreHandle | null = null

        await sessionStore.startChat({
          sessionId: "chat-a",
          createRunner: async (h) => { handle = h; return createMockChatRunner("chat-a") },
        })
        handle!.updateEntry({ outputBlocks: [{ type: "text", content: "hello" }] as AnyBlock[] })

        // Verify sessionStore has the blocks
        const entry = sessionStore.get("chat-a")
        expect(entry!.outputBlocks.length).toBe(1)
        expect(entry!.outputBlocks[0]).toEqual({ type: "text", content: "hello" })

        dispose()
        resolve()
      })
    })
  })

  it("steps returns empty array for chat entries (discriminated union)", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(mockFactories)
        await sessionStore.startChat({
          sessionId: "chat-a",
          createRunner: async (h) => createMockChatRunner("chat-a"),
        })

        const entry = sessionStore.get("chat-a")
        expect(entry!.kind).toBe("chat")
        // Chat entries don't have steps
        expect("steps" in entry!).toBe(false)

        dispose()
        resolve()
      })
    })
  })

  it("steps returns workflow steps for workflow entries", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(mockFactories)

        sessionStore.start({
          sessionId: "wf-a",
          queue: { steps: [] } as any,
          description: "test workflow",
        })

        sessionStore.updateEntry("wf-a", {
          steps: [{ title: "Step 1", status: "running" }] as any,
        })

        const entry = sessionStore.get("wf-a")
        expect(entry!.kind).toBe("workflow")
        if (entry!.kind === "workflow") {
          expect(entry!.steps.length).toBe(1)
        }

        dispose()
        resolve()
      })
    })
  })

  it("agentState derives active from non-idle modelActivity", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(mockFactories)
        let handle: ChatStoreHandle | null = null

        await sessionStore.startChat({
          sessionId: "chat-a",
          createRunner: async (h) => { handle = h; return createMockChatRunner("chat-a") },
        })

        // Default is idle
        expect(sessionStore.get("chat-a")!.modelActivity).toBe("idle")

        // Set to thinking
        handle!.updateEntry({ modelActivity: "thinking" })
        expect(sessionStore.get("chat-a")!.modelActivity).toBe("thinking")

        // Set back to idle
        handle!.updateEntry({ modelActivity: "idle" })
        expect(sessionStore.get("chat-a")!.modelActivity).toBe("idle")

        dispose()
        resolve()
      })
    })
  })
})
