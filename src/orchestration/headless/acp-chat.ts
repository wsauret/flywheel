import { realpath } from "node:fs/promises"
import { Schema } from "effect"
import { readAppVersion } from "../../infra/app-version.js"
import { errorMessage } from "../../infra/error-message.js"
import {
  ACP_PROTOCOL_VERSION, AcpCancelParamsSchema, AcpCloseSessionParamsSchema, AcpContinueSessionParamsSchema, AcpInboundResponseSchema, AcpInboundSchema,
  AcpInitializeParamsSchema, AcpNewSessionParamsSchema, AcpPromptParamsSchema, AcpSetConfigOptionParamsSchema,
  JSON_RPC_ERROR, acpBlockUpdates, acpConfigOptions, acpElicitationReply, acpElicitationRequest, acpError, acpPromptUsage, acpQuestionAnswers, acpQuestionForm,
  acpResult, acpToolOpen, acpUpdate, acpUsageUpdate,
  type AcpConfigOption, type AcpElicitationReply, type AcpStopReason, type AcpStreamed, type JsonRpcId,
} from "../../protocol/acp.js"
import type { ChatTurnEnding } from "../../protocol/chat-settlement-protocol-types.js"
import type { HeadlessChatOutcome } from "../../protocol/headless-chat.js"
import type { FrontendEvent, FrontendMutation, FrontendOutputBlock, RuntimeEventFrame } from "../../protocol/app-service-types.js"
import { blockIdentity } from "../../protocol/block-identity.js"
import { isBudgetPayload } from "../../protocol/budget-protocol-types.js"
import { createTranscriptStore, type TranscriptStore } from "../../protocol/client/transcript-store.js"
import type { ModelSelectionEffort, ModelSelectionSlot } from "../../protocol/model-assignment-protocol-types.js"
import type { PendingQuestionView } from "../../protocol/question-protocol-types.js"
import { isRolePayload } from "../../protocol/role-protocol-types.js"
import type { HeadlessChatChannel, HeadlessChatFraming } from "./headless-chat-channel.js"

/** One read of the output a recovered window skipped over. */
const GAP_PAGE = { maxBlocks: 200, maxBytes: 4 * 1024 * 1024, includeThinkingContent: true } as const

/** A command that starts a turn of the session. */
type TurnCommand = Extract<FrontendMutation, { readonly type: "session.send" | "question.answer" | "question.cancel" }>

/** The seat whose model and effort the session's configuration options set. */
const CHAT_SLOT: ModelSelectionSlot = { kind: "role", roleId: "chat" }

/** The chat seat that a configuration change saves. */
interface SeatChoice {
  readonly model: string
  readonly effort: ModelSelectionEffort | null
}

interface AcpAnswer {
  readonly lines: readonly string[]
  readonly submitted: boolean
}

/** Agent Client Protocol version 1 over headless chat (protocol/acp.ts). The
 *  channel's root chat is the one ACP session: `session/new` opens a chat, and
 *  `session/load` or `session/resume` attaches a saved chat of the project.
 *  Each refuses a second session or a `cwd` other than `executionCwd`, where
 *  the session's tools run: the starting directory of a runtime that this
 *  process hosts, or the project root in the account service. A prompt sends
 *  a message, or answers the open question with the prompt's text, and is
 *  answered when the channel settles.
 *  A turn that ends on an open question asks it as a form while the prompt
 *  stays open, for a client that can show one; otherwise the question streams
 *  as the agent's message and ends the prompt, and the next prompt answers it. */
export function acpFraming(executionCwd: string): HeadlessChatFraming {
  let connection: ReturnType<typeof openAcpConnection> | undefined
  return {
    open: async (channel) => {
      connection = openAcpConnection(channel, await readAppVersion(), executionCwd)
      return connection
    },
    final: () => {
      connection?.dispose()
      return undefined
    },
  }
}

/** The stop reason that answers a prompt (https://agentclientprotocol.com/protocol/prompt-turn#stop-reasons),
 *  or undefined for a turn that failed, which a JSON-RPC error answers. A failed turn is never `end_turn`, and a
 *  channel that failed after a refusal, such as on its durable write, fails the prompt. A turn that waits on a
 *  question ends its prompt as `end_turn`: the next prompt answers it. */
