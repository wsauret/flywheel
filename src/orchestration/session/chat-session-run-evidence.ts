import { CorruptEventRowError, StateRequestNotServedError, type AsyncEventStateReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { parseProjectionFact } from "../../infra/event-projection.js"
import type { ChatSessionAction, StoppedBy, WorkflowSessionAction } from "../../protocol/app-service-types.js"
import type { WorkflowView } from "../../workflows/view/types.js"
import { loadQueueSnapshotFromReader } from "../../workflows/view/view-store.js"
import { parseConversationTreeFact, type ConversationTreeFact } from "./conversation/conversation-facts.js"
import { chatTurnEndEvidenceOf, isPlannedCut, isProducedInput, isResumableTurnEnd, isSettledRecord, pendingTurnEndEntry, turnEndOfEntry, waitsAtRuntimeInterrupt, waitsForPerson, type ChatTurnEnd, type TurnEnd, type TurnEndEntry } from "./conversation/turn-end-record.js"
import { isWorkflowResumeCandidate } from "./resumable.js"
import { startedAgents, type StartedAgent } from "../../workflows/vm/host-commit-controller.js"
import { holdsInterruptedGuess, readToolExecution } from "./tool-execution-projection.js"
import type { SessionLifecycleState } from "./types.js"
import { readReplyWaits } from "./conversation/reply-wait-cells.js"
import type { RestoredAgentWait } from "../agent-runtime/agent-loop-types.js"

/** The newest entry batches of a conversation, oldest first, or nothing when
 *  this release cannot read them: a corrupt row or a batch that fails its
 *  parse. One unreadable batch makes the whole tail unreadable, because the
 *  turn end can be in it and an older batch would then answer wrongly. A
 *  read the state Worker refuses or cannot serve is not unreadable history:
 *  it rejects with a `StateRequestNotServedError`, so that no caller decides
 *  from a turn end it never read.
 *
 *  The read pages backward one batch at a time, from the newest batch, and
 *  stops at the first tail that `decides` what its reader answers (the turn
 *  end, by default) or at the start of the conversation. Most turns end in their newest batch. The batches after the
 *  turn end hold only entries that decide nothing, such as labels a rename
 *  appended, notices a review committed, settled records a direct launch
 *  committed, or messages that other sessions sent to an interrupted chat,
 *  each in its own batch. No count of such batches bounds the read, because a
 *  read that stops before the turn end answers other than the whole-branch
 *  read (`chatTurnEndOf`). Each read holds one batch, so a large batch, such
 *  as a message with images, never shares a slice with another batch, and the
 *  tail stays inside the state Worker's response budget whatever the batches
 *  around it hold. */
async function readConversationTail(reader: AsyncEventStateReadSurface, conversationId: string, decides: (tail: readonly TurnEndEntry[]) => boolean = tailDecision(), wholeTail = false): Promise<{ readonly entries: readonly (TurnEndEntry & { readonly timestamp: string })[]; readonly sessionId: string } | undefined> {
  const entries: (TurnEndEntry & { readonly timestamp: string })[] = []
  let beforePosition: number | undefined
  let sessionId = ""
  for (;;) {
    const slice = await reader.readSlice({
      aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"], order: "desc", limit: 1,
      ...(beforePosition === undefined ? {} : { beforePosition }),
    }, true)
    const batch = slice.facts[0]
    if (batch === undefined) return { entries, sessionId }
    if (batch instanceof Error) return undefined
    const fact = parseTailBatch(batch)
    if (fact === undefined) return undefined
    sessionId = batch.sessionId
    if (fact.type === "chat.entries.appended") entries.unshift(...fact.payload.entries)
    if (fact.type === "chat.entries.appended" && decides(wholeTail ? entries : fact.payload.entries)) return { entries, sessionId }
    beforePosition = batch.position
  }
}

/** Whether no older entry can change what the tail readers answer: newest
 *  first, the tail reaches an entry at which `chatTurnEndOf`,
 *  `questionExchangeOf`, and `waitsAtRuntimeInterrupt` all stop. Labels,
 *  notices, settled records, produced input, and tool results let those
 *  walks go on to older entries, so they decide nothing alone. A record that
 *  the runtime or an unexpected exit wrote decides only with the last model
 *  step before it, which says whether the turn waited on background work.
 *  Detail reads stop at a second record. Only a one-shot restoration reads
 *  through repeated runtime cuts to the original waiting batch. */
function tailDecision(restore = false): (tail: readonly TurnEndEntry[]) => boolean {
  let records = 0
  return (tail) => {
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const entry = tail[index]
      if (!entry || entry.kind === "label" || entry.kind === "session_info" || entry.displayOnly === true || isSettledRecord(entry)) continue
      const message = entry.message
      if (entry.kind !== "message" || !message) return true
      const end = turnEndOfEntry(entry)
      if (end !== undefined) {
        records += 1
        if (!restore && records > 1) return true
        if (!isResumableTurnEnd(end) || (end.reason === "paused" && end.pausedBy !== "runtime")) return true
        continue
      }
      if (message.kind === "toolResult" || isProducedInput(message)) continue
      return true
    }
    return false
  }
}

