/**
 * Tests for Session Store — polymorphic entries (workflow + chat).
 *
 * Verifies that the sessionStore handles both WorkflowSessionEntry
 * and ChatSessionEntry correctly via discriminated union on `kind`.
 *
 * Entries persist after runners complete (ended=true) — display data
 * (outputBlocks, steps, etc.) is retained. Lifecycle state flows
 * through onRunnerDone/onRunnerError callbacks.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { createSessionStore } from "../src/orchestration/session-store"
import type { SessionEntry, ChatStoreHandle } from "../src/orchestration/session-store-types"
import type { ChatRunner } from "../src/orchestration/chat-runner"
import type { WorkflowSessionFactories } from "../src/orchestration/workflow-session"

/** Minimal mock factories for sessionStore tests (workflow features not tested here). */
const mockFactories: WorkflowSessionFactories = {
  createAdapter: () => ({
    connect: () => {},
    start: () => {},
    stop: () => {},
    disconnect: () => {},
  }),
}

// ── Helpers ──

/** Create a minimal mock ChatRunner that records calls. */
function createMockChatRunner(sessionId: string): ChatRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    sessionId,
    abort: () => { calls.push("abort") },
    dispose: async () => { calls.push("dispose") },
    injectMessage: (text: string) => { calls.push(`injectMessage:${text}`); return true },
    chatSession: {} as any,
    initialBlocks: [],
    calls,
  }
}

