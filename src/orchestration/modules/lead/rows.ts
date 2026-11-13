import type { PositionedEventProjection } from "../../../infra/event-projection.js"
import type { AsyncEventReadSurface, StoredFact } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import type { QuestionEntry } from "../../../infra/output-blocks.js"
import { recordBackgroundFailure } from "../../../infra/operation-log.js"
import { pinHeldProjection } from "../../../infra/projection-registry.js"
import { isActiveActivity } from "../../../protocol/app-service-types.js"
import type { LeadRow, LeadRowState } from "../../../protocol/modules/lead.js"
import { AGENT_INPUT_FACT_TYPES } from "../../session/agent-input-facts.js"
import { loadAgentInputProjection, type AgentInputEntry } from "../../session/agent-input-projection.js"
import { isVisibleTurnEnd, type ChatTurnEnd } from "../../session/conversation/turn-end-record.js"
import type { ModuleProcessServices } from "../../app-service/module-service-host.js"
import type { SessionManager } from "../../session/manager.js"
import { entryActivity } from "../../session-store/activity.js"
import type { SessionStore } from "../../session-store/types.js"
import { leadRowFold, type RowFold } from "./row.js"

const log = Log.create({ service: "lead-rows" })

const UPDATE_CHARS = 240
const REQUEST_CHARS = 400
const QUESTION_FACT_TYPES: ReadonlySet<string> = new Set(AGENT_INPUT_FACT_TYPES)
const NEEDS_PERSON: ReadonlySet<LeadRowState> = new Set(["question", "failed", "cut"])

/** One started chat as the lead reads it: its row, if any, and what the row derives from. */
export interface LeadChatReading {
  readonly row: LeadRow | undefined
  /** Whether the chat works: the live store shows an active turn or a wait on background work, or a runner starts for its open turn. */
  readonly working: boolean
  readonly turnEnd: ChatTurnEnd | undefined
  /** The full first text block of the person's newest message. */
  readonly request: string | null
  /** The full text of the newest assistant message that holds no tool call. */
  readonly final: string | null
  /** The pending question: its call, the leading context of that call, and the form. */
  readonly question: { readonly toolUseId: string; readonly context: string | null; readonly questions: readonly QuestionEntry[] } | undefined
}

/** A row's state, the time its evidence names, and for a failure the entry that records it, null when none does. */
interface RowState {
  readonly state: LeadRowState
  readonly at: number | undefined
  readonly failure?: string | null
}

export type LeadRowChange = { readonly kind: "updated"; readonly row: LeadRow } | { readonly kind: "removed"; readonly sessionId: string }

interface LeadRowsDeps {
  readonly reader: AsyncEventReadSurface
  readonly sessionManager: Pick<SessionManager, "read">
  readonly sessionStore: Pick<SessionStore, "get" | "onChange">
  readonly sessionRuntime: ReturnType<ModuleProcessServices["executionEnvironment"]>["sessionRuntime"]
  /** The entry of the newest result that the person read in the chat. */
  readonly readMark: (sessionId: string) => string | undefined
  readonly publish: (change: LeadRowChange) => void
  readonly now?: () => number
}

/** The rows of the chats that the lead started (PI-LEAD-004): one held fold of each chat's conversation, its pending
 *  question, and its live activity. Each change touches only the chats that it names, and a row publishes only when it
 *  differs. */
export interface LeadRows {
  /** Starts following these started chats. A chat that is not a chat, or no longer exists, gets no row. */
  add(sessionIds: Iterable<string>): Promise<void>
  /** Advances the chats that a committed batch of the store's broadcast names. */
  observe(events: readonly StoredFact[]): Promise<void>
  /** Reads a chat's row again, as after a change of its read mark. */
  refresh(sessionId: string): void
  rows(): readonly LeadRow[]
  /** A started chat that exists, once its fold is built; undefined for any other chat. */
  chat(sessionId: string): Promise<LeadChatReading | undefined>
  /** Releases every fold and listener, and settles the builds that run. Publishes nothing. */
  dispose(): Promise<void>
}

interface Member {
  readonly sessionId: string
  readonly conversation: string
  readonly fold: PositionedEventProjection<RowFold>
  readonly release: readonly (() => void)[]
  question: Extract<AgentInputEntry, { kind: "pending" }> | undefined
  /** The row's state and the time the chat entered it. */
  entered: { readonly state: LeadRowState; readonly at: number } | undefined
  row: LeadRow | undefined
}

