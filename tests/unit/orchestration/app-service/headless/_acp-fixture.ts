import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { PassThrough } from "node:stream"
import type { FrontendEvent, FrontendMutation, FrontendOutputBlock, RuntimeClient } from "../../../../../src/protocol/runtime/app-service-types.js"
import type { BudgetView } from "../../../../../src/protocol/session/budget-protocol-types.js"
import { blockIdentity } from "../../../../../src/protocol/transcript/block-identity.js"
import type { AcpElicitationReply, AcpResult, AcpSessionUpdate } from "../../../../../src/protocol/rpc/acp.js"
import type { ModelSelectionEffort } from "../../../../../src/protocol/auth/model-assignment-protocol-types.js"
import type { UsageSessionStats } from "../../../../../src/protocol/modules/subscription-usage.js"
import type { PendingQuestionView } from "../../../../../src/protocol/session/question-protocol-types.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime/runtime-ui-protocol-types.js"
import type { ChatSettlementOutcome, ChatTurnEnding } from "../../../../../src/protocol/session/chat-settlement-protocol-types.js"
import { RuntimeLaneLost } from "../../../../../src/protocol/client/runtime/connection-failures.js"
import { projectFrontendOutputBlock } from "../../../../../src/orchestration/app-service/projections/output/frontend-output-blocks.js"
import { createRuntimeUiBus } from "../../../../../src/orchestration/app-service/projections/runtime-ui-bus.js"
import { serveChatSettlement } from "../../../../../src/orchestration/app-service/supervisor/runtime-work-settlement.js"
import { acpFraming } from "../../../../../src/orchestration/app-service/headless/acp-chat.js"
import { runHeadlessChatChannel, type HeadlessChatClient } from "../../../../../src/orchestration/app-service/headless/headless-chat-channel.js"
import { recordedDispatch, runtimeDispatch, runtimeQuery } from "../../../../helpers/runtime-dispatch.js"
import { detailView, modulesView, tailWindow } from "../../../../helpers/runtime-views.js"
import { catalogRow } from "../../../../helpers/session-catalog.js"

/** One line Flywheel wrote: a response or a session update. */
interface Message {
  readonly id?: number | string
  readonly method?: string
  readonly result?: AcpResult
  readonly error?: { readonly code: number; readonly message: string; readonly data?: { readonly failure?: string; readonly sessionId?: string } }
  readonly params?: { readonly update: AcpSessionUpdate; readonly [field: string]: unknown }
}

interface Inbound {
  readonly id?: number
  readonly method: string
  readonly params: object
}

const SUMMARY = {
  attempts: 2, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true,
  tokens: { input: 100, output: 40, cacheRead: 900, cacheWrite: 0, reasoning: 10, total: 1040 },
  estimatedBilledUsd: 0, includedValueUsd: 0.25, priceUnavailable: false,
}
const STATS: UsageSessionStats = {
  sessionId: "root", asOf: 0, partial: false, descendantCount: 0, direct: SUMMARY, descendants: SUMMARY, totals: SUMMARY, models: [], tools: [],
  generation: { basis: "O200kBase", totals: { outputTokens: 0, durationMs: 0, measuredRequests: 0, unmeasuredRequests: 0, measuredBlocks: 0, excludedBlocks: 0, averageTokensPerSecond: null }, coverageComplete: true, models: [] },
}

/** The directory the agent runs in, which session/new must name. */
export const CWD = tmpdir()

export const question: PendingQuestionView = {
  kind: "question", toolUseId: "ask", timestamp: 0,
  questions: [{ question: "Which port?", multiSelect: false, choices: [{ kind: "option", choiceId: "c8080", label: "8080" }, { kind: "freeform", label: "Other" }] }],
}

/** The chat seat's selectable models, each with the efforts it offers. */
const MODELS = [
  { model: "gpt-a", label: "GPT A", efforts: ["low", "medium"] },
  { model: "gpt-b", label: "GPT B", efforts: ["high"] },
] as const
export const CHAT = { kind: "role", roleId: "chat" } as const

/** The model and effort of the session's chat seat. */
interface Seat {
  readonly model: string
  readonly effort: ModelSelectionEffort
}

interface FixtureOptions {
  /** The client advertises form elicitation. */
  readonly forms?: boolean
  /** The saved chat's output before the client attaches. */
  readonly history?: readonly FrontendOutputBlock[]
  /** The question the chat asks while it waits for input. */
  readonly asks?: PendingQuestionView
  /** The saved chat already waits on its question. */
  readonly waiting?: boolean
}

