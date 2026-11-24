import { DebugLog } from "../../../../infra/debug-log.js"
import type { ReasoningEffort } from "../../../../infra/llm/models.js"
import type { LlmToolOutputPart } from "../../../../infra/llm/tool-output-part-schema.js"
import { ContextLengthExceededError, LlmStreamError, RouteUnavailableError } from "../../../agent-runtime/llm/errors.js"
import type { SystemPromptTiers } from "../../../agent-runtime/llm/system-prompt-tiers.js"
import type { ContentBlock, ConversationMessage, ProviderStreamEvent } from "../../../agent-runtime/llm/types.js"
import { AcpConnectionClosed } from "../acp/connection.js"
import type { AcpConfigOption, AcpPromptResult, AcpSessionUpdate, AcpTextBlock } from "../acp/schema.js"
import type { EngineProcess } from "../engine/engine-process.js"
import { engineStoppedFailure } from "../acp/errors.js"
import { renderMessages } from "./history-text.js"
import type { ParkedToolCall, ToolServerRegistration } from "../tools/mcp-server.js"
import { GOOGLE_ANTIGRAVITY_LABEL } from "../names.js"
import { planRequest, type PlanLimits, type RequestPlan } from "./request-plan.js"
import { messageFingerprint, type SessionView } from "./session-view.js"
import type { StepGate, StepGateEvent } from "../engine/step-gate.js"
import { createRequestStream, NO_MODEL_REQUEST_USAGE, type RequestStream, type RequestStreamOptions } from "../stream-map.js"
import type { McpToolDeclaration } from "../tools/tool-projection.js"
import type { AuditedRelease, TransportAudit } from "./transport-audit.js"

/** The fixed first prompt of every engine session (decision 5). The gate refuses its step as the proof that the
 *  session's hook runs (the canary, P4a), so only its text and agy's title request for it reach Google. It stays in
 *  the engine's history and never in Flywheel's. */
export const PRIMER_TEXT = "This session continues a conversation. Wait for its next message."

export type BridgeEngine = Pick<EngineProcess, "processId" | "toolNames" | "openSession" | "releaseSession" | "prompt" | "cancel" | "configure" | "close">
export type BridgeGate = Pick<StepGate, "grant" | "expectCanary" | "revoke" | "onEvent">

/** The engine process that serves a request, and the step gate of its login. */
interface BridgeServing {
  readonly engine: BridgeEngine
  readonly gate: BridgeGate
}

/** An engine process of the login that declares no Flywheel tool, for the gate probe, and the end of its use. */
interface ProbeServing extends BridgeServing {
  release(): Promise<void>
}

export interface BridgeConfig {
  /** The serving engine for a request whose tool surface is `tools`: the process of the request's chat tree and
   *  login, which a changed surface replaces. */
  readonly serving: (tools: readonly McpToolDeclaration[]) => Promise<BridgeServing>
  /** An engine of the serving login that declares no tool of Flywheel, which the gate probe prompts, so a hook that
   *  does not run sends none of Flywheel's tool declarations to Google. */
  readonly probeServing: () => Promise<ProbeServing>
  /** The limits of the engine model family `model` (plan P9). */
  readonly limits: (model: string) => PlanLimits
  /** The name under which the request's history names a tool (`ToolPresentation.wireName`), so the session's output
   *  is fingerprinted as the next request's history holds it. */
  readonly wireName: (name: string) => string
  readonly audit: TransportAudit
}

/** One Flywheel request as the bridge serves it. */
export interface BridgeRequest {
  readonly systemPrompt: SystemPromptTiers
  /** The request's history, lowered for this route, ending with its new input. */
  readonly messages: readonly ConversationMessage[]
  readonly tools: readonly McpToolDeclaration[]
  /** The engine model family (an agy `model` option value). */
  readonly model: string
  /** The family's `thought_level` value, when the request names one. */
  readonly effort?: ReasoningEffort
  readonly estimatedTokens: number
  readonly signal?: AbortSignal
  readonly liveness: RequestStreamOptions["liveness"]
  readonly onDispatch?: () => void | Promise<void>
  /** The copy of the result of the call `toolUseId` that the engine reads (`projectToolResult`), under the request's
   *  own tool-output owners. */
  readonly projectResult: (content: readonly LlmToolOutputPart[], call: { readonly toolName: string; readonly toolUseId: string }) => Promise<readonly LlmToolOutputPart[]>
}