/** One tail batch, or nothing when this release cannot parse it. */
function parseTailBatch(batch: StoredFact): ConversationTreeFact | undefined {
  try {
    return parseProjectionFact(batch, parseConversationTreeFact)
  } catch {
    return undefined
  }
}

/** The turn-end evidence of a chat, read from the newest entry batches of
 *  its conversation instead of a replay of the whole tree: the one source
 *  the row builder, the resume admission, and the replacement blockers
 *  read (PI-INTERACTION-043). A conversation this release cannot read
 *  proves nothing, so it admits no Resume. */
export async function readChatTurnEnd(reader: AsyncEventStateReadSurface, conversationId: string): Promise<ChatTurnEnd | undefined> {
  return (await readChatTurnEndEvidence(reader, conversationId))?.turnEnd
}

/** Reads the turn end and its original timestamp. `restoreWait` is for a
 * one-shot attach or Resume: it finds the wait anchor through all runtime cuts.
 * Live detail readers omit it and stop at the second record.
 *
 * Only a runtime or crash end of a batch whose calls the wait policy cannot
 * classify from the tail alone asks which reply waits are open. The tail
 * decides whether it asks, so the waiter's open waits are read only then,
 * and `waitsOf` names the waiter whose waits decided the evidence: a change
 * of those waits can change it, and a change of any other waits cannot. */
export async function readChatTurnEndEvidence(reader: AsyncEventStateReadSurface, conversationId: string, options?: { readonly restoreWait: true }): Promise<(NonNullable<ReturnType<typeof chatTurnEndEvidenceOf>> & { readonly waitsOf?: string }) | undefined> {
  const tail = await readConversationTail(reader, conversationId, tailDecision(options?.restoreWait))
  if (tail === undefined) return undefined
  let asksWaits = false
  const evidence = chatTurnEndEvidenceOf(tail.entries, () => { asksWaits = true; return false })
  if (!asksWaits || evidence === undefined) return evidence
  const waits = new Set((await readReplyWaits(reader, tail.sessionId)).map((wait) => wait.toolUseId))
  const decided = chatTurnEndEvidenceOf(tail.entries, (id) => waits.has(id))
  return decided && { ...decided, waitsOf: tail.sessionId }
}

/** The restored wait of a workflow agent or a subagent. Each restores its
 *  wait only under a Resume or a continuation, and that authority admits a
 *  request, so the original deadline and the nothing-pending notice apply
 *  whatever cut the wait. Only a chat's attach parks only
 *  (`RestoredAgentWait.parkOnly`). */
export async function readAuthorizedRestoredWait(reader: AsyncEventStateReadSurface, conversationId: string): Promise<RestoredAgentWait | undefined> {
  const wait = (await readChatTurnEndEvidence(reader, conversationId, { restoreWait: true }))?.restoredWait
  return wait && { deadlineMs: wait.deadlineMs, ...(wait.wakePending ? { wakePending: true as const } : {}) }
}

/** The turn end that the newest record of a conversation names while no
 *  model step followed it, or nothing (`pendingTurnEndEntry`). A child's
 *  record names who interrupted it even while a person's message queued
 *  behind the interrupt waits, which hides it from `readChatTurnEnd`. A
 *  conversation this release cannot read names nobody. */