async function pendingQuestion(reader: AsyncEventReadSurface, sessionId: string): Promise<Member["question"]> {
  let newest: Member["question"]
  for (const entry of (await loadAgentInputProjection(reader, sessionId)).values()) {
    if (entry.kind === "pending" && (newest === undefined || entry.openedAt >= newest.openedAt)) newest = entry
  }
  return newest
}

export function createLeadRows(deps: LeadRowsDeps): LeadRows {
  const now = deps.now ?? Date.now
  const builds = new Map<string, Promise<Member | undefined>>()
  /** Every member that holds its pins, also while its fold builds. */
  const pinned = new Map<string, Member>()
  /** The members whose fold is built. */
  const members = new Map<string, Member>()
  const byConversation = new Map<string, Member>()
  let disposed = false

  /** What the runtime shows of a chat now: a runner start that failed, work, or neither. A chat whose turn is open
   *  works while its runner starts: from the commit of the person's message the chat has no runner yet, and the
   *  runner that attaches rests until it takes that message, which only the runtime's `starting` tells apart from a
   *  runner that rests for good. */
  const liveState = (sessionId: string, fold: RowFold): "failed" | "working" | undefined => {
    const runtime = deps.sessionRuntime(sessionId)
    if (runtime?.kind === "failed") return "failed"
    const entry = deps.sessionStore.get(sessionId)
    if (entry?.kind !== "chat") return undefined
    if (entry.waitingOnBackgroundWork || isActiveActivity(entryActivity(entry))) return "working"
    const open = fold.turnEnd?.reading.end.reason === "crash" && !fold.turnEnd.reading.recorded
    return open && (entry.runner === null || runtime?.kind === "starting") ? "working" : undefined
  }

  /** The state of a chat by the order of section 2.5 of the lead design. */
  function stateOf(member: Member, fold: RowFold, live: "failed" | "working" | undefined): RowState | undefined {
    if (member.question) return { state: "question", at: member.question.openedAt }
    if (live === "failed") return { state: "failed", at: undefined, failure: null }
    if (live === "working") return { state: "working", at: undefined }
    const end = fold.turnEnd
    if (end?.reading.end.reason === "paused" && isVisibleTurnEnd(end.reading.end)) return { state: "cut", at: end.at }
    if (end?.reading.end.reason === "crash") return { state: "failed", at: end.at, failure: end.recordId }
    if (fold.final && fold.final.entryId !== deps.readMark(member.sessionId)) return { state: "result", at: fold.final.at }
    return undefined
  }

  function rowOf(member: Member, fold: RowFold, { state, failure }: RowState, entered: number): LeadRow {
    const update = fold.updates.at(-1)
    const toolUseId = member.question?.toolUseId
    return {
      sessionId: member.sessionId,
      state,
      update: update ? update.text.slice(0, UPDATE_CHARS) : null,
      since: Math.max(entered, update?.at ?? 0),
      ...(NEEDS_PERSON.has(state) ? { waitingSince: entered } : {}),
      request: fold.request ? { entryId: fold.request.entryId, text: fold.request.text.slice(0, REQUEST_CHARS) } : null,
      updates: fold.updates.map((line) => ({ text: line.text.slice(0, UPDATE_CHARS), at: line.at })),
      ...(state === "question" && toolUseId !== undefined ? { question: { toolUseId, context: fold.contexts[toolUseId] ?? null } } : {}),
      ...(failure !== undefined ? { failure: { entryId: failure } } : {}),
      ...(state === "result" && fold.final ? { result: { entryId: fold.final.entryId } } : {}),
    }
  }

  /** Derives the member's row from its fold, its question, and the live store, and publishes it when it changed. */
  function compute(member: Member): void {
    const fold = member.fold.getState()
    const next = stateOf(member, fold, liveState(member.sessionId, fold))
    if (next === undefined) {
      member.entered = undefined
      if (member.row) {
        member.row = undefined
        deps.publish({ kind: "removed", sessionId: member.sessionId })
      }
      return
    }
    if (member.entered?.state !== next.state) member.entered = { state: next.state, at: next.at ?? now() }
    const row = rowOf(member, fold, next, member.entered.at)
    if (member.row && Bun.deepEquals(member.row, row, true)) return
    member.row = row
    deps.publish({ kind: "updated", row })
  }

  async function build(sessionId: string): Promise<Member | undefined> {
    const session = await deps.sessionManager.read(sessionId)
    if (session?.kind !== "chat" || disposed || !builds.has(sessionId)) return undefined
    // Pinned while the chat is a started chat, so the registry's bound for a family never folds one from its start again.
    const release = [
      pinHeldProjection(deps.reader, `lead-row:${sessionId}`, { dropOnLastRelease: true }),
      pinHeldProjection(deps.reader, `agent-input:${sessionId}`),
    ]
    const member: Member = {
      sessionId, conversation: `conversation:${session.conversationId}`, release,
      fold: leadRowFold(deps.reader, sessionId, session.conversationId), question: undefined, entered: undefined, row: undefined,
    }
    pinned.set(sessionId, member)
    byConversation.set(member.conversation, member)
    try {
      await member.fold.replay()
      member.question = await pendingQuestion(deps.reader, sessionId)
    } catch (error) {
      remove(sessionId)
      throw error
    }
    if (!builds.has(sessionId)) return undefined
    members.set(sessionId, member)
    compute(member)
    return member
  }

  function remove(sessionId: string): void {
    builds.delete(sessionId)
    const member = pinned.get(sessionId)
    if (!member) return
    pinned.delete(sessionId)
    byConversation.delete(member.conversation)
    members.delete(sessionId)
    for (const release of member.release) release()
    if (member.row) deps.publish({ kind: "removed", sessionId })
  }

  const unsubscribeStore = deps.sessionStore.onChange((changed) => {
    if (disposed) return
    // An undefined set follows a change of the store's membership, after which every subscriber reads every entry.
    if (changed === undefined) {
      for (const member of members.values()) compute(member)
      return
    }
    for (const sessionId of changed) {
      const member = members.get(sessionId)
      if (member) compute(member)
    }
  }, "lead-rows")

  return {
    async add(sessionIds) {
      const started: Promise<unknown>[] = []
      for (const sessionId of sessionIds) {
        if (disposed || builds.has(sessionId)) continue
        const built = build(sessionId)
        builds.set(sessionId, built)
        started.push(built.catch((error: unknown) => { recordBackgroundFailure(log, "lead row build", { sessionId }, error) }))
      }
      await Promise.all(started)
    },
    async observe(events) {
      const batches = new Map<Member, StoredFact[]>()
      const questions = new Set<Member>()
      for (const event of events) {
        const folded = byConversation.get(event.aggregateId)
        if (folded) {
          const batch = batches.get(folded) ?? []
          batch.push(event)
          batches.set(folded, batch)
          continue
        }
        if (!event.aggregateId.startsWith("session:")) continue
        const sessionId = event.aggregateId.slice("session:".length)
        if (!builds.has(sessionId)) continue
        if (event.type === "session.deleted") remove(sessionId)
        else if (QUESTION_FACT_TYPES.has(event.type)) {
          const member = members.get(sessionId)
          if (member) questions.add(member)
        }
      }
      await Promise.all([...new Set([...batches.keys(), ...questions])].map(async (member) => {
        try {
          const batch = batches.get(member)
          if (batch) await member.fold.apply(batch)
          if (questions.has(member)) member.question = await pendingQuestion(deps.reader, member.sessionId)
        } catch (error) {
          recordBackgroundFailure(log, "lead row update", { sessionId: member.sessionId }, error)
          return
        }
        if (!disposed && members.get(member.sessionId) === member) compute(member)
      }))
    },
    refresh(sessionId) {
      const member = members.get(sessionId)
      if (member && !disposed) compute(member)
    },
    rows: () => [...members.values()].flatMap((member) => member.row ? [member.row] : []),
    async chat(sessionId) {
      const member = await builds.get(sessionId)?.catch(() => undefined)
      if (!member || members.get(sessionId) !== member) return undefined
      const fold = member.fold.getState()
      const { question } = member
      return {
        row: member.row,
        working: liveState(sessionId, fold) === "working",
        turnEnd: fold.turnEnd?.reading,
        request: fold.request?.text ?? null,
        final: fold.final?.text ?? null,
        question: question && { toolUseId: question.toolUseId, context: fold.contexts[question.toolUseId] ?? null, questions: question.request },
      }
    },
    async dispose() {
      disposed = true
      unsubscribeStore()
      const running = [...builds.values()]
      builds.clear()
      for (const member of pinned.values()) for (const release of member.release) release()
      pinned.clear()
      byConversation.clear()
      members.clear()
      await Promise.allSettled(running)
    },
  }
}