export interface Bridge {
  /** The events of `request`, then its transport record, which also ends a failed request before its error. */
  stream(request: BridgeRequest): AsyncGenerator<ProviderStreamEvent>
  /** Cancels the open prompt, answers a parked call with an error, and ends the bridge. */
  close(): Promise<void>
}

type CallToolResult = Awaited<ReturnType<ToolServerRegistration["onCall"]>>

const CANCELLED_RESULT: CallToolResult = { content: [{ type: "text", text: "The request was cancelled." }], isError: true }

/** A call that agy parked on Flywheel's MCP server, which waits for its result. */
interface Park {
  readonly call: ParkedToolCall
  readonly answer: (result: CallToolResult) => void
}

/** The events of one open request, which the bridge feeds and the request's generator reads in order. */
interface Feed {
  readonly stream: RequestStream
  readonly queue: ProviderStreamEvent[]
  failure?: { readonly error: unknown }
  settled: boolean
  wake: (() => void) | undefined
  /** The text blocks and the call of the response, from which the session's output is fingerprinted. */
  readonly text: Map<string, string>
  call?: Extract<ContentBlock, { type: "tool_use" }>
  readonly events: ProviderStreamEvent[]
}

/** One engine session and what the bridge knows of it. */
interface Session {
  readonly serving: BridgeServing
  readonly sessionId: string
  /** The session's append, in UTF-8 bytes. */
  readonly appendBytes: number
  config: readonly AcpConfigOption[]
  view: SessionView
  /** A prompt of the session is open: sent, and its result not yet read. */
  prompting: boolean
  park: Park | undefined
  feed: Feed | undefined
  /** Model frames of the admitted step that came after the open request settled, for the next request's stream. */
  readonly pending: AcpSessionUpdate[]
  /** How the bridge last released work to the session: a prompt, which reaches the model only through a new step, or
   *  a delivered result, after which agy also reveals the next call of the same response without one. */
  release: "prompt" | "deliver" | undefined
  /** The gate admitted a step of the session since the bridge last released work to it. */
  admitted: boolean
  /** agy reported context occupancy (`usage_update`) since the last release, which it does for each model request. */
  modelRequest: boolean
  /** The tokens that the requests of the open prompt reported as partial usage (`RequestStream.partialTokens`). */
  promptTokensReported: number
  /** The gate refused a step of the session while the open request ran. */
  refused: number
  /** The kinds of tool result that the bridge delivered to the session, which agy then holds in every later model
   *  request. */
  readonly delivered: { results: boolean; errors: boolean }
  /** The session's primer: whether its step reached the gate, and whether the model answered it. */
  primer: { canary: boolean; modelFrames: number } | undefined
  /** The events of the last call the session revealed, for a request whose history does not hold it yet. */
  lastCall: readonly ProviderStreamEvent[]
  readonly unsubscribe: () => void
}

/** The session that a new engine session's handlers serve, once `session/new` returned its id. */
interface SessionRef {
  current?: Session
}

/** What one request did, filled in as it runs, for the transport record that ends it, also when it fails. */
interface RequestRecord {
  missingTools: readonly string[]
  sharedTools: readonly string[]
  /** The session to which the request released work, and the request's events on it. */
  released?: { readonly target: Session; readonly feed: Feed }
  /** The request continued to the session's last call (`Session.lastCall`), which holds its usage, and released nothing. */
  continued?: true
}

function isModelText(update: AcpSessionUpdate): boolean {
  return update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk"
}

function isModelFrame(update: AcpSessionUpdate): boolean {
  return isModelText(update) || update.sessionUpdate === "tool_call"
}

function text(value: string): readonly AcpTextBlock[] {
  return [{ type: "text", text: value }]
}

