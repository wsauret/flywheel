import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { createOutputSession, type OutputSession, type OutputSessionOptions } from "../src/orchestration/output-session"
import { createNoopEmit } from "../src/infra/event-bus"
import type { SessionEntryBase } from "../src/orchestration/session-store"
import type { AnyBlock } from "../src/infra/output-blocks"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** No-op emit that satisfies the required EmitFn signature. */
const noopEmit = createNoopEmit()

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOutputSession", () => {
  let session: OutputSession | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    session?.dispose()
    session = null
    vi.useRealTimers()
  })

  // ── writeStdout: NDJSON thinking content ──

  it("writeStdout with NDJSON thinking content -> updateEntry called with ThinkingBlock", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.writeStdout(makeAssistantThinkingNdjson("deep thoughts"))
    vi.advanceTimersByTime(20)

    // updateEntry should have been called with outputBlocks containing a thinking block
    const blockCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls[blockCalls.length - 1][0].outputBlocks as AnyBlock[]
    const thinkingBlock = blocks.find((b) => b.kind === "thinking")
    expect(thinkingBlock).toBeDefined()
    expect((thinkingBlock as { content: string }).content).toContain("deep thoughts")
  })

  // ── writeStdout: NDJSON text content ──

  it("writeStdout with NDJSON text content -> updateEntry called with TextBlock", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.writeStdout(makeAssistantTextNdjson("Hello world"))
    vi.advanceTimersByTime(20)

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

  it("writeStdout(data, engineId) — per-call engineId flows through to parser", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // Feed a Claude assistant event with an explicit engineId
    session.writeStdout(makeAssistantTextNdjson("from claude engine"), "claude")
    vi.advanceTimersByTime(20)

    const blockCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls[blockCalls.length - 1][0].outputBlocks as AnyBlock[]
    const textBlock = blocks.find((b) => b.kind === "text")
    expect(textBlock).toBeDefined()
  })

  // ── writeStderr ──

  it("writeStderr -> updateEntry called with SystemBlock after flush tick", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.writeStderr("something went wrong", 1000)

    // writeStderr defers to the 16ms interval — advance timers
    vi.advanceTimersByTime(20)
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

  it("notifySpawned sets thinking start time, reflected in ThinkingBlock timestamp", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // Notify spawned with a specific timestamp
    session.notifySpawned(5000)

    // Now feed a thinking block — it should use the spawn timestamp
    session.writeStdout(makeAssistantThinkingNdjson("initial thinking"))
    vi.advanceTimersByTime(20)

    const blockCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls[blockCalls.length - 1][0].outputBlocks as AnyBlock[]
    const thinkingBlock = blocks.find((b) => b.kind === "thinking")
    expect(thinkingBlock).toBeDefined()
    expect(thinkingBlock!.timestamp).toBe(5000)
  })

  // ── notifyInjected ──

  it("notifyInjected pushes user message + sets thinking start time", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.notifyInjected("injected message", 3000, false, true)
    vi.advanceTimersByTime(20)

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

  it("notifyInjected with pending=true marks message as pending user message (not system-injected)", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.notifyInjected("pending message", 3000, true, false)
    vi.advanceTimersByTime(20)

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

    // Feed a text event which triggers "generating" activity
    session.writeStdout(makeAssistantTextNdjson("some text"))

    const activityCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].modelActivity !== undefined,
    )
    expect(activityCalls.length).toBeGreaterThan(0)
    const activities = activityCalls.map((c: Partial<SessionEntryBase>[]) => c[0].modelActivity)
    expect(activities).toContain("generating")
  })

  it("thinking content triggers 'thinking' model activity", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.writeStdout(makeAssistantThinkingNdjson("pondering"))

    const activityCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].modelActivity !== undefined,
    )
    const activities = activityCalls.map((c: Partial<SessionEntryBase>[]) => c[0].modelActivity)
    expect(activities).toContain("thinking")
  })

  // ── Flush interval ──

  it("flush interval -> updateEntry({ outputBlocks }) called only when builder has changes", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // Advance without changes — no outputBlocks update
    vi.advanceTimersByTime(50)
    const blockCallsBefore = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCallsBefore.length).toBe(0)

    // Now write data
    session.writeStdout(makeAssistantTextNdjson("trigger flush"))
    vi.advanceTimersByTime(20)

    const blockCallsAfter = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].outputBlocks !== undefined,
    )
    expect(blockCallsAfter.length).toBeGreaterThan(0)
  })

  // ── onFlush hook ──

  it("onFlush hook called on each 16ms tick alongside block flush", () => {
    const { updateEntry, emit, onFlush } = createMocks()
    session = createOutputSession({ updateEntry, emit, onFlush })

    session.writeStdout(makeAssistantTextNdjson("data"))
    vi.advanceTimersByTime(20)

    expect(onFlush).toHaveBeenCalled()
  })

  // ── emit called with subprocess:ndjson ──

  it("emit called with subprocess:ndjson events", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit, workflowId: "test-wf" })

    session.writeStdout(makeAssistantTextNdjson("data for emit"))

    // emit should have been called with subprocess:ndjson
    const emitFn = emit as unknown as ReturnType<typeof vi.fn>
    expect(emitFn).toHaveBeenCalledWith(
      "subprocess:ndjson",
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

  it("resolvePendingMessages() delegates to builder, returns boolean", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // No pending messages — should return false
    expect(session.resolvePendingMessages()).toBe(false)

    // Add a pending message via notifyInjected with pending=true
    session.notifyInjected("pending msg", 1000, true)

    // Now resolve — should return true
    expect(session.resolvePendingMessages()).toBe(true)
    // Second resolve — already resolved, should return false
    expect(session.resolvePendingMessages()).toBe(false)
  })

  // ── pushSystemMessage ──

  it("pushSystemMessage() delegates to builder", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.pushSystemMessage("System alert", 2000)
    vi.advanceTimersByTime(20)

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

  it("resetTracking() delegates to builder", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // Feed some data first to populate blocks
    session.writeStdout(makeAssistantTextNdjson("before reset"))
    vi.advanceTimersByTime(20)

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

  it("dispose() stops flush interval, no further updateEntry calls", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    // Write data and flush it
    session.writeStdout(makeAssistantTextNdjson("pre-dispose"))
    vi.advanceTimersByTime(20)

    // Dispose
    session.dispose()
    ;(updateEntry as ReturnType<typeof vi.fn>).mockClear()

    // Advance timers — no further updateEntry calls should happen
    vi.advanceTimersByTime(100)
    expect(updateEntry).not.toHaveBeenCalled()

    // Set to null so afterEach doesn't double-dispose
    session = null
  })

  // ── After dispose, writeStdout is a no-op ──

  it("after dispose(), writeStdout is a no-op", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.dispose()
    ;(updateEntry as ReturnType<typeof vi.fn>).mockClear()

    // writeStdout should not throw or trigger any updates
    session.writeStdout(makeAssistantTextNdjson("should be ignored"))
    vi.advanceTimersByTime(50)
    expect(updateEntry).not.toHaveBeenCalled()

    session = null
  })

  // ── After dispose, writeStderr is a no-op ──

  it("after dispose(), writeStderr is a no-op", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.dispose()
    ;(updateEntry as ReturnType<typeof vi.fn>).mockClear()

    session.writeStderr("should be ignored", Date.now())
    vi.advanceTimersByTime(50)
    expect(updateEntry).not.toHaveBeenCalled()

    session = null
  })

  // ── Raw text (non-JSON) falls through to text blocks ──

  it("non-JSON stdout lines become text blocks via onRawText", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.writeStdout("plain text not json\n")
    vi.advanceTimersByTime(20)

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

    const activityCalls = (updateEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: Partial<SessionEntryBase>[]) => c[0].modelActivity !== undefined,
    )
    expect(activityCalls.length).toBeGreaterThan(0)
    expect(activityCalls[0][0].modelActivity).toBe("thinking")
  })

  // ── Multiple writeStdout calls accumulate blocks ──

  it("multiple writeStdout calls accumulate blocks", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.writeStdout(makeAssistantTextNdjson("first"))
    session.writeStdout(makeAssistantThinkingNdjson("think"))
    session.writeStdout(makeAssistantTextNdjson("second"))
    vi.advanceTimersByTime(20)

    const blocks = session.getBlocks()
    // Should have text + thinking + text blocks
    expect(blocks.length).toBeGreaterThanOrEqual(3)
  })

  // ── onFlush is NOT called when no changes ──

  it("onFlush is called every tick even when builder has no changes", () => {
    const { updateEntry, emit, onFlush } = createMocks()
    session = createOutputSession({ updateEntry, emit, onFlush })

    // Advance timers without writing any data — onFlush still fires
    vi.advanceTimersByTime(100)

    expect(onFlush).toHaveBeenCalled()
  })

  // ── Double dispose is safe ──

  it("calling dispose() twice does not throw", () => {
    const { updateEntry, emit } = createMocks()
    session = createOutputSession({ updateEntry, emit })

    session.dispose()
    expect(() => session!.dispose()).not.toThrow()

    session = null
  })
})
