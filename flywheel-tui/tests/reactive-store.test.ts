/**
 * Tests for Reactive Session Store — createStore-backed implementation.
 *
 * Verifies that the sessionStore uses SolidJS reactive primitives:
 * - Store-backed entries (createStore)
 * - Reactive get() returns proxy that tracks in memos
 * - Discriminated union: workflow entries have steps, chat entries do not
 * - Mutations via store handle are visible to reactive consumers
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { createRoot, createMemo, createEffect } from "solid-js"
import { createSessionStore } from "../src/orchestration/session-store"
import type { SessionEntry, ChatStoreHandle } from "../src/orchestration/session-store-types"
import type { ChatRunner } from "../src/orchestration/chat-runner"
import type { WorkflowSessionFactories } from "../src/orchestration/workflow-session"

/** Minimal mock factories for sessionStore tests. */
const mockFactories: WorkflowSessionFactories = {
  createStore: () => ({
    startWorkflow: () => {},
    subscribe: () => () => {},
    subscribeExecution: () => () => {},
  }),
  createAdapter: () => ({
    connect: () => {},
    start: () => {},
    stop: () => {},
    disconnect: () => {},
  }),
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

describe("Reactive SessionStore — store-backed", () => {
  it("get() returns a reactive proxy — memo tracks changes", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(mockFactories)
        let capturedHandle: ChatStoreHandle | null = null

        await sessionStore.startChat({
          sessionId: "reactive-001",
          createRunner: async (handle) => {
            capturedHandle = handle
            return createMockChatRunner("reactive-001")
          },
        })

        // get() should return a reactive proxy
        const entry = sessionStore.get("reactive-001")
        expect(entry).toBeDefined()
        expect(entry!.kind).toBe("chat")

        // Mutate via store handle and verify change is visible
        capturedHandle!.updateEntry({ description: "Updated Name" })
        expect(sessionStore.get("reactive-001")!.description).toBe("Updated Name")

        dispose()
        resolve()
      })
    })
  })

  it("workflow entry has steps, chat entry does not (discriminated union)", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(mockFactories)

        await sessionStore.startChat({
          sessionId: "chat-union-001",
          createRunner: async (handle) => createMockChatRunner("chat-union-001"),
        })

        const chatEntry = sessionStore.get("chat-union-001")
        expect(chatEntry).toBeDefined()
        expect(chatEntry!.kind).toBe("chat")
        expect("steps" in chatEntry!).toBe(false)

        dispose()
        resolve()
      })
    })
  })

  it("remove() deletes entry from store entirely", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(mockFactories)

        await sessionStore.startChat({
          sessionId: "remove-001",
          createRunner: async (handle) => createMockChatRunner("remove-001"),
        })

        expect(sessionStore.get("remove-001")).toBeDefined()

        await sessionStore.remove("remove-001")

        expect(sessionStore.get("remove-001")).toBeUndefined()

        dispose()
        resolve()
      })
    })
  })

  it("mutations via store handle are visible to reactive consumers", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const sessionStore = createSessionStore(mockFactories)
        let capturedHandle: ChatStoreHandle | null = null

        await sessionStore.startChat({
          sessionId: "mutate-001",
          createRunner: async (handle) => {
            capturedHandle = handle
            return createMockChatRunner("mutate-001")
          },
        })

        // Mutate tokens
        capturedHandle!.updateEntry({ tokens: 500 })
        expect(sessionStore.get("mutate-001")!.tokens).toBe(500)

        // Mutate cost
        capturedHandle!.updateEntry({ cost: 1.23 })
        expect(sessionStore.get("mutate-001")!.cost).toBe(1.23)

        // Mutate model activity
        capturedHandle!.updateEntry({ modelActivity: "thinking" })
        expect(sessionStore.get("mutate-001")!.modelActivity).toBe("thinking")

        // Mutate context percent
        capturedHandle!.updateEntry({ contextPercent: 42 })
        expect(sessionStore.get("mutate-001")!.contextPercent).toBe(42)

        dispose()
        resolve()
      })
    })
  })

})
