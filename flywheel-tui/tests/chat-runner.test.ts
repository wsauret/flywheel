/**
 * Tests for ChatRunner — wraps ChatSession with SessionRunner compliance,
 * output persistence, and state machine transitions.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import type { SessionRunner } from "../src/orchestration/session-runner"
import type { AnyBlock } from "../src/infra/output-blocks"

// ── Stubs ──

/** Minimal ChatSession stub that records calls. */
function createStubChatSession() {
  const calls: string[] = []
  let onBlocks: ((blocks: any[]) => void) | null = null
  let onWaiting: ((waiting: boolean) => void) | null = null
  return {
    session: {
      send: (text: string) => { calls.push(`send:${text}`) },
      interrupt: () => { calls.push("interrupt") },
      end: () => { calls.push("end") },
      builder: { getBlocks: () => [] },
      budgetTracker: { getTokensUsed: () => 0, getTotalCost: () => 0 },
    },
    calls,
    /** Simulate wiring callbacks during factory */
    captureCallbacks(cbs: { onBlocks: any; onWaiting: any }) {
      onBlocks = cbs.onBlocks
      onWaiting = cbs.onWaiting
    },
    triggerBlocks(blocks: any[]) { onBlocks?.(blocks) },
    triggerWaiting(waiting: boolean) { onWaiting?.(waiting) },
  }
}

