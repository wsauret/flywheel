import { describe, expect, test } from "bun:test"
import { ContextLengthExceededError, LlmStreamError, RouteUnavailableError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js"
import type { ConversationMessage, ProviderStreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import type { AcpConfigOption, AcpPromptResult, AcpSessionUpdate } from "../../../../../src/orchestration/modules/provider-google-antigravity/acp/schema.js"
import { createBridge, type BridgeEngine, type BridgeRequest } from "../../../../../src/orchestration/modules/provider-google-antigravity/bridge.js"
import type { StepGateEvent } from "../../../../../src/orchestration/modules/provider-google-antigravity/step-gate.js"
import { createTransportAudit } from "../../../../../src/orchestration/modules/provider-google-antigravity/transport-audit.js"
import type { ProviderTransportContext } from "../../../../../src/orchestration/session/provider-request-audit-types.js"

type Action = { readonly text: string } | { readonly call: string } | { readonly hold: Promise<void> }

/** The step gate's routing, as the bridge sees it: one held admission per session, and each answer as an event. */
function fakeGate() {
  const listeners = new Set<(event: StepGateEvent) => void>()
  const held = new Map<string, { readonly sessionId: string; readonly kind: "step" | "canary" }>()
  const gate = {
    held,
    grant(sessionId: string) {
      const admission = { sessionId, kind: "step" as const }
      if (held.get(sessionId)?.kind !== "canary") held.set(sessionId, admission)
      return admission
    },
    expectCanary(sessionId: string) {
      const admission = { sessionId, kind: "canary" as const }
      held.set(sessionId, admission)
      return admission
    },
    revoke(admission: { readonly sessionId: string }) {
      if (held.get(admission.sessionId) === admission) held.delete(admission.sessionId)
    },
    onEvent(listener: (event: StepGateEvent) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** The engine's PreInvocation hook for the next step of `sessionId`. */
    ask(sessionId: string): StepGateEvent["kind"] {
      const admission = held.get(sessionId)
      held.delete(sessionId)
      const kind = admission === undefined ? "refused" : admission.kind === "canary" ? "canary-refused" : "consumed"
      for (const listener of listeners) listener({ sessionId, invocationNum: 0, kind })
      return kind
    },
  }
  return gate
}

const MODELS: AcpConfigOption = { id: "model", name: "Model", currentValue: "gemini-3.1-pro", options: [{ value: "gemini-3.1-pro", name: "Pro" }, { value: "gemini-4-neon", name: "Neon" }] }
const LEVELS: AcpConfigOption = { id: "thought_level", name: "Thinking", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }
const USAGE = { inputTokens: 10, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 12 }

/**
 * An engine process whose model answers each admitted step with the next scripted response. A step asks the gate
 * first unless the hook does not run; a call waits on the bridge's MCP handler, and a later call of the same response
 * follows its result without a new step, as agy 1.5.14 does.
 */
function fakeEngine(gate: ReturnType<typeof fakeGate>, options: { readonly hookRuns?: () => boolean } = {}) {
  const log: string[] = []
  const responses: Action[][] = []
  const sessions = new Map<string, Parameters<BridgeEngine["openSession"]>[0] & { config: AcpConfigOption[]; cancel?: () => void }>()
  let calls = 0
  let opened = 0
  const step = async (sessionId: string): Promise<AcpPromptResult> => {
    const session = sessions.get(sessionId)!
    for (;;) {
      if ((options.hookRuns?.() ?? true) && gate.ask(sessionId) !== "consumed") return { stopReason: "end_turn" }
      const response = responses.shift() ?? [{ text: "reply" }]
      // agy reports the occupancy of each model request: before the calls of a response, after its text.
      const usage: AcpSessionUpdate = { sessionUpdate: "usage_update", used: 1_000, size: 250_000 }
      const hasCall = response.some((action) => "call" in action)
      if (hasCall) session.onUpdate(usage)
      let called = false
      for (const action of response) {
        if ("text" in action) {
          session.onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: action.text } })
          continue
        }
        if ("hold" in action) {
          const cancelled = new Promise<"cancelled">((resolve) => { session.cancel = () => { resolve("cancelled") } })
          if (await Promise.race([action.hold, cancelled]) === "cancelled") return { stopReason: "cancelled" }
          continue
        }
        const toolUseId = `call-${String(++calls)}`
        const revealed: AcpSessionUpdate = { sessionUpdate: "tool_call", toolUseId, status: "pending", title: action.call }
        session.onUpdate(revealed)
        const cancelled = new Promise<"cancelled">((resolve) => { session.cancel = () => { resolve("cancelled") } })
        const answer = await Promise.race([session.onToolCall({ sessionId, name: "echo", arguments: { text: action.call } }, new AbortController().signal), cancelled])
        if (answer === "cancelled") return { stopReason: "cancelled" }
        log.push(`result ${JSON.stringify(answer.content)}`)
        called = true
      }
      if (!hasCall) session.onUpdate(usage)
      if (!called) return { stopReason: "end_turn", usage: USAGE }
    }
  }
  const engine: BridgeEngine = {
    processId: "p1",
    toolNames: new Set(["echo"]),
    async openSession(handlers) {
      const sessionId = `s${String(++opened)}`
      sessions.set(sessionId, { ...handlers, config: [MODELS, LEVELS] })
      log.push(handlers.append === undefined ? "open probe" : "open")
      return { sessionId, configOptions: [MODELS, LEVELS] }
    },
    async prompt(sessionId, blocks) {
      log.push(`prompt ${blocks.map((block) => block.text).join("")}`)
      return step(sessionId)
    },
    releaseSession(sessionId) {
      log.push(`release ${sessionId}`)
      sessions.delete(sessionId)
    },
    async cancel(sessionId) {
      log.push("cancel")
      sessions.get(sessionId)?.cancel?.()
    },
    async configure(_method, params) {
      if (!("configId" in params)) throw new Error("the bridge changes the model through set_config_option")
      log.push(`configure ${params.configId}=${params.value}`)
      const session = sessions.get(params.sessionId)!
      session.config = session.config.map((option) => option.id === params.configId ? { ...option, currentValue: params.value } : option)
      return { configOptions: session.config }
    },
    async close(reason) {
      log.push(`close ${reason}`)
      return { reason, served: false }
    },
  }
  return { engine, log, script: (...answers: Action[][]) => { responses.push(...answers) } }
}

