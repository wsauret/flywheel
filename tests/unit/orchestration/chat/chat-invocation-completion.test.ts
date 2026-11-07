import { expect, it } from "bun:test"
import { flushMicrotasks, makeLifecycle } from "./_chat-runner-lifecycle-fixtures"
import { createChatControls } from "../../../../src/orchestration/chat/controls"
import { createChatInvocationCompletion, type ChatTurnEnding } from "../../../../src/orchestration/chat/runner-completion"

it.each(["completed", "no_capture", "failed", "flush_failed"] as const)("publishes the sealed final reply only after successful durable completion: %s", async (scenario) => {
  const { lifecycle, deps, resolvers, runnerOptions } = makeLifecycle()
  const results: unknown[] = []
  deps.rootChatCompletion = createChatInvocationCompletion((content) => { results.push(content) })
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const endTurn = deps.treeWriter.endTurn
  deps.treeWriter.endTurn = async () => {
    entered.resolve()
    await held.promise
    if (scenario === "flush_failed") throw new Error("durable flush failed")
    await endTurn()
  }
  try {
    await lifecycle.enqueueInput("first")
    await flushMicrotasks()
    const options = runnerOptions[0]!
    expect(options.purpose.kind).toBe("interactive-chat")
    // The final reply is the result, so the invocation adds no request-only text and no handoff tool.
    expect(options.requestContext).toBeUndefined()
    expect(options.runtimeSurfaces?.handoff).toBeUndefined()
    const seal = options.lifecycle?.kind === "complete-on-idle" ? options.lifecycle.seal : undefined
    if (scenario !== "no_capture") expect(seal?.("done")).toBe(true)
    expect(results).toEqual([])
    const settlement = lifecycle.pendingTurnSettlement
    expect(settlement).toBeDefined()
    let settled = false
    void settlement?.then(() => { settled = true })
    if (scenario === "completed") {
      const ended = options.lifecycle?.onTurnEnded?.({ handoffWritten: false, turnCount: 1 })
      await entered.promise
      expect(settled).toBe(false)
      held.resolve()
      await ended
      await lifecycle.awaitLogicalTurnDurability()
      expect(results).toEqual([])
      expect(settled).toBe(false)
    }
    resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: scenario === "failed" ? { kind: "api_error", message: "failed", recovery: { kind: "none" } } : { kind: "completed" } })
    await entered.promise
    expect(results).toEqual([])
    expect(settled).toBe(false)
    held.resolve()
    await lifecycle.settle()
    await settlement
    expect(lifecycle.pendingTurnSettlement).toBeUndefined()
    expect(results).toEqual(scenario === "completed" ? [{ summary: "done" }] : [])
  } finally {
    held.resolve()
    await lifecycle.terminateBackgroundWorks()
  }
})

it.each([
  ["a turn the model answered", "turn", { kind: "completed" }, [{ kind: "completed" }]],
  ["a turn the content filter ended", "refused-turn", { kind: "completed" }, [{ kind: "refused" }]],
  ["a run the provider's content refusal failed", "none", { kind: "api_error", message: "cyber_policy", recovery: { kind: "none" }, contentRefused: true }, [{ kind: "refused" }]],
  ["a run another provider fault failed", "none", { kind: "api_error", message: "overloaded", recovery: { kind: "retry" } }, [{ kind: "failed", failure: "api_error" }]],
  ["a run whose context overflowed", "none", { kind: "context_overflow" }, [{ kind: "failed", failure: "context_overflow" }]],
  ["a run the caller stopped", "none", { kind: "aborted" }, []],
] as const)("reports how each turn of the root chat ended: %s", async (_name, turnEnd, terminal, expected) => {
  const { lifecycle, deps, resolvers, runnerOptions } = makeLifecycle()
  const endings: ChatTurnEnding[] = []
  deps.rootChatCompletion = createChatInvocationCompletion(undefined, (ending) => { endings.push(ending) })
  try {
    await lifecycle.enqueueInput("first")
    await flushMicrotasks()
    const options = runnerOptions[0]!
    if (turnEnd !== "none") await options.lifecycle?.onTurnEnded?.({ handoffWritten: false, turnCount: 1, ...(turnEnd === "refused-turn" ? { contentRefused: true } : {}) })
    resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal })
    await lifecycle.settle()
    expect(endings).toEqual([...expected])
  } finally {
    await lifecycle.terminateBackgroundWorks()
  }
})

it("refuses to seal while accepted input commits and refuses new input after sealing", async () => {
  const { lifecycle, deps, runnerOptions, resolvers, state, session, callbacks } = makeLifecycle()
  deps.rootChatCompletion = createChatInvocationCompletion(() => {})
  const held = Promise.withResolvers<string | null>()
  let saves = 0
  deps.treeWriter.holdQueuedUserInput = () => { saves++; return held.promise }
  const controls = createChatControls({
    lifecycle, state, session, callbacks, treeWriter: deps.treeWriter, eventUnsubs: [],
    onTreeFailure: () => {}, drainEvents: async () => ({ kind: "drained", acked: [] }),
    recordInterruption: () => {}, supersedeInterruptedTurn: () => {},
  })
  try {
    await lifecycle.enqueueInput("first")
    await flushMicrotasks()
    const options = runnerOptions[0]!
    if (options.lifecycle?.kind !== "complete-on-idle" || !options.lifecycle.seal) throw new Error("one-shot Chat completes on idle")
    const seal = options.lifecycle.seal
    const sending = controls.send("already accepted")
    expect(options.runtimeSurfaces!.background!.tasks.assertHandoffReady()?.pending).toBe(1)
    expect(seal("premature")).toBe(false)
    held.resolve("held-input")
    expect(await sending).toBe("accepted")
    expect(seal("still unread")).toBe(false)
    const pending = options.lifecycle!.inputSource!.drainPending()
    expect(JSON.stringify(pending)).toContain("already accepted")
    expect(options.runtimeSurfaces!.background!.tasks.assertHandoffReady()).toBeNull()
    expect(seal("incorporated")).toBe(true)
    expect(await controls.send("too late")).toBe("ended")
    expect(lifecycle.resumeCommitted({ explicit: true })).toBe(false)
    expect(lifecycle.requestWithContext("too late", "context")).toBe(false)
    expect(() => lifecycle.requestCompact()).toThrow("already completed")
    expect(controls.deliverCommitted("too late")).toBe(false)
    expect(() => deps.rootChatCompletion!.beginAttempt()).toThrow("already completed")
    expect(saves).toBe(1)
    resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await lifecycle.settle()
    expect(await controls.send("after settlement")).toBe("ended")
  } finally {
    held.resolve(null)
    resolvers[0]?.({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
    await lifecycle.settle()
    await lifecycle.terminateBackgroundWorks()
  }
})
