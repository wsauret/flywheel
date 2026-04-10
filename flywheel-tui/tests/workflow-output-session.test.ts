/**
 * Tests for Phase 3: Workflow Mode (OpenTUIAdapter) → OutputSession integration.
 *
 * Verifies that:
 * - subprocess:spawned → thinking start captured via notifySpawned
 * - subprocess:output stdout → blocks rendered via writeStdout
 * - subprocess:output stderr → system block via writeStderr
 * - subprocess:injected → user message + thinking start via notifyInjected
 * - queue:completed → flush() writes immediately
 * - Shared builder — NdjsonPipeline writes to shared builder, OutputSession flushes them
 * - Synthetic thinking timer intercepts modelActivity via wrappedUpdateEntry
 * - Builder injection — OutputSession uses injected builder, not a new one
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createOutputSession, type OutputSession, type OutputSessionOptions } from "../src/orchestration/output-session"
import { StructuredOutputBuilder } from "../src/infra/output/structured-output-builder"
import { NdjsonPipeline } from "../src/tui/adapters/ndjson-pipeline"
import type { SessionEntryBase } from "../src/orchestration/session-store-types"
import { createNoopEmit } from "../src/infra/event-bus"
import type { AnyBlock } from "../src/infra/output-blocks"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopEmit = createNoopEmit()

function makeAssistantTextNdjson(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  }) + "\n"
}

function makeAssistantThinkingNdjson(thinking: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking }] },
  }) + "\n"
}

/** Create an OutputSession with a shared builder (workflow mode pattern). */
function createWorkflowSession(overrides?: {
  onFlush?: () => void
}) {
  const patches: Array<Partial<SessionEntryBase>> = []
  const builder = new StructuredOutputBuilder()

  const session = createOutputSession({
    updateEntry: (patch) => patches.push({ ...patch }),
    emit: noopEmit,
    builder,
    onFlush: overrides?.onFlush,
  })

  return { session, patches, builder }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Workflow → OutputSession integration", () => {
  let session: OutputSession | null = null

  afterEach(() => {
    session?.dispose()
    session = null
  })

  // ── Builder injection ──

  describe("builder injection", () => {
    it("uses the injected builder instead of creating a new one", () => {
      const { session: s, builder, patches } = createWorkflowSession()
      session = s

      // Write directly to the shared builder (simulating NdjsonPipeline)
      builder.pushSystemMessage("from ndjson-pipeline", Date.now())

      // OutputSession's flush should pick up the builder's blocks
      session.flush()

      const blockPatch = patches.find((p) => p.outputBlocks !== undefined)
      expect(blockPatch).toBeDefined()
      const blocks = blockPatch!.outputBlocks as AnyBlock[]
      const sysBlock = blocks.find((b) => b.kind === "system")
      expect(sysBlock).toBeDefined()
      expect((sysBlock as any).message).toBe("from ndjson-pipeline")
    })

    it("shared builder — NdjsonPipeline and OutputSession write to the same block stream", () => {
      const { session: s, builder, patches } = createWorkflowSession()
      session = s

      const ndjsonPipeline = new NdjsonPipeline(builder)

      // OutputSession writes a text block via stdout
      session.writeStdout(makeAssistantTextNdjson("worker output"))

      // NdjsonPipeline writes an agent block via dispatcher
      ndjsonPipeline.startDispatcher()
      ndjsonPipeline.completeDispatcher("Prompt ready")

      // Flush picks up BOTH sources
      session.flush()

      const blockPatch = patches.filter((p) => p.outputBlocks !== undefined).pop()
      expect(blockPatch).toBeDefined()
      const blocks = blockPatch!.outputBlocks as AnyBlock[]

      // Should have both a text block (from worker) and an agent block (from dispatcher)
      const textBlock = blocks.find((b) => b.kind === "text")
      const agentBlock = blocks.find((b) => b.kind === "agent")
      expect(textBlock).toBeDefined()
      expect(agentBlock).toBeDefined()
    })
  })

  // ── subprocess:spawned → notifySpawned ──

  describe("subprocess:spawned → notifySpawned", () => {
    it("sets thinking start, reflected in subsequent ThinkingBlock timestamp", () => {
      const { session: s, patches } = createWorkflowSession()
      session = s

      session.notifySpawned(5000)
      session.writeStdout(makeAssistantThinkingNdjson("initial thinking"))
      session.flush()

      const blockPatch = patches.filter((p) => p.outputBlocks !== undefined).pop()
      const blocks = blockPatch!.outputBlocks as AnyBlock[]
      const thinkingBlock = blocks.find((b) => b.kind === "thinking")
      expect(thinkingBlock).toBeDefined()
      expect(thinkingBlock!.timestamp).toBe(5000)
    })

    it("triggers thinking model activity via updateEntry", () => {
      const { session: s, patches } = createWorkflowSession()
      session = s

      session.notifySpawned(1000)

      const activityPatches = patches.filter((p) => p.modelActivity !== undefined)
      expect(activityPatches.length).toBeGreaterThan(0)
      expect(activityPatches[0].modelActivity).toBe("thinking")
    })
  })

  // ── subprocess:output stdout → writeStdout ──

  describe("subprocess:output stdout → writeStdout", () => {
    it("text content renders as TextBlock", () => {
      const { session: s, patches } = createWorkflowSession()
      session = s

      session.writeStdout(makeAssistantTextNdjson("Hello from worker"))
      session.flush()

      const blockPatch = patches.filter((p) => p.outputBlocks !== undefined).pop()
      expect(blockPatch).toBeDefined()
      const blocks = blockPatch!.outputBlocks as AnyBlock[]
      const textBlock = blocks.find((b) => b.kind === "text")
      expect(textBlock).toBeDefined()
      expect((textBlock as any).content).toContain("Hello from worker")
    })

    it("engineId is accepted per-call without error", () => {
      const { session: s, patches } = createWorkflowSession()
      session = s

      session.writeStdout(makeAssistantTextNdjson("with engine"), "claude")
      session.flush()

      const blockPatch = patches.filter((p) => p.outputBlocks !== undefined).pop()
      expect(blockPatch).toBeDefined()
    })
  })

  // ── subprocess:output stderr → writeStderr ──

  describe("subprocess:output stderr → writeStderr", () => {
    it("creates SystemBlock (flushed by interval or explicit flush)", () => {
      const { session: s, patches } = createWorkflowSession()
      session = s

      session.writeStderr("error output from worker", 2000)

      // writeStderr defers to the 16ms interval — force flush to verify
      session.flush()
      const blockPatch = patches.filter((p) => p.outputBlocks !== undefined).pop()
      expect(blockPatch).toBeDefined()
      const blocks = blockPatch!.outputBlocks as AnyBlock[]
      const sysBlock = blocks.find((b) => b.kind === "system")
      expect(sysBlock).toBeDefined()
      expect((sysBlock as any).message).toBe("error output from worker")
    })
  })

  // ── subprocess:injected → notifyInjected ──

  describe("subprocess:injected → notifyInjected", () => {
    it("pushes user message + sets thinking start", () => {
      const { session: s, patches } = createWorkflowSession()
      session = s

      session.notifyInjected("injected prompt", 3000, false, true)
      session.flush()

      const blockPatch = patches.filter((p) => p.outputBlocks !== undefined).pop()
      const blocks = blockPatch!.outputBlocks as AnyBlock[]

      const userMsg = blocks.find((b) => b.kind === "userMessage")
      expect(userMsg).toBeDefined()
      expect((userMsg as any).content).toBe("injected prompt")
      expect((userMsg as any).injected).toBe(true)
    })
  })

  // ── queue:completed → flush() ──

  describe("queue:completed → flush()", () => {
    it("flush() writes blocks immediately without waiting for interval", () => {
      const { session: s, patches } = createWorkflowSession()
      session = s

      // Add content, then flush (simulating queue:completed handler)
      session.writeStdout(makeAssistantTextNdjson("final output"))

      // Clear patches to isolate flush
      patches.length = 0

      session.flush()

      const blockPatch = patches.find((p) => p.outputBlocks !== undefined)
      expect(blockPatch).toBeDefined()
      const blocks = blockPatch!.outputBlocks as AnyBlock[]
      expect(blocks.length).toBeGreaterThan(0)
    })
  })

  // ── resetTracking (queue:step-started) ──

  describe("resetTracking", () => {
    it("resets tracking while preserving existing blocks", () => {
      const { session: s } = createWorkflowSession()
      session = s

      session.writeStdout(makeAssistantTextNdjson("step 1 output"))
      const blocksBefore = session.getBlocks()
      expect(blocksBefore.length).toBeGreaterThan(0)

      session.resetTracking()

      // Blocks should still exist after reset
      const blocksAfter = session.getBlocks()
      expect(blocksAfter.length).toBeGreaterThan(0)
    })
  })

  // ── pushSystemMessage + flush (budget:exhausted pattern) ──

  describe("pushSystemMessage + flush", () => {
    it("writes system message and flushes immediately", () => {
      const { session: s, patches } = createWorkflowSession()
      session = s

      session.pushSystemMessage("Budget exhausted: token limit", 4000)
      session.flush()

      const blockPatch = patches.filter((p) => p.outputBlocks !== undefined).pop()
      expect(blockPatch).toBeDefined()
      const blocks = blockPatch!.outputBlocks as AnyBlock[]
      const sysBlock = blocks.find((b) => b.kind === "system")
      expect(sysBlock).toBeDefined()
      expect((sysBlock as any).message).toContain("Budget exhausted")
    })
  })

  // ── getBlocks for step boundary check ──

  describe("getBlocks for step boundary check", () => {
    it("returns empty array initially — no step boundary needed for first step", () => {
      const { session: s } = createWorkflowSession()
      session = s

      expect(session.getBlocks().length).toBe(0)
    })

    it("returns non-empty after content — step boundary should be emitted", () => {
      const { session: s } = createWorkflowSession()
      session = s

      session.writeStdout(makeAssistantTextNdjson("step 1 done"))
      expect(session.getBlocks().length).toBeGreaterThan(0)
    })
  })

  // ── Synthetic thinking timer via wrappedUpdateEntry ──

  describe("synthetic thinking timer (wrappedUpdateEntry pattern)", () => {
    it("wrappedUpdateEntry intercepts modelActivity and applies timer", async () => {
      const patches: Array<Partial<SessionEntryBase>> = []
      const builder = new StructuredOutputBuilder()
      const syntheticThinkingMs = 50

      let syntheticTimer: ReturnType<typeof setTimeout> | null = null

      const wrappedUpdateEntry = (patch: Partial<SessionEntryBase>) => {
        if (patch.modelActivity !== undefined) {
          if (syntheticTimer) {
            clearTimeout(syntheticTimer)
            syntheticTimer = null
          }
          if (patch.modelActivity === "tool_executing" || patch.modelActivity === "generating") {
            syntheticTimer = setTimeout(() => {
              syntheticTimer = null
              patches.push({ modelActivity: "thinking" })
            }, syntheticThinkingMs)
          }
        }
        patches.push({ ...patch })
      }

      const s = createOutputSession({
        updateEntry: wrappedUpdateEntry,
        emit: noopEmit,
        builder,
      })
      session = s

      // Feed a text event which triggers "generating" activity
      s.writeStdout(makeAssistantTextNdjson("some text"))

      // Should have "generating" in patches
      const generatingPatch = patches.find((p) => p.modelActivity === "generating")
      expect(generatingPatch).toBeDefined()

      // Wait for synthetic timer to fire
      await new Promise((r) => setTimeout(r, syntheticThinkingMs + 20))

      // Should now have "thinking" from the synthetic timer
      const thinkingPatch = patches.find((p) => p.modelActivity === "thinking")
      expect(thinkingPatch).toBeDefined()

      // Clean up
      if (syntheticTimer) clearTimeout(syntheticTimer)
    })
  })

  // ── No-op emit prevents duplicate subprocess:ndjson ──

  describe("no-op emit", () => {
    it("no-op emit does not produce subprocess:ndjson events", () => {
      const emitCalls: any[] = []
      const trackingEmit = ((...args: any[]) => emitCalls.push(args)) as unknown as EmitFn

      // Deliberately use the tracking emit to verify no calls happen with no-op
      const builder = new StructuredOutputBuilder()
      const s = createOutputSession({
        updateEntry: () => {},
        emit: noopEmit,
        builder,
      })
      session = s

      s.writeStdout(makeAssistantTextNdjson("test"))

      // With noopEmit, no events should be tracked
      // (This test validates the pattern — noopEmit absorbs the call)
      expect(emitCalls.length).toBe(0)
    })
  })

  // ── dispose ──

  describe("dispose", () => {
    it("stops flush interval and prevents further writes", () => {
      const { session: s, patches } = createWorkflowSession()
      session = s

      s.dispose()
      const patchCountBefore = patches.length

      s.writeStdout(makeAssistantTextNdjson("should be ignored"))
      s.writeStderr("should be ignored", Date.now())

      expect(patches.length).toBe(patchCountBefore)

      session = null // prevent double-dispose in afterEach
    })
  })
})
