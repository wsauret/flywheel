import { describe, it, expect, afterEach } from "bun:test"
import { createOutputSession, type OutputSession } from "../../../../src/orchestration/runner/output-session"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
import {
  createMocks,
  flushMicrotasks,
  makeAssistantEvent,
  makeAssistantTextEvent,
  makeAssistantThinkingEvent,
} from "./_output-session-fixtures"

/** Every block snapshot the session synced to the store, in call order. */
function blockSnapshots(updateEntry: ReturnType<typeof createMocks>["updateEntry"]): (readonly AnyBlock[])[] {
  return updateEntry.mock.calls.flatMap(([patch]) => patch.outputBlocks === undefined ? [] : [patch.outputBlocks])
}

function findBlock<K extends AnyBlock["kind"]>(blocks: readonly AnyBlock[], kind: K): Extract<AnyBlock, { kind: K }> | undefined {
  return blocks.find((block): block is Extract<AnyBlock, { kind: K }> => block.kind === kind)
}

describe("createOutputSession — write/push behaviors", () => {
  let session: OutputSession | null = null

  afterEach(() => {
    session?.dispose()
    session = null
  })

  it("assistant thinking runtime event alone creates standalone thinking block", async () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    session.dispatchRuntimeEvent(makeAssistantThinkingEvent("deep thoughts"))
    await flushMicrotasks()

    // Thinking without tool context creates a standalone thinking block
    const blockCalls = blockSnapshots(updateEntry)
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls.at(-1) ?? []
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe("thinking")
  })

  it("assistant text runtime event updates the store with a TextBlock", async () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    session.dispatchRuntimeEvent(makeAssistantTextEvent("Hello world"))
    await flushMicrotasks()

    const blockCalls = blockSnapshots(updateEntry)
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls.at(-1) ?? []
    const textBlock = findBlock(blocks, "text")
    expect(textBlock).toBeDefined()
    expect(textBlock?.content).toContain("Hello world")
  })

  it("pushSystemMessage updates the store with a SystemBlock", async () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    session.pushSystemMessage("something went wrong", 1000)

    await flushMicrotasks()
    const blockCalls = blockSnapshots(updateEntry)
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls.at(-1) ?? []
    const systemBlock = findBlock(blocks, "system")
    expect(systemBlock).toBeDefined()
    expect(systemBlock?.message).toBe("something went wrong")
  })

  // ── beginTurn ──

  it("provider response start sets thinking start time for top-level thinking blocks", async () => {
    const realNow = Date.now
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    try {
      session.beginTurn()
      Date.now = () => 5000
      session.dispatchRuntimeEvent({ type: "agent.provider_response.started", data: {} })

      Date.now = () => 6000
      session.dispatchRuntimeEvent(makeAssistantEvent([
        { type: "tool_use", id: "t1", name: "Read", input: { path: "test.ts" } },
      ]))
      session.dispatchRuntimeEvent(makeAssistantThinkingEvent("initial thinking"))
      await flushMicrotasks()
    } finally {
      Date.now = realNow
    }

    const blockCalls = blockSnapshots(updateEntry)
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls.at(-1) ?? []
    const thinking = findBlock(blocks, "thinking")
    expect(thinking).toBeDefined()
    expect(thinking).toMatchObject({ timestamp: 5000, content: "initial thinking" })
  })

  it("nested provider response start does not drive the parent model phase", async () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    session.dispatchRuntimeEvent({
      type: "agent.provider_response.started",
      data: { parent_tool_use_id: "subagent-tool" },
    })
    await flushMicrotasks()

    expect(updateEntry.mock.calls).toHaveLength(0)
  })

  // ── pushUserMessage ──

  it("pushUserMessage pushes an injected user message", async () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    session.pushUserMessage("injected message", 3000, { injected: true })
    await flushMicrotasks()

    const blockCalls = blockSnapshots(updateEntry)
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls.at(-1) ?? []

    const userMsg = findBlock(blocks, "userMessage")
    expect(userMsg).toBeDefined()
    expect(userMsg?.content).toBe("injected message")
    expect(userMsg?.injected).toBe(true)
    expect(userMsg?.pending).toBe(false)
  })

  it("pushUserMessage with queued=true marks message as queued (not system-injected)", async () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    const images = [{ mediaType: "image/png", data: "aGk=" }]
    session.pushUserMessage("pending message [Image #1]", 3000, { queued: true, submissionIds: ["queued-1"], images })
    expect(session.getBlocks()).toContainEqual(expect.objectContaining({ kind: "userMessage", pending: true, submissionIds: ["queued-1"], images }))
    await flushMicrotasks()

    const blockCalls = blockSnapshots(updateEntry)
    const blocks = blockCalls.at(-1) ?? []
    const userMsg = findBlock(blocks, "userMessage")
    expect(userMsg).toBeDefined()
    expect(userMsg?.pending).toBe(true)
    expect(userMsg?.injected).toBe(false)
    session.drainQueued()
    expect(session.getBlocks()).toContainEqual(expect.objectContaining({ kind: "userMessage", pending: false, images }))
  })

  // ── pushSystemMessage ──

  it("multiple assistant runtime events accumulate blocks", async () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    session.dispatchRuntimeEvent(makeAssistantTextEvent("first"))
    session.dispatchRuntimeEvent(makeAssistantTextEvent("second"))
    await flushMicrotasks()

    const blocks = session.getBlocks()
    // Text blocks get merged, so we have at least 1
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    expect(blocks[0]?.kind).toBe("text")
  })

  // ── Seeded sessions still stream ──

  // Regression: seedBlocks fires the builder's change notification during
  // construction. If that happens before onChange is wired, the change latch
  // arms with no consumer to re-arm it and every later streamed update stays
  // silent until the end-of-turn flush — blocks render all at once.
  it("session seeded with priorBlocks still syncs streamed updates incrementally", async () => {
    const { updateEntry } = createMocks()
    const prior: AnyBlock[] = [{ kind: "userMessage", id: "user-1", content: "hi", timestamp: 1, pending: false, injected: false }]
    session = createOutputSession({ updateEntry, priorBlocks: prior, executionCwd: "/workspace" })
    await flushMicrotasks()
    ;updateEntry.mockClear()

    session.dispatchRuntimeEvent(makeAssistantTextEvent("streamed"))
    await flushMicrotasks()

    const blockCalls = blockSnapshots(updateEntry)
    expect(blockCalls.length).toBeGreaterThan(0)
    const blocks = blockCalls.at(-1) ?? []
    expect(blocks.some((b) => b.kind === "text")).toBe(true)
  })

  // The sync throttle reads performance.now(). A stubbed clock keeps a stall of
  // the test process between flush and the first delta from making the first
  // delta overdue, and moves time past the throttle without letting the
  // pending timer fire, which is the overdue state under test.
  it("forces an overdue pending sync from the next streamed update", () => {
    const realNow = performance.now
    let now = 1000
    performance.now = () => now
    const { updateEntry } = createMocks()
    try {
      session = createOutputSession({ updateEntry, executionCwd: "/workspace" })
      session.flush()
      ;updateEntry.mockClear()

      session.dispatchRuntimeEvent({
        type: "model.content.delta",
        data: { type: "model.content.delta", delta: { type: "text_delta", text: "first " }, block_key: "answer" },
      })
      expect(updateEntry.mock.calls).toHaveLength(0)

      now += 25
      session.dispatchRuntimeEvent({
        type: "model.content.delta",
        data: { type: "model.content.delta", delta: { type: "text_delta", text: "second" }, block_key: "answer" },
      })
    } finally {
      performance.now = realNow
    }

    const blockCalls = blockSnapshots(updateEntry)
    expect(blockCalls).toHaveLength(1)
    const blocks = blockCalls[0] ?? []
    const text = findBlock(blocks, "text")
    expect(text).toMatchObject({ content: "first second" })
  })

  it("output session writes the visible suffix count with every coalesced block patch", async () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({
      updateEntry,
      priorBlocks: [{ kind: "text", id: "durable", content: "history", timestamp: 0 }],
      executionCwd: "/workspace",
    })
    await flushMicrotasks()
    expect(updateEntry.mock.calls.at(-1)?.[0]).toMatchObject({ visibleMessageCountSuffix: 1 })

    session.dispatchRuntimeEvent(makeAssistantTextEvent("new answer"))
    await flushMicrotasks()
    expect(updateEntry.mock.calls.at(-1)?.[0]).toMatchObject({ visibleMessageCountSuffix: 2 })

    session.dispatchRuntimeEvent(makeAssistantTextEvent(" continued"))
    await flushMicrotasks()
    expect(updateEntry.mock.calls.at(-1)?.[0]).toMatchObject({ visibleMessageCountSuffix: 3 })
  })
})