const SYSTEM = { stable: "stable", session: "session", conversation: "conversation" }
const liveness = { preStream() {}, frame() {}, begin() {}, append() {}, complete() {} }
const projectResult: BridgeRequest["projectResult"] = async (content) => content

function rig(options: { readonly hookRuns?: () => boolean } = {}) {
  const gate = fakeGate()
  const fake = fakeEngine(gate, options)
  const bridge = createBridge({
    serving: async () => ({ engine: fake.engine, gate }),
    probeServing: async () => ({ engine: fake.engine, gate, release: async () => { fake.log.push("probe released") } }),
    limits: () => ({ threshold: 250_000, margin: 8_000, byteCap: 760_000, promptByteCap: 190_000 }),
    wireName: (name) => `mcp_runtime_${name}`,
    audit: createTransportAudit(),
  })
  return { gate, ...fake, bridge }
}

interface Served {
  readonly events: readonly ProviderStreamEvent[]
  readonly assistant: ConversationMessage
  readonly toolUseId?: string
  readonly audit?: ProviderTransportContext
}

async function serve(bridge: ReturnType<typeof createBridge>, messages: readonly ConversationMessage[], request: Partial<BridgeRequest> = {}): Promise<Served> {
  const events: ProviderStreamEvent[] = []
  for await (const event of bridge.stream({ systemPrompt: SYSTEM, messages, tools: [], model: "gemini-3.1-pro", estimatedTokens: 1_000, liveness, projectResult, ...request })) events.push(event)
  const text = events.flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("")
  const toolUse = events.find((event) => event.kind === "tool_use")
  const call = toolUse?.kind === "tool_use" ? { type: "tool_use" as const, id: toolUse.toolCall.id, name: "mcp_runtime_echo", input: toolUse.toolCall.input } : undefined
  const audit = events.find((event) => event.kind === "transport_context")
  return {
    events,
    assistant: { kind: "assistant", content: [...text === "" ? [] : [{ type: "text" as const, text }], ...call === undefined ? [] : [call]] },
    ...call === undefined ? {} : { toolUseId: call.id },
    ...audit?.kind === "transport_context" ? { audit: audit.context } : {},
  }
}

