import type { PositionedEventProjection } from "../../../infra/event-projection.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import type { QuestionEntry } from "../../../infra/output-blocks.js"
import { recordBackgroundFailure } from "../../../infra/operation-log.js"
import { pinHeldProjection } from "../../../infra/projection-registry.js"
import { isActiveActivity } from "../../../protocol/app-service-types.js"
import { resolveToolRowPresentation } from "../../../infra/tools/tool-display-registry.js"
import type { LeadRow, LeadRowState, LeadSeenState } from "../../../protocol/modules/lead.js"
import { AGENT_INPUT_FACT_TYPES } from "../../session/agent-input-facts.js"
import { loadAgentInputProjection, type AgentInputEntry } from "../../session/agent-input-projection.js"
import { isPlannedCut, isVisibleTurnEnd, type ChatTurnEnd } from "../../session/conversation/turn-end-record.js"
import { awaitsPlannedContinuation, onPlannedContinuationRetired } from "../../session/planned-session-continuation.js"
import type { ModuleProcessServices } from "../../app-service/module-service-host.js"
import type { SessionManager } from "../../session/manager.js"
import { entryActivity } from "../../session-store/activity.js"
import type { SessionStore } from "../../session-store/types.js"
import { firstLine, leadRowFold, type RowFold } from "./row.js"

const log = Log.create({ service: "lead-rows" })

const STATUS_CHARS = 240
const QUESTION_FACT_TYPES: ReadonlySet<string> = new Set(AGENT_INPUT_FACT_TYPES)
const NEEDS_PERSON: ReadonlySet<LeadRowState> = new Set(["question", "failed", "cut"])

/** One listed chat as the lead reads it: its row and what the row derives from. */
export interface LeadChatReading {
  readonly row: LeadRow | undefined
  /** Whether the chat works: the live store shows an active turn or a wait on background work, or a runner starts for its open turn. */
  readonly working: boolean
  readonly turnEnd: ChatTurnEnd | undefined
  readonly question: LeadPendingQuestion | undefined
}

/** A listed chat's pending question: its call, the leading context of that call, the form, and when it opened. */
interface LeadPendingQuestion {
  readonly toolUseId: string
  readonly context: string | null
  readonly questions: readonly QuestionEntry[]
  readonly openedAt: number
}

/** A chat's state: a row's state, or `done` for a chat at rest with nothing for the person, which shows no row. */
type ChatState = LeadRowState | "done"

/** A chat's state, the time its evidence names, and for a failure or a cut the entry that the person sees it at. */
interface RowState {
  readonly state: ChatState
  readonly at: number | undefined
  readonly ended?: string
}

export type LeadRowChange = { readonly kind: "updated"; readonly row: LeadRow } | { readonly kind: "removed"; readonly sessionId: string }

interface LeadRowsDeps {
  /** The project's reader, which also keys the retirements of continuation rows. */
  readonly reader: AsyncEventStateReadSurface
  readonly sessionManager: Pick<SessionManager, "read">
  readonly sessionStore: Pick<SessionStore, "get" | "onChange">
  readonly sessionRuntime: ReturnType<ModuleProcessServices["executionEnvironment"]>["sessionRuntime"]
  /** The entry of the newest result that the person read in the chat. */
  readonly readMark: (sessionId: string) => string | undefined
  /** The newest failed or cut state that the person saw in the chat, at its entry. */
  readonly seenMark: (sessionId: string) => { readonly state: LeadSeenState; readonly entryId: string } | undefined
  readonly publish: (change: LeadRowChange) => void
  /** A followed chat came to rest with nothing for the person, once its fold is built or after it showed a row. It
   *  shows no row until it works or needs the person again. */
  readonly onRest: (sessionId: string) => void
  readonly now?: () => number
}

/** The rows of the chats in the lead's list (PI-LEAD-004): one held fold of each chat's conversation, its pending
 *  question, and its live activity. A followed chat that exists has a row while it works or needs the person. Each
 *  change touches only the chats that it names, and a row publishes only when it differs. */
