import { describe, expect, it } from "bun:test"
import { Effect, Exit, Fiber, Scope } from "effect"
import type { PersistenceWriteRefused } from "../../../../src/infra/event-store-types.js"

import { createTurnDispatcher, type SettledToolBatch } from "../../../../src/orchestration/agent-runtime/agent-loop-tools.js"
import { fixedTurnOutputBound } from "../../../../src/orchestration/agent-runtime/compaction/compaction-policy.js"
import { settleTurn } from "../../../../src/orchestration/agent-runtime/agent-turn-settlement.js"
import type { RuntimeTool, ToolContext } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import type { ToolCall } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { ToolResultEntry } from "../../../../src/orchestration/agent-runtime/agent-state.js"

function makeTool(execute: RuntimeTool["execute"], name: string, extra: Partial<RuntimeTool> = {}): RuntimeTool {
  return {
    name,
    action: "shell_exec",
    description: `${name} tool`,
    inputSchema: { type: "object" },
    isConcurrencySafe: false,
    execute,
    ...extra,
  }
}

function toolCall(id: string, name: string): ToolCall {
  return { id, name, input: {} }
}

interface RecordedEvent {
  [key: string]: unknown
  kind: string
  toolUseId?: string
}

interface Harness {
  /** Everything the turn did, in the order it did it. */
  log: string[]
  events: RecordedEvent[]
  results: ToolResultEntry[]
  onToolUse: (tc: ToolCall) => void
  settle: (calls: readonly ToolCall[]) => Effect.Effect<{ batch: SettledToolBatch }, PersistenceWriteRefused>
  close: () => Promise<void>
}

function harness(input: {
  tools: RuntimeTool[]
  signal?: AbortSignal
  stream?: () => Promise<void>
  checkpoint?: (kind: string, key: string, payload: unknown) => Promise<void>
  displayBarrier?: () => Promise<void>
  commitConversationSavePoint?: (calls: readonly ToolCall[]) => Promise<void>
  closeAttempt?: () => Promise<void>
}): Harness {
  const log: string[] = []
  const events: RecordedEvent[] = []
  const results: ToolResultEntry[] = []
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]))
  const toolContext: ToolContext = {
    executionCwd: "/scratch",
    userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    artifactScopeId: "settlement-artifacts",
    retrievalSessionId: "settlement-test",
    conversationId: "settlement-conversation",
    flushCanonicalMessages: async () => {
      await Bun.sleep(1)
      log.push("assistant-acknowledged")
    },
    sessionEventWriter: {
      record: async () => null,
      recordBatch: async () => null,
      recordGuarded: async () => null,
      transaction: async (fn) => { fn() },
      dispose: () => {},
      putInFlight: input.checkpoint ?? (async () => {}),
    },
  }
  const turnScope = Scope.makeUnsafe()
  const dispatcher = createTurnDispatcher({
    tools,
    executionAdmission: (toolName) => tools.has(toolName)
      ? { ok: true }
      : { ok: false, refusal: { content: `Tool '${toolName}' is not registered`, outcome: "error" } },
    toolContext,
    artifactScopeId: toolContext.artifactScopeId,
    background: undefined,
    signal: input.signal,
    turnScope,
    afterToolCall: undefined,
    onEvent: (event) => { events.push(event) },
    outputBound: fixedTurnOutputBound(undefined),
  })
  return {
    log,
    events,
    results,
    onToolUse: (tc) => { dispatcher.onToolUse(tc) },
    settle: (calls) => settleTurn({
      dispatcher,
      ...(input.signal ? { turnSignal: input.signal } : {}),
      stream: input.stream ?? (() => Promise.resolve()),
      commitAssistant: () => {
        log.push("assistant-appended")
        return calls
      },
      commitAssistantBarrier: async (assistantCalls) => {
        await Bun.sleep(1)
        log.push(`assistant-canonical:${assistantCalls.map((call) => call.id).join(",")}`)
      },
      commitResults: async (settledResults, published) => {
        await Bun.sleep(1)
        results.push(...settledResults)
        log.push(`canonical:${settledResults.map((r) => r.toolUseId).join(",")}`)
        await input.commitConversationSavePoint?.(published.map((call) => call.tc))
        log.push(`retired:${published.map((call) => call.tc.id).join(",")}`)
      },
      onEvent: (event) => {
        log.push(`projection:${event.toolUseId}`)
        events.push(event)
      },
      commitDisplayBarrier: input.displayBarrier ?? (async () => { log.push("display-durable") }),
      closeAttempt: input.closeAttempt,
      publishTerminal: () => { log.push("terminal") },
      publishSettlement: () => { log.push("settlement-published") },
    }),
    close: () => Effect.runPromise(Scope.close(turnScope, Exit.void)),
  }
}

