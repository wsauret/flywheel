import { tmpdir } from "node:os"
import { describe, expect, it } from "bun:test"
import { Effect, Exit, Scope } from "effect"

import { canonicalDirectory } from "../src/infra/directory-authorities.js"
import { createTurnDispatcher } from "../src/orchestration/agent-runtime/agent-loop-tools.js"
import { settleTurn } from "../src/orchestration/agent-runtime/agent-turn-settlement.js"
import type { BackgroundExecutionOwner } from "../src/orchestration/agent-runtime/background-execution-owner.js"
import type { RuntimeTool, ToolContext, ToolResult } from "../src/orchestration/agent-runtime/tools/types.js"
import type { SessionFactWriter } from "../src/orchestration/session/session-fact-writer.js"
import type { StreamEvent, ToolCall } from "../src/orchestration/agent-runtime/llm/types.js"
import { fixedTurnOutputBound } from "../src/orchestration/agent-runtime/compaction/compaction-policy.js"
import { RequestToolMap } from "../tests/helpers/request-tool-surface.js"

function makeTool(execute: RuntimeTool["execute"], name = "waiter", extra: Partial<RuntimeTool> = {}): RuntimeTool {
  return {
    name,
    action: "shell_exec",
    description: "Wait for an abort signal",
    inputSchema: { type: "object" },
    isConcurrencySafe: false,
    execute,
    ...extra,
  }
}

/** The CLI publishes canonical authorities, so this fixture does too: a
 *  breadcrumb write never follows a link on the project root's own name, and
 *  `/tmp` is a link on this platform. */
function makeContext(): ToolContext {
  const root = canonicalDirectory(tmpdir(), "test project root")
  return {
    executionCwd: root,
    artifactScopeId: "test-session", retrievalSessionId: "test-session",
    projectRoot: root,
  }
}

/** Production shape in miniature: the dispatcher owns the fibers, and the
 *  masked coordinator is the only publisher of results. */
function harness(input: {
  tools: ReadonlyMap<string, RuntimeTool>
  signal?: AbortSignal
  background?: BackgroundExecutionOwner
  commitAssistant?: () => void
  toolContext?: ToolContext
}) {
  const events: StreamEvent[] = []
  const onEvent = (event: StreamEvent): void => { events.push(event) }
  const turnScope = Scope.makeUnsafe()
  const dispatcher = createTurnDispatcher({
    tools: input.tools,
    executionAdmission: (toolName) => input.tools.has(toolName)
      ? { ok: true }
      : { ok: false, refusal: { content: `Tool '${toolName}' is not registered`, outcome: "error" } },
    toolContext: input.toolContext ?? makeContext(),
    signal: input.signal,
    background: input.background,
    turnScope,
    afterToolCall: undefined,
    onEvent,
    artifactScopeId: "test-session",
    outputBound: fixedTurnOutputBound(undefined),
  })
  return {
    events,
    onToolUse: (tc: ToolCall) => dispatcher.onToolUse(tc),
    onStreamRetry: () => dispatcher.onStreamRetry(),
    settle: async (calls: readonly ToolCall[]) => {
      try {
        const settled = await Effect.runPromise(settleTurn({
          dispatcher,
          ...(input.signal ? { turnSignal: input.signal } : {}),
          stream: () => Promise.resolve(),
          commitAssistant: () => {
            input.commitAssistant?.()
            return calls
          },
          commitAssistantBarrier: async () => {},
          commitResults: async () => {},
          commitDisplayBarrier: async () => {},
          onEvent,
          publishTerminal: () => {},
          publishSettlement: () => {},
        }))
        return settled.batch
      } finally {
        await Effect.runPromise(Scope.close(turnScope, Exit.void))
      }
    },
  }
}

