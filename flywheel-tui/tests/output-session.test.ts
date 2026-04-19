import { describe, it, expect, vi, afterEach } from "vitest"
import { createOutputSession, type OutputSession, type OutputSessionOptions } from "../src/orchestration/output-session"
import { createNoopEmit } from "../src/infra/event-bus"
import { StructuredOutputBuilder } from "../src/infra/output/structured-output-builder"
import type { SessionEntryBase } from "../src/orchestration/session-store-types"
import type { AnyBlock } from "../src/infra/output-blocks"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** No-op emit that satisfies the required EmitFn signature. */
const noopEmit = createNoopEmit()

/** Flush one round of queued microtasks so onChange callbacks propagate. */
const flushMicrotasks = () => new Promise<void>(r => queueMicrotask(r))

function createMocks() {
  const updateEntry = vi.fn<(patch: Partial<SessionEntryBase>) => void>()
  const emit = vi.fn() as unknown as OutputSessionOptions["emit"]
  const onFlush = vi.fn()
  return { updateEntry, emit, onFlush }
}

/** Build a Claude-format assistant NDJSON line with a text content block. */
function makeAssistantTextNdjson(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "text", text }],
    },
  }) + "\n"
}

/** Build a Claude-format assistant NDJSON line with a thinking block. */
function makeAssistantThinkingNdjson(thinking: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [{ type: "thinking", thinking }],
    },
  }) + "\n"
}

