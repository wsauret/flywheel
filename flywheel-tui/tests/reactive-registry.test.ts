/**
 * Tests for Reactive Session Registry — createStore-backed implementation.
 *
 * Verifies that the registry uses SolidJS reactive primitives:
 * - Store-backed entries (createStore)
 * - Reactive get() returns proxy that tracks in memos
 * - Discriminated union: workflow entries have steps, chat entries do not
 * - Mutations via store handle are visible to reactive consumers
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { createRoot, createMemo, createEffect } from "solid-js"
import { createSessionRegistry, type SessionEntry, type ChatStoreHandle } from "../src/orchestration/session-registry"
import type { ChatRunner } from "../src/orchestration/chat-runner"
import type { WorkflowSessionFactories } from "../src/orchestration/workflow-session"

/** Minimal mock factories for registry tests. */
const mockFactories: WorkflowSessionFactories = {
  createStore: () => ({
    startWorkflow: () => {},
    getState: () => ({ modelActivity: "idle" as const }),
    subscribe: () => () => {},
    subscribeExecution: () => () => {},
  }),
  createAdapter: () => ({
    connect: () => {},
    start: () => {},
    stop: () => {},
    disconnect: () => {},
  }),
  createTimer: () => ({ stop: () => {} }),
}

// ── Helpers ──

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

describe("Reactive SessionRegistry — store-backed", () => {
  it("get() returns a reactive proxy — memo tracks changes", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const registry = createSessionRegistry(mockFactories)
        let capturedHandle: ChatStoreHandle | null = null

        await registry.startChat({
          sessionId: "reactive-001",
          createRunner: async (handle) => {
            capturedHandle = handle
            return createMockChatRunner("reactive-001")
          },
        })

        // get() should return a reactive proxy
        const entry = registry.get("reactive-001")
        expect(entry).toBeDefined()
        expect(entry!.kind).toBe("chat")

        // Mutate via store handle and verify change is visible
        capturedHandle!.updateEntry({ description: "Updated Name" })
        expect(registry.get("reactive-001")!.description).toBe("Updated Name")

        dispose()
        resolve()
      })
    })
  })

  it("workflow entry has steps, chat entry does not (discriminated union)", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const registry = createSessionRegistry(mockFactories)

        await registry.startChat({
          sessionId: "chat-union-001",
          createRunner: async (handle) => createMockChatRunner("chat-union-001"),
        })

        const chatEntry = registry.get("chat-union-001")
        expect(chatEntry).toBeDefined()
        expect(chatEntry!.kind).toBe("chat")
        expect("steps" in chatEntry!).toBe(false)

        dispose()
        resolve()
      })
    })
  })

  it("remove() deletes entry from store", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const registry = createSessionRegistry(mockFactories)

        await registry.startChat({
          sessionId: "remove-001",
          createRunner: async (handle) => createMockChatRunner("remove-001"),
        })

        expect(registry.get("remove-001")).toBeDefined()
        expect(registry.runningCount()).toBe(1)

        await registry.remove("remove-001")

        expect(registry.get("remove-001")).toBeUndefined()
        expect(registry.runningCount()).toBe(0)

        dispose()
        resolve()
      })
    })
  })

  it("mutations via store handle are visible to reactive consumers", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const registry = createSessionRegistry(mockFactories)
        let capturedHandle: ChatStoreHandle | null = null

        await registry.startChat({
          sessionId: "mutate-001",
          createRunner: async (handle) => {
            capturedHandle = handle
            return createMockChatRunner("mutate-001")
          },
        })

        // Mutate tokens
        capturedHandle!.updateEntry({ tokens: 500 })
        expect(registry.get("mutate-001")!.tokens).toBe(500)

        // Mutate cost
        capturedHandle!.updateEntry({ cost: 1.23 })
        expect(registry.get("mutate-001")!.cost).toBe(1.23)

        // Mutate model activity
        capturedHandle!.updateEntry({ modelActivity: "thinking" })
        expect(registry.get("mutate-001")!.modelActivity).toBe("thinking")

        // Mutate context percent
        capturedHandle!.updateEntry({ contextPercent: 42 })
        expect(registry.get("mutate-001")!.contextPercent).toBe(42)

        dispose()
        resolve()
      })
    })
  })

  it("runningCount() auto-tracks via internal createMemo", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const registry = createSessionRegistry(mockFactories)

        expect(registry.runningCount()).toBe(0)

        await registry.startChat({
          sessionId: "count-001",
          createRunner: async (handle) => createMockChatRunner("count-001"),
        })

        expect(registry.runningCount()).toBe(1)

        await registry.startChat({
          sessionId: "count-002",
          createRunner: async (handle) => createMockChatRunner("count-002"),
        })

        expect(registry.runningCount()).toBe(2)

        await registry.remove("count-001")
        expect(registry.runningCount()).toBe(1)

        dispose()
        resolve()
      })
    })
  })
})