/** An ACP request of the engine, whose failure the walk reads: a connection that ended with the engine, such as a
 *  process that died during `session/new`, `session/set_config_option`, or a prompt, fails as a stopped engine, cut
 *  after the first model frame of the released request's `stream` when it had one. Every engine request of the bridge
 *  goes through it. */
function engineRequest<T>(request: Promise<T>, stream?: RequestStream): Promise<T> {
  return request.catch((error: unknown) => {
    if (!(error instanceof AcpConnectionClosed)) throw error
    throw stream === undefined ? engineStoppedFailure(error.close, false) : stream.connectionEnded(error.close)
  })
}

function gateNotReached(processId: string, sessionId: string, phase: "probe" | "session", modelFrames: number): RouteUnavailableError {
  DebugLog.record({ type: "provider.antigravity.gate.not_reached", notable: true, payload: { processId, sessionId, phase, modelFrames } })
  return new RouteUnavailableError(`The ${GOOGLE_ANTIGRAVITY_LABEL} engine ran its first step without asking Flywheel's step gate (gate-not-reached)`)
}

/** The gate probe of each serving engine process, which must pass before any session with Flywheel's content opens
 *  on the process. A process whose probe failed is closed and never serves. */
const probes = new WeakMap<BridgeEngine, Promise<void>>()

/**
 * Proves that the hook of the serving login runs before `serving` opens a session with Flywheel's content: one session
 * with no append, on an engine of the login that declares no Flywheel tool, whose primer must reach the gate and be
 * refused. Every engine of a login reads the login's one hook file, so the probe holds for the serving engine. A probe
 * that could not run, such as one whose engine did not launch, is not kept, and the next request probes again.
 */
function probeGate(serving: BridgeServing, config: BridgeConfig): Promise<void> {
  const known = probes.get(serving.engine)
  if (known !== undefined) return known
  let decided = false
  const probe = (async () => {
    const prober = await config.probeServing()
    try {
      const { engine, gate } = prober
      let modelFrames = 0
      const opened = await engineRequest(engine.openSession({
        onUpdate: (update) => { if (isModelFrame(update)) modelFrames += 1 },
        onToolCall: () => Promise.resolve(CANCELLED_RESULT),
      }))
      let canary = false
      const stop = gate.onEvent((event) => { if (event.sessionId === opened.sessionId && event.kind === "canary-refused") canary = true })
      try {
        gate.expectCanary(opened.sessionId)
        await engineRequest(engine.prompt(opened.sessionId, text(PRIMER_TEXT)))
        config.audit.hidden("title:gate-probe")
      } finally {
        stop()
        engine.releaseSession(opened.sessionId)
      }
      decided = true
      if (canary && modelFrames === 0) return
      // The probe's primer ran as a model step with no admission.
      if (!canary) config.audit.hidden("unadmitted-step")
      void serving.engine.close("gate-not-reached")
      throw gateNotReached(serving.engine.processId, opened.sessionId, "probe", modelFrames)
    } finally {
      await prober.release()
    }
  })()
  probes.set(serving.engine, probe)
  void probe.catch(() => {
    if (!decided && probes.get(serving.engine) === probe) probes.delete(serving.engine)
  })
  return probe
}

function optionValue(config: readonly AcpConfigOption[], id: string): string | undefined {
  return config.find((option) => option.id === id)?.currentValue
}

/** The assistant message of a settled response as Flywheel's history holds it, read only for its fingerprint. */
function outputMessage(feed: Feed, wireName: (name: string) => string): ConversationMessage {
  const content: ContentBlock[] = [...feed.text.values()].filter((value) => value.length > 0).map((value) => ({ type: "text", text: value }))
  if (feed.call !== undefined) content.push({ ...feed.call, name: wireName(feed.call.name) })
  return { kind: "assistant", content }
}

function resultContent(parts: readonly LlmToolOutputPart[]): CallToolResult["content"] {
  return parts.map((part) => part.type === "text" ? { type: "text" as const, text: part.text } : { type: "image" as const, data: part.data, mimeType: part.mediaType })
}

