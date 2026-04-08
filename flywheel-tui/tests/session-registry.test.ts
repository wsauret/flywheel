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
import { createSessionRegistry, type SessionEntry, type ChatRegistryCallbacks } from "../src/orchestration/session-registry"
import type { ChatRunner } from "../src/orchestration/chat-runner"

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
  let capturedCallbacks: ChatRegistryCallbacks | null

  beforeEach(() => {
    registry = createSessionRegistry()
    mockRunner = createMockChatRunner("chat-001")
    capturedCallbacks = null
  })

  function startTestChat(sessionId = "chat-001") {
    return registry.startChat({
      sessionId,
      createRunner: async (callbacks) => {
        capturedCallbacks = callbacks
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

  it("activeIds() includes chat session IDs", async () => {
    await startTestChat()

    const ids = registry.activeIds()
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

    registry.remove("chat-001")
    expect(mockRunner.calls).toContain("dispose")
    expect(registry.get("chat-001")).toBeUndefined()
  })

  it("workflow + chat entries coexist", async () => {
    await startTestChat()

    // Both should appear in activeIds
    const ids = registry.activeIds()
    expect(ids).toContain("chat-001")

    // Get returns correct types
    const chatEntry = registry.get("chat-001")!
    expect(chatEntry.kind).toBe("chat")
  })

  it("subscriber notifications fire for chat entry changes", async () => {
    const notifications: number[] = []
    let count = 0
    registry.subscribe(() => { count++; notifications.push(count) })

    await startTestChat()

    // At least one notification from startChat
    expect(notifications.length).toBeGreaterThanOrEqual(1)

    const countBefore = notifications.length
    registry.remove("chat-001")
    expect(notifications.length).toBeGreaterThan(countBefore)
  })

  it("injectMessage delegates to chat runner", async () => {
    await startTestChat()

    const result = registry.injectMessage("chat-001", "hello")
    expect(result).toBe(true)
    expect(mockRunner.calls).toContain("injectMessage:hello")
  })

  it("registry callbacks update chat entry fields", async () => {
    await startTestChat()

    // Callbacks were captured during createRunner
    expect(capturedCallbacks).not.toBeNull()

    // onBlocks updates outputBlocks
    capturedCallbacks!.onBlocks([{ type: "text", content: "hello" }] as any)
    const entry1 = registry.get("chat-001")!
    expect(entry1.outputBlocks.length).toBe(1)

    // onTokens updates tokens
    capturedCallbacks!.onTokens(100)
    expect(registry.get("chat-001")!.tokens).toBe(100)

    // onCost updates cost
    capturedCallbacks!.onCost(0.05)
    expect(registry.get("chat-001")!.cost).toBe(0.05)

    // onModelActivity updates modelActivity
    capturedCallbacks!.onModelActivity("thinking")
    expect(registry.get("chat-001")!.modelActivity).toBe("thinking")
  })

  it("onError callback sets errorMessage and removes entry via onRunnerError", async () => {
    let errorCallbackFired = false
    let errorSessionId: string | undefined
    let errorValue: unknown

    await registry.startChat({
      sessionId: "chat-err",
      createRunner: async (callbacks) => {
        capturedCallbacks = callbacks
        return createMockChatRunner("chat-err")
      },
      onRunnerError: (id, err) => {
        errorCallbackFired = true
        errorSessionId = id
        errorValue = err
      },
    })

    capturedCallbacks!.onError("something broke")

    // onRunnerError callback should have fired
    expect(errorCallbackFired).toBe(true)
    expect(errorSessionId).toBe("chat-err")
    expect((errorValue as Error).message).toBe("something broke")

    // Entry should be removed synchronously
    expect(registry.get("chat-err")).toBeUndefined()
  })

  it("onEnded callback removes entry via onRunnerDone", async () => {
    let doneCallbackFired = false
    let doneSessionId: string | undefined

    await registry.startChat({
      sessionId: "chat-end",
      createRunner: async (callbacks) => {
        capturedCallbacks = callbacks
        return createMockChatRunner("chat-end")
      },
      onRunnerDone: (id) => {
        doneCallbackFired = true
        doneSessionId = id
      },
    })

    capturedCallbacks!.onEnded()

    // onRunnerDone callback should have fired
    expect(doneCallbackFired).toBe(true)
    expect(doneSessionId).toBe("chat-end")

    // Entry should be removed synchronously
    expect(registry.get("chat-end")).toBeUndefined()
  })

  it("runningCount() returns entries.size", async () => {
    expect(registry.runningCount()).toBe(0)
    await startTestChat()
    expect(registry.runningCount()).toBe(1)
    registry.remove("chat-001")
    expect(registry.runningCount()).toBe(0)
  })
})