export async function readPendingTurnEnd(reader: AsyncEventStateReadSurface, conversationId: string): Promise<TurnEnd | undefined> {
  const tail = await readConversationTail(reader, conversationId, (entries) => pendingTurnEndEntry(entries) !== undefined, true)
  const entry = tail === undefined ? undefined : pendingTurnEndEntry(tail.entries)
  return entry === undefined ? undefined : turnEndOfEntry(entry)
}

/** The conversations whose newest batches one tail read takes together, and
 *  the batches it takes of each: a paused child's newest batch holds its
 *  turn end or the messages held behind it. The rows stay under the state
 *  Worker's row bound for one slice and SQLite's bound on one compound
 *  select. */
const SHARED_TAIL_CONVERSATIONS = 64
const SHARED_TAIL_BATCHES = 2

/** The pending turn end of each conversation, as `readPendingTurnEnd` reads
 *  it, with one read of the newest batches of each of them, whatever history
 *  each holds. A conversation that those batches do not decide is read
 *  alone, from its newest batch. So is every conversation of a shared read
 *  that the state Worker does not serve, such as one past its response
 *  budget: the batches of several conversations can be larger together than
 *  any one of them. */
export async function readPendingTurnEnds(reader: AsyncEventStateReadSurface, conversationIds: readonly string[]): Promise<ReadonlyMap<string, TurnEnd | undefined>> {
  const ids = [...new Set(conversationIds)]
  const ends = new Map<string, TurnEnd | undefined>()
  const alone: string[] = []
  for (let start = 0; start < ids.length; start += SHARED_TAIL_CONVERSATIONS) {
    const chunk = ids.slice(start, start + SHARED_TAIL_CONVERSATIONS)
    let facts: readonly (StoredFact | CorruptEventRowError)[]
    try {
      facts = (await reader.readSlice({
        aggregateIds: chunk.map((id) => `conversation:${id}`), types: ["chat.entries.appended"], order: "desc",
        limitPerAggregate: SHARED_TAIL_BATCHES, limit: chunk.length * SHARED_TAIL_BATCHES,
      }, true)).facts
    } catch (error) {
      if (!(error instanceof StateRequestNotServedError)) throw error
      alone.push(...chunk)
      continue
    }
    const batches = Map.groupBy(facts, (fact) => fact instanceof CorruptEventRowError ? fact.row.aggregateId : fact.aggregateId)
    for (const id of chunk) {
      const newest = batches.get(`conversation:${id}`) ?? []
      const tail = pendingTurnEndOfBatches(newest, newest.length < SHARED_TAIL_BATCHES)
      if (tail.decided) ends.set(id, tail.end)
      else alone.push(id)
    }
  }
  for (const [conversationId, end] of await Promise.all(alone.map(async (id) => [id, await readPendingTurnEnd(reader, id)] as const))) ends.set(conversationId, end)
  return ends
}

/** The pending turn end that a conversation's newest batches, newest first,
 *  decide, as `readConversationTail` walks them. `complete` states that the
 *  batches reach the conversation's start. */
function pendingTurnEndOfBatches(newestFirst: readonly (StoredFact | CorruptEventRowError)[], complete: boolean): { readonly decided: true; readonly end: TurnEnd | undefined } | { readonly decided: false } {
  const entries: TurnEndEntry[] = []
  for (const batch of newestFirst) {
    if (batch instanceof CorruptEventRowError) return { decided: true, end: undefined }
    const fact = parseTailBatch(batch)
    if (fact === undefined) return { decided: true, end: undefined }
    if (fact.type !== "chat.entries.appended") continue
    entries.unshift(...fact.payload.entries)
    const entry = pendingTurnEndEntry(entries)
    if (entry !== undefined) return { decided: true, end: turnEndOfEntry(entry) }
  }
  return complete ? { decided: true, end: undefined } : { decided: false }
}

/** Whether a conversation still waits where the runtime interrupted it,
 *  with no Resume since (`waitsAtRuntimeInterrupt`), read from the same
 *  tail. A conversation this release cannot read waits for nothing. */
