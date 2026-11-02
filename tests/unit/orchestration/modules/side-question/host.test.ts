import { describe, expect, it } from "bun:test"
import { createSideQuestionHost } from "../../../../../src/orchestration/modules/side-question/host.js"
import { SIDE_QUESTION_PENDING_RESULT } from "../../../../../src/orchestration/modules/side-question/context.js"
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import type { AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js"

function fixture() {
  const parent = new AbortController()
  let source: ConversationMessage[] = [{ kind: "user", content: "parent" }]
  const started = Promise.withResolvers<void>()
  const runs: Array<{
    messages: readonly ConversationMessage[]
    signal: AbortSignal
    text: (text: string) => void
    finish: (result: AgentRunResult) => void
  }> = []
  const host = createSideQuestionHost({
    signal: parent.signal,
    capture: async () => source,
    run: async (request) => {
      const done = Promise.withResolvers<AgentRunResult>()
      runs.push({ messages: request.messages, signal: request.signal, text: request.onAnswer, finish: done.resolve })
      request.signal.addEventListener("abort", () => done.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "aborted" } }), { once: true })
      started.resolve()
      return done.promise
    },
  })
  return { host, runs, parent, started: started.promise, source: (messages: ConversationMessage[]) => { source = messages } }
}

async function answered(f: ReturnType<typeof fixture>, question = "side") {
  await f.host.ask(question)
  await f.started
  const run = f.runs.at(-1)!
  run.text(`answer ${question}`)
  run.finish({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
  await f.host.settled()
  return f.host.snapshot().exchanges.at(-1)!
}

describe("session side questions", () => {
  it("captures all live parent messages and closes unfinished calls only in its copy", async () => {
    const f = fixture()
    const source: ConversationMessage[] = [
      ...Array.from({ length: 25 }, (_, index): ConversationMessage => ({ kind: "user", content: `parent ${index}` })),
      { kind: "assistant", content: [{ type: "tool_use", id: "done", name: "read", input: {} }, { type: "tool_use", id: "live", name: "bash", input: {} }], incomplete: true },
      { kind: "toolResult", toolUseId: "done", content: [{ type: "text", text: "done result" }] },
    ]
    const before = structuredClone(source)
    f.source(source)
    await f.host.ask("what is happening?")
    await f.started
    expect(f.runs[0]!.messages).toHaveLength(29)
    expect(f.runs[0]!.messages.at(-2)).toEqual({
      kind: "toolResult", toolUseId: "live", content: [{ type: "text", text: SIDE_QUESTION_PENDING_RESULT }],
    })
    expect(source).toEqual(before)
    expect(f.host.snapshot().current?.state).toBe("running")
    f.runs[0]!.text("live answer")
    expect(f.host.snapshot().current?.answer).toBe("live answer")
    f.parent.abort()
    await f.host.dispose()
    expect(f.runs[0]!.signal.aborted).toBe(true)
  })

  it("retains only 20 answered exchanges and promotes the selected captured source, not later parent context", async () => {
    const f = fixture()
    for (let index = 0; index < 22; index++) await answered(f, `question ${index}`)
    const view = f.host.snapshot()
    expect(view.exchanges).toHaveLength(20)
    expect(view.exchanges[0]!.question).toBe("question 2")
    const selected = view.exchanges[3]!
    f.source([{ kind: "user", content: "later parent" }])
    const context = f.host.promotion(selected.id)
    expect(context?.[0]).toEqual({ kind: "user", content: "parent" })
    expect(context?.at(-1)).toEqual({ kind: "assistant", content: selected.answer })
    expect(context).toHaveLength(13)
    expect(context?.[1]).toEqual({ kind: "user", origin: "human", content: "question 0" })
    await answered(f, "later side")
    expect(f.host.promotion(selected.id)).toEqual(context)
    expect(f.runs.at(-1)!.messages).toContainEqual({ kind: "user", origin: "human", content: "question 2" })
    expect(f.host.promotion(view.exchanges.at(-1)!.id)?.[1]).toEqual({ kind: "user", origin: "human", content: "question 1" })
    await f.host.dispose()
    expect(f.host.snapshot().exchanges).toEqual([])
  })

  it("joins replacement and ignores stale stop and clear from another client", async () => {
    const f = fixture()
    await f.host.ask("first")
    await f.started
    const first = f.host.snapshot()
    await f.host.ask("second")
    expect(f.runs[0]!.signal.aborted).toBe(true)
    const second = f.host.snapshot().current!
    expect(await f.host.stop(first.current!.id)).toBe(false)
    expect(await f.host.clear(first.revision)).toBe(false)
    expect(f.host.snapshot().current?.id).toBe(second.id)
    expect(await f.host.stop(second.id)).toBe(true)
    expect(f.host.snapshot().current?.state).toBe("stopped")
    expect(f.host.snapshot().exchanges).toEqual([])
    expect(await f.host.clear(f.host.snapshot().revision)).toBe(true)
    expect(f.host.snapshot().current).toBeNull()
    await f.host.ask("third")
    const third = f.runs.at(-1)!
    const displayedRevision = f.host.snapshot().revision
    third.text("progress since display")
    expect(f.host.snapshot().revision).toBe(displayedRevision)
    expect(await f.host.clear(displayedRevision)).toBe(true)
    expect(third.signal.aborted).toBe(true)
    expect(f.host.snapshot().current).toBeNull()
    await f.host.dispose()
  })

  it("retires admission without aborting admitted work and keeps parent shutdown connected", async () => {
    const f = fixture()
    await f.host.ask("admitted")
    await f.started
    const disposal = f.host.dispose()
    expect(f.runs[0]!.signal.aborted).toBe(false)
    f.runs[0]!.text("settling answer")
    expect(f.host.snapshot().current?.answer).toBe("settling answer")
    f.runs[0]!.finish({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await disposal
    await expect(f.host.ask("disabled")).rejects.toThrow("unavailable")

    const queued = fixture()
    const admission = queued.host.ask("queued before retirement")
    const queuedDisposal = queued.host.dispose()
    await admission
    await queued.started
    expect(queued.runs[0]!.signal.aborted).toBe(false)
    queued.runs[0]!.text("queued answer")
    queued.runs[0]!.finish({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await queuedDisposal

    const shutdown = fixture()
    await shutdown.host.ask("pending")
    await shutdown.started
    const retiring = shutdown.host.dispose()
    shutdown.parent.abort()
    await retiring
    expect(shutdown.runs[0]!.signal.aborted).toBe(true)
  })

  it("retains answered history on close and excludes errors and empty answers from follow-up history", async () => {
    const f = fixture()
    const exchange = await answered(f)
    expect(await f.host.stop(exchange.id)).toBe(false)
    await f.host.ask("fail")
    const run = f.runs.at(-1)!
    expect(run.messages).toContainEqual({ kind: "assistant", content: exchange.answer })
    run.finish({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error", message: "provider refused", recovery: { kind: "none" } } })
    await f.host.settled()
    expect(f.host.snapshot().current?.state).toBe("error")
    expect(f.host.snapshot().exchanges).toHaveLength(1)
    await f.host.ask("empty")
    f.runs.at(-1)!.finish({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } })
    await f.host.settled()
    expect(f.host.snapshot().current?.state).toBe("error")
    expect(f.host.snapshot().current?.error).toContain("returned no answer")
    expect(f.host.snapshot().exchanges).toHaveLength(1)
    await f.host.dispose()
  })

  it("settles initialization failure as an error and disposes once", async () => {
    const host = createSideQuestionHost({
      signal: new AbortController().signal,
      capture: async () => [],
      run: async () => { throw new Error("provider initialization failed") },
    })
    const updates: Array<string | null> = []
    host.subscribe((view) => { updates.push(view?.current?.state ?? null) })
    await host.ask("question")
    await host.settled()
    expect(host.snapshot().current?.state).toBe("error")
    expect(host.snapshot().exchanges).toEqual([])
    await host.dispose()
    await host.dispose()
    expect(updates).toEqual(["running", "error", null])
    await expect(host.ask("after disposal")).rejects.toThrow("unavailable")
  })
})
