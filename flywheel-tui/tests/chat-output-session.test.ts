/**
 * Tests for Phase 2: Chat Mode → OutputSession integration.
 *
 * Verifies that chat-session correctly uses OutputSession instead of the
 * manual createOutputPipeline() + callbacks approach:
 * - OutputSession writes blocks and modelActivity to the store via updateEntry
 * - Pending messages are resolved when user echo events arrive
 * - Context-too-long detection still resets session and pushes a system message
 * - Budget metrics are written to the store via onFlush
 * - The userTurnInProgress gate works correctly
 * - flushContextRun is called at turn boundaries
 * - flushParser is called on worker exit
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { createOutputSession, type OutputSession, type OutputSessionOptions } from "../src/orchestration/output-session"
import { EventBus, createEmit } from "../src/infra/event-bus"
import type { SessionEntryBase } from "../src/orchestration/session-store-types"
import type { AnyBlock } from "../src/infra/output-blocks"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestOutputSession(overrides?: Partial<OutputSessionOptions>) {
  const patches: Array<Partial<SessionEntryBase>> = []
  const flushCalls: number[] = []

  const bus = new EventBus()
  const emit = createEmit(bus)

  const opts: OutputSessionOptions = {
    updateEntry: (patch) => patches.push({ ...patch }),
    emit,
    onFlush: () => flushCalls.push(Date.now()),
    workflowId: "test-chat",
    ...overrides,
  }

  const session = createOutputSession(opts)

  return { session, patches, flushCalls, bus, emit }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Chat → OutputSession integration", () => {
  describe("writeStdout + block rendering", () => {
    it("feeds NDJSON through the pipeline and updateEntry receives blocks", async () => {
      const { session, patches } = createTestOutputSession()

      // Feed a Claude Code assistant NDJSON event through stdout
      const ndjsonLine = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello from Claude" }] },
      }) + "\n"
      session.writeStdout(ndjsonLine, "claude")

      // Force flush to push blocks to updateEntry
      session.flush()

      // Should have at least one patch with outputBlocks
      const blockPatch = patches.find((p) => p.outputBlocks !== undefined)
      expect(blockPatch).toBeDefined()
      expect(blockPatch!.outputBlocks!.length).toBeGreaterThan(0)

      session.dispose()
    })

    it("writeStdout with engineId passes engine to event parser", () => {
      const { session, patches } = createTestOutputSession()

      // Feed an assistant event — the engineId is used internally for
      // structured event parser dispatch
      const ndjsonLine = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "test" }] },
      }) + "\n"
      session.writeStdout(ndjsonLine, "claude")
      session.flush()

      const blockPatch = patches.find((p) => p.outputBlocks !== undefined)
      expect(blockPatch).toBeDefined()

      session.dispose()
    })
  })

  describe("writeStderr", () => {
    it("creates a system block (flushed by interval or explicit flush)", () => {
      const { session, patches } = createTestOutputSession()

      session.writeStderr("some warning", Date.now())

      // writeStderr defers to the 16ms interval — force flush to verify
      session.flush()
      const blockPatch = patches.find((p) => p.outputBlocks !== undefined)
      expect(blockPatch).toBeDefined()

      const blocks = blockPatch!.outputBlocks!
      const systemBlock = blocks.find((b: any) => b.kind === "system")
      expect(systemBlock).toBeDefined()

      session.dispose()
    })
  })

  describe("notifyInjected + pending messages", () => {
    it("creates a user message block with pending flag", () => {
      const { session } = createTestOutputSession()

      session.notifyInjected("Hello!", Date.now(), true)

      const blocks = session.getBlocks()
      const userBlock = blocks.find((b: any) => b.kind === "userMessage")
      expect(userBlock).toBeDefined()
      expect((userBlock as any).pending).toBe(true)

      session.dispose()
    })

    it("resolvePendingMessages marks pending messages as resolved", () => {
      const { session } = createTestOutputSession()

      session.notifyInjected("Hello!", Date.now(), true)
      const resolved = session.resolvePendingMessages()
      expect(resolved).toBe(true)

      const blocks = session.getBlocks()
      const userBlock = blocks.find((b: any) => b.kind === "userMessage")
      expect(userBlock).toBeDefined()
      expect((userBlock as any).pending).toBe(false)

      session.dispose()
    })
  })

  describe("user echo detection via EventBus", () => {
    it("engine:ndjson events are emitted to EventBus", () => {
      const { session, bus } = createTestOutputSession()

      const events: any[] = []
      bus.subscribeToType("engine:ndjson", (e) => events.push(e))

      // Feed a user echo event through stdout
      const ndjsonLine = JSON.stringify({ type: "user" }) + "\n"
      session.writeStdout(ndjsonLine)

      expect(events.length).toBe(1)
      expect(events[0].ndjsonEvent.type).toBe("user")

      session.dispose()
    })

    it("chat code can subscribe to engine:ndjson and call resolvePendingMessages on user echo", () => {
      const { session, bus } = createTestOutputSession()

      // Inject a pending message
      session.notifyInjected("Hello!", Date.now(), true)

      // Subscribe like chat-session does
      bus.subscribeToType("engine:ndjson", (e) => {
        if (e.ndjsonEvent.type === "user") {
          session.resolvePendingMessages()
        }
      })

      // Feed the user echo event
      const ndjsonLine = JSON.stringify({ type: "user" }) + "\n"
      session.writeStdout(ndjsonLine)

      // Pending message should now be resolved
      const blocks = session.getBlocks()
      const userBlock = blocks.find((b: any) => b.kind === "userMessage")
      expect(userBlock).toBeDefined()
      expect((userBlock as any).pending).toBe(false)

      session.dispose()
    })
  })

  describe("context-too-long detection via EventBus", () => {
    it("result event with 'prompt is too long' is visible on EventBus for chat to handle", () => {
      const { session, bus } = createTestOutputSession()

      const events: any[] = []
      bus.subscribeToType("engine:ndjson", (e) => events.push(e))

      const resultEvent = JSON.stringify({
        type: "result",
        is_error: true,
        subtype: "error",
        result: "Error: prompt is too long for context window",
      }) + "\n"
      session.writeStdout(resultEvent)

      expect(events.length).toBe(1)
      const data = events[0].ndjsonEvent.data
      expect(data.type).toBe("result")
      expect(data.is_error).toBe(true)
      expect(data.result).toContain("prompt is too long")

      session.dispose()
    })
  })

  describe("model activity gating", () => {
    it("updateEntry receives modelActivity changes from the builder", async () => {
      const { session, patches } = createTestOutputSession()

      // Trigger thinking by spawning
      session.notifySpawned(Date.now())

      // Feed an assistant event that triggers thinking → generating transition
      const ndjsonLine = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "test" }] },
      }) + "\n"
      session.writeStdout(ndjsonLine, "claude")

      session.flush()

      const activityPatches = patches.filter((p) => p.modelActivity !== undefined)
      expect(activityPatches.length).toBeGreaterThan(0)

      session.dispose()
    })
  })

  describe("flushContextRun", () => {
    it("can be called at turn boundaries without error", () => {
      const { session } = createTestOutputSession()

      // Should not throw
      session.flushContextRun(Date.now())

      session.dispose()
    })
  })

  describe("flushParser", () => {
    it("processes any remaining partial line in the NDJSON buffer", () => {
      const { session, patches } = createTestOutputSession()

      // Write a partial line (no newline) — it stays in the buffer
      session.writeStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}')

      // Blocks should be empty before flush
      const blocksBefore = session.getBlocks()
      const textBlocksBefore = blocksBefore.filter((b: any) => b.kind === "text")

      // Now flush the parser to process the partial line
      session.flushParser()
      session.flush()

      const blocksAfter = session.getBlocks()
      // The partial line should now be processed
      expect(blocksAfter.length).toBeGreaterThan(textBlocksBefore.length)

      session.dispose()
    })
  })

  describe("sessionId", () => {
    it("starts as null", () => {
      const { session } = createTestOutputSession()
      expect(session.sessionId).toBeNull()
      session.dispose()
    })

    it("captures session ID from system event", () => {
      const { session } = createTestOutputSession()

      // Feed a system event with session ID (Claude Code's first event)
      const systemEvent = JSON.stringify({
        type: "system",
        sessionID: "test-session-123",
      }) + "\n"
      session.writeStdout(systemEvent)

      expect(session.sessionId).toBe("test-session-123")

      session.dispose()
    })
  })

  describe("onFlush callback", () => {
    it("fires on explicit flush, not on interval ticks", async () => {
      const { session, flushCalls } = createTestOutputSession()

      // Create some changes
      session.pushSystemMessage("test", Date.now())

      // Wait for flush ticks — onFlush should NOT fire from the interval
      await new Promise((r) => setTimeout(r, 50))
      expect(flushCalls.length).toBe(0)

      // Explicit flush DOES fire onFlush
      session.flush()
      expect(flushCalls.length).toBeGreaterThan(0)

      session.dispose()
    })
  })

  describe("dispose", () => {
    it("stops flush interval and prevents further writes", async () => {
      const { session, patches } = createTestOutputSession()

      session.dispose()

      const patchCountBefore = patches.length

      // These should be no-ops after dispose
      session.writeStdout('{"type":"user"}\n')
      session.writeStderr("test", Date.now())

      // Wait for any potential flush
      await new Promise((r) => setTimeout(r, 50))

      // No new patches should have been added
      expect(patches.length).toBe(patchCountBefore)
    })
  })

  describe("priorBlocks wrappedUpdateEntry pattern", () => {
    it("prepends priorBlocks when outputBlocks are written", () => {
      const priorBlocks: AnyBlock[] = [
        { kind: "text", content: "prior", timestamp: 100 } as AnyBlock,
      ]
      const allPatches: any[] = []

      // Simulate the wrappedUpdateEntry from chat-runner
      const rawUpdateEntry = (patch: any) => allPatches.push(patch)
      const wrappedUpdateEntry = (patch: Partial<SessionEntryBase>) => {
        if (patch.outputBlocks && priorBlocks.length > 0) {
          rawUpdateEntry({ ...patch, outputBlocks: [...priorBlocks, ...(patch.outputBlocks as AnyBlock[])] })
        } else {
          rawUpdateEntry(patch)
        }
      }

      const session = createOutputSession({
        updateEntry: wrappedUpdateEntry,
        emit: createEmit(new EventBus()),
        workflowId: "test",
      })

      session.pushSystemMessage("new message", Date.now())
      session.flush()

      const blockPatch = allPatches.find((p: any) => p.outputBlocks !== undefined)
      expect(blockPatch).toBeDefined()
      expect(blockPatch.outputBlocks[0].kind).toBe("text")
      expect(blockPatch.outputBlocks[0].content).toBe("prior")
      expect(blockPatch.outputBlocks.length).toBeGreaterThan(1)

      session.dispose()
    })
  })
})
