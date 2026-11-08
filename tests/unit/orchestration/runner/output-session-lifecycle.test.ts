import { describe, it, expect, afterEach } from "bun:test"
import { createOutputSession, type OutputSession } from "../../../../src/orchestration/runner/output-session"
import { OutputProjector } from "../../../../src/infra/output/output-projector"
import {
  createMocks,
  flushMicrotasks,
  makeAssistantTextEvent,
} from "./_output-session-fixtures"

describe("createOutputSession — queue/lifecycle/question handling", () => {
  let session: OutputSession | null = null

  afterEach(() => {
    session?.dispose()
    session = null
  })

  it("captures provider session ID from turn completion event", () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })
    expect(session.sessionId).toBeNull()
    session.dispatchRuntimeEvent({
      type: "model.turn.completed",
      data: { type: "model.turn.completed", session_id: "test-session-123" },
    })
    expect(session.sessionId).toBe("test-session-123")
  })

  // ── queue primitives ──

  it("drainQueued returns every queued message and empties the queue", () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    expect(session.drainQueued()).toEqual([])
    session.pushUserMessage("first", 1000, { queued: true })
    session.pushUserMessage("second", 2000, { queued: true })
    expect(session.drainQueued()).toEqual(["first", "second"])
    expect(session.hasQueued()).toBe(false)
  })

  it("withdrawQueued removes the queued row its cell names, and its restore puts the row back in place", () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })
    const queuedTexts = () => session!.getBlocks().filter((block) => block.kind === "userMessage").map((block) => block.content)

    session.pushUserMessage("first", 1000, { queued: true, dispatchIds: ["cell-1"] })
    session.pushUserMessage("second", 2000, { queued: true, dispatchIds: ["cell-2"] })

    const restore = session.withdrawQueued(["cell-1"])
    expect(queuedTexts()).toEqual(["second"])
    expect(session.withdrawQueued(["cell-3"])).toBeNull()
    restore?.()
    expect(queuedTexts()).toEqual(["first", "second"])
  })

  // ── getBlocks ──

  // ── dispose ──

  it("dispose() stops onChange callbacks, no further updateEntry calls", async () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    // Write data and flush it
    session.dispatchRuntimeEvent(makeAssistantTextEvent("pre-dispose"))
    await flushMicrotasks()

    // Dispose
    session.dispose()
    ;updateEntry.mockClear()

    // Advance timers — no further updateEntry calls should happen
    await flushMicrotasks()
    expect(updateEntry).not.toHaveBeenCalled()

    // Set to null so afterEach doesn't double-dispose
    session = null
  })

  // ── After dispose, runtime events are no-ops ──

  it("after dispose(), dispatchRuntimeEvent is a no-op", async () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    session.dispose()
    ;updateEntry.mockClear()

    // Runtime events should not throw or trigger any updates.
    session.dispatchRuntimeEvent(makeAssistantTextEvent("should be ignored"))
    await flushMicrotasks()
    expect(updateEntry).not.toHaveBeenCalled()

    session = null
  })

  // ── After dispose, system message writes are no-ops ──

  // ── Double dispose is safe ──

  it("calling dispose() twice does not throw", () => {
    const { updateEntry } = createMocks()
    session = createOutputSession({ updateEntry, executionCwd: "/workspace" })

    session.dispose()
    expect(() => session!.dispose()).not.toThrow()

    session = null
  })

  // ── answerQuestion / cancelQuestion ──

  it("answerQuestion marks the matching question block answered", async () => {
    const { updateEntry } = createMocks()
    const projector = new OutputProjector({ executionCwd: "/workspace" })
    session = createOutputSession({ updateEntry, projector })
    projector.apply({ type: "push-question", toolUseId: "tool_q1", questions: [{ question: "Which color?", choices: [{ kind: "option", label: "Red" }], multiSelect: false }], timestamp: 1 })
    await flushMicrotasks()
    updateEntry.mockClear()

    session.answerQuestion("tool_q1", { "Which color?": "Red" })
    await flushMicrotasks()

    expect(updateEntry).toHaveBeenCalled()
    const blocks = updateEntry.mock.calls.at(-1)![0].outputBlocks
    if (!blocks) throw new Error("The last store sync carried no output blocks")
    const question = blocks.find((b) => b.kind === "question")
    expect(question).toBeDefined()
    if (question?.kind === "question") {
      expect(question.answers).toEqual({ "Which color?": "Red" })
      expect(question.cancelled).toBeUndefined()
    }
  })

  it("cancelQuestion marks the matching question block cancelled", async () => {
    const { updateEntry } = createMocks()
    const projector = new OutputProjector({ executionCwd: "/workspace" })
    session = createOutputSession({ updateEntry, projector })
    projector.apply({ type: "push-question", toolUseId: "tool_q1", questions: [{ question: "Which color?", choices: [{ kind: "option", label: "Red" }], multiSelect: false }], timestamp: 1 })
    await flushMicrotasks()
    updateEntry.mockClear()

    session.cancelQuestion("tool_q1")
    await flushMicrotasks()

    expect(updateEntry).toHaveBeenCalled()
    const blocks = updateEntry.mock.calls.at(-1)![0].outputBlocks
    if (!blocks) throw new Error("The last store sync carried no output blocks")
    const question = blocks.find((b) => b.kind === "question")
    if (question?.kind === "question") {
      expect(question.cancelled).toBe(true)
    }
  })
})