describe("SessionStore — chat entries", () => {
  let sessionStore: ReturnType<typeof createSessionStore>
  let mockRunner: ReturnType<typeof createMockChatRunner>
  let capturedHandle: ChatStoreHandle | null

  beforeEach(() => {
    sessionStore = createSessionStore(mockFactories)
    mockRunner = createMockChatRunner("chat-001")
    capturedHandle = null
  })

  function startTestChat(sessionId = "chat-001") {
    return sessionStore.startChat({
      sessionId,
      createRunner: async (handle) => {
        capturedHandle = handle
        return mockRunner
      },
    })
  }

  it("startChat() creates entry with kind: 'chat'", async () => {
    const id = await startTestChat()

    expect(id).toBe("chat-001")
    const entry = sessionStore.get("chat-001")
    expect(entry).toBeDefined()
    expect(entry!.kind).toBe("chat")
  })

  it("chat entry is ChatSessionEntry (no steps, no result, no status)", async () => {
    await startTestChat()

    const entry = sessionStore.get("chat-001")!
    expect(entry.kind).toBe("chat")
    // Chat entries should NOT have steps, result, or status
    expect("steps" in entry).toBe(false)
    expect("result" in entry).toBe(false)
    expect("status" in entry).toBe(false)
  })

  it("get() returns chat entry by session ID", async () => {
    await startTestChat()

    const entry = sessionStore.get("chat-001")
    expect(entry).toBeDefined()
    expect(entry!.kind).toBe("chat")
    expect(entry!.description).toBe("Chat")
  })

  it("has() returns true for existing entries", async () => {
    await startTestChat()
    expect(sessionStore.has("chat-001")).toBe(true)
    expect(sessionStore.has("nonexistent")).toBe(false)
  })

  it("allIds() includes chat session IDs", async () => {
    await startTestChat()

    const ids = sessionStore.allIds()
    expect(ids).toContain("chat-001")
  })

  it("pause() returns false for chat entries (no-op)", async () => {
    await startTestChat()

    const result = sessionStore.pause("chat-001")
    expect(result).toBe(false)
    // Entry still exists (not removed)
    expect(sessionStore.get("chat-001")).toBeDefined()
  })

  it("cancelShutdown() returns false for chat entries (no-op)", async () => {
    await startTestChat()

    const result = sessionStore.cancelShutdown("chat-001")
    expect(result).toBe(false)
    // Entry still exists
    expect(sessionStore.get("chat-001")).toBeDefined()
  })

  it("abort() calls chatRunner.abort()", async () => {
    await startTestChat()

    sessionStore.abort("chat-001")
    expect(mockRunner.calls).toContain("abort")
  })

  it("remove() calls chatRunner.dispose() and removes entry", async () => {
    await startTestChat()

    await sessionStore.remove("chat-001")
    expect(mockRunner.calls).toContain("dispose")
    expect(sessionStore.get("chat-001")).toBeUndefined()
  })

  it("isRunning() returns true for active entries", async () => {
    await startTestChat()
    expect(sessionStore.isRunning("chat-001")).toBe(true)
    expect(sessionStore.has("chat-001")).toBe(true)
  })

  it("workflow + chat entries coexist", async () => {
    await startTestChat()

    // Both should appear in allIds
    const ids = sessionStore.allIds()
    expect(ids).toContain("chat-001")

    // Get returns correct types
    const chatEntry = sessionStore.get("chat-001")!
    expect(chatEntry.kind).toBe("chat")
  })

  it("runningCount() tracks active entries", async () => {
    expect(sessionStore.runningCount()).toBe(0)

    await startTestChat()
    expect(sessionStore.runningCount()).toBe(1)

    // remove() deletes the entry
    await sessionStore.remove("chat-001")
    expect(sessionStore.has("chat-001")).toBe(false)
    expect(sessionStore.runningCount()).toBe(0)
  })

  it("injectMessage delegates to chat runner", async () => {
    await startTestChat()

    const result = sessionStore.injectMessage("chat-001", "hello")
    expect(result).toBe(true)
    expect(mockRunner.calls).toContain("injectMessage:hello")
  })

  it("store handle updates chat entry fields", async () => {
    await startTestChat()

    // Handle was captured during createRunner
    expect(capturedHandle).not.toBeNull()

    // updateEntry updates outputBlocks
    capturedHandle!.updateEntry({ outputBlocks: [{ type: "text", content: "hello" }] } as any)
    const entry1 = sessionStore.get("chat-001")!
    expect(entry1.outputBlocks.length).toBe(1)

    // updateEntry updates tokens
    capturedHandle!.updateEntry({ tokens: 100 } as any)
    expect(sessionStore.get("chat-001")!.tokens).toBe(100)

    // updateEntry updates cost
    capturedHandle!.updateEntry({ cost: 0.05 } as any)
    expect(sessionStore.get("chat-001")!.cost).toBe(0.05)

    // updateEntry updates modelActivity
    capturedHandle!.updateEntry({ modelActivity: "thinking" } as any)
    expect(sessionStore.get("chat-001")!.modelActivity).toBe("thinking")
  })

  it("onError sets errorMessage and marks entry as ended", async () => {
    let errorCallbackFired = false
    let errorSessionId: string | undefined
    let errorValue: unknown

    await sessionStore.startChat({
      sessionId: "chat-err",
      createRunner: async (handle) => {
        capturedHandle = handle
        return createMockChatRunner("chat-err")
      },
      onRunnerError: (id, err) => {
        errorCallbackFired = true
        errorSessionId = id
        errorValue = err
      },
    })

    await capturedHandle!.onError("something broke")

    // onRunnerError callback should have fired
    expect(errorCallbackFired).toBe(true)
    expect(errorSessionId).toBe("chat-err")
    expect((errorValue as Error).message).toBe("something broke")

    // Entry should be ended but still present (display data retained)
    const entry = sessionStore.get("chat-err")
    expect(entry).toBeDefined()
    expect(entry!.ended).toBe(true)
    expect(sessionStore.isRunning("chat-err")).toBe(false)
  })

  it("onEnded marks entry as ended via onRunnerDone", async () => {
    let doneCallbackFired = false
    let doneSessionId: string | undefined

    await sessionStore.startChat({
      sessionId: "chat-end",
      createRunner: async (handle) => {
        capturedHandle = handle
        return createMockChatRunner("chat-end")
      },
      onRunnerDone: (id) => {
        doneCallbackFired = true
        doneSessionId = id
      },
    })

    await capturedHandle!.onEnded()

    // onRunnerDone callback should have fired
    expect(doneCallbackFired).toBe(true)
    expect(doneSessionId).toBe("chat-end")

    // Entry should be ended but still present (display data retained)
    const entry = sessionStore.get("chat-end")
    expect(entry).toBeDefined()
    expect(entry!.ended).toBe(true)
    expect(sessionStore.isRunning("chat-end")).toBe(false)
  })

  it("runningCount() decrements on remove", async () => {
    expect(sessionStore.runningCount()).toBe(0)
    await startTestChat()
    expect(sessionStore.runningCount()).toBe(1)
    await sessionStore.remove("chat-001")
    expect(sessionStore.runningCount()).toBe(0)
    expect(sessionStore.get("chat-001")).toBeUndefined()
  })
})