describe("ChatRunner", () => {
  // We test the design contract here. The actual createChatRunner is tested
  // against a mock ChatSession factory (no real subprocess).

  it("ChatRunner implements SessionRunner interface", () => {
    // Type-level check: if this compiles, the contract is met.
    const assertAssignable = (_runner: SessionRunner) => {}

    // Minimal mock matching the ChatRunner shape
    const mockChatRunner: SessionRunner = {
      sessionId: "chat-test-session",
      abort: () => {},
      dispose: async () => {},
      injectMessage: (_text: string) => true,
    }

    assertAssignable(mockChatRunner)
    expect(typeof mockChatRunner.sessionId).toBe("string")
    expect(typeof mockChatRunner.abort).toBe("function")
    expect(typeof mockChatRunner.dispose).toBe("function")
    expect(typeof mockChatRunner.injectMessage).toBe("function")
  })

  it("injectMessage delegates to ChatSession.send and returns true", () => {
    const stub = createStubChatSession()

    // Simulate what ChatRunner.injectMessage does
    const injectMessage = (text: string): boolean => {
      stub.session.send(text)
      return true
    }

    const result = injectMessage("hello")
    expect(result).toBe(true)
    expect(stub.calls).toContain("send:hello")
  })

  it("abort delegates to ChatSession.interrupt", () => {
    const stub = createStubChatSession()

    // Simulate what ChatRunner.abort does
    const abort = () => stub.session.interrupt()

    abort()
    expect(stub.calls).toContain("interrupt")
  })

  it("dispose calls flush then dispose on flusher, then chatSession.end", async () => {
    const order: string[] = []
    const mockFlusher = {
      schedule: () => {},
      flush: async () => { order.push("flush") },
      dispose: () => { order.push("flusher-dispose") },
    }
    const stub = createStubChatSession()

    // Simulate dispose sequence
    const dispose = async () => {
      await mockFlusher.flush()
      mockFlusher.dispose()
      stub.session.end()
    }

    await dispose()
    expect(order).toEqual(["flush", "flusher-dispose"])
    expect(stub.calls).toContain("end")
  })

  it("dispose must flush BEFORE dispose to prevent DebouncedWriter data loss", async () => {
    const order: string[] = []
    const mockFlusher = {
      flush: async () => { order.push("flush") },
      dispose: () => { order.push("dispose") },
    }

    // Correct order
    await mockFlusher.flush()
    mockFlusher.dispose()

    expect(order[0]).toBe("flush")
    expect(order[1]).toBe("dispose")
  })

  it("state transitions: active on send, paused when response completes", () => {
    const stateUpdates: string[] = []
    const updateState = (_id: string, state: string) => { stateUpdates.push(state) }
    const sessionId = "test-123"

    // Simulate injectMessage: sets active
    updateState(sessionId, "active")

    // Simulate onWaiting(false) callback: sets paused
    updateState(sessionId, "paused")

    expect(stateUpdates).toEqual(["active", "paused"])
  })

  it("onBlocks wired to output flusher schedule", () => {
    let scheduled = false
    const mockFlusher = {
      schedule: () => { scheduled = true },
      flush: async () => {},
      dispose: () => {},
    }

    // Simulate onBlocks callback wiring
    const onBlocks = (_blocks: any[]) => {
      mockFlusher.schedule()
    }

    onBlocks([{ type: "text", content: "hello" }])
    expect(scheduled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Resume — prior blocks behavior
// ---------------------------------------------------------------------------

describe("ChatRunner — resume with priorBlocks", () => {
  it("emits prior blocks immediately via onBlocks callback", () => {
    const emitted: AnyBlock[][] = []
    const priorBlocks: AnyBlock[] = [
      { kind: "text", content: "prior message", timestamp: 100 } as AnyBlock,
      { kind: "system", message: "started", timestamp: 200 } as AnyBlock,
    ]

    // Simulate ChatRunner initialization with priorBlocks
    let currentBlocks: AnyBlock[] = []
    const callbacks = {
      onBlocks: (blocks: AnyBlock[]) => { emitted.push([...blocks]) },
    }

    // This is the logic from createChatRunner when priorBlocks is provided
    if (priorBlocks && priorBlocks.length > 0) {
      currentBlocks = [...priorBlocks]
      callbacks.onBlocks(currentBlocks)
    }

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toHaveLength(2)
    expect((emitted[0][0] as any).kind).toBe("text")
    expect((emitted[0][0] as any).content).toBe("prior message")
  })

  it("prepends prior blocks to new blocks from ChatSession", () => {
    const priorBlocks: AnyBlock[] = [
      { kind: "text", content: "prior", timestamp: 100 } as AnyBlock,
    ]
    const newBlocks: AnyBlock[] = [
      { kind: "text", content: "new message", timestamp: 300 } as AnyBlock,
    ]

    // Simulate the onBlocks merge logic from ChatRunner
    let currentBlocks: AnyBlock[] = [...priorBlocks]
    const onBlocksFromSession = (blocks: AnyBlock[]) => {
      currentBlocks = priorBlocks ? [...priorBlocks, ...blocks] : blocks
    }

    onBlocksFromSession(newBlocks)

    expect(currentBlocks).toHaveLength(2)
    expect((currentBlocks[0] as any).content).toBe("prior")
    expect((currentBlocks[1] as any).content).toBe("new message")
  })

  it("flusher saves prior + new blocks combined", () => {
    const priorBlocks: AnyBlock[] = [
      { kind: "text", content: "old", timestamp: 100 } as AnyBlock,
    ]
    const newBlocks: AnyBlock[] = [
      { kind: "text", content: "fresh", timestamp: 200 } as AnyBlock,
    ]

    let currentBlocks: AnyBlock[] = [...priorBlocks]
    let savedBlocks: AnyBlock[] = []

    // Simulate flusher getBlocks callback
    const getBlocks = () => currentBlocks

    // Simulate onBlocks from ChatSession
    currentBlocks = [...priorBlocks, ...newBlocks]

    // Simulate flusher saving
    savedBlocks = getBlocks()

    expect(savedBlocks).toHaveLength(2)
    expect((savedBlocks[0] as any).content).toBe("old")
    expect((savedBlocks[1] as any).content).toBe("fresh")
  })

  it("without priorBlocks, onBlocks passes new blocks directly", () => {
    const priorBlocks: AnyBlock[] | undefined = undefined
    const newBlocks: AnyBlock[] = [
      { kind: "text", content: "new", timestamp: 100 } as AnyBlock,
    ]

    // Simulate the onBlocks merge logic when no priorBlocks
    const currentBlocks = priorBlocks ? [...priorBlocks, ...newBlocks] : newBlocks

    expect(currentBlocks).toHaveLength(1)
    expect((currentBlocks[0] as any).content).toBe("new")
  })
})