export async function readWaitsAtRuntimeInterrupt(reader: AsyncEventStateReadSurface, conversationId: string): Promise<boolean> {
  const tail = await readConversationTail(reader, conversationId)
  return tail !== undefined && waitsAtRuntimeInterrupt(tail.entries)
}

/** An unfinished started attempt's decisive tail evidence. The timestamp is
 *  the original recorded turn end, never the time this evidence was read. */
export interface WorkflowAgentTurnEnd extends StartedAgent {
  readonly turnEnd: ChatTurnEnd | undefined
  readonly timestamp?: number
}

/** Every unfinished started attempt of a workflow, including pending attempts
 *  after an abort, read only from the queue facts of `workflow:<sessionId>`
 *  through the held queue projection, which folds only the facts after its
 *  last read: every agent's start commits to this aggregate. */
export async function readStartedWorkflowAgents(reader: AsyncEventStateReadSurface, sessionId: string): Promise<readonly StartedAgent[]> {
  return startedAgents(await loadQueueSnapshotFromReader(reader, sessionId))
}

/** Reads every unfinished started attempt with its tail evidence. Unreadable
 *  tails carry no turn end and authorize no continuation. */
export async function readWorkflowAgentTurnEnds(reader: AsyncEventStateReadSurface, sessionId: string): Promise<readonly WorkflowAgentTurnEnd[]> {
  return await Promise.all((await readStartedWorkflowAgents(reader, sessionId)).map(async (agent) => workflowAgentTurnEnd(agent, await readChatTurnEndEvidence(reader, agent.conversationId))))
}

/** A started agent with the turn-end evidence that its conversation's tail holds. */
export function workflowAgentTurnEnd(agent: StartedAgent, evidence: Awaited<ReturnType<typeof readChatTurnEndEvidence>>): WorkflowAgentTurnEnd {
  return { ...agent, turnEnd: evidence?.turnEnd, ...(evidence?.timestamp === undefined ? {} : { timestamp: evidence.timestamp }) }
}

/** A started attempt whose end admits explicit Resume, if any. */
export function resumableAgentTurnEnd(agents: readonly WorkflowAgentTurnEnd[]): ChatTurnEnd | undefined {
  return agents.find(({ turnEnd }) => waitsForPerson(turnEnd))?.turnEnd
    ?? agents.find(({ turnEnd }) => isResumableTurnEnd(turnEnd?.end))?.turnEnd
}

/** The parent's call that launched a workflow, as its Stop reads it. An
 *  empty value is a call that still waits and a Stop can end. Crash
 *  recovery's `interrupted` guess is not a result, as reconciliation reads
 *  it, so a call that holds only the guess still waits. `stoppedBy`
 *  names who stopped it when a Stop is that result: `stopped` is a
 *  person's, `cancelled` the requesting agent's. `settled` is a call that
 *  holds another result, such as a start failure, or that the parent never
 *  recorded. A live tracked run can correct an earlier result with its Stop. */
export interface ChildCall {
  readonly stoppedBy?: StoppedBy
  readonly settled?: true
}

/** Reads the parent's launching call of a workflow, or nothing for a child
 *  no call launched. */
export async function readChildCall(reader: AsyncEventStateReadSurface, launchedFrom: { readonly parentSessionId: string; readonly toolUseId?: string } | undefined): Promise<ChildCall | undefined> {
  if (launchedFrom?.toolUseId === undefined) return undefined
  const tool = await readToolExecution(reader, launchedFrom.parentSessionId, launchedFrom.toolUseId)
  if (tool?.resultOutcome === "stopped") return { stoppedBy: "person" }
  if (tool?.resultOutcome === "cancelled") return { stoppedBy: "agent" }
  return tool !== undefined && (tool.resultEventId === undefined || holdsInterruptedGuess(tool)) ? {} : { settled: true }
}

/** Who ended a child's run for its parent with Stop.
 *  Absent for a child no Stop ended and for one no tool call waits on. A
 *  stopped child is terminal for its parent, whatever its own control says,
 *  so every reader that admits an Interrupt or a Resume reads this first. */