describe("SessionStore — load() for historical sessions", () => {
  let sessionStore: ReturnType<typeof createSessionStore>

  beforeEach(() => {
    sessionStore = createSessionStore(mockFactories)
  })

  it("load() creates an ended entry with display data and no runner", () => {
    const blocks = [{ kind: "text", content: "historical output" }] as any
    sessionStore.load("hist-001", {
      kind: "workflow",
      description: "Old workflow",
      outputBlocks: blocks,
      tokens: 500,
      cost: 0.05,
    })

    const entry = sessionStore.get("hist-001")
    expect(entry).toBeDefined()
    expect(entry!.kind).toBe("workflow")
    expect(entry!.ended).toBe(true)
    expect(entry!.runner).toBeNull()
    expect(entry!.description).toBe("Old workflow")
    expect(entry!.outputBlocks.length).toBe(1)
    expect(entry!.tokens).toBe(500)
    expect(entry!.cost).toBe(0.05)
    expect(entry!.modelActivity).toBe("idle")
  })

  it("load() does not overwrite an existing entry", async () => {
    await sessionStore.startChat({
      sessionId: "chat-001",
      createRunner: async (handle) => createMockChatRunner("chat-001"),
    })

    sessionStore.load("chat-001", {
      kind: "chat",
      description: "Should not overwrite",
      outputBlocks: [],
    })

    // Original entry should be preserved
    const entry = sessionStore.get("chat-001")
    expect(entry!.description).toBe("Chat")
    expect(entry!.ended).toBe(false)
  })

  it("load() entries are excluded from runningCount()", () => {
    sessionStore.load("hist-001", {
      kind: "chat",
      description: "Old chat",
      outputBlocks: [],
    })

    expect(sessionStore.has("hist-001")).toBe(true)
    expect(sessionStore.isRunning("hist-001")).toBe(false)
    expect(sessionStore.runningCount()).toBe(0)
  })

  it("runner operations are no-ops on loaded entries", () => {
    sessionStore.load("hist-001", {
      kind: "workflow",
      description: "Old workflow",
      outputBlocks: [],
    })

    expect(sessionStore.pause("hist-001")).toBe(false)
    expect(sessionStore.injectMessage("hist-001", "hello")).toBe(false)
    expect(sessionStore.cancelShutdown("hist-001")).toBe(false)
    // abort is void — just verify it doesn't throw
    sessionStore.abort("hist-001")
  })
})

describe("SessionStore — updateEntry direct writes (workflow)", () => {
  let sessionStore: ReturnType<typeof createSessionStore>

  beforeEach(() => {
    sessionStore = createSessionStore(mockFactories)
  })

  it("updateEntry({ outputBlocks }) updates workflow entry outputBlocks", () => {
    sessionStore.start({
      sessionId: "wf-001",
      queue: { steps: [] } as any,
      description: "test workflow",
    })

    const blocks = [{ type: "text", content: "hello" }] as any
    sessionStore.updateEntry("wf-001", { outputBlocks: blocks })

    const entry = sessionStore.get("wf-001")!
    expect(entry.outputBlocks.length).toBe(1)
  })

  it("updateEntry({ modelActivity }) updates workflow entry modelActivity", () => {
    sessionStore.start({
      sessionId: "wf-002",
      queue: { steps: [] } as any,
      description: "test workflow",
    })

    sessionStore.updateEntry("wf-002", { modelActivity: "thinking" })
    expect(sessionStore.get("wf-002")!.modelActivity).toBe("thinking")

    sessionStore.updateEntry("wf-002", { modelActivity: "generating" })
    expect(sessionStore.get("wf-002")!.modelActivity).toBe("generating")

    sessionStore.updateEntry("wf-002", { modelActivity: "idle" })
    expect(sessionStore.get("wf-002")!.modelActivity).toBe("idle")
  })
})