/** A root chat whose turns a test scripts: `onTurn` runs for every message
 *  or answer and owns the settlement state it ends in. The client reaches it
 *  as a client of the account service does: over a lane that a test can
 *  break, and with live output only for a session that it watches. */
export function acpFixture(onTurn: (turn: { readonly command: FrontendMutation; publish(input: RuntimeUiPatchInput): void; stored(budget: BudgetView): void; unreadable(error: Error): void; output(block: FrontendOutputBlock): void; lose(block: FrontendOutputBlock): void; retract(block: FrontendOutputBlock): void; ended(ending: ChatTurnEnding): void; settle(outcome: ChatSettlementOutcome): Promise<void>; settleUnseen(outcome: ChatSettlementOutcome): void; streamed(text: string): Promise<void> }) => void | Promise<void>, transport: Pick<Parameters<typeof runHeadlessChatChannel>[1], "completion" | "authProfile"> = {}, options: FixtureOptions = {}) {
  const bus = createRuntimeUiBus()
  const asks = options.asks ?? question
  const framing = acpFraming(realpathSync(CWD))
  /** How the root chat's last turn ended, until it accepts input again, as its runner states it. */
  let turnEnding: ChatTurnEnding | undefined
  const ended = (ending: ChatTurnEnding) => { turnEnding = ending }
  const calls: FrontendMutation[] = []
  // The rows a client reads, as the runtime's live edge publishes them, and
  // the blocks whose bodies a row can leave out.
  const blocks: FrontendOutputBlock[] = []
  const bodies = new Map<string, FrontendOutputBlock>()
  const resident = (block: FrontendOutputBlock) => {
    bodies.set(blockIdentity(block), block)
    const known = blocks.findIndex((candidate) => blockIdentity(candidate) === blockIdentity(block))
    const index = known === -1 ? blocks.length : known
    const row = projectFrontendOutputBlock(block)
    blocks[index] = row
    return { index, known: known !== -1, row }
  }
  for (const block of options.history ?? []) resident(block)
  const listeners = new Set<() => void>()
  let state: ChatSettlementOutcome | "busy" = options.waiting ? "input_required" : "complete"
  let interrupt = () => {}
  let budget: BudgetView | null = null
  const settle = async (outcome: ChatSettlementOutcome) => {
    await bus.drain()
    state = outcome
    for (const listener of listeners) listener()
  }
  /** Settles with no wake reaching the client, as when its lane broke. */
  const settleUnseen = (outcome: ChatSettlementOutcome) => { state = outcome }
  // The settlement reads the next lane loses, as a broken lane loses its calls.
  let lostReads = 0
  let position = 0
  const publish = (input: RuntimeUiPatchInput) => {
    if (input.payload.kind === "budget.updated") budget = input.payload.budget
    position = bus.publish(input)?.position ?? position
  }
  // Usage the store holds and the totals do not state yet: the totals follow
  // the store through a derived index, which states it once it is current.
  let unindexed: BudgetView | undefined
  const stored = (next: BudgetView) => { unindexed = next }
  // A failure of the next totals read, as when it passes its deadline.
  let readFailure: Error | undefined
  const unreadable = (error: Error) => { readFailure = error }
  const currentTotals = async () => {
    const failure = readFailure
    readFailure = undefined
    if (failure) throw failure
    if (unindexed) publish({ cursor: { scope: "session", domain: "budget", sessionId: "root" }, payload: { kind: "budget.updated", budget: unindexed } })
    unindexed = undefined
  }
  const output = (block: FrontendOutputBlock) => {
    const { index, known, row } = resident(block)
    publish({ cursor: { scope: "session", domain: "output", sessionId: "root" }, payload: { kind: "output.delta", delta: { visibleMessageCount: blocks.length, blocks: [{ kind: known ? "upsert" : "insert", index, blockId: blockIdentity(row), block: row }] } } })
  }
  /** Output whose live delta never reaches the client, as when its queue overflowed. */
  const lose = (block: FrontendOutputBlock) => { resident(block) }
  /** Removes a draft row, as a resync does: it truncates at the row and inserts the rows after it again. */
  const retract = (block: FrontendOutputBlock) => {
    const index = blocks.findIndex((candidate) => blockIdentity(candidate) === blockIdentity(block))
    blocks.splice(index, 1)
    const after = blocks.slice(index).map((row, offset) => ({ kind: "insert" as const, index: index + offset, blockId: blockIdentity(row), block: row }))
    publish({ cursor: { scope: "session", domain: "output", sessionId: "root" }, payload: { kind: "output.delta", delta: { visibleMessageCount: blocks.length, truncateTo: index, blocks: after } } })
  }
  // The chat seat of the session, which a save or the runtime changes.
  let seat: Seat = { model: "gpt-a", effort: "medium" }
  const reseat = (next: Seat) => {
    seat = next
    publish({ cursor: { scope: "session", domain: "roles", sessionId: "root" }, payload: { kind: "roles.updated", roles: { assignments: { chat: seat }, serving: { slot: CHAT, selection: seat } } } })
  }
  const turn = async (command: FrontendMutation) => {
    state = "busy"
    turnEnding = undefined
    queueMicrotask(() => { onTurn({ command, publish, stored, unreadable, output, lose, retract, ended, settle, settleUnseen, streamed }) })
    return { ok: true as const, sessionId: "root" }
  }
  const runtime: RuntimeClient = {
    query: runtimeQuery({
      budgetSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: budget })) }),
      outputWindow: async ({ request }) => {
        const start = Math.max(0, blocks.length - request.range.maxBlocks)
        return tailWindow(blocks.slice(start), { snapshotPosition: position, startBlockIndex: start })
      },
      outputRange: async ({ request }) => {
        if (request.anchor.kind !== "beforeBlock") throw new Error(`Unexpected anchor ${request.anchor.kind}`)
        const { blockId } = request.anchor
        const end = blocks.findIndex((block) => blockIdentity(block) === blockId)
        const start = Math.max(0, end - request.maxBlocks)
        return {
          kind: "ok", consistencyToken: "fixture", anchor: request.anchor, streamingToolText: {}, streamingOutputChars: 0, blocks: blocks.slice(start, end),
          window: { startBlockIndex: start, endBlockIndex: end - 1, hasBefore: start > 0, hasAfter: true, contentBytes: 0 },
        }
      },
      outputBlockBody: async ({ request }) => {
        const block = bodies.get(request.blockId)
        return { blockId: request.blockId, ...(block?.kind === "tool" && block.content !== undefined ? { content: block.content } : {}) }
      },
      questionSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: state === "input_required" ? asks : null })) }),
      "usage.stats": async () => STATS,
      sessionDetail: async (request) => ({ view: request.sessionId === "root" ? detailView(catalogRow("root", "Saved chat")) : null }),
      modelOptions: async ({ slot }) => [
        ...MODELS.map((entry) => ({ slot, model: entry.model, label: entry.label, selectable: true, current: entry.model === seat.model, efforts: entry.efforts, effort: entry.efforts[0], providers: [] })),
        { slot, model: "gpt-off", label: "GPT Off", selectable: false, efforts: [], effort: "low" as const, providers: [] },
      ],
      effortOptions: async ({ slot, model }) => (MODELS.find((entry) => entry.model === model)?.efforts ?? []).map((effort) => ({ slot, effort, label: effort, selectable: true, current: effort === seat.effort })),
      modelAssignments: async ({ slots }) => slots.map((slot) => ({ slot, label: "Chat", ...seat, modelSource: "explicit" as const, matchesInheritedPair: false, configured: { kind: "value" as const, value: { ...seat } } })),
      sessionModelPlan: async ({ sessionId, slots }) => ({
        sessionId, profile: { persistedId: "Personal", effectiveId: "Personal" },
        assignments: slots.map((slot) => ({ slot, label: "Chat", ...seat, modelSource: "explicit" as const, matchesInheritedPair: false })),
        plans: [{ kind: "available", model: seat.model, candidates: [] }],
      }),
      roleSnapshot: async ({ sessionIds }) => ({ snapshotPosition: 0, views: sessionIds.map((sessionId) => ({ sessionId, view: { assignments: { chat: seat }, serving: { slot: CHAT, selection: seat } } })) }),
      moduleSnapshot: async () => ({ snapshotPosition: 0, capabilities: modulesView() }),
    }),
    dispatch: recordedDispatch((command) => { calls.push(command) }, runtimeDispatch({
      "chat.open": async () => ({ ok: true, sessionId: "root" }),
      "session.activate": async () => ({ ok: true, sessionId: "root" }),
      "session.send": turn,
      "question.answer": turn,
      "question.cancel": turn,
      "chat.interrupt": async () => { interrupt(); return { ok: true, sessionId: "root" } },
      "session.release": async () => ({ ok: true, sessionId: "root" }),
      "auth.profile.select": async (command) => command.id === "Locked" ? { ok: false, error: "cannot switch the environment-selected auth profile" } : { id: command.id },
      "model.save_effort": async (command) => {
        reseat({ model: command.model ?? seat.model, effort: command.effort ?? seat.effort })
        return { label: `${seat.model} ${seat.effort}` }
      },
    })),
    close: async () => {},
    subscribe: (next) => { bus.addListener(next); return () => { bus.removeListener(next) } },
  }
  const served = serveChatSettlement({
    client: runtime, currentTotals, bus, turnEnding: () => turnEnding,
    settlement: { read: async () => state, onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } },
  })
  // The open lane, the receivers that hear each new one, and the sessions
  // whose output the open lane carries.
  let lane = 1
  const lanes = new Set<(lane: number) => void>()
  const watched = new Map<string, number>()
  const client: HeadlessChatClient = {
    query: async (query, queryOptions) => {
      if (query.type === "chatSettlement" && lostReads > 0) {
        lostReads--
        throw new RuntimeLaneLost(new Error("lane closed"))
      }
      return await served.query(query, queryOptions)
    },
    dispatch: runtime.dispatch,
    subscribe: (next) => {
      const listener = (event: FrontendEvent) => {
        if (event.type === "patch" && event.patch.payload.kind === "output.delta" && event.patch.cursor.scope === "session" && !watched.has(event.patch.cursor.sessionId)) return
        next(event)
      }
      return runtime.subscribe(listener)
    },
    onLane: (listener) => {
      lanes.add(listener)
      listener(lane)
      return () => { lanes.delete(listener) }
    },
    watchOutput: (sessionId) => {
      watched.set(sessionId, (watched.get(sessionId) ?? 0) + 1)
      const watchedOn = lane
      return () => {
        const count = watched.get(sessionId) ?? 0
        if (watchedOn !== lane) return
        if (count <= 1) watched.delete(sessionId)
        else watched.set(sessionId, count - 1)
      }
    },
  }
  /** Ends the open lane, whose watches end with it, and opens the next. */
  const breakLane = () => {
    watched.clear()
    lane++
    for (const listener of lanes) listener(lane)
  }
  const input = new PassThrough()
  const messages: Message[] = []
  const arrived = new Set<() => void>()
  const channel = runHeadlessChatChannel(client, {
    ...transport, input, framing,
    write: async (line) => {
      messages.push(JSON.parse(line))
      for (const wake of arrived) wake()
    },
  })
  const send = (message: Inbound) => { input.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`) }
  /** Answers a request the agent sent the client. */
  const reply = (id: string, result: AcpElicitationReply) => { input.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`) }
  /** Resolves with the next form the agent asks for after the `seen` ones. */
  const form = async (seen = 0): Promise<{ readonly id: string; readonly params: { readonly [field: string]: unknown } }> => {
    while (true) {
      const asked = messages.filter((message) => message.method === "elicitation/create")[seen]
      if (asked?.params) return { id: String(asked.id), params: asked.params }
      await new Promise<void>((resolve) => { arrived.add(resolve) })
    }
  }
  /** Resolves with the response to request `id`. */
  const response = async (id: number): Promise<Message> => {
    while (true) {
      const found = messages.find((message) => message.id === id)
      if (found) return found
      await new Promise<void>((resolve) => { arrived.add(resolve) })
    }
  }
  /** Resolves once a session update whose JSON contains `text` was written. */
  const streamed = async (text: string): Promise<void> => {
    while (!updates().some((update) => JSON.stringify(update).includes(text))) {
      await new Promise<void>((resolve) => { arrived.add(resolve) })
    }
  }
  const updates = () => messages.flatMap((message) => message.method === "session/update" && message.params ? [message.params.update] : [])
  const initialize = () => {
    send({ id: 0, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, ...(options.forms ? { elicitation: { form: {} } } : {}) } } })
    return response(0)
  }
  const open = async () => {
    const initialized = initialize()
    send({ id: 1, method: "session/new", params: { cwd: CWD, mcpServers: [] } })
    return [await initialized, await response(1)]
  }
  return {
    send, reply, form, response, updates, initialize, open, reseat, calls, messages, channel, breakLane,
    watching: (sessionId: string) => watched.has(sessionId),
    loseSettlementReads: (count: number) => { lostReads = count },
    end: () => { input.end() }, onInterrupt: (next: () => void) => { interrupt = next },
  }
}

export const prompt = (id: number, text: string) => ({ id, method: "session/prompt", params: { sessionId: "root", prompt: [{ type: "text", text }] } })