export interface LeadRows {
  /** Starts following these chats. A chat that is not a chat, or no longer exists, gets no row. */
  add(sessionIds: Iterable<string>): Promise<void>
  /** Stops following a chat and removes its row. */
  remove(sessionId: string): void
  /** Advances the chats that a committed batch of the store's broadcast names. */
  observe(events: readonly StoredFact[]): Promise<void>
  /** Reads a chat's row again, as after a change of its read mark. */
  refresh(sessionId: string): void
  rows(): readonly LeadRow[]
  /** The unread result of a chat whose row holds one: the entry of its final message and that message's full text,
   *  as the fold holds them now. A caller that acts on the result later keeps this pair, because a later batch can
   *  bring a newer final message. */
  result(sessionId: string): { readonly entryId: string; readonly text: string } | undefined
  /** Every pending question of a chat whose fold is built, oldest first, as the fold holds them now. A chat can wait
   *  on several calls at once. */
  questions(sessionId: string): readonly LeadPendingQuestion[]
  /** A followed chat that exists, once its fold is built; undefined for any other chat. */
  chat(sessionId: string): Promise<LeadChatReading | undefined>
  /** Whether a followed chat's fold is built and the chat is at rest with nothing for the person after its first
   *  entry. A chat that holds no entry yet, such as a new chat before its first message, waits for it. */
  resting(sessionId: string): boolean
  /** Any chat that exists, read once from its start when this owner does not follow it, as for a chat that left the
   *  list. Publishes nothing. */
  read(sessionId: string): Promise<LeadChatReading | undefined>
  /** Releases every fold and listener, and settles the builds that run. Publishes nothing. */
  dispose(): Promise<void>
}

interface Member {
  readonly sessionId: string
  readonly conversation: string
  /** The chat's directory, against which a tool call's paths read as its transcript shows them. */
  readonly cwd: string
  readonly fold: PositionedEventProjection<RowFold>
  readonly release: readonly (() => void)[]
  /** The chat's pending questions, oldest first. */
  questions: readonly PendingEntry[]
  /** Whether a successor owes the continuation of the chat's planned cut, read when the turn end changes and when
   *  a continuation row retires. */
  owed: boolean
  /** The chat's state and the time the chat entered it. */
  entered: { readonly state: ChatState; readonly at: number } | undefined
  row: LeadRow | undefined
}

type PendingEntry = Extract<AgentInputEntry, { kind: "pending" }>

async function pendingQuestions(reader: AsyncEventStateReadSurface, sessionId: string): Promise<readonly PendingEntry[]> {
  const pending = [...(await loadAgentInputProjection(reader, sessionId)).values()].filter((entry): entry is PendingEntry => entry.kind === "pending")
  return pending.toSorted((left, right) => left.openedAt - right.openedAt)
}

/** The record of the planned cut that ends a fold's newest turn, or undefined for any other turn end. A message that
 *  the cut turn's continuation adds keeps the record, so it reads no continuation row again. */
const plannedCutOf = (fold: RowFold): string | null | undefined => isPlannedCut(fold.turnEnd?.reading.end) ? fold.turnEnd?.recordId ?? null : undefined

/** The question that the row and the lead's reading show: the newest that waits. */
const newestQuestion = (member: Pick<Member, "questions">): PendingEntry | undefined => member.questions.at(-1)

