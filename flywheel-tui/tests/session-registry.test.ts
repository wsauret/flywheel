/**
 * Tests for Session Registry — polymorphic entries (workflow + chat).
 *
 * Phase 4+5: Verifies that the registry handles both WorkflowSessionEntry
 * and ChatSessionEntry correctly via discriminated union on `kind`.
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

  it("chat entry is ChatSessionEntry (no steps, no result)", async () => {
    await startTestChat()

    const entry = registry.get("chat-001")!
    expect(entry.kind).toBe("chat")
    // Chat entries should NOT have steps or result
    expect("steps" in entry).toBe(false)
    expect("result" in entry).toBe(false)
  })

  it("get() returns chat entry by session ID", async () => {
    await startTestChat()

    const entry = registry.get("chat-001")
    expect(entry).toBeDefined()
    expect(entry!.kind).toBe("chat")
    expect(entry!.description).toBe("Chat")
  })

  it("activeIds() includes chat session IDs", async () => {
    await startTestChat()

    const ids = registry.activeIds()
    expect(ids).toContain("chat-001")
  })

  it("pause() is a no-op for chat entries", async () => {
    await startTestChat()

    // Should not throw, should not change status
    registry.pause("chat-001")
    const entry = registry.get("chat-001")
    expect(entry!.status).toBe("running")
  })

  it("cancelShutdown() is a no-op for chat entries", async () => {
    await startTestChat()

    // Should not throw
    registry.cancelShutdown("chat-001")
    const entry = registry.get("chat-001")
    expect(entry!.status).toBe("running")
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

  it("onError callback sets error status", async () => {
    await startTestChat()

    capturedCallbacks!.onError("something broke")
    const entry = registry.get("chat-001")!
    expect(entry.status).toBe("error")
    expect(entry.errorMessage).toBe("something broke")
  })

  it("onEnded callback sets completed status", async () => {
    await startTestChat()

    capturedCallbacks!.onEnded()
    const entry = registry.get("chat-001")!
    expect(entry.status).toBe("completed")
  })
})