function stopReasonOf(outcome: HeadlessChatOutcome, cancelled: boolean, ending: ChatTurnEnding | undefined): AcpStopReason | undefined {
  if (outcome === "failed") return undefined
  if (cancelled) return "cancelled"
  if (ending?.kind === "refused") return "refusal"
  return ending?.kind === "failed" || outcome === "incomplete" ? undefined : "end_turn"
}

/** The requests the agent sends the client, which only forms are. */
interface AcpOutbound {
  /** The client advertised form elicitation. */
  forms(): boolean
  /** A new request's id and the reply that settles it. After input ended,
   *  nothing can reply, so the reply is `cancel` at once. */
  request(): { readonly id: JsonRpcId; readonly reply: Promise<AcpElicitationReply> }
  /** Settles every unanswered request as `cancel`, and says whether one was. */
  dismiss(): boolean
}

/** One client connection: the JSON-RPC requests of the protocol and the one
 *  session that it serves. A closed session stays this connection's session,
 *  which serves no other. */
function openAcpConnection(channel: HeadlessChatChannel, version: string, executionCwd: string) {
  let forms = false
  let session: AcpSession | undefined
  let closed = false
  let inputOpen = true
  let requests = 0
  const unanswered = new Map<JsonRpcId, (reply: AcpElicitationReply) => void>()
  const outbound: AcpOutbound = {
    forms: () => forms,
    request: () => {
      const id = `flywheel-${++requests}`
      const reply = inputOpen
        ? new Promise<AcpElicitationReply>((resolve) => { unanswered.set(id, resolve) })
        : Promise.resolve<AcpElicitationReply>({ action: "cancel" })
      return { id, reply }
    },
    dismiss: () => {
      const dismissed = unanswered.size > 0
      for (const [id, settle] of unanswered) {
        unanswered.delete(id)
        settle({ action: "cancel" })
      }
      return dismissed
    },
  }
  const refuse = (id: JsonRpcId | null, code: number, message: string): AcpAnswer => ({ lines: [acpError(id, code, message)], submitted: false })
  const unknown = (id: JsonRpcId, sessionId: string): AcpAnswer =>
    ({ lines: [acpError(id, JSON_RPC_ERROR.resourceNotFound, `Unknown session: ${sessionId}`, { sessionId })], submitted: false })
  /** The session a request names, while it is open. */
  const named = (sessionId: string): AcpSession | undefined => !closed && session?.sessionId === sessionId ? session : undefined
  /** Why a request cannot attach a session here, if it cannot. */
  const unattachable = async (id: JsonRpcId, cwd: string): Promise<AcpAnswer | undefined> => {
    if (session !== undefined) return refuse(id, JSON_RPC_ERROR.invalidRequest, "This agent serves one session per process")
    const resolved = await realpath(cwd).catch(() => undefined)
    return resolved === executionCwd ? undefined : refuse(id, JSON_RPC_ERROR.invalidParams, `This agent runs in ${executionCwd}; start it in ${cwd} to work there`)
  }

  const respond = (raw: unknown): AcpAnswer => {
    const response = Schema.decodeUnknownOption(AcpInboundResponseSchema)(raw)
    if (response._tag === "Some") {
      const settle = unanswered.get(response.value.id)
      unanswered.delete(response.value.id)
      settle?.(acpElicitationReply(response.value))
    }
    return { lines: [], submitted: false }
  }

  const request = async (line: string): Promise<AcpAnswer> => {
    let raw: unknown
    try { raw = JSON.parse(line) } catch { return refuse(null, JSON_RPC_ERROR.parse, "Invalid JSON") }
    if (typeof raw === "object" && raw !== null && !("method" in raw) && "id" in raw) return respond(raw)
    const inbound = Schema.decodeUnknownOption(AcpInboundSchema)(raw)
    if (inbound._tag === "None") return refuse(null, JSON_RPC_ERROR.invalidRequest, "Invalid JSON-RPC 2.0 message")
    const { id, method, params } = inbound.value
    if (id === undefined) {
      const cancel = method === "session/cancel" ? Schema.decodeUnknownOption(AcpCancelParamsSchema)(params) : undefined
      if (cancel?._tag === "Some") await named(cancel.value.sessionId)?.cancel()
      return { lines: [], submitted: false }
    }
    try {
      switch (method) {
        case "initialize": {
          const decoded = Schema.decodeUnknownOption(AcpInitializeParamsSchema)(params)
          if (decoded._tag === "None") return refuse(id, JSON_RPC_ERROR.invalidParams, "initialize requires protocolVersion")
          const form = decoded.value.clientCapabilities?.elicitation?.form
          forms = form !== undefined && form !== null
          return { lines: [acpResult(id, {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
            agentInfo: { name: "flywheel", title: "Flywheel", version },
            authMethods: [],
          })], submitted: false }
        }
        case "session/new": {
          const decoded = Schema.decodeUnknownOption(AcpNewSessionParamsSchema)(params)
          if (decoded._tag === "None") return refuse(id, JSON_RPC_ERROR.invalidParams, "session/new requires cwd and mcpServers")
          const refused = await unattachable(id, decoded.value.cwd)
          if (refused) return refused
          const sessionId = await channel.attach()
          if (sessionId === undefined) throw new Error("Chat open returned no session id")
          session = openAcpSession(channel, sessionId, outbound)
          await session.start("new")
          return { lines: [acpResult(id, { sessionId, ...await session.settings() })], submitted: false }
        }
        case "session/load":
        case "session/resume": {
          const decoded = Schema.decodeUnknownOption(AcpContinueSessionParamsSchema)(params)
          if (decoded._tag === "None") return refuse(id, JSON_RPC_ERROR.invalidParams, `${method} requires sessionId and cwd`)
          const refused = await unattachable(id, decoded.value.cwd)
          if (refused) return refused
          const sessionId = await channel.attach(decoded.value.sessionId)
          if (sessionId === undefined) return unknown(id, decoded.value.sessionId)
          const attached = openAcpSession(channel, sessionId, outbound)
          session = attached
          // A load replays the history before it answers; the question still
          // open is asked again after the answer, which names the session.
          await attached.start(method === "session/load" ? "load" : "resume")
          await channel.write(acpResult(id, await attached.settings()))
          channel.hold(attached.askAgain())
          return { lines: [], submitted: false }
        }
        case "session/close": {
          const decoded = Schema.decodeUnknownOption(AcpCloseSessionParamsSchema)(params)
          if (decoded._tag === "None") return refuse(id, JSON_RPC_ERROR.invalidParams, "session/close requires sessionId")
          if (session?.sessionId !== decoded.value.sessionId) return unknown(id, decoded.value.sessionId)
          if (!closed) {
            closed = true
            await session.close()
          }
          return { lines: [acpResult(id, {})], submitted: false }
        }
        case "session/set_config_option": {
          const decoded = Schema.decodeUnknownOption(AcpSetConfigOptionParamsSchema)(params)
          if (decoded._tag === "None") return refuse(id, JSON_RPC_ERROR.invalidParams, "session/set_config_option requires sessionId, configId, and a value")
          const target = named(decoded.value.sessionId)
          if (target === undefined) return unknown(id, decoded.value.sessionId)
          const set = await target.setConfig(decoded.value.configId, decoded.value.value)
          if ("invalid" in set) return refuse(id, JSON_RPC_ERROR.invalidParams, set.invalid)
          return { lines: [acpResult(id, set)], submitted: false }
        }
        case "session/prompt": {
          const decoded = Schema.decodeUnknownOption(AcpPromptParamsSchema)(params)
          if (decoded._tag === "None") return refuse(id, JSON_RPC_ERROR.invalidParams, "session/prompt accepts text content blocks only")
          const target = named(decoded.value.sessionId)
          if (target === undefined) return refuse(id, JSON_RPC_ERROR.invalidParams, `Unknown session: ${decoded.value.sessionId}`)
          if (target.working()) return refuse(id, JSON_RPC_ERROR.invalidRequest, "A prompt is already running in this session")
          return await target.prompt(id, decoded.value.prompt.map((block) => block.text).join("\n"))
        }
        default:
          return refuse(id, JSON_RPC_ERROR.methodNotFound, `Method not found: ${method}`)
      }
    } catch (error) {
      return refuse(id, JSON_RPC_ERROR.internal, errorMessage(error))
    }
  }

  return {
    request,
    frame: (event: RuntimeEventFrame): readonly string[] => closed ? [] : session?.frame(event) ?? [],
    inputEnded: () => {
      inputOpen = false
      outbound.dismiss()
    },
    dispose: () => { session?.dispose() },
  }
}