/** Build a Claude-format assistant NDJSON line with arbitrary content blocks. */
function makeAssistantNdjson(content: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    type: "assistant",
    message: { content },
  }) + "\n"
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOutputSession", () => {
  let session: OutputSession | null = null

  afterEach(() => {
    session?.dispose()
    session = null
  })

  // ── writeStdout: NDJSON thinking content ──

  it("writeStdout with NDJSON thinking content alone -> creates standalone thinking block", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.writeStdout(makeAssistantThinkingNdjson("deep thoughts"))
    await flushMicrotasks()

    // Thinking without tool context creates a standalone thinking block
    const blockCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls[blockCalls.length - 1][0].outputBlocks as AnyBlock[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe("thinking")
  })

  // ── writeStdout: NDJSON text content ──

  it("writeStdout with NDJSON text content -> updateEntry called with TextBlock", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.writeStdout(makeAssistantTextNdjson("Hello world"))
    await flushMicrotasks()

    const blockCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls[blockCalls.length - 1][0].outputBlocks as AnyBlock[]
    const textBlock = blocks.find((b) => b.kind === "text")
    expect(textBlock).toBeDefined()
    expect((textBlock as { content: string }).content).toContain("Hello world")
  })

  // ── writeStdout: per-call engineId ──

  it("writeStdout(data, engineId) — per-call engineId flows through to parser", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // Feed a Claude assistant event with an explicit engineId
    session.writeStdout(makeAssistantTextNdjson("from claude engine"), "claude")
    await flushMicrotasks()

    const blockCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls[blockCalls.length - 1][0].outputBlocks as AnyBlock[]
    const textBlock = blocks.find((b) => b.kind === "text")
    expect(textBlock).toBeDefined()
  })

  // ── writeStderr ──

  it("writeStderr -> updateEntry called with SystemBlock after flush tick", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.writeStderr("something went wrong", 1000)

    // writeStderr defers to onChange microtask — flush it
    await flushMicrotasks()
    const blockCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls[blockCalls.length - 1][0].outputBlocks as AnyBlock[]
    const systemBlock = blocks.find((b) => b.kind === "system")
    expect(systemBlock).toBeDefined()
    expect((systemBlock as { message: string }).message).toBe("something went wrong")
  })

  // ── notifySpawned ──

  it("notifySpawned sets thinking start time, used when thinking joins a tool context", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // Notify spawned with a specific timestamp
    session.notifySpawned(5000)

    // First create a tool context, then thinking joins it
    session.writeStdout(makeAssistantNdjson([
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "test.ts" } },
    ]))
    session.writeStdout(makeAssistantThinkingNdjson("initial thinking"))
    await flushMicrotasks()

    const blockCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls[blockCalls.length - 1][0].outputBlocks as AnyBlock[]
    const toolGroup = blocks.find((b) => b.kind === "toolGroup") as { children: Array<{ name: string; timestamp: number }> } | undefined
    expect(toolGroup).toBeDefined()
    const thinkingRow = toolGroup!.children.find(c => c.name === "Thinking")
    expect(thinkingRow).toBeDefined()
    expect(thinkingRow!.timestamp).toBe(5000)
  })

  // ── notifyInjected ──

  it("notifyInjected pushes user message + sets thinking start time", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.notifyInjected("injected message", 3000, false, true)
    await flushMicrotasks()

    const blockCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls[blockCalls.length - 1][0].outputBlocks as AnyBlock[]

    // Should have a user message block
    const userMsg = blocks.find((b) => b.kind === "userMessage")
    expect(userMsg).toBeDefined()
    expect((userMsg as { content: string }).content).toBe("injected message")
    // System-injected: injected=true, pending=false
    expect((userMsg as { injected?: boolean }).injected).toBe(true)
    expect((userMsg as { pending?: boolean }).pending).toBe(false)
  })

  it("notifyInjected with pending=true marks message as pending user message (not system-injected)", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.notifyInjected("pending message", 3000, true, false)
    await flushMicrotasks()

    const blockCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    const blocks = blockCalls[blockCalls.length - 1][0].outputBlocks as AnyBlock[]
    const userMsg = blocks.find((b) => b.kind === "userMessage")
    expect(userMsg).toBeDefined()
    expect((userMsg as { pending?: boolean }).pending).toBe(true)
    // User-steering messages are not system-injected
    expect((userMsg as { injected?: boolean }).injected).toBe(false)
  })

  // ── Model activity transitions ──

  it("model activity transitions -> updateEntry called with correct modelActivity values", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.writeStdout(makeAssistantTextNdjson("some text"))
    session.flush()

    const activityCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].modelActivity !== undefined,
    )
    expect(activityCalls.length).toBeGreaterThan(0)
    const activities = activityCalls.map((c: Partial<SessionEntryBase>[]) => c[0].modelActivity)
    expect(activities).toContain("generating")
  })

  it("thinking content triggers 'thinking' model activity even without tool context", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // notifyThinkingStarted sets activity to "thinking" even without creating blocks
    session.writeStdout(makeAssistantThinkingNdjson("pondering"))
    session.flush()

    const activityCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].modelActivity !== undefined,
    )
    const activities = activityCalls.map((c: Partial<SessionEntryBase>[]) => c[0].modelActivity)
    expect(activities).toContain("thinking")
  })

  // ── Flush interval ──

  it("onChange -> updateEntry({ outputBlocks }) called only when builder has changes", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // Advance without changes — no outputBlocks update
    await flushMicrotasks()
    const blockCallsBefore = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCallsBefore.length).toBe(0)

    // Now write data
    session.writeStdout(makeAssistantTextNdjson("trigger flush"))
    await flushMicrotasks()

    const blockCallsAfter = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCallsAfter.length).toBeGreaterThan(0)
  })

  // ── onFlush hook ──

  it("onFlush hook called on explicit flush, not on onChange callbacks", async () => {
    const { updateEntry, emit, onFlush } = createMocks()
    session = createOutputSession({ updateEntry, emit, onFlush })

    session.writeStdout(makeAssistantTextNdjson("data"))
    await flushMicrotasks()

    // onFlush only fires on explicit flush(), not interval ticks
    expect(onFlush).not.toHaveBeenCalled()
    session.flush()
    expect(onFlush).toHaveBeenCalled()
  })

  // ── emit called with engine:ndjson ──

  it("emit called with engine:ndjson events", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit, workflowId: "test-wf" })

    session.writeStdout(makeAssistantTextNdjson("data for emit"))

    // emit should have been called with engine:ndjson
    const emitFn = emit as unknown as ReturnType<typeof vi.fn>
    expect(emitFn).toHaveBeenCalledWith(
      "engine:ndjson",
      expect.objectContaining({
        workflowId: "test-wf",
        ndjsonEvent: expect.objectContaining({
          type: "assistant",
        }),
      }),
    )
  })

  // ── flush() forces immediate updateEntry + onFlush ──

  it("flush() forces immediate updateEntry + onFlush call", () => {
    const { updateEntry, emit, onFlush } = createMocks()
    session = createOutputSession({ updateEntry, emit, onFlush })

    // Write some data but don't advance timers
    session.writeStdout(makeAssistantTextNdjson("urgent data"))

    // Clear mocks to isolate flush() behavior
    ;(updateEntry as ReturnType<typeof vi.fn>).mockClear()
    ;(onFlush as ReturnType<typeof vi.fn>).mockClear()

    session.flush()

    // Both should be called immediately without timer advancement
    expect(updateEntry).toHaveBeenCalledWith(
      expect.objectContaining({ outputBlocks: expect.any(Array) }),
    )
    expect(onFlush).toHaveBeenCalled()
  })

  // ── resolvePendingMessages ──

  it("resolvePendingMessages() delegates to builder, returns message texts", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // No pending messages — should return empty array
    expect(session.resolvePendingMessages()).toEqual([])

    // Add a pending message via notifyInjected with pending=true
    session.notifyInjected("pending msg", 1000, true)

    // Now resolve — should return the message texts
    expect(session.resolvePendingMessages()).toEqual(["pending msg"])
    // Second resolve — already resolved, should return empty array
    expect(session.resolvePendingMessages()).toEqual([])
  })

  // ── pushSystemMessage ──

  it("pushSystemMessage() delegates to builder", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.pushSystemMessage("System alert", 2000)
    await flushMicrotasks()

    const blockCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls[blockCalls.length - 1][0].outputBlocks as AnyBlock[]
    const systemBlock = blocks.find((b) => b.kind === "system")
    expect(systemBlock).toBeDefined()
    expect((systemBlock as { message: string }).message).toBe("System alert")
  })

  // ── resetTracking ──

  it("resetTracking() delegates to builder", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // Feed some data first to populate blocks
    session.writeStdout(makeAssistantTextNdjson("before reset"))
    await flushMicrotasks()

    // resetTracking should not throw and blocks should still exist
    session.resetTracking()
    const blocks = session.getBlocks()
    expect(blocks.length).toBeGreaterThan(0)
  })

  // ── getBlocks ──

  it("getBlocks() returns current blocks", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // Initially empty
    expect(session.getBlocks()).toEqual([])

    // After writing data
    session.writeStdout(makeAssistantTextNdjson("block data"))
    const blocks = session.getBlocks()
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks[0].kind).toBe("text")
  })

  // ── dispose ──

  it("dispose() stops onChange callbacks, no further updateEntry calls", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // Write data and flush it
    session.writeStdout(makeAssistantTextNdjson("pre-dispose"))
    await flushMicrotasks()

    // Dispose
    session.dispose()
    ;(updateEntry as ReturnType<typeof vi.fn>).mockClear()

    // Advance timers — no further updateEntry calls should happen
    await flushMicrotasks()
    expect(updateEntry).not.toHaveBeenCalled()

    // Set to null so afterEach doesn't double-dispose
    session = null
  })

  // ── After dispose, writeStdout is a no-op ──

  it("after dispose(), writeStdout is a no-op", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.dispose()
    ;(updateEntry as ReturnType<typeof vi.fn>).mockClear()

    // writeStdout should not throw or trigger any updates
    session.writeStdout(makeAssistantTextNdjson("should be ignored"))
    await flushMicrotasks()
    expect(updateEntry).not.toHaveBeenCalled()

    session = null
  })

  // ── After dispose, writeStderr is a no-op ──

  it("after dispose(), writeStderr is a no-op", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.dispose()
    ;(updateEntry as ReturnType<typeof vi.fn>).mockClear()

    session.writeStderr("should be ignored", Date.now())
    await flushMicrotasks()
    expect(updateEntry).not.toHaveBeenCalled()

    session = null
  })

  // ── Raw text (non-JSON) falls through to text blocks ──

  it("non-JSON stdout lines become text blocks via onRawText", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.writeStdout("plain text not json\n")
    await flushMicrotasks()

    const blockCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls[blockCalls.length - 1][0].outputBlocks as AnyBlock[]
    const textBlock = blocks.find((b) => b.kind === "text")
    expect(textBlock).toBeDefined()
    expect((textBlock as { content: string }).content).toContain("plain text not json")
  })

  // ── notifySpawned triggers thinking model activity ──

  it("notifySpawned triggers 'thinking' model activity via updateEntry", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.notifySpawned(1000)
    session.flush()

    const activityCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].modelActivity !== undefined,
    )
    expect(activityCalls.length).toBeGreaterThan(0)
    expect(activityCalls[0][0].modelActivity).toBe("thinking")
  })

  // ── Multiple writeStdout calls accumulate blocks ──

  it("multiple writeStdout calls accumulate blocks", async () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.writeStdout(makeAssistantTextNdjson("first"))
    session.writeStdout(makeAssistantTextNdjson("second"))
    await flushMicrotasks()

    const blocks = session.getBlocks()
    // Text blocks get merged, so we have at least 1
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    expect(blocks[0].kind).toBe("text")
  })

  // ── onFlush is NOT called when no changes ──

  it("onFlush is only called on explicit flush, not on idle ticks", async () => {
    const { updateEntry, emit, onFlush } = createMocks()
    session = createOutputSession({ updateEntry, emit, onFlush })

    // Advance timers without writing any data — onFlush does NOT fire
    await flushMicrotasks()

    expect(onFlush).not.toHaveBeenCalled()
  })

  // ── Double dispose is safe ──

  it("calling dispose() twice does not throw", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.dispose()
    expect(() => session!.dispose()).not.toThrow()

    session = null
  })

  // ── answerQuestion / cancelQuestion ──

  it("answerQuestion marks the matching question block answered", async () => {
    const { updateEntry, emit } = createMocks()
    const builder = new StructuredOutputBuilder()
    session = createOutputSession({ updateEntry, emit, builder })
    builder.pushQuestion("tool_q1", [{ question: "Which color?", options: [{ label: "Red" }] }], 1)
    await flushMicrotasks()
    updateEntry.mockClear()

    session.answerQuestion("tool_q1", { "Which color?": "Red" })
    await flushMicrotasks()

    expect(updateEntry).toHaveBeenCalled()
    const blocks = updateEntry.mock.calls.at(-1)![0].outputBlocks as AnyBlock[]
    const question = blocks.find((b) => b.kind === "question")
    expect(question).toBeDefined()
    if (question?.kind === "question") {
      expect(question.answers).toEqual({ "Which color?": "Red" })
      expect(question.cancelled).toBeUndefined()
    }
  })

  it("cancelQuestion marks the matching question block cancelled", async () => {
    const { updateEntry, emit } = createMocks()
    const builder = new StructuredOutputBuilder()
    session = createOutputSession({ updateEntry, emit, builder })
    builder.pushQuestion("tool_q1", [{ question: "Which color?", options: [{ label: "Red" }] }], 1)
    await flushMicrotasks()
    updateEntry.mockClear()

    session.cancelQuestion("tool_q1")
    await flushMicrotasks()

    expect(updateEntry).toHaveBeenCalled()
    const blocks = updateEntry.mock.calls.at(-1)![0].outputBlocks as AnyBlock[]
    const question = blocks.find((b) => b.kind === "question")
    if (question?.kind === "question") {
      expect(question.cancelled).toBe(true)
    }
  })
})