describe("a question that suspends the turn", () => {
  it("settles a suspended durable tool without emitting or checkpointing a tool result", async () => {
    const toolCall: ToolCall = { id: "tool_wait", name: "waiter", input: {} }
    const checkpoints: unknown[] = []
    const writer: SessionFactWriter = {
      record: async () => null,
      recordBatch: async () => { throw new Error("unused request audit") },
      recordGuarded: async () => null,
      transaction: async (fn) => { fn() },
      dispose: () => {},
      putInFlight: async (_kind, _key, payload) => { checkpoints.push(payload) },
    }

    const tool = makeTool(async (): Promise<ToolResult> => ({
      content: "",
      outcome: "interrupted",
      suspendTurn: true,
    }))
    const turn = harness({
      tools: new RequestToolMap([[tool.name, tool]]),
      toolContext: {
        ...makeContext(),
        conversationId: "conversation-suspended",
        sessionEventWriter: writer,
        flushCanonicalMessages: async () => {},
      },
    })

    turn.onToolUse(toolCall)

    const batch = await turn.settle([toolCall])
    expect(batch.toolResults).toEqual([])
    expect(batch.suspended).toBe(true)
    expect(batch.terminate).toBe(false)
    const resultEvents = turn.events.filter((event) =>
      (event.kind === "tool_result" || event.kind === "tool_result_available") && event.toolUseId === toolCall.id)
    expect(resultEvents).toEqual([])
    expect(checkpoints).toEqual([])
  })

  // Regression guard: this passes on the base. A fix must not hold back the
  // record of an ordinary finished tool result until every sibling call in
  // the batch has finished.
  it("checkpoints a finished tool result while a sibling call is still running", async () => {
    const quickCall: ToolCall = { id: "tool_quick", name: "quick", input: {} }
    const slowCall: ToolCall = { id: "tool_slow", name: "slow", input: {} }
    const held = Promise.withResolvers<void>()
    const quickCheckpointed = Promise.withResolvers<void>()
    const checkpointed: string[] = []
    const writer: SessionFactWriter = {
      record: async () => null,
      recordBatch: async () => { throw new Error("unused request audit") },
      recordGuarded: async () => null,
      transaction: async (fn) => { fn() },
      dispose: () => {},
      putInFlight: async (_kind, _key, payload) => {
        const toolUseId = (payload as { toolUseId?: unknown }).toolUseId
        checkpointed.push(String(toolUseId))
        if (toolUseId === quickCall.id) quickCheckpointed.resolve()
      },
    }

    const quick = makeTool(async (): Promise<ToolResult> => ({ content: "finished", outcome: "ok" }), "quick", { isConcurrencySafe: true })
    const slow = makeTool(async (): Promise<ToolResult> => {
      await held.promise
      return { content: "slow finished", outcome: "ok" }
    }, "slow", { isConcurrencySafe: true })
    const turn = harness({
      tools: new RequestToolMap([[quick.name, quick], [slow.name, slow]]),
      toolContext: {
        ...makeContext(),
        conversationId: "conversation-ordinary",
        sessionEventWriter: writer,
        flushCanonicalMessages: async () => {},
      },
    })

    turn.onToolUse(quickCall)
    turn.onToolUse(slowCall)

    const settling = turn.settle([quickCall, slowCall])
    const checkpointedWhileSiblingRan = await Promise.race([
      quickCheckpointed.promise.then(() => true),
      Bun.sleep(1000).then(() => false),
    ])
    const quickAvailable = () => turn.events.some((event) =>
      event.kind === "tool_result_available" && event.toolUseId === quickCall.id)
    for (let waited = 0; checkpointedWhileSiblingRan && !quickAvailable() && waited < 1000; waited += 5) await Bun.sleep(5)
    const availableWhileSiblingRan = quickAvailable()
    held.resolve()
    const batch = await settling

    expect(checkpointedWhileSiblingRan).toBe(true)
    expect(availableWhileSiblingRan).toBe(true)
    expect(batch.suspended).toBe(false)
    expect(batch.toolResults).toHaveLength(2)
    expect(checkpointed).toContain(slowCall.id)
  })
})