function pendingOf(fold: RowFold, question: PendingEntry): LeadPendingQuestion {
  return { toolUseId: question.toolUseId, context: fold.contexts[question.toolUseId] ?? null, questions: question.request, openedAt: question.openedAt }
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
    // A runner that parks on a question announces it in the store before the question's fact folds here, so it works
    // until the question shows: a row that left in between would let go of the chat's open hold (PI-LEAD-003).
    if (entry.waitingOnBackgroundWork || entry.runnerState === "awaiting_user" || isActiveActivity(entryActivity(entry))) return "working"
    const open = fold.turnEnd?.reading.end.reason === "crash" && !fold.turnEnd.reading.recorded
    return open && (entry.runner === null || runtime?.kind === "starting") ? "working" : undefined
  }

  /** The state of a chat by the order of section 2.5 of the lead design. A chat at rest with nothing for the person,
   *  such as a read result or a failure or a cut that the person saw at the same entry, is done since its newest
   *  output. */
  function stateOf(member: Pick<Member, "sessionId" | "questions" | "owed">, fold: RowFold, live: "failed" | "working" | undefined): RowState {
    const question = newestQuestion(member)
    if (question) return { state: "question", at: question.openedAt }
    if (live === "working") return { state: "working", at: undefined }
    const end = fold.turnEnd
    const newest = fold.tail.at(-1)?.id
    const latest = Math.max(fold.latest?.at ?? 0, fold.final?.at ?? 0, end?.at ?? 0)
    const done: RowState = { state: "done", at: latest > 0 ? latest : undefined }
    const ended = (state: LeadSeenState, at: number | undefined, entryId: string | undefined): RowState => {
      const seen = deps.seenMark(member.sessionId)
      if (seen && seen.state === state && seen.entryId === entryId) return done
      return { state, at, ...(entryId === undefined ? {} : { ended: entryId }) }
    }
    if (live === "failed") return ended("failed", undefined, newest)
    if (end?.reading.end.reason === "paused" && isVisibleTurnEnd(end.reading.end)) return ended("cut", end.at, end.recordId ?? newest)
    if (end?.reading.end.reason === "crash") return ended("failed", end.at, end.recordId ?? newest)
    // A planned stop's successor continues the cut turn, so its newest message is no result until the turn answers.
    // A continuation that no successor owes any more, such as one whose resume failed, leaves the turn cut, and the
    // person resumes it as after any interrupt.
    if (isPlannedCut(end?.reading.end)) {
      if (member.owed || deps.sessionRuntime(member.sessionId)?.kind === "starting") return { state: "working", at: undefined }
      return ended("cut", end?.at, end?.recordId ?? newest)
    }
    if (fold.final && fold.final.entryId !== deps.readMark(member.sessionId)) return { state: "result", at: fold.final.at }
    return done
  }

  /** Whether a successor owes the continuation of the planned cut that ends the fold's newest turn. Any other turn
   *  end owes none, so only a planned cut reads the continuation row. */
  const readOwed = async (sessionId: string, fold: RowFold): Promise<boolean> =>
    isPlannedCut(fold.turnEnd?.reading.end) && await awaitsPlannedContinuation({ reader: deps.reader, projectionReader: deps.reader, manager: deps.sessionManager }, sessionId)

  /** The chat's state as its row and the lead's reading of it decide it. */
  const stateNow = (member: Pick<Member, "sessionId" | "questions" | "owed">, fold: RowFold): RowState => stateOf(member, fold, liveState(member.sessionId, fold))

  /** The row's one line, which the runtime derives from the chat's own output and no model writes. */
  function statusOf(member: Member, fold: RowFold, state: LeadRowState): string {
    switch (state) {
      case "failed": return "failed"
      case "cut": return "interrupted"
      case "question": return firstLine(newestQuestion(member)?.request[0]?.question ?? "")
      case "result": return firstLine(fold.final?.text ?? "")
      case "working": {
        const latest = fold.latest
        if (latest?.kind === "text") return latest.text
        if (latest === null) return "working"
        const { sentence } = resolveToolRowPresentation(latest.name, latest.input, member.cwd)
        return `${sentence.name} ${sentence.detail}`.trim()
      }
    }
  }

  function rowOf(member: Member, fold: RowFold, { state, ended }: RowState & { readonly state: LeadRowState }, entered: number): LeadRow {
    return {
      sessionId: member.sessionId,
      state,
      status: statusOf(member, fold, state).slice(0, STATUS_CHARS),
      // A working chat's age counts from its newest output, so its line and its age change together.
      since: state === "working" ? Math.max(entered, fold.latest?.at ?? 0) : entered,
      ...(NEEDS_PERSON.has(state) ? { waitingSince: entered } : {}),
      ...(state === "result" && fold.final ? { result: { entryId: fold.final.entryId } } : {}),
      ...(ended !== undefined ? { ended: { entryId: ended } } : {}),
    }
  }

  /** Derives the member's row from its fold, its question, and the live store, and publishes it when it changed. A
   *  chat that comes to rest with nothing for the person loses its row and tells `onRest` once. */
  function compute(member: Member): void {
    const fold = member.fold.getState()
    const next = stateNow(member, fold)
    const before = member.entered
    const entered = before?.state === next.state ? before : { state: next.state, at: next.at ?? now() }
    member.entered = entered
    if (next.state === "done") {
      const shown = member.row !== undefined
      member.row = undefined
      if (shown) deps.publish({ kind: "removed", sessionId: member.sessionId })
      if (before?.state !== "done") deps.onRest(member.sessionId)
      return
    }
    const row = rowOf(member, fold, { ...next, state: next.state }, entered.at)
    if (member.row && Bun.deepEquals(member.row, row, true)) return
    member.row = row
    deps.publish({ kind: "updated", row })
  }

  async function build(sessionId: string): Promise<Member | undefined> {
    const session = await deps.sessionManager.read(sessionId)
    if (session?.kind !== "chat" || disposed || !builds.has(sessionId)) return undefined
    // Pinned while the chat is in the list, so the registry's bound for a family never folds one from its start again.
    const release = [
      pinHeldProjection(deps.reader, `lead-row:${sessionId}`, { dropOnLastRelease: true }),
      pinHeldProjection(deps.reader, `agent-input:${sessionId}`),
    ]
    const member: Member = {
      // The type admits a row written before sessions recorded a directory; such a row shows its paths whole.
      sessionId, conversation: `conversation:${session.conversationId}`, cwd: session.executionCwd ?? "", release,
      fold: leadRowFold(deps.reader, sessionId, session.conversationId), questions: [], owed: false, entered: undefined, row: undefined,
    }
    pinned.set(sessionId, member)
    byConversation.set(member.conversation, member)
    try {
      member.owed = await readOwed(sessionId, await member.fold.replay())
      member.questions = await pendingQuestions(deps.reader, sessionId)
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

  async function chat(sessionId: string): Promise<LeadChatReading | undefined> {
    const member = await builds.get(sessionId)?.catch(() => undefined)
    if (!member || members.get(sessionId) !== member) return undefined
    const fold = member.fold.getState()
    const question = newestQuestion(member)
    return { row: member.row, working: stateNow(member, fold).state === "working", turnEnd: fold.turnEnd?.reading, question: question && pendingOf(fold, question) }
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
  // A retired row writes no fact, so a chat whose planned cut it owed reads its turn end again here.
  const unsubscribeRetired = onPlannedContinuationRetired(deps.reader, (sessionId) => {
    const member = members.get(sessionId)
    if (!member || disposed) return
    void readOwed(sessionId, member.fold.getState()).then((owed) => {
      member.owed = owed
      if (!disposed && members.get(sessionId) === member) compute(member)
    }, (error: unknown) => { recordBackgroundFailure(log, "lead row continuation read", { sessionId }, error) })
  })

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
    remove,
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
          if (batch) {
            const before = plannedCutOf(member.fold.getState())
            const fold = await member.fold.apply(batch)
            if (plannedCutOf(fold) !== before) member.owed = await readOwed(member.sessionId, fold)
          }
          if (questions.has(member)) member.questions = await pendingQuestions(deps.reader, member.sessionId)
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
    result(sessionId) {
      const member = members.get(sessionId)
      const final = member?.row?.state === "result" ? member.fold.getState().final : null
      return final && final.entryId === member?.row?.result?.entryId ? { entryId: final.entryId, text: final.text } : undefined
    },
    questions(sessionId) {
      const member = members.get(sessionId)
      return member ? member.questions.map((question) => pendingOf(member.fold.getState(), question)) : []
    },
    chat,
    resting(sessionId) {
      const member = members.get(sessionId)
      return member?.entered?.state === "done" && member.fold.getState().tail.length > 0
    },
    async read(sessionId) {
      const followed = await chat(sessionId)
      if (followed) return followed
      const session = await deps.sessionManager.read(sessionId)
      if (session?.kind !== "chat") return undefined
      // One explicit read of a chat that the list does not follow, so it folds once from the start.
      const fold = await leadRowFold(deps.reader, sessionId, session.conversationId).replay()
      const questions = await pendingQuestions(deps.reader, sessionId)
      const question = newestQuestion({ questions })
      const owed = await readOwed(sessionId, fold)
      return { row: undefined, working: stateNow({ sessionId, questions, owed }, fold).state === "working", turnEnd: fold.turnEnd?.reading, question: question && pendingOf(fold, question) }
    },
    async dispose() {
      disposed = true
      unsubscribeStore()
      unsubscribeRetired()
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