describe("settleTurn", () => {
  it("closes accounting inside the mask after cancellation at the canonical barrier", async () => {
    const canonical = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const turn = harness({
      tools: [makeTool(async () => ({ content: "completed", outcome: "ok" }), "worker")],
      commitConversationSavePoint: async () => { canonical.resolve(); await release.promise },
      closeAttempt: async () => { turn.log.push("accounting") },
    })
    const tc = toolCall("completed", "worker")
    turn.onToolUse(tc)
    const fiber = Effect.runFork(turn.settle([tc]))
    await canonical.promise
    const interrupt = Effect.runPromise(Fiber.interrupt(fiber))
    release.resolve()
    await interrupt
    await turn.close()
    expect(turn.results.map((entry) => entry.toolUseId)).toEqual(["completed"])
    expect(turn.log.slice(-4)).toEqual(["retired:completed", "accounting", "terminal", "settlement-published"])
  })

  it("does not publish settlement when attempt accounting fails", async () => {
    const turn = harness({
      tools: [makeTool(async () => ({ content: "completed", outcome: "ok" }), "worker")],
      closeAttempt: async () => { throw new Error("accounting failed") },
    })
    const tc = toolCall("completed", "worker")
    turn.onToolUse(tc)
    const result = await Effect.runPromiseExit(turn.settle([tc]))
    await turn.close()
    expect(Exit.isFailure(result)).toBe(true)
    expect(turn.results.map((entry) => entry.toolUseId)).toEqual(["completed"])
    expect(turn.log).not.toContain("settlement-published")
    expect(turn.log).not.toContain("terminal")
  })
  it("publishes a call's projection only after its canonical result is acknowledged", async () => {
    const turn = harness({
      tools: [makeTool(async () => ({ content: "done", outcome: "ok" }), "worker")],
      closeAttempt: async () => { turn.log.push("attempt-closed") },
    })
    const tc = toolCall("tool_1", "worker")

    turn.onToolUse(tc)
    await Effect.runPromise(turn.settle([tc]))
    await turn.close()

    expect(turn.log).toEqual([
      "assistant-appended",
      "assistant-canonical:tool_1",
      "projection:tool_1",
      "display-durable",
      "canonical:tool_1",
      "retired:tool_1",
      "attempt-closed",
      "terminal",
      "settlement-published",
    ])
    expect(turn.results).toEqual([
      { toolUseId: "tool_1", content: [{ type: "text", text: "done" }], outcome: "ok" },
    ])
  })

  it("does not append conversation results or continue before display evidence is durable", async () => {
    const barrier = Promise.withResolvers<void>()
    const turn = harness({
      tools: [makeTool(async () => ({ content: "done", outcome: "ok" }), "worker")],
      displayBarrier: () => barrier.promise,
    })
    const tc = toolCall("tool_1", "worker")

    turn.onToolUse(tc)
    const settling = Effect.runPromise(turn.settle([tc]))
    await Bun.sleep(5)

    expect(turn.log).toEqual(["assistant-appended", "assistant-canonical:tool_1", "projection:tool_1"])
    barrier.resolve()
    await settling
    await turn.close()
  })

  it("retains finalized checkpoints until the conversation result append commits", async () => {
    const turn = harness({
      tools: [makeTool(async () => ({ content: "done", outcome: "ok" }), "worker")],
      commitConversationSavePoint: async () => {
        expect(turn.log).toContain("canonical:tool_1")
      },
    })
    const tc = toolCall("tool_1", "worker")

    turn.onToolUse(tc)
    await Effect.runPromise(turn.settle([tc]))
    await turn.close()

    expect(turn.log.indexOf("display-durable")).toBeLessThan(turn.log.indexOf("canonical:tool_1"))
    expect(turn.log.indexOf("canonical:tool_1")).toBeLessThan(turn.log.indexOf("retired:tool_1"))
  })

  it("preserves checkpoints when the display durability barrier fails", async () => {
    let retired = false
    const turn = harness({
      tools: [makeTool(async () => ({ content: "done", outcome: "ok" }), "worker")],
      displayBarrier: () => Promise.reject(new Error("display commit failed")),
      commitConversationSavePoint: async () => { retired = true },
    })
    const tc = toolCall("tool_1", "worker")

    turn.onToolUse(tc)
    const exit = await Effect.runPromiseExit(turn.settle([tc]))
    await turn.close()

    expect(Exit.isFailure(exit)).toBe(true)
    expect(turn.log).toEqual(["assistant-appended", "assistant-canonical:tool_1", "projection:tool_1"])
    expect(turn.results).toEqual([])
    expect(retired).toBe(false)
  })

  it("checkpoints an out-of-order result before making it available while its sibling is held", async () => {
    const held = Promise.withResolvers<void>()
    const checkpointStarted = Promise.withResolvers<void>()
    const checkpointRelease = Promise.withResolvers<void>()
    const turn = harness({
      tools: [
        makeTool(async () => {
          await held.promise
          return { content: "first", outcome: "ok" }
        }, "first", { isConcurrencySafe: true }),
        makeTool(async () => ({ content: "second", outcome: "ok", details: { opaque: 1 } }), "second", { isConcurrencySafe: true }),
      ],
      checkpoint: async (kind, key, payload) => {
        turn.log.push(`checkpoint:${kind}:${key}`)
        if (!key.endsWith(":tool_second")) return
        expect(payload).toMatchObject({
          toolUseId: "tool_second",
          content: [{ type: "text", text: "second" }],
          outcome: "ok",
          details: { opaque: 1 },
        })
        checkpointStarted.resolve()
        await checkpointRelease.promise
      },
    })
    const first = toolCall("tool_first", "first")
    const second = toolCall("tool_second", "second")

    turn.onToolUse(first)
    turn.onToolUse(second)
    const settling = Effect.runPromise(turn.settle([first, second]))
    await checkpointStarted.promise
    expect(turn.events).not.toContainEqual({ kind: "tool_result_available", toolUseId: "tool_second" })
    checkpointRelease.resolve()
    await Bun.sleep(1)

    expect(turn.events).toContainEqual({
      kind: "tool_result_available",
      toolUseId: "tool_second",
      content: [{ type: "text", text: "second" }],
      outcome: "ok",
      details: { opaque: 1 },
    })
    expect(turn.events.some((event) => event.kind === "tool_result" && event.toolUseId === "tool_second")).toBe(false)

    held.resolve()
    await settling
    await turn.close()

    expect(turn.events.filter((event) => event.kind === "tool_result_available" && event.toolUseId === "tool_second")).toHaveLength(1)
  })

  it("makes the assistant durable before it releases a call gated on that append", async () => {
    const gated = makeTool(async () => {
      turnLog.push("tool-ran")
      return { content: "gated", outcome: "ok" }
    }, "gated", { deferUntilAssistantCommitted: true })
    const turn = harness({ tools: [gated] })
    const turnLog = turn.log
    const tc = toolCall("tool_gated", "gated")

    turn.onToolUse(tc)
    await Effect.runPromise(turn.settle([tc]))
    await turn.close()

    expect(turn.log.slice(0, 4)).toEqual(["assistant-appended", "assistant-canonical:tool_gated", "assistant-acknowledged", "tool-ran"])
  })

  it("keeps the handler's own interrupted result and waits for the handler to stop writing", async () => {
    let stillWriting = false
    const started = Promise.withResolvers<void>()
    const blocking = makeTool(async (_input, context) => {
      started.resolve()
      await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }))
      stillWriting = true
      // The handler keeps writing after the abort: settlement may not report
      // completion until this Promise has really settled.
      await Bun.sleep(5)
      stillWriting = false
      return { content: "handler answered on the way out", outcome: "interrupted" }
    }, "blocking")
    const turn = harness({ tools: [blocking] })
    const tc = toolCall("tool_blocking", "blocking")

    turn.onToolUse(tc)
    const fiber = Effect.runFork(turn.settle([tc]))
    await started.promise
    await Effect.runPromise(Fiber.interrupt(fiber))
    await turn.close()

    expect(stillWriting).toBe(false)
    expect(turn.results).toEqual([
      { toolUseId: "tool_blocking", content: [{ type: "text", text: "handler answered on the way out" }], outcome: "interrupted" },
    ])
    expect(turn.events.filter((event) => event.kind === "tool_result")).toHaveLength(1)
  })

  it("synthesizes exactly one tombstone for a call whose handler never answered", async () => {
    const started = Promise.withResolvers<void>()
    const blocker = makeTool(async (_input, context) => {
      started.resolve()
      await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }))
      return { content: "blocker done", outcome: "interrupted" }
    }, "blocker", { isConcurrencySafe: false })
    // Exclusive admission: this call cannot start until the blocker releases,
    // by which time the turn is already interrupted.
    const queued = makeTool(async () => ({ content: "must not run", outcome: "ok" }), "queued", { isConcurrencySafe: false })
    const turn = harness({ tools: [blocker, queued] })
    const blockerCall = toolCall("tool_blocker", "blocker")
    const queuedCall = toolCall("tool_queued", "queued")

    turn.onToolUse(blockerCall)
    turn.onToolUse(queuedCall)
    const fiber = Effect.runFork(turn.settle([blockerCall, queuedCall]))
    await started.promise
    await Effect.runPromise(Fiber.interrupt(fiber))
    await turn.close()

    expect(turn.results).toEqual([
      { toolUseId: "tool_blocker", content: [{ type: "text", text: "blocker done" }], outcome: "interrupted" },
      { toolUseId: "tool_queued", content: [{ type: "text", text: "Tool 'queued' was interrupted before a result was recorded." }], outcome: "interrupted" },
    ])
    expect(turn.events.filter((event) => event.kind === "tool_result")).toHaveLength(2)
  })

  it("retains a completed sibling while a suspended call gets neither result nor projection", async () => {
    const suspending = makeTool(async () => ({ content: "", outcome: "interrupted", suspendTurn: true }), "suspending")
    const sibling = makeTool(async () => ({ content: "sibling done", outcome: "ok" }), "sibling")
    const turn = harness({ tools: [suspending, sibling] })
    const suspendCall = toolCall("tool_suspend", "suspending")
    const siblingCall = toolCall("tool_sibling", "sibling")

    turn.onToolUse(suspendCall)
    turn.onToolUse(siblingCall)
    const settled = await Effect.runPromise(turn.settle([suspendCall, siblingCall]))
    await turn.close()

    expect(settled.batch.suspended).toBe(true)
    expect(turn.results.map((r) => r.toolUseId)).toEqual(["tool_sibling"])
    expect(turn.log).toEqual(["assistant-appended", "assistant-canonical:tool_suspend,tool_sibling", "projection:tool_sibling", "display-durable", "canonical:tool_sibling", "retired:tool_sibling", "terminal", "settlement-published"])
  })

  it("settles the turn durably before it re-raises the provider failure", async () => {
    const turn = harness({
      tools: [makeTool(async () => ({ content: "ran anyway", outcome: "ok" }), "worker")],
      stream: () => Promise.reject(new Error("provider exploded")),
    })
    const tc = toolCall("tool_1", "worker")

    turn.onToolUse(tc)
    const exit = await Effect.runPromiseExit(turn.settle([tc]))
    await turn.close()

    expect(Exit.isFailure(exit)).toBe(true)
    expect(turn.log).toEqual(["assistant-appended", "assistant-canonical:tool_1", "projection:tool_1", "display-durable", "canonical:tool_1", "retired:tool_1", "terminal"])
  })
})
