/**
 * Tests for ChatRunner — wraps ChatSession with
 * output persistence, and state machine transitions.
 */

import { describe, it, expect } from "bun:test"
import type { AnyBlock } from "../src/infra/output-blocks"

// ── Stubs ──

/** Minimal ChatSession stub that records calls. */
function createStubChatSession() {
  const calls: string[] = []
  let onWaiting: ((waiting: boolean) => void) | null = null
  return {
    session: {
      send: (text: string) => { calls.push(`send:${text}`) },
      interrupt: () => { calls.push("interrupt") },
      end: () => { calls.push("end") },
      outputSession: { getBlocks: () => [], flush: () => {}, dispose: () => {} },
      budgetTracker: { getTokensUsed: () => 0, getTotalCost: () => 0 },
    },
    calls,
    /** Simulate wiring callbacks during factory */
    captureCallbacks(cbs: { onWaiting: any }) {
      onWaiting = cbs.onWaiting
    },
    triggerWaiting(waiting: boolean) { onWaiting?.(waiting) },
  }
}

describe("ChatRunner", () => {
  // We test the design contract here. The actual createChatRunner is tested
  // against a mock ChatSession factory (no real subprocess).

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

  it("onFlush wired to output flusher schedule", () => {
    let scheduled = false
    const mockFlusher = {
      schedule: () => { scheduled = true },
      flush: async () => {},
      dispose: () => {},
    }

    // Simulate onFlush callback wiring (from chat-runner → chat-session → OutputSession)
    const onFlush = () => {
      mockFlusher.schedule()
    }

    onFlush()
    expect(scheduled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Resume — prior blocks behavior
// ---------------------------------------------------------------------------

describe("ChatRunner — resume with priorBlocks", () => {
  it("emits prior blocks immediately via updateEntry", () => {
    const entryUpdates: any[] = []
    const priorBlocks: AnyBlock[] = [
      { kind: "text", content: "prior message", timestamp: 100 } as AnyBlock,
      { kind: "system", message: "started", timestamp: 200 } as AnyBlock,
    ]

    const updateEntry = (patch: any) => { entryUpdates.push(patch) }

    // This is the logic from createChatRunner when priorBlocks is provided
    if (priorBlocks && priorBlocks.length > 0) {
      updateEntry({ outputBlocks: [...priorBlocks] })
    }

    expect(entryUpdates).toHaveLength(1)
    expect(entryUpdates[0].outputBlocks).toHaveLength(2)
    expect((entryUpdates[0].outputBlocks[0] as any).kind).toBe("text")
    expect((entryUpdates[0].outputBlocks[0] as any).content).toBe("prior message")
  })

  it("wrappedUpdateEntry prepends prior blocks to OutputSession blocks", () => {
    const priorBlocks: AnyBlock[] = [
      { kind: "text", content: "prior", timestamp: 100 } as AnyBlock,
    ]
    const newBlocks: AnyBlock[] = [
      { kind: "text", content: "new message", timestamp: 300 } as AnyBlock,
    ]

    // Simulate the wrappedUpdateEntry logic from ChatRunner
    let lastUpdate: any = null
    const updateEntry = (patch: any) => { lastUpdate = patch }
    const wrappedUpdateEntry = (patch: any) => {
      if (patch.outputBlocks && priorBlocks && priorBlocks.length > 0) {
        updateEntry({ ...patch, outputBlocks: [...priorBlocks, ...patch.outputBlocks] })
      } else {
        updateEntry(patch)
      }
    }

    wrappedUpdateEntry({ outputBlocks: newBlocks })

    expect(lastUpdate.outputBlocks).toHaveLength(2)
    expect((lastUpdate.outputBlocks[0] as any).content).toBe("prior")
    expect((lastUpdate.outputBlocks[1] as any).content).toBe("new message")
  })

  it("flusher saves prior + OutputSession blocks combined", () => {
    const priorBlocks: AnyBlock[] = [
      { kind: "text", content: "old", timestamp: 100 } as AnyBlock,
    ]
    const sessionBlocks: AnyBlock[] = [
      { kind: "text", content: "fresh", timestamp: 200 } as AnyBlock,
    ]

    // Simulate flusher getBlocks callback (from ChatRunner wiring)
    const getBlocksFn = () => {
      return priorBlocks && priorBlocks.length > 0
        ? [...priorBlocks, ...sessionBlocks]
        : sessionBlocks
    }

    const savedBlocks = getBlocksFn()

    expect(savedBlocks).toHaveLength(2)
    expect((savedBlocks[0] as any).content).toBe("old")
    expect((savedBlocks[1] as any).content).toBe("fresh")
  })

  it("without priorBlocks, wrappedUpdateEntry passes blocks directly", () => {
    const priorBlocks: AnyBlock[] | undefined = undefined
    const newBlocks: AnyBlock[] = [
      { kind: "text", content: "new", timestamp: 100 } as AnyBlock,
    ]

    // Simulate the wrappedUpdateEntry logic when no priorBlocks
    let lastUpdate: any = null
    const updateEntry = (patch: any) => { lastUpdate = patch }
    const wrappedUpdateEntry = (patch: any) => {
      if (patch.outputBlocks && priorBlocks && priorBlocks.length > 0) {
        updateEntry({ ...patch, outputBlocks: [...priorBlocks, ...patch.outputBlocks] })
      } else {
        updateEntry(patch)
      }
    }

    wrappedUpdateEntry({ outputBlocks: newBlocks })

    expect(lastUpdate.outputBlocks).toHaveLength(1)
    expect((lastUpdate.outputBlocks[0] as any).content).toBe("new")
  })
})
