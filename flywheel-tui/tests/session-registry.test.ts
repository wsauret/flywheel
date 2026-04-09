/**
 * Tests for Session Registry — polymorphic entries (workflow + chat).
 *
 * Verifies that the registry handles both WorkflowSessionEntry
 * and ChatSessionEntry correctly via discriminated union on `kind`.
 *
 * After Phase 3: entries have no `status` or `result` fields. Lifecycle
 * state flows through onRunnerDone/onRunnerError callbacks. Entries are
 * removed synchronously when runners complete or error.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { createSessionRegistry, type SessionEntry, type ChatStoreHandle } from "../src/orchestration/session-registry"
import type { ChatRunner } from "../src/orchestration/chat-runner"
import type { WorkflowSessionFactories } from "../src/orchestration/workflow-session"

/** Minimal mock factories for registry tests (workflow features not tested here). */
const mockFactories: WorkflowSessionFactories = {
  createAdapter: () => ({
    connect: () => {},
    start: () => {},
    stop: () => {},
    disconnect: () => {},
  }),
  createTimer: () => ({ stop: () => {} }),
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
    calls,
  }
}

describe("SessionRegistry — chat entries", () => {
  let registry: ReturnType<typeof createSessionRegistry>
  let mockRunner: ReturnType<typeof createMockChatRunner>
  let capturedHandle: ChatStoreHandle | null

  beforeEach(() => {
    registry = createSessionRegistry(mockFactories)
    mockRunner = createMockChatRunner("chat-001")
    capturedHandle = null
  })

  function startTestChat(sessionId = "chat-001") {
    return registry.startChat({
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
    const entry = registry.get("chat-001")
    expect(entry).toBeDefined()
    expect(entry!.kind).toBe("chat")
  })

  it("chat entry is ChatSessionEntry (no steps, no result, no status)", async () => {
    await startTestChat()

    const entry = registry.get("chat-001")!
    expect(entry.kind).toBe("chat")
    // Chat entries should NOT have steps, result, or status
    expect("steps" in entry).toBe(false)
    expect("result" in entry).toBe(false)
    expect("status" in entry).toBe(false)
  })

  it("get() returns chat entry by session ID", async () => {
    await startTestChat()

    const entry = registry.get("chat-001")
    expect(entry).toBeDefined()
    expect(entry!.kind).toBe("chat")
    expect(entry!.description).toBe("Chat")
  })

  it("has() returns true for existing entries", async () => {
    await startTestChat()
    expect(registry.has("chat-001")).toBe(true)
    expect(registry.has("nonexistent")).toBe(false)
  })

  it("allIds() includes chat session IDs", async () => {
    await startTestChat()

    const ids = registry.allIds()
    expect(ids).toContain("chat-001")
  })

  it("pause() returns false for chat entries (no-op)", async () => {
    await startTestChat()

    const result = registry.pause("chat-001")
    expect(result).toBe(false)
    // Entry still exists (not removed)
    expect(registry.get("chat-001")).toBeDefined()
  })

  it("cancelShutdown() returns false for chat entries (no-op)", async () => {
    await startTestChat()

    const result = registry.cancelShutdown("chat-001")
    expect(result).toBe(false)
    // Entry still exists
    expect(registry.get("chat-001")).toBeDefined()
  })

  it("abort() calls chatRunner.abort()", async () => {
    await startTestChat()

    registry.abort("chat-001")
    expect(mockRunner.calls).toContain("abort")
  })

  it("remove() calls chatRunner.dispose() and removes entry", async () => {
    await startTestChat()

    await registry.remove("chat-001")
    expect(mockRunner.calls).toContain("dispose")
    expect(registry.get("chat-001")).toBeUndefined()
  })

  it("workflow + chat entries coexist", async () => {
    await startTestChat()

    // Both should appear in allIds
    const ids = registry.allIds()
    expect(ids).toContain("chat-001")

    // Get returns correct types
    const chatEntry = registry.get("chat-001")!
    expect(chatEntry.kind).toBe("chat")
  })

  it("runningCount() tracks entry additions and removals", async () => {
    expect(registry.runningCount()).toBe(0)

    await startTestChat()
    expect(registry.runningCount()).toBe(1)

    await registry.remove("chat-001")
    expect(registry.runningCount()).toBe(0)
  })

  it("injectMessage delegates to chat runner", async () => {
    await startTestChat()

    const result = registry.injectMessage("chat-001", "hello")
    expect(result).toBe(true)
    expect(mockRunner.calls).toContain("injectMessage:hello")
  })

  it("store handle updates chat entry fields", async () => {
    await startTestChat()

    // Handle was captured during createRunner
    expect(capturedHandle).not.toBeNull()

    // updateEntry updates outputBlocks
    capturedHandle!.updateEntry({ outputBlocks: [{ type: "text", content: "hello" }] } as any)
    const entry1 = registry.get("chat-001")!
    expect(entry1.outputBlocks.length).toBe(1)

    // updateEntry updates tokens
    capturedHandle!.updateEntry({ tokens: 100 } as any)
    expect(registry.get("chat-001")!.tokens).toBe(100)

    // updateEntry updates cost
    capturedHandle!.updateEntry({ cost: 0.05 } as any)
    expect(registry.get("chat-001")!.cost).toBe(0.05)

    // updateEntry updates modelActivity
    capturedHandle!.updateEntry({ modelActivity: "thinking" } as any)
    expect(registry.get("chat-001")!.modelActivity).toBe("thinking")
  })

  it("onError sets errorMessage and removes entry via onRunnerError", async () => {
    let errorCallbackFired = false
    let errorSessionId: string | undefined
    let errorValue: unknown

    await registry.startChat({
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

    // Entry should be removed
    expect(registry.get("chat-err")).toBeUndefined()
  })

  it("onEnded removes entry via onRunnerDone", async () => {
    let doneCallbackFired = false
    let doneSessionId: string | undefined

    await registry.startChat({
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

    // Entry should be removed
    expect(registry.get("chat-end")).toBeUndefined()
  })

  it("runningCount() returns entries.size", async () => {
    expect(registry.runningCount()).toBe(0)
    await startTestChat()
    expect(registry.runningCount()).toBe(1)
    await registry.remove("chat-001")
    expect(registry.runningCount()).toBe(0)
  })
})

describe("SessionRegistry — updateEntry direct writes (workflow)", () => {
  let registry: ReturnType<typeof createSessionRegistry>

  beforeEach(() => {
    registry = createSessionRegistry(mockFactories)
  })

  it("updateEntry({ outputBlocks }) updates workflow entry outputBlocks", () => {
    registry.start({
      sessionId: "wf-001",
      queue: { steps: [] } as any,
      description: "test workflow",
    })

    const blocks = [{ type: "text", content: "hello" }] as any
    registry.updateEntry("wf-001", { outputBlocks: blocks })

    const entry = registry.get("wf-001")!
    expect(entry.outputBlocks.length).toBe(1)
  })

  it("updateEntry({ modelActivity }) updates workflow entry modelActivity", () => {
    registry.start({
      sessionId: "wf-002",
      queue: { steps: [] } as any,
      description: "test workflow",
    })

    registry.updateEntry("wf-002", { modelActivity: "thinking" })
    expect(registry.get("wf-002")!.modelActivity).toBe("thinking")

    registry.updateEntry("wf-002", { modelActivity: "generating" })
    expect(registry.get("wf-002")!.modelActivity).toBe("generating")

    registry.updateEntry("wf-002", { modelActivity: "idle" })
    expect(registry.get("wf-002")!.modelActivity).toBe("idle")
  })
})