/**
 * The bridge of one Flywheel conversation to its engine sessions (plan M12c). It serves one request at a time: each
 * request is planned against the session's view (`planRequest`), and only the plan's work is released, under one
 * admission of the login's step gate. A request settles at its single call or at the end of the prompt; a call keeps
 * the prompt open and parks on Flywheel's MCP server until the next request delivers its result. A session that cannot
 * continue to a request rotates: a new session opens with the whole system prompt and history in its append, its fixed
 * primer must reach the gate and be refused (the canary), and then the request's own step runs. A model step that the
 * gate did not admit cancels the session, fails the request, and is recorded as a hidden request (P4a).
 */
export function createBridge(config: BridgeConfig): Bridge {
  let session: Session | undefined
  let closed = false
  let queue: Promise<void> = Promise.resolve()

  const push = (target: Session, events: readonly ProviderStreamEvent[]): void => {
    const feed = target.feed
    if (feed === undefined || feed.settled) return
    for (const event of events) {
      feed.queue.push(event)
      feed.events.push(event)
      if (event.kind === "text_delta") feed.text.set(event.blockKey, (feed.text.get(event.blockKey) ?? "") + event.text)
      if (event.kind === "tool_use") feed.call = { type: "tool_use", id: event.toolCall.id, name: event.toolCall.name, input: event.toolCall.input }
      if (event.kind === "done") settle(target, feed)
    }
    feed.wake?.()
  }

  const fail = (target: Session, error: unknown): void => {
    const feed = target.feed
    if (feed === undefined || feed.settled) return
    feed.failure = { error }
    feed.settled = true
    target.view = { ...target.view, cancelled: true }
    feed.wake?.()
  }

  const settle = (target: Session, feed: Feed): void => {
    feed.settled = true
    const fingerprint = messageFingerprint(outputMessage(feed, config.wireName))
    target.view = feed.call === undefined
      ? { ...target.view, output: { kind: "answer", fingerprint } }
      : { ...target.view, output: { kind: "call", toolUseId: feed.call.id, fingerprint } }
    // A request that continues to the call runs no model request: the request that revealed the call reported its usage.
    if (feed.call !== undefined) target.lastCall = feed.events.flatMap((event) => event.kind === "usage" ? [] : event.kind === "done" ? [NO_MODEL_REQUEST_USAGE, event] : [event])
  }

  /** Cancels the session's open prompt and answers its parked call, so the session never continues (P7). */
  const cancel = async (target: Session): Promise<void> => {
    target.view = { ...target.view, cancelled: true }
    const park = target.park
    target.park = undefined
    park?.answer(CANCELLED_RESULT)
    if (target.prompting) await target.serving.engine.cancel(target.sessionId).catch(() => {})
  }

  /** Ends the bridge's use of a session that it no longer serves. */
  const retire = async (target: Session): Promise<void> => {
    await cancel(target)
    target.unsubscribe()
    target.serving.engine.releaseSession(target.sessionId)
  }

  /** Whether a model frame shows a step that the gate did not admit (P4a). After a prompt, every model frame follows an
   *  admitted step. After a delivered result, agy reveals a later call of the same response without a step, but a new
   *  step sends a model request, whose occupancy agy reports before the step's calls, and only a new step has text. */
  const unadmittedStep = (target: Session, modelText: boolean): boolean =>
    target.release !== undefined && !target.admitted && !target.view.cancelled && (target.release === "prompt" || modelText || target.modelRequest)

  /** A step that the gate did not admit produced model output: stop it and fail the open request (P4a). */
  const unadmitted = (target: Session): void => {
    config.audit.hidden("unadmitted-step")
    DebugLog.record({ type: "provider.antigravity.request.refused", notable: true, payload: { processId: target.serving.engine.processId, sessionId: target.sessionId, reason: "unadmitted-step" } })
    void cancel(target)
    fail(target, new LlmStreamError(`The ${GOOGLE_ANTIGRAVITY_LABEL} engine ran a step that Flywheel did not admit`, "transient"))
  }

  const onUpdate = (target: Session, update: AcpSessionUpdate): void => {
    if (target.primer !== undefined) {
      if (isModelFrame(update)) target.primer.modelFrames += 1
      return
    }
    if (update.sessionUpdate === "usage_update") target.modelRequest = true
    if (isModelFrame(update) && unadmittedStep(target, isModelText(update))) {
      unadmitted(target)
      return
    }
    const feed = target.feed
    if (feed === undefined || (feed.settled && isModelFrame(update))) {
      if (update.sessionUpdate === "usage_update") target.view = { ...target.view, occupancy: update.used }
      else if (isModelFrame(update) || update.sessionUpdate === "tool_call_update") target.pending.push(update)
      return
    }
    push(target, feed.stream.update(update))
  }

  const onToolCall = (target: Session, call: ParkedToolCall, signal: AbortSignal): Promise<CallToolResult> => new Promise((resolve) => {
    // The session never continues to a call of a cancelled prompt.
    if (target.view.cancelled) {
      resolve(CANCELLED_RESULT)
      return
    }
    const park: Park = { call, answer: resolve }
    target.park = park
    if (unadmittedStep(target, false)) {
      unadmitted(target)
      return
    }
    // agy gave the call up, so its prompt cannot continue to the call's result.
    signal.addEventListener("abort", () => {
      // The signal also ends a call once its answer was sent.
      if (target.park !== park) return
      target.park = undefined
      target.view = { ...target.view, cancelled: true }
    }, { once: true })
    const feed = target.feed
    if (feed !== undefined && !feed.settled) push(target, feed.stream.toolCall(call))
  })

  const onGate = (target: Session, event: StepGateEvent): void => {
    if (event.sessionId !== target.sessionId) return
    if (event.kind === "consumed") target.admitted = true
    else if (event.kind === "refused") target.refused += 1
    else if (target.primer !== undefined) target.primer.canary = true
  }

  /** Sends `blocks` as the session's next prompt, whose end settles the open request. */
  const sendPrompt = (target: Session, blocks: readonly AcpTextBlock[]): void => {
    target.prompting = true
    void engineRequest(target.serving.engine.prompt(target.sessionId, blocks), target.feed?.stream).then((result: AcpPromptResult) => {
      target.prompting = false
      const feed = target.feed
      if (feed !== undefined && !feed.settled) {
        try {
          push(target, feed.stream.promptEnded(result))
        } catch (error) {
          fail(target, error)
        }
      } else if (target.view.output?.kind === "call") {
        // The prompt ended while its call waited: the session cannot continue to the call's result.
        target.view = { ...target.view, cancelled: true }
      }
    }, (error: unknown) => {
      target.prompting = false
      target.view = { ...target.view, cancelled: true }
      fail(target, error)
    })
  }

  /** Sets one option of the session (`session/set_config_option`) and records the value that the engine acknowledged. */
  const configure = async (target: Session, configId: "model" | "thought_level", value: string): Promise<void> => {
    const from = optionValue(target.config, configId)
    target.config = (await engineRequest(target.serving.engine.configure("session/set_config_option", { sessionId: target.sessionId, configId, value }))).configOptions
    DebugLog.record({ type: "provider.antigravity.session.configured", payload: { processId: target.serving.engine.processId, sessionId: target.sessionId, configId, from, to: optionValue(target.config, configId) } })
  }

  /** Sets the session's model and effort between prompts. */
  const select = async (target: Session, model: string, effort: ReasoningEffort | undefined): Promise<void> => {
    if (optionValue(target.config, "model") !== model) await configure(target, "model", model)
    // A family offers only some thought levels; an effort it does not list leaves the family's default.
    const levels = target.config.find((option) => option.id === "thought_level")?.options.map((level) => level.value) ?? []
    if (effort !== undefined && levels.includes(effort) && optionValue(target.config, "thought_level") !== effort) await configure(target, "thought_level", effort)
  }

  /** Opens a new session for a rotation: its append, its selection, and its primer, which must reach the gate. */
  const open = async (serving: BridgeServing, plan: Extract<RequestPlan, { kind: "rotate" }>, request: BridgeRequest): Promise<Session> => {
    // agy sends nothing for a session before `session/new` returns its id, so the handlers find the session made below.
    const opening: SessionRef = {}
    const opened = await engineRequest(serving.engine.openSession({
      append: plan.append,
      onUpdate: (update) => { if (opening.current !== undefined) onUpdate(opening.current, update) },
      onToolCall: (call, signal) => opening.current === undefined
        ? Promise.reject(new Error("the session is not open yet"))
        : onToolCall(opening.current, call, signal),
    }))
    const target: Session = {
      serving, sessionId: opened.sessionId, appendBytes: Buffer.byteLength(plan.append, "utf8"), config: opened.configOptions, view: plan.view,
      prompting: false, park: undefined, feed: undefined, pending: [], release: undefined, admitted: false, modelRequest: false, promptTokensReported: 0, refused: 0, delivered: { results: false, errors: false },
      primer: { canary: false, modelFrames: 0 }, lastCall: [],
      unsubscribe: serving.gate.onEvent((event) => { onGate(target, event) }),
    }
    opening.current = target
    try {
      await select(target, request.model, request.effort)
      serving.gate.expectCanary(target.sessionId)
      await engineRequest(serving.engine.prompt(target.sessionId, text(PRIMER_TEXT)))
      config.audit.hidden("title:new-session")
      const primer = target.primer
      target.primer = undefined
      if (primer === undefined || !primer.canary || primer.modelFrames > 0) {
        // The primer's step ran unadmitted with the session's append.
        if (primer !== undefined && !primer.canary) config.audit.hidden("unadmitted-step")
        void serving.engine.close("gate-not-reached")
        throw gateNotReached(serving.engine.processId, target.sessionId, "session", primer?.modelFrames ?? 0)
      }
    } catch (error) {
      await retire(target)
      throw error
    }
    DebugLog.record({ type: "provider.antigravity.session.rotated", payload: { processId: serving.engine.processId, sessionId: target.sessionId, reason: plan.reason, appendBytes: target.appendBytes } })
    return target
  }

  async function* serve(request: BridgeRequest, record: RequestRecord): AsyncGenerator<ProviderStreamEvent> {
    if (closed) throw new LlmStreamError(`The ${GOOGLE_ANTIGRAVITY_LABEL} bridge closed`, "transient")
    const serving = await config.serving(request.tools)
    const granted = new Set(request.tools.map((tool) => tool.name))
    record.missingTools = [...granted].filter((name) => !serving.engine.toolNames.has(name))
    record.sharedTools = [...serving.engine.toolNames].filter((name) => !granted.has(name))
    await probeGate(serving, config)
    const limits = config.limits(request.model)
    const planned = { processId: serving.engine.processId, systemPrompt: request.systemPrompt, messages: request.messages, model: request.model, estimatedTokens: request.estimatedTokens, ...request.effort === undefined ? {} : { effort: request.effort } }
    let plan = planRequest(session?.view, planned, limits)
    // A user abort during a parked call ends that call with an interrupted result: the session never continues to it.
    if (plan.kind === "deliver" && plan.result.interrupted === true && session !== undefined) {
      await cancel(session)
      plan = planRequest(session.view, planned, limits)
    }
    if (plan.kind === "overflow") throw new ContextLengthExceededError(`The request does not fit the ${GOOGLE_ANTIGRAVITY_LABEL} engine's context (${plan.reason})`)

    if (plan.kind === "continue-call") {
      const target = session
      if (target === undefined) throw new Error("continue-call without a session")
      target.view = plan.view
      record.continued = true
      yield* target.lastCall
      return
    }

    let target: Session
    if (plan.kind === "rotate") {
      const previous = session
      session = undefined
      if (previous !== undefined) await retire(previous)
      target = await open(serving, plan, request)
      session = target
    } else {
      if (session === undefined) throw new Error(`${plan.kind} without a session`)
      target = session
      if (plan.kind === "push" && plan.select !== undefined) await select(target, plan.select.model, plan.select.effort)
      target.view = plan.view
    }

    // A delivered result continues the open prompt; every other release starts a new one.
    const promptTokensReported = plan.kind === "deliver" ? target.promptTokensReported : 0
    const feed: Feed = {
      stream: createRequestStream({
        requestId: crypto.randomUUID(), liveness: request.liveness, promptTokensReported,
        ...request.onDispatch === undefined ? {} : { onDispatch: request.onDispatch },
        onOccupancy: (used) => { target.view = { ...target.view, occupancy: used } },
        modelRequested: () => target.admitted || target.modelRequest,
      }),
      queue: [], settled: false, wake: undefined, text: new Map(), events: [],
    }
    target.feed = feed
    target.refused = 0
    target.release = plan.kind === "deliver" ? "deliver" : "prompt"
    target.admitted = false
    target.modelRequest = false
    record.released = { target, feed }
    const admission = target.serving.gate.grant(target.sessionId)
    const abort = () => {
      if (feed.settled) return
      void cancel(target)
      fail(target, request.signal?.reason)
    }
    request.signal?.addEventListener("abort", abort, { once: true })
    try {
      await feed.stream.released()
      for (const update of target.pending.splice(0)) push(target, feed.stream.update(update))
      if (plan.kind === "deliver") {
        const park = target.park
        target.park = undefined
        if (park === undefined) throw new LlmStreamError(`The ${GOOGLE_ANTIGRAVITY_LABEL} engine no longer waits for the call's result`, "transient")
        const projected = await request.projectResult(plan.result.content, { toolName: park.call.name, toolUseId: plan.result.toolUseId })
        const notices = renderMessages(plan.notices)
        if (plan.result.isError === true) target.delivered.errors = true
        else target.delivered.results = true
        park.answer({ content: resultContent(notices.length === 0 ? projected : [...projected, { type: "text", text: notices }]), ...plan.result.isError === true ? { isError: true } : {} })
      } else {
        sendPrompt(target, text(plan.kind === "push" ? plan.text : plan.prompt.text))
      }
      if (request.signal?.aborted === true) abort()
      while (true) {
        const event = feed.queue.shift()
        if (event !== undefined) {
          yield event
          continue
        }
        if (feed.failure !== undefined) throw feed.failure.error
        if (feed.settled) break
        await new Promise<void>((resolve) => { feed.wake = resolve })
        feed.wake = undefined
      }
    } finally {
      request.signal?.removeEventListener("abort", abort)
      target.promptTokensReported = promptTokensReported + feed.stream.partialTokens
      // A request that settled on a revealed call leaves the step it admitted unused.
      target.serving.gate.revoke(admission)
      if (target.feed === feed && !feed.settled) {
        // The consumer stopped reading before the request settled.
        void cancel(target)
        feed.settled = true
      }
    }
  }

  /** The transport record of a request, from what it did. Only a step that the gate admitted sent a model request. */
  const finish = (record: RequestRecord): ProviderStreamEvent => {
    const released = record.released
    const release: AuditedRelease = {
      ...released?.target.admitted === true ? { step: { appendBytes: released.target.appendBytes, synthetic: released.target.view.synthetic, delivered: { ...released.target.delivered } } } : {},
      refusedSteps: released?.target.refused ?? 0,
      usageReported: released === undefined ? record.continued ?? false : released.feed.stream.usageReported,
      missingTools: record.missingTools,
      sharedTools: record.sharedTools,
    }
    return { kind: "transport_context", context: config.audit.record(release) }
  }

  return {
    async *stream(request) {
      let done!: () => void
      const turn = new Promise<void>((resolve) => { done = resolve })
      const before = queue
      queue = turn
      await before
      const record: RequestRecord = { missingTools: [], sharedTools: [] }
      try {
        yield* serve(request, record)
      } catch (error) {
        yield finish(record)
        throw error
      } finally {
        done()
      }
      yield finish(record)
    },
    async close() {
      closed = true
      const target = session
      session = undefined
      if (target === undefined) return
      fail(target, new LlmStreamError(`The ${GOOGLE_ANTIGRAVITY_LABEL} bridge closed`, "transient"))
      await retire(target)
    },
  }
}
