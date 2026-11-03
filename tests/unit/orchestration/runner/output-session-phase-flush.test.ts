import { describe, it, expect, afterEach, mock, spyOn } from "bun:test"
import { createOutputSession, type OutputSession } from "../../../../src/orchestration/runner/output-session"
import type { SessionEntryBasePatch } from "../../../../src/orchestration/session-store/types"
import {
  flushMicrotasks,
  makeAssistantTextEvent,
  makeAssistantThinkingEvent,
} from "./_output-session-fixtures"

describe("createOutputSession — model phase + flush", () => {
  let session: OutputSession | null = null
  const createMocks = () => ({ updateEntry: mock<(patch: SessionEntryBasePatch) => void>() })
  /** The count the store holds: it folds each patch over the entry, so a
   *  patch without the count keeps the last one published. */
  const storedChars = (updateEntry: ReturnType<typeof createMocks>["updateEntry"]): number | undefined =>
    updateEntry.mock.calls.map(([patch]) => patch.streamingOutputChars).filter((chars) => chars !== undefined).at(-1)

  afterEach(() => {
    session?.dispose()
    session = null
  })

  // ── Model phase transitions ──

  it("settled thinking-only block renders without a live phase", () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    // makeAssistantThinkingEvent emits a settled assistant event with a
    // thinking block. Settlement renders the block but never moves the live
    // phase, so the phase stays null.
    session.dispatchRuntimeEvent(makeAssistantThinkingEvent("pondering"))
    session.flush()

    const activityCalls = updateEntry.mock.calls.filter(
      (c) => c[0]?.streamPhase !== undefined,
    )
    const activities = activityCalls.map((c) => c[0]?.streamPhase)
    expect(activities).toContain(null)

    const blockCalls = updateEntry.mock.calls.filter(
      (c) => c[0]?.outputBlocks !== undefined,
    )
    const lastBlocks = blockCalls.at(-1)?.[0]?.outputBlocks ?? []
    expect(lastBlocks.some((b) => b.kind === "thinking")).toBe(true)
  })

  it("empty thinking_delta (Anthropic content_block_start) still flips phase to 'thinking'", () => {
    // Regression: Opus extended-reasoning turns emit an empty thinking_delta from
    // content_block_start before streaming any thinking text (sometimes the entire
    // thinking block streams only as signature_delta and no thinking text ever arrives).
    // The phase must still flip to "thinking" the moment that signal arrives, not on
    // the eventual text_delta.
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    session.dispatchRuntimeEvent({
      type: "model.content.delta",
      data: { type: "model.content.delta", delta: { type: "thinking_delta", thinking: "" }, block_key: "thinking" },
    })
    session.flush()

    const phases = updateEntry.mock.calls
      .filter((c) => c[0]?.streamPhase !== undefined)
      .map((c) => c[0]?.streamPhase)
    expect(phases).toContain("thinking")
  })

  it("notifies when whitespace-only thinking deltas advance the token estimate", () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    session.dispatchRuntimeEvent({
      type: "model.content.delta",
      data: { type: "model.content.delta", delta: { type: "thinking_delta", thinking: "\n\n\n\n" }, block_key: "thinking" },
    })
    session.flush()

    expect(storedChars(updateEntry)).toBe(4)
  })

  it("publishes the streamed character count on a phase change, then at a glance cadence", () => {
    // A live stream's deltas arrive more than one 16 ms frame apart, so each
    // one syncs the store as it lands. The case steps a frozen clock one
    // frame before each delta, so neither the frame nor the cadence depends
    // on how fast this process runs.
    let now = 1_000
    const clock = spyOn(performance, "now").mockImplementation(() => now)
    try {
      const { updateEntry } = createMocks()
      session = createOutputSession({ updateEntry, executionCwd: "/workspace" })
      const delta = (payload: { type: "text_delta"; text: string } | { type: "thinking_delta"; thinking: string }, blockKey: string) => {
        now += 20
        session?.dispatchRuntimeEvent({
          type: "model.content.delta",
          data: { type: "model.content.delta", delta: payload, block_key: blockKey },
        })
      }

      delta({ type: "text_delta", text: "first " }, "answer")
      session.flush()
      expect(updateEntry.mock.calls.at(-1)?.[0].streamPhase).toBe("generating")
      expect(storedChars(updateEntry)).toBe(6)

      // Within the cadence the text still syncs at frame rate, the count does not.
      delta({ type: "text_delta", text: "second" }, "answer")
      session.flush()
      expect(updateEntry.mock.calls.at(-1)?.[0].outputBlocks).toBeDefined()
      expect(storedChars(updateEntry)).toBe(6)

      // A phase change carries the exact count, with the characters of the
      // delta that changed the phase.
      delta({ type: "thinking_delta", thinking: "hm" }, "thinking")
      session.flush()
      expect(updateEntry.mock.calls.at(-1)?.[0].streamPhase).toBe("thinking")
      expect(storedChars(updateEntry)).toBe(14)
    } finally {
      clock.mockRestore()
    }
  })

  // ── beginTurn resets local turn state ──

  it("beginTurn resets phase and streaming chars without marking provider activity", () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    session.dispatchRuntimeEvent({
      type: "model.content.delta",
      data: { type: "model.content.delta", delta: { type: "text_delta", text: "seed text" }, block_key: "answer" },
    })
    session.flush()
    expect(updateEntry.mock.calls.at(-1)?.[0].streamPhase).toBe("generating")
    expect(storedChars(updateEntry)).toBe(9)

    session.beginTurn()
    session.flush()

    expect(updateEntry.mock.calls.at(-1)?.[0].streamPhase).toBeNull()
    expect(storedChars(updateEntry)).toBe(0)
  })

  // ── Flush interval ──

  it("flushes terminal tool availability through a pending coalesced sync without a second sync", async () => {
    // The sync stays pending only inside the 16 ms frame after the last one.
    // A frozen clock keeps both events inside that frame, so a stall of this
    // process cannot turn the coalesced sync into an immediate one.
    const clock = spyOn(performance, "now").mockReturnValue(1_000)
    try {
      const { updateEntry } = createMocks()
      session = createOutputSession({ updateEntry, executionCwd: "/workspace" })
      session.flush()
      updateEntry.mockClear()

      session.dispatchRuntimeEvent({
        type: "model.assistant_message.recorded",
        data: {
          message: {
            content: [{ type: "tool_use", id: "toolu_bash", name: "bash", input: { command: "printf final" } }],
          },
        },
      })
      expect(updateEntry.mock.calls).toHaveLength(0)

      session.dispatchRuntimeEvent({
        type: "tool.result.available",
        data: {
          tool_use_id: "toolu_bash",
          content: [{ type: "text", text: "final" }],
          outcome: "ok",
        },
      })

      expect(updateEntry.mock.calls).toHaveLength(1)
      expect(updateEntry.mock.calls[0]?.[0].outputBlocks).toContainEqual(
        expect.objectContaining({ kind: "tool", id: "toolu_bash", status: "completed", content: "final" }),
      )

      await flushMicrotasks()
      expect(updateEntry.mock.calls).toHaveLength(1)
    } finally {
      clock.mockRestore()
    }
  })

  it("onChange -> updateEntry({ outputBlocks }) called only when projected output changes", async () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    // Advance without changes — no outputBlocks update
    await flushMicrotasks()
    const blockCallsBefore = updateEntry.mock.calls.filter(
      (c) => c[0]?.outputBlocks !== undefined,
    )
    expect(blockCallsBefore.length).toBe(0)

    // Now write data
    session.dispatchRuntimeEvent(makeAssistantTextEvent("trigger flush"))
    await flushMicrotasks()

    const blockCallsAfter = updateEntry.mock.calls.filter(
      (c) => c[0]?.outputBlocks !== undefined,
    )
    expect(blockCallsAfter.length).toBeGreaterThan(0)
  })

})