export async function readChildStop(reader: AsyncEventStateReadSurface, launchedFrom: { readonly parentSessionId: string; readonly toolUseId?: string } | undefined): Promise<StoppedBy | undefined> {
  return (await readChildCall(reader, launchedFrom))?.stoppedBy
}

/** Why a Stop left a workflow uninteractable, or nothing: a stopped child
 *  never resumes and takes no message, whatever its own control says. */
export async function workflowStopRefusal(reader: AsyncEventStateReadSurface, launchedFrom: { readonly parentSessionId: string; readonly toolUseId?: string } | undefined): Promise<string | undefined> {
  const stoppedBy = await readChildStop(reader, launchedFrom)
  return workflowInteractionRefusal(undefined, stoppedBy)
}

/** Terminal control or a parent Stop forbids both a message and Resume.
 * Unknown control remains eligible for explicit-message recovery, never implicit execution. */
export function workflowInteractionRefusal(status: string | undefined, stoppedBy?: StoppedBy): string | undefined {
  if (stoppedBy !== undefined) return stoppedBy === "person" ? "This workflow was stopped, so it cannot resume" : "This workflow was canceled, so it cannot resume"
  return status === "completed" || status === "failed"
    ? "This workflow has finished and is read-only. Continue in its parent chat."
    : undefined
}

/** Whether a turn end admits Resume. A turn that waits for the person (a
 *  recorded interrupt or crash end) admits it; the crash shape (an
 *  unanswered leaf with no record) admits it only once the session is
 *  inactive: while it is active, that same shape is a turn in progress.
 *  A chat's turn that an unexpected exit or an ordinary stop cut while it
 *  waited on background work admits it too: its attach parks the turn on
 *  that work without a request (`RestoredAgentWait.parkOnly`), so Resume is
 *  how the person continues it once none of the work runs. While the work
 *  runs, the live status offers Interrupt in the same slot instead. A
 *  planned cut's successor continues the wait itself, and a workflow agent
 *  restores its wait only under a Resume or a continuation, so neither
 *  admits it on that ground. */
function admitsResume(kind: "chat" | "workflow-agent", lifecycleState: SessionLifecycleState, turnEnd: ChatTurnEnd | undefined): boolean {
  return waitsForPerson(turnEnd)
    || (kind === "chat" && turnEnd?.backgroundWait === true && !isPlannedCut(turnEnd.end))
    || (lifecycleState === "inactive" && isResumableTurnEnd(turnEnd?.end))
}

/** The actions a chat's row admits. An active chat admits Interrupt: whether
 *  a turn is running right now is live status, which a durable row does not
 *  carry and which each client reads beside the row, so an interrupt of an
 *  idle chat is a successful no-op rather than refused here. A chat a
 *  successor owes its continuation admits Interrupt whatever its lifecycle
 *  (`continuationOwed`). Resume follows the turn-end evidence only when no
 *  successor owes continuation. A chat has no terminal stop (PI-INTERACTION-043).
 *  A workflow agent's row (`kind`) takes the same actions, and its Resume
 *  follows the workflow agent's own rule (`admitsResume`). */
export function chatSessionActions(kind: "chat" | "workflow-agent", lifecycleState: SessionLifecycleState, turnEnd?: ChatTurnEnd, continuationOwed = false, retainedInput = false): readonly ChatSessionAction[] {
  const resume = !continuationOwed && (retainedInput || admitsResume(kind, lifecycleState, turnEnd)) ? ["chat.resume" as const] : []
  return lifecycleState === "active" || continuationOwed ? ["chat.interrupt", ...resume, "session.delete"] : [...resume, "session.delete"]
}

/** The parent chat's tool call a workflow answers: `read: false`
 *  for a listed row, which cannot tell whether a Stop ended the call, or the
 *  detail read's answer (`ChildCall`). */
export type WorkflowToolCall = { readonly read: false } | ({ readonly read: true } & ChildCall)

/** The tool-call evidence of one workflow: absent when no tool call launched
 *  it, and unread when the caller read no `call`. */
export function workflowToolCall(toolUseId: string | undefined, call: ChildCall | undefined): WorkflowToolCall | undefined {
  if (toolUseId === undefined) return undefined
  return call === undefined ? { read: false } : { read: true, ...call }
}