const user = (text: string): ConversationMessage => ({ kind: "user", content: text, origin: "human" })
const stops = (served: Served) => served.events.flatMap((event) => event.kind === "done" ? [event.stopReason] : [])

describe("Google Antigravity bridge", () => {
  test("a new session probes the process's gate once, opens with the append, refuses its primer, then runs the request's step", async () => {
    const { bridge, log, gate } = rig()
    const first = await serve(bridge, [user("hello")])
    expect(stops(first)).toEqual(["end_turn"])
    expect(log).toEqual(["open probe", expect.stringMatching(/^prompt /u), "release s1", "probe released", "open", expect.stringMatching(/^prompt /u), "prompt <message role=\"user\" origin=\"person\">\nhello\n</message>"])
    expect(first.audit?.hiddenRequests.map((request) => request.source)).toEqual(["title:gate-probe", "title:new-session"])
    expect(gate.held.size).toBe(0)

    log.length = 0
    await serve(bridge, [user("hello"), first.assistant, user("again")])
    expect(log).toEqual(["prompt <message role=\"user\" origin=\"person\">\nagain\n</message>"])
  })

  test("an effort change between prompts sets the thought level, and an effort the family does not list leaves it", async () => {
    const { bridge, log } = rig()
    const first = await serve(bridge, [user("one")], { effort: "low" })
    log.length = 0
    const second = await serve(bridge, [user("one"), first.assistant, user("two")], { effort: "high" })
    expect(log).toEqual(["configure thought_level=high", expect.stringMatching(/^prompt /u)])
    log.length = 0
    await serve(bridge, [user("one"), first.assistant, user("two"), second.assistant, user("three")], { effort: "xhigh" })
    expect(log).toEqual([expect.stringMatching(/^prompt /u)])
  })

  test("a request that settles on a revealed call revokes the admission that its delivery granted", async () => {
    const { bridge, gate, script } = rig()
    script([{ call: "a" }, { call: "b" }])
    const history: ConversationMessage[] = [user("go")]
    const first = await serve(bridge, history)
    expect(stops(first)).toEqual(["tool_use"])
    history.push(first.assistant, { kind: "toolResult", toolUseId: first.toolUseId!, content: [{ type: "text", text: "a done" }] })
    const second = await serve(bridge, history)
    expect(stops(second)).toEqual(["tool_use"])
    expect(second.audit?.notRecorded).toContain("usage")
    // The second call followed the first result without a model step, so the grant of the delivery is gone.
    expect(gate.held.size).toBe(0)
  })

  test("a request whose history does not hold the revealed call yet settles on that call again and releases nothing", async () => {
    const { bridge, log, script } = rig()
    script([{ call: "a" }])
    const first = await serve(bridge, [user("go")])
    log.length = 0
    const again = await serve(bridge, [user("go")])
    expect(again.toolUseId).toBe(first.toolUseId)
    expect(stops(again)).toEqual(["tool_use"])
    expect(log).toEqual([])
  })

  test("a request over the engine's threshold fails with a context overflow before anything is released", async () => {
    const { bridge, log } = rig()
    await expect(serve(bridge, [user("big")], { estimatedTokens: 245_000 })).rejects.toBeInstanceOf(ContextLengthExceededError)
    expect(log.filter((line) => line === "open")).toEqual([])
  })

  test("a caller abort during the step cancels the session, and the next request rotates", async () => {
    const { bridge, log, script } = rig()
    script([{ text: "partial" }, { hold: new Promise(() => {}) }])
    const abort = new AbortController()
    const history: ConversationMessage[] = [user("go")]
    const failure = await (async () => {
      for await (const event of bridge.stream({ systemPrompt: SYSTEM, messages: history, tools: [], model: "gemini-3.1-pro", estimatedTokens: 1_000, liveness, projectResult, signal: abort.signal })) {
        if (event.kind === "text_delta") abort.abort(new Error("stopped by the person"))
      }
    })().then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ message: "stopped by the person" })
    expect(log).toContain("cancel")

    log.length = 0
    await serve(bridge, [...history, { kind: "assistant", content: "partial" }, user("again")])
    expect(log.slice(0, 2)).toEqual(["release s2", "open"])
  })

  test("a model frame of a step that the gate did not admit cancels the session, fails the request, and is recorded", async () => {
    let hookRuns = true
    const { bridge, log } = rig({ hookRuns: () => hookRuns })
    const history: ConversationMessage[] = [user("one")]
    history.push((await serve(bridge, history)).assistant)
    hookRuns = false
    history.push(user("two"))
    const events: ProviderStreamEvent[] = []
    const failure = await (async () => {
      for await (const event of bridge.stream({ systemPrompt: SYSTEM, messages: history, tools: [], model: "gemini-3.1-pro", estimatedTokens: 1_000, liveness, projectResult })) events.push(event)
    })().then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmStreamError)
    expect(log).toContain("cancel")
    const audit = events.find((event) => event.kind === "transport_context")
    expect(audit?.kind === "transport_context" && audit.context.hiddenRequests).toEqual([{ source: "unadmitted-step" }])

    hookRuns = true
    log.length = 0
    await serve(bridge, history)
    expect(log.slice(0, 2)).toEqual(["release s2", "open"])
  })

  test("a tool-only step of a prompt that the gate did not admit cancels the session, fails the request, and is recorded", async () => {
    let hookRuns = true
    const { bridge, log, script } = rig({ hookRuns: () => hookRuns })
    const history: ConversationMessage[] = [user("one")]
    history.push((await serve(bridge, history)).assistant)
    hookRuns = false
    script([{ call: "x" }])
    history.push(user("two"))
    const events: ProviderStreamEvent[] = []
    const failure = await (async () => {
      for await (const event of bridge.stream({ systemPrompt: SYSTEM, messages: history, tools: [], model: "gemini-3.1-pro", estimatedTokens: 1_000, liveness, projectResult })) events.push(event)
    })().then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmStreamError)
    expect(events.some((event) => event.kind === "tool_use")).toBe(false)
    expect(log).toContain("cancel")
    const audit = events.find((event) => event.kind === "transport_context")
    expect(audit?.kind === "transport_context" && audit.context.hiddenRequests).toEqual([{ source: "unadmitted-step" }])
  })

  test("after a delivered result, a later call of the same response is served, and a call of a new step that the gate did not admit is refused", async () => {
    let hookRuns = true
    const { bridge, log, script } = rig({ hookRuns: () => hookRuns })
    script([{ call: "a" }, { call: "b" }], [{ call: "c" }])
    const history: ConversationMessage[] = [user("go")]
    for (const done of ["a", "b"]) {
      const served = await serve(bridge, history)
      history.push(served.assistant, { kind: "toolResult", toolUseId: served.toolUseId!, content: [{ type: "text", text: `${done} done` }] })
    }
    expect(log.filter((line) => line.startsWith("result"))).toHaveLength(1)
    // The result of b ends the response, so agy runs a new step for c, which no hook asks the gate for.
    hookRuns = false
    const events: ProviderStreamEvent[] = []
    const failure = await (async () => {
      for await (const event of bridge.stream({ systemPrompt: SYSTEM, messages: history, tools: [], model: "gemini-3.1-pro", estimatedTokens: 1_000, liveness, projectResult })) events.push(event)
    })().then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmStreamError)
    expect(events.some((event) => event.kind === "tool_use")).toBe(false)
    const audit = events.find((event) => event.kind === "transport_context")
    expect(audit?.kind === "transport_context" && audit.context.hiddenRequests).toEqual([{ source: "unadmitted-step" }])
  })

  test("a gate probe whose primer never reaches the gate closes the process and fails every request on it", async () => {
    const { bridge, log } = rig({ hookRuns: () => false })
    await expect(serve(bridge, [user("one")])).rejects.toBeInstanceOf(RouteUnavailableError)
    await expect(serve(bridge, [user("two")])).rejects.toBeInstanceOf(RouteUnavailableError)
    expect(log.filter((line) => line.startsWith("open"))).toEqual(["open probe"])
    expect(log).toContain("close gate-not-reached")
  })
})
