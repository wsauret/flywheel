import { tmpdir } from "node:os"
import { describe, expect, it } from "bun:test"
import { Effect, Exit, Scope } from "effect"

import { canonicalDirectory } from "../../../../src/infra/directory-authorities.js"
import { createTurnDispatcher } from "../../../../src/orchestration/agent-runtime/agent-loop-tools.js"
import { settleTurn } from "../../../../src/orchestration/agent-runtime/agent-turn-settlement.js"
import { createBackgroundExecutionOwner, type BackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js"
import type { RuntimeTool, ToolContext, ToolResult } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import type { LLMClient, ProviderStreamEvent, StreamEvent, StreamOptions, ToolCall } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { SessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { messageInput } from "../../../../src/infra/agent-loop-events.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { createRequestToolSurface } from "../../../../src/orchestration/agent-runtime/request-tool-surface.js"
import { asModelClient, fakeAttempt } from "./_model-client.js"
import { RequestToolMap, testCapabilityModules, testDefinitionAvailability, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { budgetCaptureSurface } from "./context/_loop-fixtures.js"
import { estimateConversationTokens, tokenCountingPolicy } from "../../../../src/orchestration/agent-runtime/compaction/token-counter.js"
import { fixedTurnOutputBound, type TurnOutputBound } from "../../../../src/orchestration/agent-runtime/compaction/compaction-policy.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

// A replaced result writes its breadcrumb under the project root.
const temporaryDirectory = temporaryDirectories()

function makeTool(execute: RuntimeTool["execute"], name = "waiter"): RuntimeTool {
  return {
    name,
    action: "shell_exec",
    description: "Wait for an abort signal",
    inputSchema: { type: "object" },
    isConcurrencySafe: false,
    execute,
  }
}

/** The CLI publishes canonical authorities, so this fixture does too: a
 *  breadcrumb write never follows a link on the project root's own name, and
 *  `/tmp` is a link on this platform. */
function makeContext(): ToolContext {
  const root = canonicalDirectory(temporaryDirectory("flywheel-loop-tools-"), "test project root")
  return {
    executionCwd: root,
    artifactScopeId: "test-session", retrievalSessionId: "test-session",
    userDataRoot: `${root}/.test-account`, projectRoot: root,
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
  outputBound?: TurnOutputBound
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
    outputBound: input.outputBound ?? fixedTurnOutputBound(undefined),
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

function backgroundOwner(): BackgroundExecutionOwner {
  return createBackgroundExecutionOwner(createBackgroundWorkRegistry({
    kind: "chat",
    enqueueNotification: () => {},
  }))
}

describe("createTurnDispatcher", () => {
  it("passes user interrupts into foreground tool execution", async () => {
    const turnAbort = new AbortController()
    const toolStarted = Promise.withResolvers<AbortSignal>()
    const toolCall: ToolCall = { id: "tool_wait", name: "waiter", input: {} }


    const tool = makeTool(async (_input, context): Promise<ToolResult> => {
      if (!context.signal) throw new Error("missing tool signal")
      toolStarted.resolve(context.signal)
      await new Promise<void>((resolve) => {
        context.signal!.addEventListener("abort", () => resolve(), { once: true })
      })
      return { content: "foreground aborted", outcome: "error" }
    })

    const turn = harness({ tools: new RequestToolMap([[tool.name, tool]]), signal: turnAbort.signal })

    turn.onToolUse(toolCall)
    const settling = turn.settle([toolCall])
    const toolSignal = await toolStarted.promise

    expect(toolSignal.aborted).toBe(false)
    turnAbort.abort()

    const result = await settling

    expect(toolSignal.aborted).toBe(true)
    expect(result.toolResults).toEqual([
      { toolUseId: "tool_wait", content: [{ type: "text", text: "foreground aborted" }], outcome: "interrupted" },
    ])
    expect(turn.events).toContainEqual({
      kind: "tool_result",
      toolUseId: "tool_wait",
      content: [{ type: "text", text: "foreground aborted" }],
      outcome: "interrupted",
    })
  })


  it("keeps background tools alive across a turn interrupt, ending them only when their owner closes", async () => {
    const turnAbort = new AbortController()
    const owner = backgroundOwner()
    const toolStarted = Promise.withResolvers<AbortSignal>()
    const backgroundCall: ToolCall = { id: "tool_bg", name: "process", input: {} }

    const background: RuntimeTool = {
      ...makeTool(async (_input, context): Promise<ToolResult> => {
        if (!context.signal) throw new Error("missing tool signal")
        toolStarted.resolve(context.signal)
        await new Promise<void>((resolve) => {
          context.signal!.addEventListener("abort", () => resolve(), { once: true })
        })
        return { content: "background ended", outcome: "ok" }
      }, "process"),
      execution: { mode: "background", traceKind: "subagent" },
    }

    const turn = harness({
      tools: new RequestToolMap([[background.name, background]]),
      signal: turnAbort.signal,
      background: owner,
    })

    turn.onToolUse(backgroundCall)
    const settling = turn.settle([backgroundCall])
    const toolSignal = await toolStarted.promise
    expect(toolSignal.aborted).toBe(false)

    // A turn interrupt (the next logical turn beginning, or ESC) must NOT kill a
    // background subagent dispatched to outlive the turn. This is the regression.
    turnAbort.abort()
    await Promise.resolve()
    expect(toolSignal.aborted).toBe(false)

    // The owner's close is the durable boundary that does stop it.
    void owner.close()
    const result = await settling
    expect(toolSignal.aborted).toBe(true)
    expect(result.toolResults).toEqual([
      { toolUseId: "tool_bg", content: [{ type: "text", text: "background ended" }], outcome: "ok" },
    ])
  })

  it("owner close awaits a background dispatch queued at the gate and stops it from ever executing", async () => {
    const owner = backgroundOwner()
    const blockerStarted = Promise.withResolvers<void>()
    const releaseBlocker = Promise.withResolvers<void>()
    let backgroundExecuted = false

    // Exclusive by default: the background dispatch queues behind it on the
    // admission gate (ARCH-TOOLS-004) instead of starting.
    const blocker = makeTool(async (): Promise<ToolResult> => {
      blockerStarted.resolve()
      await releaseBlocker.promise
      return { content: "blocker done", outcome: "ok" }
    }, "blocker")
    const background: RuntimeTool = {
      ...makeTool(async (): Promise<ToolResult> => {
        backgroundExecuted = true
        return { content: "background ran", outcome: "ok" }
      }, "process"),
      execution: { mode: "background", traceKind: "subagent" },
      isConcurrencySafe: true,
    }

    const turn = harness({
      tools: new RequestToolMap([[blocker.name, blocker], [background.name, background]]),
      background: owner,
    })

    const blockerCall: ToolCall = { id: "tool_blocker", name: "blocker", input: {} }
    const backgroundCall: ToolCall = { id: "tool_bg", name: "process", input: {} }
    turn.onToolUse(blockerCall)
    turn.onToolUse(backgroundCall)
    const settling = turn.settle([blockerCall, backgroundCall])
    await blockerStarted.promise

    let closed = false
    const closing = owner.close().then(() => { closed = true })
    await Bun.sleep(1)
    // The queued dispatch is owned work: close cannot report settlement while
    // the call could still reach the tool.
    expect(closed).toBe(false)
    expect(backgroundExecuted).toBe(false)

    releaseBlocker.resolve()
    await closing

    expect(closed).toBe(true)
    expect(backgroundExecuted).toBe(false)

    const result = await settling
    expect(result.toolResults.find((entry) => entry.toolUseId === "tool_bg")?.outcome).toBe("interrupted")
  })

  it("does not abort foreground tools just because input is queued", async () => {
    const toolCall: ToolCall = { id: "tool_wait", name: "waiter", input: {} }

    const tool = makeTool(async (): Promise<ToolResult> => ({ content: "finished", outcome: "ok" }))

    const turn = harness({ tools: new RequestToolMap([[tool.name, tool]]) })

    turn.onToolUse(toolCall)
    const result = await turn.settle([toolCall])

    expect(result.toolResults).toEqual([
      { toolUseId: "tool_wait", content: [{ type: "text", text: "finished" }], outcome: "ok" },
    ])
  })

  it("settles a suspended durable tool without emitting a tool result", async () => {
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
    // The suspended call gets neither a canonical result nor a projection; it
    // stays available to the resume path.
    expect(turn.events).toEqual([])
    expect(checkpoints).toEqual([])
  })

  it.each([
    [true, ["bash_1"]],
    [false, ["read_1", "bash_1"]],
  ])("bounds a batch by its admission bound with reads exempt %p, and never replaces uncapped output", async (readsExempt, replaced) => {
    const output = (id: string) => `${id}\n${"x".repeat(25_000)}`
    const read = { ...makeTool(async () => ({ content: output("read_1"), outcome: "ok" })), name: "read", action: "file_read" as const }
    const skill = { ...makeTool(async () => ({ content: output("skill_1"), outcome: "ok" })), name: "skill", uncappedOutput: true }
    const bash = makeTool(async () => ({ content: output("bash_1"), outcome: "ok" }), "bash")
    const admitted: number[] = []
    const calls: ToolCall[] = [read, skill, bash].map((tool, index) => ({ id: `${tool.name}_1`, name: tool.name, input: { index } }))
    const turn = harness({
      tools: new RequestToolMap([read, skill, bash].map((tool) => [tool.name, tool])),
      outputBound: { chars: 20_000, readsExempt, admit: (chars) => { admitted.push(chars) } },
    })

    for (const call of calls) turn.onToolUse(call)
    const batch = await turn.settle(calls)

    const persisted = batch.toolResults.filter((result) => result.content.some((part) => part.type === "text" && part.text.startsWith("<persisted-output>")))
    expect(persisted.map((result) => result.toolUseId)).toEqual(replaced)
    const chars = batch.toolResults.flatMap((result) => result.content).reduce((sum, part) => sum + (part.type === "text" ? part.text.length : 0), 0)
    expect(admitted).toEqual([chars])
  })

  it("emits live execution output with the tool call id", async () => {
    const toolCall: ToolCall = { id: "tool_output", name: "waiter", input: {} }

    const tool = makeTool(async (_input, context): Promise<ToolResult> => {
      if (!context.onExecutionOutput) throw new Error("missing execution output callback")
      context.onExecutionOutput("live output")
      return { content: "finished", outcome: "ok" }
    })

    const turn = harness({ tools: new RequestToolMap([[tool.name, tool]]) })

    turn.onToolUse(toolCall)
    await turn.settle([toolCall])

    expect(turn.events).toContainEqual({
      kind: "tool_execution_output",
      toolUseId: "tool_output",
      output: "live output",
    })
  })

  it("uses runtime execution metadata, not display metadata, to bypass the stream gate", async () => {
    let foregroundStarted = false
    let backgroundStarted = false
    // Gated on the assistant append, so nothing releases it before settlement.
    const foreground: RuntimeTool = {
      ...makeTool(async (): Promise<ToolResult> => {
        foregroundStarted = true
        return { content: "foreground", outcome: "ok" }
      }, "foreground"),
      deferUntilAssistantCommitted: true,
    }
    const background: RuntimeTool = {
      ...makeTool(async (): Promise<ToolResult> => {
        backgroundStarted = true
        return { content: "background", outcome: "ok" }
      }, "process"),
      execution: { mode: "background", traceKind: "subagent" },
    }

    const turn = harness({
      tools: new RequestToolMap([
        [foreground.name, foreground],
        [background.name, background],
      ]),
      background: backgroundOwner(),
    })

    const foregroundCall: ToolCall = { id: "tool_foreground", name: "foreground", input: {} }
    const backgroundCall: ToolCall = { id: "tool_background", name: "process", input: {} }
    turn.onToolUse(foregroundCall)
    turn.onToolUse(backgroundCall)
    await Bun.sleep(1)

    expect(foregroundStarted).toBe(false)
    expect(backgroundStarted).toBe(true)

    await turn.settle([foregroundCall, backgroundCall])
    expect(foregroundStarted).toBe(true)
  })

  it("keeps a deferred call gated on the assistant commit when an ordinary foreground call opens the stream gate", async () => {
    let committed = false
    const commitStatesSeenByDeferred: boolean[] = []
    const ordinaryRan = Promise.withResolvers<void>()
    const deferred: RuntimeTool = {
      ...makeTool(async (): Promise<ToolResult> => {
        commitStatesSeenByDeferred.push(committed)
        return { content: "deferred", outcome: "ok" }
      }, "deferred"),
      deferUntilAssistantCommitted: true,
    }
    const ordinary = makeTool(async (): Promise<ToolResult> => {
      ordinaryRan.resolve()
      return { content: "ordinary", outcome: "ok" }
    }, "ordinary")

    const turn = harness({
      tools: new RequestToolMap([
        [deferred.name, deferred],
        [ordinary.name, ordinary],
      ]),
      commitAssistant: () => { committed = true },
    })

    const deferredCall: ToolCall = { id: "tool_deferred", name: "deferred", input: {} }
    const ordinaryCall: ToolCall = { id: "tool_ordinary", name: "ordinary", input: {} }
    turn.onToolUse(deferredCall)
    turn.onToolUse(ordinaryCall)
    // The ordinary call runs off the eager stream-gate open; that open must
    // not wake the deferred call before the assistant commit.
    await ordinaryRan.promise
    expect(commitStatesSeenByDeferred).toEqual([])

    await turn.settle([deferredCall, ordinaryCall])
    expect(commitStatesSeenByDeferred).toEqual([true])
  })

  it("releases a deferred waiter on stream retry without executing the abandoned call", async () => {
    let runs = 0
    const deferred: RuntimeTool = {
      ...makeTool(async (): Promise<ToolResult> => {
        runs += 1
        return { content: "deferred", outcome: "ok" }
      }, "deferred"),
      deferUntilAssistantCommitted: true,
    }

    const turn = harness({ tools: new RequestToolMap([[deferred.name, deferred]]) })

    const call: ToolCall = { id: "tool_deferred_retry", name: "deferred", input: {} }
    turn.onToolUse(call)
    // Abandons the attempt: the queued deferred waiter must wake through the
    // opened gates and bail on the aborted attempt, never running the tool.
    turn.onStreamRetry()

    // The re-stream re-emits the same call on the fresh attempt.
    turn.onToolUse(call)
    const batch = await turn.settle([call])

    expect(runs).toBe(1)
    expect(batch.published).toHaveLength(1)
    expect(batch.published[0]?.content).toEqual([{ type: "text", text: "deferred" }])
    expect(batch.published[0]?.outcome).toBe("ok")
  })

  it("uses one normalized input object for dynamic admission and execution", async () => {
    const order: string[] = []
    let admittedInput: Readonly<{ [key: string]: unknown }> | undefined
    let executedInput: { [key: string]: unknown } | undefined
    const tool: RuntimeTool = {
      ...makeTool(async (input): Promise<ToolResult> => {
        order.push("execute")
        executedInput = input
        return { content: "done", outcome: "ok" }
      }, "dynamic"),
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
        additionalProperties: false,
      },
      isConcurrencySafe: (input) => {
        order.push("admission")
        admittedInput = input
        return true
      },
    }
    const call: ToolCall = { id: "tool_dynamic", name: "dynamic", input: { amount: "7" } }
    const turn = harness({ tools: new RequestToolMap([[tool.name, tool]]) })

    turn.onToolUse(call)
    await turn.settle([call])

    expect(order).toEqual(["admission", "execute"])
    expect(admittedInput).toBe(executedInput)
    expect(executedInput).toEqual({ amount: 7 })
  })

  it("serializes invalid input through its validation result without admission or execution", async () => {
    let admitted = false
    let executed = false
    const tool: RuntimeTool = {
      ...makeTool(async (): Promise<ToolResult> => {
        executed = true
        return { content: "unexpected", outcome: "ok" }
      }, "validated"),
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
        additionalProperties: false,
      },
      isConcurrencySafe: () => {
        admitted = true
        return true
      },
    }
    const call: ToolCall = { id: "tool_invalid", name: "validated", input: { amount: "not-a-number" } }
    const turn = harness({ tools: new RequestToolMap([[tool.name, tool]]) })

    turn.onToolUse(call)
    const result = await turn.settle([call])

    expect(admitted).toBe(false)
    expect(executed).toBe(false)
    expect(result.toolResults[0]).toMatchObject({ toolUseId: "tool_invalid", outcome: "error" })
    expect(result.toolResults[0]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("expected as `number`") })
  })

})

describe("per-request tool surface", () => {
  /** Records the tool schemas of every provider request the loop makes. */
  function capturingClient(responses: Array<{ events: ProviderStreamEvent[] }>, model = "test-model") {
    const requests: StreamOptions["tools"][] = []
    let callIndex = 0
    const client: LLMClient = {
      ...fakeAttempt("anthropic_api", model),
      async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
        requests.push(options.tools)
        const response = responses[callIndex++]
        if (!response) throw new Error("No more mock responses")
        for (const event of response.events) yield event
      },
    }
    return { client: asModelClient(client), requests }
  }

  function probeTool(name: string, schema: { [key: string]: unknown }): RuntimeTool {
    return {
      name,
      action: "ui_meta",
      description: `${name} tool`,
      inputSchema: { type: "object", properties: schema },
      isConcurrencySafe: true,
      execute: async () => ({ content: "ran", outcome: "ok" }),
    }
  }

  function requestPlan(tools: RequestToolMap, omitted: ReadonlyArray<{ name: string; reason: string }> = []) {
    return { eligibleTools: tools, tools, omitted, usable: new Set(tools.keys()), turnedOff: [], registrationIds: new Map([...tools.keys()].map((name) => [name, name])), registrationIdentities: new Map([...tools.keys()].map((name) => [name, name])), definitionAvailability: testDefinitionAvailability() }
  }
  async function dynamicRequestSurface(plan: Parameters<typeof createRequestToolSurface>[0]) {
    const surface = await createRequestToolSurface(plan, testCapabilityModules, testRuntimeConfigCapture)
    return {
      async resolve() {
        const resolved = await surface.resolve()
        return { ...resolved, executionAdmission: (toolName: string) => resolved.tools.has(toolName) ? { ok: true as const } : resolved.executionAdmission(toolName) }
      },
      current() {
        const current = surface.current()
        return { ...current, executionAdmission: (toolName: string) => current.tools.has(toolName) ? { ok: true as const } : current.executionAdmission(toolName) }
      },
    }
  }

  const answer = (text: string) => ({
    events: [{ kind: "text_delta", text, blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] satisfies ProviderStreamEvent[],
  })

  it("advertises the surface planned for each request, so a parked runner changes schema", async () => {
    let confirmationRequired = false
    const surface = await dynamicRequestSurface(() => requestPlan(
      new RequestToolMap([["workflow", probeTool("workflow", confirmationRequired ? { confirmation_id: { type: "string" } } : {})]]),
    ))
    const { client, requests } = capturingClient([answer("first"), answer("second")])
    let sent = 0

    await runAgentLoop({
      client,
      tools: surface,
      systemPrompt: () => stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: tmpdir(),
      userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
      providerSessionKey: "dynamic-surface", promptCacheKey: "dynamic-surface", artifactScopeId: "dynamic-surface", retrievalSessionId: "dynamic-surface",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: {
        drainPending: () => {
          // The second request is sent only after the first one completed, so
          // the schema change lands on a request the loop had not planned yet.
          if (requests.length < 1 || sent++ > 0) return null
          confirmationRequired = true
          return messageInput("again")
        },
        prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }),
      },
    })

    expect(requests[0]?.map((tool) => tool.input_schema)).toEqual([{ type: "object", properties: {} }])
    expect(requests[1]?.map((tool) => tool.input_schema)).toEqual([
      { type: "object", properties: { confirmation_id: { type: "string" } } },
    ])
  })


  it("dispatches each response through the exact map that request advertised", async () => {
    let exposed = true
    const surface = await dynamicRequestSurface(() => (exposed
      ? requestPlan(new RequestToolMap([["probe", probeTool("probe", {})]]))
      : requestPlan(new RequestToolMap(), [{ name: "probe", reason: "Skills is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml" }])))
    const results: string[] = []
    const { client, requests } = capturingClient([
      { events: [{ kind: "tool_use", toolCall: { id: "tc_1", name: "probe", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
      answer("first done"),
      { events: [{ kind: "tool_use", toolCall: { id: "tc_2", name: "probe", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
      answer("second done"),
    ])
    let sent = 0

    await runAgentLoop({
      client,
      tools: surface,
      systemPrompt: () => stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: tmpdir(),
      userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
      providerSessionKey: "dynamic-surface-removal", promptCacheKey: "dynamic-surface-removal", artifactScopeId: "dynamic-surface-removal", retrievalSessionId: "dynamic-surface-removal",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: (event) => {
        if (event.kind === "tool_result") results.push(event.content.map((part) => (part.type === "text" ? part.text : "")).join(""))
      },
      inputSource: {
        drainPending: () => {
          if (requests.length < 2 || sent++ > 0) return null
          exposed = false
          return messageInput("again")
        },
        prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }),
      },
    })

    expect(requests[0]?.map((tool) => tool.name)).toEqual(["probe"])
    expect(requests[2]?.map((tool) => tool.name)).toEqual([])
    expect(results[0]).toBe("ran")
    expect(results[1]).toContain("Unknown tool")
  })


  it("recaptures an empty budget summary without reintroducing omitted tools", async () => {
    let exposed = true
    const capture = await budgetCaptureSurface(() => exposed
      ? new Map([["probe", probeTool("probe", {})]])
      : new Map(), [
      [{ events: [{ kind: "done", stopReason: "end_turn" }] }],
      [answer("final summary")],
    ], (requestCount) => {
      if (requestCount !== 1) return
      exposed = false
      capture.advance()
    })
    const saved: unknown[] = []

    const terminal = await runAgentLoop({
      client: capture.client,
      tools: capture.surface,
      systemPrompt: (attempt, profile) => stableSystemPrompt(`${attempt.model} profile ${profile.id}`),
      instruction: "work",
      executionCwd: tmpdir(),
      userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(), retrievalSessionId: "budget-exhaustion",
      providerSessionKey: "budget-conversation", promptCacheKey: "budget-conversation", artifactScopeId: "budget-artifacts",
      maxLLMCalls: 0,
      requestAudit: capture.requestAudit,
      handoff: { onContent: () => {} },
      persistence: { history: { append: (message) => { saved.push(message) } } },
      seed: { kind: "fresh" },
      onEvent: () => {},
    })

    expect(terminal.kind).toBe("budget_exhausted")
    expect(capture.requests.map(({ options }) => options.tools.map(({ name }) => name))).toEqual([["probe"], []])
    expect(capture.admissions).toEqual([{ generation: 0, uses: 1 }, { generation: 1, uses: 1 }])
    expect(capture.requests.map(({ generation }) => generation)).toEqual([0, 1])
    expect(capture.requests.map(({ options }) => options.providerSessionKey)).toEqual(["budget-conversation", "budget-conversation"])
    expect(capture.requests.map(({ options }) => options.providerOptions?.openai?.text_verbosity)).toEqual(["low", "high"])
    expect(capture.audits.map(({ interactionProfileId }) => interactionProfileId)).toEqual(["default", "default"])
    expect(capture.audits.map(({ systemPrompt }) => systemPrompt)).toEqual(["claude-opus-3 profile default", "gpt-6-luna profile default"])
    expect(capture.audits.map(({ omittedTools }) => omittedTools)).toEqual([[], []])
    expect(capture.audits[1]!.estimatedContextTokens - capture.audits[1]!.attemptStaticTokens).toBe(
      estimateConversationTokens(capture.requests[1]!.options.messages, tokenCountingPolicy("gpt-6-luna", "openai")),
    )
    expect(saved).toContainEqual(expect.objectContaining({ kind: "assistant", content: [{ type: "text", text: "final summary" }] }))
  })
})