/** The durable evidence a workflow's row reads beyond its control state. */
interface WorkflowActionEvidence {
  /** Whether the workflow takes a message: false once it ended or a Stop ended it. */
  readonly message?: boolean
  readonly executable?: boolean
  /** Whether durable state that cannot execute can run again from its
   *  recorded request (`assessWorkflowRecovery`), which a person's Restart
   *  does. */
  readonly restartable?: boolean
  /** A resumable turn end from any unfinished started attempt, from the detail read. */
  readonly stepTurnEnd?: ChatTurnEnd
  /** The parent chat's tool call it answers. */
  readonly toolCall?: WorkflowToolCall
  /** Whether a successor owes the workflow its continuation, from the detail read. */
  readonly continuationOwed?: boolean
  /** Whether a Resume runs the failed agents of a failed run again
   *  (`resumesFailedAgents`), from the detail read. */
  readonly retriesFailedAgents?: boolean
}

/** The actions a workflow's row admits. A workflow a Stop ended admits
 *  nothing but deletion: it is terminal for its parent. In every lifecycle
 *  a workflow admits Stop while its parent's tool call waits on it, because
 *  each child has its own Stop (PI-INTERACTION-043, PI-INTERACTION-044): a
 *  call that holds another result, such as a start failure, has no Stop left
 *  to record, so a Resume of its workflow brings back Interrupt but no Stop.
 *  A running workflow admits Interrupt and Resume while any started agent's
 *  turn end records an interrupt; a listed row cannot tell whether its call
 *  waits, and admits Stop while it runs. An inactive one admits Resume while
 *  its committed control is not terminal: paused by the runtime, or left
 *  running by an unexpected exit; a listed one with an unread launching call
 *  admits neither Resume nor Stop, because a listing cannot tell whether a
 *  Stop ended it. An inactive workflow a successor owes its continuation
 *  admits Interrupt whatever else holds (`continuationOwed`). A workflow
 *  whose last Resume met a changed definition still admits Resume, which
 *  checks the definition again. A workflow whose saved progress cannot
 *  execute admits Restart while its recorded request can run again
 *  (`restartable`). A failed run that an agent's failure
 *  ended admits Resume as a paused one does, which runs its failed agents
 *  again, and takes no message (`retriesFailedAgents`); a listed one admits
 *  no Resume until its detail is read. */
export function workflowSessionActions(lifecycleState: SessionLifecycleState, workflowState: WorkflowView["status"] | undefined, evidence: WorkflowActionEvidence = {}): readonly WorkflowSessionAction[] {
  const toolCall = evidence.toolCall
  if (toolCall?.read === true && toolCall.stoppedBy !== undefined) return ["session.delete"]
  const retry = workflowState === "failed" && evidence.retriesFailedAgents === true
  if (!retry && (evidence.message === false || workflowInteractionRefusal(workflowState) !== undefined)) return ["session.delete"]
  const message = evidence.message === true ? ["session.send" as const] : []
  const owed = evidence.continuationOwed === true ? ["workflow.interrupt" as const] : []
  // A Resume after a changed definition checks the definition again, so
  // a person who restored it continues with the same control
  // (PI-AGENT-015).
  const executable = evidence.executable !== false
  const restart = evidence.executable === false && evidence.restartable === true ? ["workflow.restart" as const] : []
  const stop = toolCall !== undefined && (toolCall.read === false || toolCall.settled !== true) ? ["background.terminate" as const] : []
  if (lifecycleState === "active") {
    return [
      ...message,
      "workflow.interrupt",
      ...(executable && admitsResume("workflow-agent", lifecycleState, evidence.stepTurnEnd) ? ["workflow.resume" as const] : []),
      ...stop,
      "session.delete",
    ]
  }
  if (toolCall?.read === false) return ["session.delete"]
  const resumable = executable && (workflowState !== "failed" || retry) && isWorkflowResumeCandidate({ kind: "workflow", lifecycleState, ...(workflowState ? { workflowState } : {}) })
  return [...owed, ...message, ...(resumable ? ["workflow.resume" as const] : []), ...restart, ...stop, "session.delete"]
}