type AcpSession = ReturnType<typeof openAcpSession>

function openAcpSession(channel: HeadlessChatChannel, sessionId: string, outbound: AcpOutbound) {
  const scope = { kind: "session", sessionId } as const
  const frameListeners = new Set<(event: FrontendEvent) => void>()
  let transcript: TranscriptStore | undefined
  const streamed = new Map<string, AcpStreamed>()
  // Every block identity this session passed through the stream. A recovered
  // window whose first block is not here skipped output that never streamed.
  const seen = new Set<string>()
  // The thought text the client last received. A streamed thought draft
  // settles to a block under its recorded identity (the entry and part
  // position), which the runtime publishes whole after it retracts the draft.
  // An ACP client cannot take back a chunk, so a thought block not streamed
  // before that begins with this text continues it instead of repeating it.
  let thought: string | undefined
  // Updates go out in this one order, so the output a gap read recovers
  // streams before the live output that follows it.
  let streaming: Promise<void> = Promise.resolve()
  // A prompt is running, or the work an answered form started.
  let working = false
  let cancelled = false
  let question: PendingQuestionView | undefined
  // The last error notice the running prompt streamed: why its turn failed.
  let notice: string | undefined
  // The usage update the client last received. A live budget patch that
  // repeats it, as the one behind a settled read does, streams nothing.
  let usage: string | undefined
  // How the transcript's first window reaches the client: a load replays the
  // saved history, and a resume only notes what the client is taken to hold.
  let adoption: "replay" | "note" | undefined
  // The configuration options the client last received, as JSON.
  let configShown: string | undefined

  const send = (lines: () => Promise<readonly string[]> | readonly string[]): void => {
    streaming = streaming.then(async () => { for (const line of await lines()) await channel.write(line) })
    channel.hold(streaming)
  }

  /** A completed tool row whose result the runtime left out of the row
   *  (ARCH-PROTOCOL-059), with that result read back: the client gets the
   *  whole result, as the model did, not the row's line count. */
  const withResult = async (block: FrontendOutputBlock): Promise<FrontendOutputBlock> => {
    if (block.kind !== "tool" || block.status !== "completed" || block.contentOmittedLines === undefined) return block
    const { contentOmittedLines: _omitted, ...row } = block
    const body = await channel.client.query({ type: "outputBlockBody", sessionId, request: { blockId: blockIdentity(block) } })
    return body.content === undefined ? row : { ...row, content: body.content }
  }

  const updatesFor = async (blocks: readonly FrontendOutputBlock[]): Promise<string[]> => {
    const lines: string[] = []
    for (const block of blocks) {
      const identity = blockIdentity(block)
      seen.add(identity)
      // A client that shows forms gets the open question as one.
      if (block.kind === "question" && outbound.forms()) continue
      if (block.kind === "userMessage") {
        // Only a replay streams the person's own messages, which a live
        // client sent itself.
        if (adoption === "replay" && !streamed.has(identity) && !block.injected && block.from === undefined) {
          streamed.set(identity, "sent")
          lines.push(acpUpdate(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: block.content } }))
        }
        continue
      }
      const sent = streamed.get(identity) ?? (block.kind === "thinking" && thought !== undefined && block.content.startsWith(thought) ? thought.length : undefined)
      // A result is read only for the update that carries it, never for a
      // repeat of a row the client already holds.
      const shown = acpBlockUpdates(block, sent)
      const next = shown.updates.length > 0 ? acpBlockUpdates(await withResult(block), sent) : shown
      if (next.streamed !== undefined) streamed.set(identity, next.streamed)
      if (block.kind === "thinking" && next.updates.length > 0) thought = block.content
      if (block.kind === "system" && next.updates.length > 0) notice = block.message
      lines.push(...next.updates.map((update) => acpUpdate(sessionId, update)))
    }
    return lines
  }

  /** Notes the blocks a resumed client is taken to hold, streaming nothing.
   *  An open question is not noted: it is asked again. */
  const note = (blocks: readonly FrontendOutputBlock[]): void => {
    for (const block of blocks) {
      const identity = blockIdentity(block)
      seen.add(identity)
      if (block.kind === "question") continue
      const next = acpBlockUpdates(block, streamed.get(identity))
      if (next.streamed !== undefined) streamed.set(identity, next.streamed)
      if (block.kind === "thinking") thought = block.content
    }
  }

  /** The current blocks before `read` that a gap can have changed, oldest
   *  first: back to the last streamed block, whose final characters can be
   *  lost, and back to every tool call still streamed as running, whose
   *  result can be lost. Resident blocks outside a read are not evidence: a
   *  merged read keeps the versions the lost deltas left behind. Blocks
   *  already streamed in full stream nothing again. With nothing streamed,
   *  as in a load's replay, this reads back to the first block. */
  const skippedBefore = async (read: readonly FrontendOutputBlock[]): Promise<FrontendOutputBlock[]> => {
    const pages: (readonly FrontendOutputBlock[])[] = []
    const open = new Set([...streamed].flatMap(([identity, sent]) => acpToolOpen(sent) ? [identity] : []))
    const reach = (page: readonly FrontendOutputBlock[]) => {
      for (const block of page) open.delete(blockIdentity(block))
      return page.some((block) => seen.has(blockIdentity(block)))
    }
    let first = read[0]
    let more = true
    let bounded = reach(read)
    while (first !== undefined && more && (!bounded || open.size > 0)) {
      const page = await channel.client.query({ type: "outputRange", sessionId, request: { anchor: { kind: "beforeBlock", blockId: blockIdentity(first) }, ...GAP_PAGE } })
      if (page.kind !== "ok") break
      pages.unshift(page.blocks)
      bounded = reach(page.blocks) || bounded
      first = page.blocks[0]
      more = page.window.hasBefore
    }
    return pages.flat()
  }

  /** The shared transcript store owns intake order, absolute coordinates, and
   *  recovery. It reads the session once per lane, and watches its output on
   *  each lane, because the account service streams output only to a client
   *  that watches it. Frames reach it in the channel's delivery order. */
  const openTranscript = (): TranscriptStore => {
    const store = createTranscriptStore({
      connection: {
        query: (query) => channel.client.query(query),
        subscribe: (listener) => {
          frameListeners.add(listener)
          return () => { frameListeners.delete(listener) }
        },
        onLane: channel.client.onLane,
        watchOutput: channel.client.watchOutput,
      },
      sessionId,
      includeThinkingContent: () => true,
    })
    store.onChange((change) => {
      if (change.kind === "deltas") {
        const blocks = change.replaced.map(({ next }) => next)
        send(() => updatesFor(blocks))
      } else if (change.kind === "window") {
        const { adopted } = change
        send(async () => {
          if (adoption !== "note") return updatesFor([...await skippedBefore(adopted), ...adopted])
          note(adopted)
          return []
        })
      }
    })
    return store
  }

  /** Attaches the transcript. A load streams the saved history and a resume
   *  streams none, each before this resolves; a new chat has no history. A
   *  continued chat's open question is read before this resolves, so a
   *  prompt that follows the answer at once answers it. */
  const start = async (mode: "new" | "load" | "resume"): Promise<void> => {
    const store = openTranscript()
    transcript = store
    if (mode === "new") return
    adoption = mode === "load" ? "replay" : "note"
    await store.open()
    await streaming
    adoption = undefined
    question = (await channel.client.query({ type: "questionSnapshot", sessionIds: [sessionId] })).views[0]?.view ?? undefined
  }

  const readConfig = async (): Promise<AcpConfigOption[]> => {
    const models = await channel.client.query({ type: "modelOptions", scope, slot: CHAT_SLOT })
    const model = models.find((row) => row.current === true && row.selectable && row.model !== null)?.model
    const efforts = model ? await channel.client.query({ type: "effortOptions", scope, slot: CHAT_SLOT, model }) : []
    return acpConfigOptions(models, efforts)
  }

  /** What a session result carries: the configuration options and the
   *  read-only settings (PI-AGENT-076). */
  const settings = async () => {
    const [configOptions, modelPlan, roles, modules] = await Promise.all([
      readConfig(),
      channel.client.query({ type: "sessionModelPlan", sessionId, slots: [CHAT_SLOT] }),
      channel.client.query({ type: "roleSnapshot", sessionIds: [sessionId] }),
      channel.client.query({ type: "moduleSnapshot" }),
    ])
    configShown = JSON.stringify(configOptions)
    return {
      configOptions,
      _meta: { "dev.flywheel/settings": { modelPlan, roles: roles.views[0]?.view ?? null, workflowsMode: modules.capabilities.workflowsMode } },
    }
  }

  /** The seat that setting `configId` to `value` selects. A model keeps the
   *  effort it offers in force, or takes its first. */
  const seatChoice = async (configId: string, value: string): Promise<SeatChoice | { readonly invalid: string }> => {
    const models = await channel.client.query({ type: "modelOptions", scope, slot: CHAT_SLOT })
    const selectableEfforts = async (model: string) =>
      (await channel.client.query({ type: "effortOptions", scope, slot: CHAT_SLOT, model })).filter((row) => row.selectable && row.effort !== null)
    if (configId === "model") {
      if (!models.some((row) => row.selectable && row.model === value)) return { invalid: `Model ${value} is not selectable for this session` }
      const efforts = await selectableEfforts(value)
      return { model: value, effort: (efforts.find((row) => row.current === true) ?? efforts[0])?.effort ?? null }
    }
    if (configId !== "effort") return { invalid: `Unknown configuration option: ${configId}` }
    const model = models.find((row) => row.current === true && row.selectable && row.model !== null)?.model
    const effort = model ? (await selectableEfforts(model)).find((row) => row.effort === value)?.effort : undefined
    if (!model || effort === undefined) return { invalid: `Effort ${value} is not selectable for this session's model` }
    return { model, effort }
  }

  /** Saves the chat seat's model or effort for this session. */
  const setConfig = async (configId: string, value: string) => {
    const choice = await seatChoice(configId, value)
    if ("invalid" in choice) return choice
    const [assignment] = await channel.client.query({ type: "modelAssignments", scope, slots: [CHAT_SLOT] })
    await channel.client.dispatch({ type: "model.save_effort", scope, slot: CHAT_SLOT, ...choice, expected: assignment?.configured ?? { kind: "absent" } })
    return settings()
  }

  const frame = (event: RuntimeEventFrame): readonly string[] => {
    if (transcript === undefined || event.type !== "patch") return []
    for (const listener of frameListeners) listener(event)
    const { cursor, payload } = event.patch
    if (cursor.scope !== "session" || cursor.sessionId !== sessionId) return []
    if (isBudgetPayload(payload) && payload.kind === "budget.updated") {
      const update = acpUsageUpdate(payload.budget)
      const line = update ? acpUpdate(sessionId, update) : undefined
      if (line !== undefined && line !== usage) {
        usage = line
        send(() => [line])
      }
    } else if (isRolePayload(payload) && payload.kind === "roles.updated") {
      // A change the runtime made, or one this session's own save already
      // answered, which pushes nothing. A failed read leaves the options the
      // client holds; the next change reads them again.
      send(async () => {
        const configOptions = await readConfig().catch(() => undefined)
        const shown = JSON.stringify(configOptions)
        if (configOptions === undefined || shown === configShown) return []
        configShown = shown
        return [acpUpdate(sessionId, { sessionUpdate: "config_option_update", configOptions })]
      })
    }
    return []
  }

  /** Asks the open question as a form: the command that answers or declines
   *  it, or undefined to leave it open. */
  const askForm = async (view: PendingQuestionView): Promise<TurnCommand | undefined> => {
    const { id, reply } = outbound.request()
    send(() => [acpElicitationRequest(id, acpQuestionForm(view, sessionId))])
    const answered = await reply
    if (answered.action !== "accept") return answered.action === "decline" ? { type: "question.cancel", sessionId, toolUseId: view.toolUseId } : undefined
    const answers = acpQuestionAnswers(view, answered.content)
    return answers && { type: "question.answer", sessionId, toolUseId: view.toolUseId, answers }
  }

  const submit = async (command: TurnCommand) => {
    notice = undefined
    return channel.client.dispatch(command)
  }

  /** Follows the work until it settles, answering each question it asks with
   *  a form while the client can show one, then answers prompt `id`, if a
   *  prompt started the work. */
  const follow = async (id: JsonRpcId | undefined, store: TranscriptStore): Promise<void> => {
    // A settled answer names how the turn ended: a chat states how its last
    // turn ended until it accepts input again.
    let settlement: { readonly outcome: HeadlessChatOutcome; readonly ending?: ChatTurnEnding } | { readonly failure: string }
    while (true) {
      // A settlement that fails, as when the turn's totals cannot be read,
      // fails this prompt with no usage update; a failed channel also fails on
      // its own path.
      settlement = await channel.settle().then(
        ({ state, turnEnding }) => ({ outcome: state, ...(turnEnding ? { ending: turnEnding } : {}) }),
        (error: unknown) => ({ failure: errorMessage(error) }),
      )
      // A read the store already had out when the turn settled can answer from
      // before its last output, and a refresh joins it, so the second refresh
      // reads after the settlement.
      await store.refresh()
      await store.refresh()
      await streaming
      // The settled read names the open question, which a live patch can still
      // be on its way to report.
      question = "outcome" in settlement && settlement.outcome === "input_required"
        ? (await channel.client.query({ type: "questionSnapshot", sessionIds: [sessionId] })).views[0]?.view ?? undefined
        : undefined
      if (question === undefined || cancelled || !outbound.forms()) break
      const command = await askForm(question)
      if (command === undefined || cancelled) break
      const result = await submit(command)
      if (!result.ok) {
        settlement = { failure: result.error }
        break
      }
    }
    working = false
    const lines: string[] = []
    if ("outcome" in settlement) {
      // The settled budget, which states every request of the turn, reaches
      // the client before the response that ends its prompt, which a live
      // budget patch can still be behind.
      const budget = (await channel.client.query({ type: "budgetSnapshot", sessionIds: [sessionId] })).views[0]?.view
      const settled = budget ? acpUsageUpdate(budget) : undefined
      if (settled) {
        usage = acpUpdate(sessionId, settled)
        lines.push(usage)
      }
    }
    if (id !== undefined) {
      const ending = "outcome" in settlement ? settlement.ending : undefined
      const stopReason = "outcome" in settlement ? stopReasonOf(settlement.outcome, cancelled, ending) : undefined
      if (stopReason === undefined) {
        const message = "failure" in settlement ? settlement.failure : notice ?? "The turn ended before it completed"
        lines.push(acpError(id, JSON_RPC_ERROR.internal, message, ending?.kind === "failed" ? { failure: ending.failure } : undefined))
      } else {
        // Usage stats come from the Usage module; without it the response
        // carries no token counts.
        const stats = await channel.client.query({ type: "usage.stats", sessionId }).catch(() => undefined)
        lines.push(acpResult(id, { stopReason, ...(stats ? { usage: acpPromptUsage(stats.totals.tokens) } : {}) }))
      }
    }
    send(() => lines)
    await streaming
  }

  const prompt = async (id: JsonRpcId, text: string): Promise<AcpAnswer> => {
    const store = transcript
    if (store === undefined) throw new Error("The session has no transcript")
    const command: TurnCommand = question
      ? { type: "question.answer", sessionId, toolUseId: question.toolUseId, answers: Object.fromEntries(question.questions.map((entry) => [entry.question, { kind: "freeform" as const, text }])) }
      : { type: "session.send", sessionId, input: text }
    const result = await submit(command)
    if (!result.ok) return { lines: [acpError(id, JSON_RPC_ERROR.internal, result.error)], submitted: false }
    working = true
    cancelled = false
    channel.hold(follow(id, store))
    return { lines: [], submitted: true }
  }

  /** Asks the question that a continued chat still has open, once more: as a
   *  form, whose answer starts work that no prompt answers, or as the
   *  agent's message when the client shows no forms and has not received it. */
  const askAgain = async (): Promise<void> => {
    const view = question
    const store = transcript
    if (view === undefined || store === undefined || working) return
    if (!outbound.forms()) {
      const identity = blockIdentity(view)
      const next = acpBlockUpdates(view, streamed.get(identity))
      if (next.streamed !== undefined) streamed.set(identity, next.streamed)
      send(() => next.updates.map((update) => acpUpdate(sessionId, update)))
      return
    }
    working = true
    cancelled = false
    const command = await askForm(view)
    if (command !== undefined && !cancelled && (await submit(command)).ok) return follow(undefined, store)
    working = false
  }

  /** Ends the running prompt as cancelled. A prompt whose form is open is at
   *  rest on its question, which stays open; any other prompt's turn is
   *  interrupted. */
  const cancel = async (): Promise<void> => {
    if (!working) return
    cancelled = true
    if (outbound.dismiss()) return
    await channel.client.dispatch({ type: "chat.interrupt", sessionId })
  }

  /** Cancels the running prompt and lets go of the chat, which stays saved. */
  const close = async (): Promise<void> => {
    await cancel()
    channel.release()
  }

  return {
    sessionId, start, settings, setConfig, frame, prompt, askAgain, cancel, close,
    working: () => working,
    dispose: () => { transcript?.dispose() },
  }
}
