import type { PausedBy } from "../../../infra/substrate/events/output-blocks.js"
import { toolOutcomeFromProvider } from "../../../infra/substrate/runtime-facts/tool-outcome.js"
import type { ConversationMessage } from "../../../infra/providers/llm/conversation/conversation-message.js"
import { callsShellTool } from "../../module-contract/module-catalog.js"
import { messageDisposition } from "../message-disposition.js"
import { MESSAGE_SESSION_TOOL_NAME } from "./reply-wait-cells.js"
import type { SessionRelation } from "../../../infra/substrate/events/chat-input-schema.js"

/** The duration of a wait and its deadline. */
export interface WaitExpiry {
  readonly seconds: number
  readonly deadlineMs: number
}

// The wait rule: which tool calls park a turn, for how long, and which input
// ends the wait. The live loop (agent-loop-wait.ts) and the restore readers
// below both judge by it, so a restart restores the wait the live loop held.

export const PROCESS_TOOL_NAME = "process"
export const DEFAULT_WAIT_SECONDS = 240
/** Every wait ends after at most one hour, so that the agent reassesses
 *  the work it waits on (PI-AGENT-080). The schema's maximum states it. */
export const WAIT_CEILING_SECONDS = 3600

/** A tool call as the wait rule reads it: a live call or a recorded one. */
interface WaitRuleCall {
  readonly id: string
  readonly name: string
  readonly input: { readonly [field: string]: unknown }
  readonly registrationId?: string
}

/** The duration of a native wait: the four-minute default without an
 *  estimate, the estimate up to the one-hour ceiling, or undefined for an
 *  estimate that is not positive finite seconds. A model's estimate is
 *  external input, so a value above the ceiling is read as the ceiling, not
 *  refused. A restore replays recorded calls through this function, so a
 *  longer wait that an earlier build recorded also restores at the ceiling. */
export function processWaitSeconds(input: WaitRuleCall["input"]): number | undefined {
  if (input.soft_timeout === undefined) return DEFAULT_WAIT_SECONDS
  const seconds = input.soft_timeout
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds, WAIT_CEILING_SECONDS) : undefined
}

// Remove after 2027-10-30: transcripts that builds before 2026-10-30 wrote for
// gpt-6-luna hold `process` calls of this retired registration. Its wait that
// named a process returned after its own bound instead of parking the turn.
const RETIRED_BOUNDED_WAIT_REGISTRATION_ID = "process.luna"

/** Whether a call parks the turn on session work. A native wait always parks
 *  on every process and ignores a `process_id`. A recorded call of the retired
 *  bounded-wait registration that names a process did not park. A call with no
 *  registration reads as native: it comes from a build that stamped no
 *  registration, in which every `process` wait parked. */
function isParkingWaitCall(call: WaitRuleCall): boolean {
  if (call.name !== PROCESS_TOOL_NAME || call.input.action !== "wait") return false
  if (call.registrationId === RETIRED_BOUNDED_WAIT_REGISTRATION_ID && call.input.process_id !== undefined) return false
  return processWaitSeconds(call.input) !== undefined
}

// A yield-placeholder is a bash call whose only purpose is to park the turn
// (a tool call is the opposite of yielding). It executes like any other
// command - every provider transcript must carry a result for every call, so
// nothing is erased - but a turn whose calls were all wait-shaped parks on
// background work afterwards instead of re-requesting (agent-loop.ts).
// Classification only counts while background work is pending: the completing
// task re-drives the loop, so the park always wakes. With nothing in flight
// there is nothing to wake the loop, so every shape below is an ordinary
// command with no park semantics.
//
// With background work pending, two shapes qualify:
//
//   1. Every statement is a bare no-op (`true`, `:`) or a bare `sleep N`,
//      optionally with a trailing comment. Zero semantic content beyond
//      timing, and with background work pending the timing is pointless.
//      No wait-intent text required.
//   2. The LEADING statement is a no-op (echo/printf, sleep, `true`, `:`)
//      that itself expresses wait/yield intent. This agent narrates in
//      prose, never via echo, so a command that opens with such a no-op
//      while it is waiting on background work is a yield signal even if junk
//      trails it (`echo waiting; yielding`). Only the no-op's own words
//      count: a wait word in a later statement, such as a file name in
//      `sleep 1; cat pending.log`, is not intent, and a leading echo that
//      redirects into a file writes it, so it is no no-op. Over-classifying
//      is bounded: the completing task re-drives the loop.
//
// The wait-intent requirement on shape 2 keeps harmless `echo hello` from
// parking the turn. `isYieldPlaceholderCall` judges the call itself: which
// tool it calls, whether it runs in the background, and whether work is
// pending.
const BARE_NOOP_PATTERN = /^(true|:)\s*(#.*)?$/
const BARE_SLEEP_PATTERN = /^sleep\s+\d+(\.\d+)?[smhd]?\s*(#.*)?$/
const NOOP_COMMAND_PATTERN = /^(echo|printf|sleep|true|:)(\s|$)/
const WAIT_INTENT_PATTERN = /\b(wait|yield|standby|stand by|standing by|idle|holding|pending|in progress|still (?:run|work|process))/i

function isYieldPlaceholderCommand(command: string): boolean {
  const segments = command
    .split(/(?:&&|\|\||[;&|\n])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const [first] = segments
  if (!first) return false
  if (segments.every((seg) => BARE_SLEEP_PATTERN.test(seg) || BARE_NOOP_PATTERN.test(seg))) return true
  return NOOP_COMMAND_PATTERN.test(first) && !first.includes(">") && WAIT_INTENT_PATTERN.test(first)
}

/** Whether a call is a yield placeholder: a bash call, live or recorded
 *  under a retired name, whose command only parks the turn while background
 *  work is pending. A background launch is never a placeholder, whatever its
 *  command: it starts work that the turn then owes (ARCH-TOOLS-031), so the
 *  turn continues and the pending-work reminder applies. */
function isYieldPlaceholderCall(call: WaitRuleCall, hasPendingBackgroundWork: () => boolean): boolean {
  if (!callsShellTool(call.name) || call.input.background === true) return false
  const command = call.input.command
  // The pending-work read is last: it scans the session's background work, so
  // only a call that already has a placeholder's shape pays for it.
  return typeof command === "string" && isYieldPlaceholderCommand(command) && hasPendingBackgroundWork()
}

const WORK_PENDING = (): boolean => true

/** Whether a call waits: a process wait, a yield placeholder while work is
 *  pending, or a call that opened a reply wait that is still open
 *  (`holdsWait`), which parks the turn after its batch until the reply or
 *  another end. */
export function isWaitCall(call: WaitRuleCall, hasPendingBackgroundWork: () => boolean, holdsWait?: (toolUseId: string) => boolean): boolean {
  return isParkingWaitCall(call) || isYieldPlaceholderCall(call, hasPendingBackgroundWork) || holdsWait?.(call.id) === true
}

/** The wait that a batch of wait calls opens while work is pending: the
 *  duration of its first process wait, else the default for a yield
 *  placeholder, else none, and the reply waits that its other calls hold. */
export function openedWaitOf(calls: readonly WaitRuleCall[], holdsWait?: (toolUseId: string) => boolean): OpenedWait {
  const seconds = calls.map((call) => isParkingWaitCall(call) ? processWaitSeconds(call.input) : undefined).find((duration) => duration !== undefined)
    ?? (calls.some((call) => isYieldPlaceholderCall(call, WORK_PENDING)) ? DEFAULT_WAIT_SECONDS : undefined)
  // A process wait or a placeholder is a wait by its own input; asking
  // whether it holds a reply wait would cost a restore a read.
  const replyWaitIds = calls.flatMap((call) => !isParkingWaitCall(call) && !isYieldPlaceholderCall(call, WORK_PENDING) && holdsWait?.(call.id) === true ? [call.id] : [])
  return { ...(seconds === undefined ? {} : { seconds }), replyWaitIds }
}

/** The tag of the notice that a wait's expiry delivers, which ends the wait. */
export const WAIT_EXPIRED_TAG = "wait_expired"

/** Whether a stored message's content is the notice of a wait's expiry. */
function isWaitExpiredNotice(content: unknown): boolean {
  return typeof content === "string" && content.startsWith(`<${WAIT_EXPIRED_TAG}>`)
}

/** One input that an open wait meets: a Resume, or a message in the live
 *  loop's input shape (`origin` `human`, `session`, or `silent-system`) or in
 *  its stored shape (`origin` `human` or `system`; a notification keeps
 *  `replyRequired` where the ids it carried live are gone). */
export type OpenWaitInput =
  | { readonly kind: "resume"; readonly continuesWait: boolean }
  | {
      readonly kind: "message"
      readonly origin?: string
      readonly producer?: { readonly kind: string }
      readonly backgroundNotificationIds?: readonly string[]
      readonly replyRequired?: true
      readonly content?: unknown
    }

/** Whether one input ends the open wait that holds `replyWaitIds`: a
 *  background notification, the notice of the wait's expiry, a person's
 *  message, a Resume that does not continue a planned cut's wait, or, for a
 *  message from another session, the reply that ends a reply wait the open
 *  wait holds (the registry ends that reply wait before the message
 *  commits, so `holdsWait` no longer names it). Every other input, such as a
 *  runtime or module notice, the reply nudge, or an unrelated session's
 *  message, only re-drives the turn. */
export function endsOpenWait(input: OpenWaitInput, replyWaitIds: readonly string[], holdsWait: (toolUseId: string) => boolean): boolean {
  if (input.kind === "resume") return !input.continuesWait
  if ((input.backgroundNotificationIds?.length ?? 0) > 0 || input.replyRequired === true || isWaitExpiredNotice(input.content)) return true
  if (input.producer?.kind === "session") return replyWaitIds.some((id) => !holdsWait(id))
  return input.origin !== "system" && input.origin !== "silent-system"
}

/** What the turn-end readers need of an entry: enough to name the record,
 *  skip a notice, and tell a user message from an answer. A hydrated entry
 *  and a stored one (tool text still referenced) both fit, so the tail read
 *  never hydrates. */
/** The committed wait batch and any input committed before the new loop attached.
 *  `parkOnly` is a property of the restored chain: an unexpected exit or an
 *  ordinary stop cut the wait after its batch, so no continuation authority
 *  covers it, even under a later planned replacement's successor. The loop
 *  then parks the turn on its work with no expiry and never starts a request
 *  itself: the completion of work that runs or that registers later, a
 *  message, or the person's Resume wakes the turn. A chain of planned cuts
 *  alone keeps the original deadline and the nothing-pending notice.
 *  `expiry` is the duration that the wait call asked for and its original
 *  deadline, absent for a reply wait, which has none, and `replyWaitIds`
 *  names the reply waits that the wait holds (`OpenWait`). `requestOwed`
 *  says that input committed after the wait that no request answered, so
 *  the loop runs that request instead of parking first. `woken` says that
 *  such input ended the wait (`endsOpenWait`), so the loop opens no wait. */
export interface RestoredAgentWait {
  readonly expiry?: WaitExpiry
  readonly replyWaitIds: readonly string[]
  readonly requestOwed?: true
  readonly woken?: true
  readonly parkOnly?: true
}

export interface TurnEndEntry {
  readonly kind: string
  readonly id: string
  readonly displayOnly?: boolean
  readonly message?: { readonly kind: string; readonly origin?: string; readonly replyRequired?: true; readonly producer?: { readonly kind: string; readonly sessionId?: string; readonly hop?: number; readonly envelope?: { readonly relation: SessionRelation } }; readonly content?: unknown; readonly interrupted?: boolean; readonly isError?: boolean; readonly toolUseId?: string }
}

/** How a turn ended without an assistant answer, recorded as an entry at the
 *  point it ended so every later turn and every client read the same fact:
 *  - `paused`: an interrupt, by a person (Escape or any surface's control),
 *    by a child's parent agent through its `process` tool, or by the runtime
 *    at a planned stop or a Close chat; Resume continues it. An agent's interrupt decides as
 *    a person's does in every rule but one: the parent may continue it. So
 *    every rule tests for the runtime's interrupt, never for the person's.
 *    The saved name predates the interrupt vocabulary and stays for durable
 *    compatibility.
 *  - `crash`: the process running it exited; Resume continues it.
 *  - `discarded`: history only; an earlier build wrote it when a stop dropped
 *    a turn that waited on a question. No current writer produces it.
 *  - `settled`: the runtime answered the exchange itself, so no model answer
 *    is owed and Resume has nothing to continue. The record is the exchange's
 *    own message, such as a direct workflow launch's acknowledgement or the
 *    notice that the launch could not start, or the messages that open the
 *    fresh context of a reset that no request follows (`contextResetRecordId`).
 *    It closes only that exchange. A
 *    writer commits it when a turn ends or while idle, never inside a turn,
 *    but it can follow the record of an older turn that an interrupt or a
 *    crash ended, and a candidate build committed it inside a turn. So every
 *    reader of how the model's turn ended reads past it (`isSettledRecord`),
 *    and it is the turn end only when nothing older waits. A build before
 *    this reason, such as one a rollback restores, reads the prefix through
 *    `legacyTurnEnd` as a recorded crash. It then shows the unexpected-exit
 *    row in place of the message and admits Resume. The entry stays
 *    unchanged, so this build reads it as settled again.
 *
 *  The reason travels in the entry id (see `turnEndEntryId`), the one
 *  entry-level identity every reader already has: a durable flag would be a
 *  schema change every reader of the conversation pays for, and the
 *  interruption sweep already recognized its records by prefix. */
export type TurnEnd =
  | { readonly reason: "paused"; readonly pausedBy: PausedBy; readonly planned?: true; readonly closed?: true }
  | { readonly reason: "crash" | "discarded" | "settled" }

/** Who interrupted a turn. `replacement` is the runtime's planned cut before
 *  a successor continues the same work: it is saved as the runtime's
 *  interrupt, marked planned, and no surface shows it or its Resume.
 *  `close` is the runtime's cut when a person closes the chat: it is saved
 *  as the runtime's interrupt, marked closed, and waits for the person even
 *  when the turn waited on background work, because the close ended that
 *  work (PI-INTERACTION-119). */
export type TurnInterruption = PausedBy | "replacement" | "close"

/** How the runtime ends a running turn when it stops: `runtime` for an
 *  ordinary stop, whose interrupt every surface shows with its Resume,
 *  `close` for Close chat's stop, shown the same way, or `replacement` for
 *  a turn that a planned replacement's successor continues, which no
 *  surface shows. */
export type RuntimeInterruption = Exclude<TurnInterruption, "person" | "agent">

/** Who can end a workflow's run. Close chat ends only its chat's own work,
 *  and workflows keep running (PI-INTERACTION-119). */
export type WorkflowInterruption = Exclude<TurnInterruption, "close">

/** Who can make the one Interrupt of a control: a person, or a child's
 *  parent agent. Both decide alike in every rule but one: the parent may
 *  continue its own interrupt. */
export type ControlInterruption = Exclude<PausedBy, "runtime">

/** Whether the runtime made this cut. Every rule that depends on who cut a
 *  turn asks this, never whether a person did, so an agent's interrupt
 *  decides as a person's does. */
export function isRuntimeInterruption(by: TurnInterruption): by is RuntimeInterruption {
  return by === "runtime" || by === "replacement" || by === "close"
}

/** A live runner's answer to a person's interrupt of the turn a planned
 *  replacement's cut ended, a chat's or a workflow's, whose agent or
 *  follow-up turn holds the conversation:
 *  - `recorded`: the runner recorded the person's turn end over the cut and
 *    showed it. For a cut turn that still unwinds, a chat queues the record
 *    behind that turn's own, and a workflow's turn records one turn end that
 *    names the person; either lands when the turn ends.
 *  - `running`: a turn of the runner runs that no one cut, which the
 *    ordinary interrupt cuts.
 *  - `ended`: the runner has ended, as a stop ends it, and records nothing
 *    more; the caller records the person's turn end through the
 *    conversation's writer, as it does when no runner is live. */
export type PlannedCutInterrupt = "recorded" | "running" | "ended"

/** The turn end an interruption records. */
export function interruptedTurnEnd(by: TurnInterruption): Extract<TurnEnd, { reason: "paused" }> {
  return by === "replacement" ? { reason: "paused", pausedBy: "runtime", planned: true }
    : by === "close" ? { reason: "paused", pausedBy: "runtime", closed: true }
    : { reason: "paused", pausedBy: by }
}

/** Whether a planned replacement's cut recorded this turn end. Its
 *  successor holds the authority to continue the turn. */
export function isPlannedCut(end: TurnEnd | undefined): boolean {
  return end?.reason === "paused" && end.planned === true
}

/** Whether a person sees this turn end and the Resume that continues it. */
export function isVisibleTurnEnd(end: TurnEnd | undefined): boolean {
  return !isPlannedCut(end)
}

/** Prefix of every turn-end record id. The conversation projection moves
 *  its interruption boundary on any entry that carries it, so a second
 *  interruption after a record gets its own record. */
export const TURN_END_ID_PREFIX = "itb-"

/** The display-only content of the Escape markers written before interrupt
 *  became resumable, and the one identity of those written before ids carried
 *  a reason (`legacyUserInterrupt`). Remove after 2027-03-22. */
const LEGACY_USER_INTERRUPT_CONTENT = "Interrupted by user."

export function turnEndEntryId(end: TurnEnd, key: string): string {
  // A planned or closed cut keeps the `paused-runtime-` prefix, so a release
  // that predates its marker still reads it as the runtime's interrupt. An
  // agent's interrupt keeps the `paused-person-` prefix, so a release that
  // predates the agent actor reads it as the person's interrupt, which
  // decides the same way in every rule but the parent's continuation.
  const reason = end.reason !== "paused" ? end.reason
    : end.pausedBy === "agent" ? AGENT_INTERRUPT_REASON
    : `paused-${end.pausedBy}${end.planned ? "-planned" : end.closed ? "-closed" : ""}`
  return `${TURN_END_ID_PREFIX}${reason}-${key}`
}

const HISTORICAL_COMPLETION_PREFIX = turnEndEntryId({ reason: "settled" }, "workflow-completion:")

/** The entry under which an adoption records a completion that happened
 *  before the workflow had its current parent. It is a settled record: the
 *  model sees the result in later turns, but the parent owes no answer to
 *  it, offers no Resume for it, and gets no wake.
 *  The reconciler reads this entry as the delivered completion. */
export function historicalCompletionEntryId(childSessionId: string): string {
  return `${HISTORICAL_COMPLETION_PREFIX}${childSessionId}`
}

/** Whether an entry is an adoption's historical completion. The adopted
 *  card states the same result, so the transcript shows the entry no row of
 *  its own, as it shows no row for a live completion. */
export function isHistoricalCompletionEntry(entryId: string): boolean {
  return entryId.startsWith(HISTORICAL_COMPLETION_PREFIX)
}

/** The id reason of a parent agent's interrupt (`turnEndEntryId`). */
const AGENT_INTERRUPT_REASON = "paused-person-agent"

/** The model-visible record of an interrupted turn. Its tool results are
 *  already committed, interrupted ones marked, so the record states only the
 *  fact: who interrupted the turn, and, only when the cut stopped a running
 *  tool call, that the call may have run in part. A model told a call was cut
 *  after every command finished would repeat work that already completed. It
 *  never asks the model to continue; a Resume records its own continuation,
 *  and a new message starts a fresh turn. */
export function interruptedTurnMessage(by: TurnInterruption, cutToolCall: boolean): string {
  const who = by === "person" ? "The user interrupted this turn before it finished."
    : by === "agent" ? "Your parent session interrupted this turn before it finished."
    : by === "close" ? "The runtime interrupted this turn before it finished, because the user closed the chat."
    : "The runtime interrupted this turn before it finished, at a planned stop."
  return cutToolCall ? `${who} A tool call that was running was cut and may have partially executed.` : who
}

/** Whether the interrupt that ends `tail` cut a running tool call: the tool
 *  results of the turn's last step, read back from the tail, include one
 *  marked interrupted. Produced input, notices, and settled records that
 *  landed behind those results are skipped; an assistant message, a person's
 *  message, an earlier turn-end record, or any other entry ends the search,
 *  because a cut stream commits no assistant message and a finished step's
 *  results are no cut. */
export function cutRunningToolCall(tail: readonly TurnEndEntry[]): boolean {
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const entry = tail[index]
    if (!entry || isSkippedByWalk(entry)) continue
    if (entry.kind !== "message" || !entry.message || turnEndOfEntry(entry)) return false
    const { message } = entry
    if (message.kind === "toolResult") {
      if (message.interrupted === true) return true
      continue
    }
    if (message.kind === "system" || (message.kind === "user" && message.origin === "system")) continue
    return false
  }
  return false
}

/** The turn end an entry records, or nothing for an ordinary entry. */
export function turnEndOfEntry(entry: TurnEndEntry): TurnEnd | undefined {
  if (entry.kind !== "message" || !entry.message) return undefined
  if (!entry.id.startsWith(TURN_END_ID_PREFIX)) {
    return legacyUserInterrupt(entry) ? { reason: "paused", pausedBy: "person" } : undefined
  }
  const tagged = entry.id.slice(TURN_END_ID_PREFIX.length)
  if (tagged.startsWith(`${AGENT_INTERRUPT_REASON}-`)) return { reason: "paused", pausedBy: "agent" }
  if (tagged.startsWith("paused-person-")) return { reason: "paused", pausedBy: "person" }
  if (tagged.startsWith("paused-runtime-planned-")) return { reason: "paused", pausedBy: "runtime", planned: true }
  // Added 2026-11-02; a record written before it has no marker and keeps
  // its meaning, so no conversion exists.
  if (tagged.startsWith("paused-runtime-closed-")) return { reason: "paused", pausedBy: "runtime", closed: true }
  if (tagged.startsWith("paused-runtime-")) return { reason: "paused", pausedBy: "runtime" }
  if (tagged.startsWith("crash-")) return { reason: "crash" }
  if (tagged.startsWith("discarded-")) return { reason: "discarded" }
  if (tagged.startsWith("settled-")) return { reason: "settled" }
  if (tagged.startsWith("user-")) return { reason: "paused", pausedBy: "person" }
  return legacyTurnEnd(entry)
}

/** Whether an entry is a `settled` record, which every reader of how the
 *  model's turn ended reads past: it answered only its own exchange. */
function isSettledRecord(entry: TurnEndEntry): boolean {
  return turnEndOfEntry(entry)?.reason === "settled"
}

/** Conversion of records written before 2026-09-22, whose ids carried no
 *  reason (`itb-` and eight hex digits): a discarded record opens with the
 *  person's choice, every other one is a crash. Remove after 2027-03-22. */
function legacyTurnEnd(entry: TurnEndEntry): TurnEnd {
  const content = entry.message?.kind === "user" && typeof entry.message.content === "string" ? entry.message.content : ""
  return content.startsWith("The user ended the session") ? { reason: "discarded" } : { reason: "crash" }
}

/** Conversion of Escape markers written before 2026-09-22, which had an
 *  allocated id and were told only by their display-only content. They read
 *  as a person's interrupt, which is resumable; so do the `itb-user-` records
 *  Escape wrote before interrupt became resumable. Remove after 2027-03-22. */
function legacyUserInterrupt(entry: TurnEndEntry): boolean {
  return entry.displayOnly === true && entry.message?.kind === "system" && entry.message.content === LEGACY_USER_INTERRUPT_CONTENT
}

/** The turn-end evidence of a branch, read from its tail. `recorded` is
 *  false when the tail is an unanswered user message or tool result with no
 *  record: the process died before anything recorded the exit, so the turn
 *  reads as a crash until recovery writes its record. A record that only
 *  produced input follows stays `recorded` (`chatTurnEndOf`).
 *  `backgroundWait` marks a record that the runtime or an unexpected exit
 *  wrote while the turn waited on background work (`backgroundWaitOf`). */
export interface ChatTurnEnd {
  readonly end: TurnEnd
  readonly recorded: boolean
  readonly backgroundWait?: true
}

/** Walks the tail of a branch, newest first, to the entry that says how the
 *  last turn ended. Notices and labels are skipped; an assistant answer, a
 *  compaction, or a moved leaf means no turn is waiting. `tail` may be the
 *  whole branch or only its newest entries.
 *
 *  A tool result waits for the model's answer as a user message does. A
 *  process that died while a tool call ran leaves the call closed by an
 *  interrupted result and no answer, which is the same unfinished turn as a
 *  message it never answered.
 *
 *  A produced user-role message (origin `system`: a background notification,
 *  or the continuation a Resume records; or a message from another session)
 *  after an interrupt or an unexpected
 *  exit does not hide that record: the session folds such input into its
 *  history and still waits for the person (PI-INTERACTION-102). After any
 *  other end it is an unanswered message, the crash shape, which an idle
 *  tail that a notification follows also reads as.
 *
 *  A settled record answers only its own exchange, so the walk reads past
 *  it to the turn older than it. Only when nothing there waits is the newest
 *  settled record the turn end. */
export function chatTurnEndOf(tail: readonly TurnEndEntry[], holdsWait?: (id: string) => boolean): ChatTurnEnd | undefined {
  return chatTurnEndDecision(tail, holdsWait)?.turnEnd
}

/** The decisive turn end and the timestamp of its original entry. Unrecorded
 *  exits carry no timestamp because no producer recorded their end. */
export function chatTurnEndEvidenceOf(tail: readonly (TurnEndEntry & { readonly timestamp: string })[], holdsWait?: (id: string) => boolean): { readonly turnEnd: ChatTurnEnd; readonly timestamp?: number; readonly restoredWait?: RestoredAgentWait; readonly continuedWait?: RestoredAgentWait } | undefined {
  const decision = chatTurnEndDecision(tail, holdsWait)
  if (decision === undefined) return undefined
  const timestamp = decision.entry?.timestamp
  const wait = decision.wait
  const restoredWait = wait ? {
    ...restoredWaitOf(wait.finished, wait.opened),
    ...(wait.requestOwed ? { requestOwed: true as const } : {}),
    ...(wait.woken ? { woken: true as const } : {}),
    ...(wait.parkOnly ? { parkOnly: true as const } : {}),
  } : undefined
  const continued = continuedWaitOf(tail, decision, holdsWait)
  const continuedWait = typeof continued === "object" ? restoredWaitOf(continued.finished, continued.opened) : undefined
  return { turnEnd: decision.turnEnd, ...(timestamp === undefined ? {} : { timestamp: Date.parse(timestamp) }), ...(restoredWait ? { restoredWait } : {}), ...(continuedWait ? { continuedWait } : {}) }
}

/** The wait that `opened` opened, dated from the end of its batch. A reply
 *  wait has no expiry. */
function restoredWaitOf(finished: { readonly timestamp: string }, opened: OpenedWait): RestoredAgentWait {
  return { ...(opened.seconds === undefined ? {} : { expiry: { seconds: opened.seconds, deadlineMs: Date.parse(finished.timestamp) + opened.seconds * 1000 } }), replyWaitIds: opened.replyWaitIds }
}

/** Whether the wait that a restore reads may have opened before the first
 *  entry of `tail`: nothing in the tail decides whether an older wait call
 *  still holds (`openWaitBefore`), or the tail starts inside the last model
 *  step before a runtime cut. A restore read then pages back further. */
export function restoredWaitReadsOlder(tail: readonly TurnEndEntry[]): boolean {
  const decision = chatTurnEndDecision(tail)
  return decision?.readsOlder === true || decision?.wait?.readsOlder === true
    || (decision !== undefined && continuedWaitOf(tail, decision) === "older")
}

/** The open wait of a running turn that a planned replacement cut, which
 *  the successor's Resume continues (`RestoredAgentWait`): the cut came
 *  between the turn's requests, not at its park, so the turn reads as
 *  interrupted, and the wait that its earlier wait call opened still holds
 *  by the live loop's rule (`openWaitBefore`). A chain with an unexpected
 *  exit or an ordinary stop has no continuation authority, and a person's
 *  Resume ends the wait. */
function continuedWaitOf<Entry extends TurnEndEntry>(tail: readonly Entry[], decision: ChatTurnEndDecision<Entry>, holdsWait?: (id: string) => boolean): ReturnType<typeof openWaitBefore<Entry>> {
  if (decision.wait !== undefined || !isPlannedCut(decision.turnEnd.end)) return "none"
  const open = openWaitBefore(tail, tail.length, holdsWait)
  return typeof open === "object" && open.parkOnly ? "none" : open
}

/** A user-role message that the walks below read as input to the open wait. */
type StoredInput = NonNullable<TurnEndEntry["message"]>

/** Replays the live wait and message policies over the turn's last wait.
 * Runtime cuts do not move its finish time or extend its deadline. The wait
 * parks only (`RestoredAgentWait.parkOnly`) when any cut since that batch was
 * an unexpected exit or an ordinary stop: no continuation authority covers
 * that chain, even under the successor of a later planned replacement. A new
 * wait batch starts a new chain. A turn that ended in text still waits on
 * the open wait of an earlier wait call (`openWaitBefore`); without one, it
 * waits the runtime's default duration from that text. A compaction, such as
 * a person's /compact while the turn waited, re-drove nothing, so the walk
 * reads past it. Input committed after the turn's end owes a request
 * (`requestOwed`), and it ended the wait only when the live rule says so
 * (`woken`). A Resume after the turn's end already continues the turn, so
 * nothing is restored. `older` means the tail starts before the walk
 * could decide. */
function backgroundWaitOf<Entry extends TurnEndEntry>(tail: readonly Entry[], holdsWait?: (id: string) => boolean): BackgroundWait<Entry> | "older" | undefined {
  let finished: Entry | undefined
  let requestOwed = false
  let interrupted = false
  let parkOnly = false
  const inputs: StoredInput[] = []
  const succeeded = new Set<string>()
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const entry = tail[index]
    if (!entry || isSkippedByWalk(entry)) continue
    const end = turnEndOfEntry(entry)
    if (end?.reason === "crash" || (end?.reason === "paused" && end.pausedBy === "runtime")) {
      parkOnly ||= !isPlannedCut(end)
      continue
    }
    if (entry.kind === "compaction") {
      if (finished !== undefined || !parkedReset(tail, index)) return undefined
      return endedTurnWait(tail, index, entry, holdsWait, { inputs, requestOwed, parkOnly })
    }
    if (end || entry.kind !== "message" || !entry.message) return undefined
    const message = entry.message
    if (isTurnContinuation(message)) return undefined
    if (message.kind === "user") {
      inputs.push(message)
      const producer = message.producer
      requestOwed ||= messageDisposition({
        state: "waiting_on_work", origin: producer?.kind === "session" ? "session" : "human",
        hop: producer?.hop ?? 0, relation: producer?.envelope?.relation, self: false,
      }).status === "delivered"
    }
    if (message.kind === "toolResult") {
      finished ??= entry
      interrupted ||= message.interrupted === true
      noteSucceeded(succeeded, message)
    }
    if (message.kind !== "assistant") continue
    if (interrupted) return undefined
    const calls = toolUses(message)
    if (calls.length > 0) {
      const opened = waitOpenedBy(calls.filter((call) => succeeded.has(call.id)), inputs, holdsWait)
      return opened && { finished: finished ?? entry, opened: opened.wait, requestOwed, woken: inputs.some(opened.wokenBy), parkOnly, readsOlder: false }
    }
    if (finished !== undefined) return undefined
    return endedTurnWait(tail, index, entry, holdsWait, { inputs, requestOwed, parkOnly })
  }
  return "older"
}

/** What a restore walk collected after the end of a turn: the input that
 *  came after it, whether that input owes a request, and whether a cut since
 *  it parks only. */
interface AfterTurnEnd {
  readonly inputs: readonly StoredInput[]
  readonly requestOwed: boolean
  readonly parkOnly: boolean
}

/** The wait of a turn that ended at `index`, in text or in a reset that
 *  no request followed: the open wait of an earlier wait call
 *  (`openWaitBefore`), or else the runtime's default duration from that
 *  end. */
function endedTurnWait<Entry extends TurnEndEntry>(tail: readonly Entry[], index: number, entry: Entry, holdsWait: ((id: string) => boolean) | undefined, after: AfterTurnEnd): BackgroundWait<Entry> {
  const open = openWaitBefore(tail, index, holdsWait, after.inputs)
  const { requestOwed } = after
  if (typeof open === "object") return { finished: open.finished, opened: open.opened, requestOwed, woken: after.inputs.some(open.wokenBy), parkOnly: after.parkOnly || open.parkOnly, readsOlder: false }
  const opened = { seconds: DEFAULT_WAIT_SECONDS, replyWaitIds: [] }
  const woken = after.inputs.some((input) => endsOpenWait(storedWaitInput(input), [], () => true))
  return { finished: entry, opened, requestOwed, woken, parkOnly: after.parkOnly, readsOlder: open === "older" }
}

/** Whether the reset at `index` parked where the turn had ended, as a
 *  person's /compact does during a wait: its opening messages are settled
 *  records (`contextResetRecordId`). A reset that a request follows opens
 *  with ordinary messages, so a cut after it came in the middle of a turn,
 *  and a reset that opens with a copy of a turn-end record carried a turn
 *  that waits for the person (`carriedTurnEndRecord`). */
function parkedReset(tail: readonly TurnEndEntry[], index: number): boolean {
  const opening = tail[index + 1]
  return opening !== undefined && isSettledRecord(opening)
}

/** Records a tool result that the live loop counts as a successful call
 *  (`createSettledBatchObservation` settles only those as waits). A refused
 *  call, such as a wait that a compaction's save round refused, opens no
 *  wait. */
function noteSucceeded(succeeded: Set<string>, message: NonNullable<TurnEndEntry["message"]>): void {
  if (message.toolUseId !== undefined && toolOutcomeFromProvider(message.isError, message.interrupted) === "ok") succeeded.add(message.toolUseId)
}

/** The wait that one assistant message's successful calls open, by the
 *  live policy, with the rule by which an input committed after them ends
 *  it (`endsOpenWait`), or nothing when no call is a wait. `later` is the
 *  input committed after the calls. A reply wait that its addressee answered
 *  no longer holds, so the answer is the evidence that its call was a wait,
 *  and only an answer from that addressee ended it: a restore reads which
 *  reply waits hold now, not when each message came. */
function waitOpenedBy(calls: ReturnType<typeof toolUses>, later: readonly StoredInput[], holdsWait?: (id: string) => boolean): { readonly wait: OpenedWait; readonly wokenBy: (input: StoredInput) => boolean } | undefined {
  const answeredBy = (id: string, input: StoredInput): boolean => input.producer?.kind === "session" && input.producer.sessionId !== undefined
    && calls.some((call) => call.id === id && call.name === MESSAGE_SESSION_TOOL_NAME && call.input.wait === true && call.input.to === input.producer?.sessionId)
  const holds = (id: string): boolean => holdsWait?.(id) === true || later.some((input) => answeredBy(id, input))
  const waitCalls = calls.filter((call) => isWaitCall(call, WORK_PENDING, holds))
  if (waitCalls.length === 0) return undefined
  const wait = openedWaitOf(waitCalls, holds)
  const { replyWaitIds } = wait
  return { wait, wokenBy: (input) => endsOpenWait(storedWaitInput(input), replyWaitIds, (id) => holdsWait?.(id) === true || !answeredBy(id, input)) }
}

/** A stored input in the shape the wait rule reads. */
function storedWaitInput(input: StoredInput): OpenWaitInput {
  return { ...input, kind: "message" }
}

/** Whether the Resume at `index` is the one that a planned replacement's
 *  successor commits: it follows the planned cut's record directly, past
 *  the entries that the walks read past. */
function continuesPlannedCut(tail: readonly TurnEndEntry[], index: number): boolean {
  for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
    const entry = tail[earlier]
    if (!entry || isSkippedByWalk(entry)) continue
    return isPlannedCut(turnEndOfEntry(entry))
  }
  return false
}

/** Entries that no restore walk reads: topology entries, notices, settled
 *  records. Recovery reads a historical label as a topology entry. */
export function isSkippedByWalk(entry: TurnEndEntry): boolean {
  return entry.kind === "session_info" || entry.displayOnly === true || isSettledRecord(entry)
}

/** The open wait that the history before `end` still holds, read by the
 *  live loop's rule (`endsOpenWait`): the newest older successful wait call
 *  opened it, and the requests since it only re-drove the turn. A reply
 *  nudge, a runtime or module notice, a compaction, a message from another
 *  session that is not the awaited reply, the successor's Resume of a
 *  planned cut, text answers, and tool batches without a wait call keep it.
 *  A background notification, a wait's expiry notice, the awaited reply, a
 *  person's message or other Resume, and an interrupt end it, so the walk
 *  stops there with `none`. `after` is the input committed after `end`,
 *  which the caller judges; it is evidence of the replies that the wait
 *  call's reply waits got. Work that drained with no trace in the tree, such
 *  as work that the agent stopped or a child that a person interrupted,
 *  leaves the walk the older wait. `older` means the tail starts before the
 *  walk could decide. */
function openWaitBefore<Entry extends TurnEndEntry>(tail: readonly Entry[], end: number, holdsWait?: (id: string) => boolean, after: readonly StoredInput[] = []): { readonly finished: Entry; readonly opened: OpenedWait; readonly wokenBy: (input: StoredInput) => boolean; readonly parkOnly: boolean } | "none" | "older" {
  let finished: Entry | undefined
  let parkOnly = false
  const crossed: StoredInput[] = []
  const succeeded = new Set<string>()
  for (let index = end - 1; index >= 0; index -= 1) {
    const entry = tail[index]
    if (!entry || entry.kind === "compaction" || isSkippedByWalk(entry)) continue
    const turnEnd = turnEndOfEntry(entry)
    if (turnEnd?.reason === "crash" || (turnEnd?.reason === "paused" && turnEnd.pausedBy === "runtime" && turnEnd.closed !== true)) {
      parkOnly ||= !isPlannedCut(turnEnd)
      continue
    }
    const message = entry.message
    if (turnEnd || entry.kind !== "message" || !message) return "none"
    if (message.kind === "toolResult") {
      finished ??= entry
      noteSucceeded(succeeded, message)
      continue
    }
    if (message.kind === "user") {
      // Only the awaited reply depends on which reply waits the opener
      // holds, so every other wake stops the walk here.
      const input: OpenWaitInput = isTurnContinuation(message) ? { kind: "resume", continuesWait: continuesPlannedCut(tail, index) } : storedWaitInput(message)
      if (endsOpenWait(input, [], () => true)) return "none"
      if (input.kind === "message") crossed.push(message)
      continue
    }
    if (message.kind !== "assistant") continue
    const calls = toolUses(message).filter((call) => succeeded.has(call.id))
    succeeded.clear()
    const opened = waitOpenedBy(calls, [...crossed, ...after], holdsWait)
    if (opened !== undefined) return crossed.some(opened.wokenBy) ? "none" : { finished: finished ?? entry, opened: opened.wait, wokenBy: opened.wokenBy, parkOnly }
    finished = undefined
  }
  return "older"
}

/** The wait that a batch of wait calls opened (`openedWaitOf`). */
interface OpenedWait {
  /** Absent for a reply wait, which has no expiry. */
  readonly seconds?: number
  readonly replyWaitIds: readonly string[]
}

interface BackgroundWait<Entry extends TurnEndEntry> {
  readonly finished: Entry
  readonly opened: OpenedWait
  readonly requestOwed: boolean
  readonly woken: boolean
  readonly parkOnly: boolean
  /** The opener may sit before the tail (`restoredWaitReadsOlder`). */
  readonly readsOlder: boolean
}

interface ChatTurnEndDecision<Entry extends TurnEndEntry> {
  readonly turnEnd: ChatTurnEnd
  readonly entry?: Entry
  readonly wait?: BackgroundWait<Entry>
  /** The tail starts inside the last model step before a runtime cut. */
  readonly readsOlder?: true
}

function chatTurnEndDecision<Entry extends TurnEndEntry>(tail: readonly Entry[], holdsWait?: (id: string) => boolean): ChatTurnEndDecision<Entry> | undefined {
  if (questionExchangeOf(tail) === "waiting") return undefined
  const unanswered = { turnEnd: { end: { reason: "crash" }, recorded: false } } as const
  let produced = false
  let settled: Entry | undefined
  const nothingOlderWaits = (): ChatTurnEndDecision<Entry> | undefined =>
    produced ? unanswered : settled === undefined ? undefined : { turnEnd: { end: { reason: "settled" }, recorded: true }, entry: settled }
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const entry = tail[index]
    if (!entry) continue
    if (entry.kind === "session_info") continue
    if (entry.kind !== "message" || !entry.message) return nothingOlderWaits()
    const end = turnEndOfEntry(entry)
    if (end?.reason === "settled") {
      settled ??= entry
      continue
    }
    if (end) {
      if (produced && !isResumableTurnEnd(end)) return unanswered
      const found = end.reason === "crash" || (end.reason === "paused" && end.pausedBy === "runtime" && end.closed !== true)
        ? backgroundWaitOf(tail, holdsWait) : undefined
      const wait = found === "older" ? undefined : found
      return { turnEnd: wait ? { end, recorded: true, backgroundWait: true } : { end, recorded: true }, entry, ...(wait ? { wait } : {}), ...(found === "older" ? { readsOlder: true as const } : {}) }
    }
    if (entry.displayOnly === true) continue
    if (isProducedInput(entry.message)) {
      produced = true
      continue
    }
    if (entry.message.kind === "toolResult") {
      // A handoff is itself the answer. Its canonical result, not its input
      // or display text, proves acceptance even when sibling results follow.
      return acceptedHandoffInBatch(tail, index) ? nothingOlderWaits() : unanswered
    }
    if (entry.message.kind === "user") return unanswered
    return nothingOlderWaits()
  }
  return nothingOlderWaits()
}

function acceptedHandoffInBatch(tail: readonly TurnEndEntry[], lastIndex: number): boolean {
  const successful = new Set<string>()
  for (let index = lastIndex; index >= 0; index -= 1) {
    const entry = tail[index]
    if (!entry || isSkippedByWalk(entry)) continue
    if (entry.kind !== "message" || !entry.message || turnEndOfEntry(entry)) return false
    const message = entry.message
    if (message.kind === "toolResult") {
      if (message.toolUseId !== undefined && toolOutcomeFromProvider(message.isError, message.interrupted) === "ok") successful.add(message.toolUseId)
      continue
    }
    return message.kind === "assistant" && toolUses(message).some((call) => call.name === "handoff" && call.id !== undefined && successful.has(call.id))
  }
  return false
}

/** The tool calls of an assistant message's content, each with the
 *  registration that exposed its tool when the block records one. */
function toolUses(message: NonNullable<TurnEndEntry["message"]>): readonly { readonly name: string; readonly id: string; readonly input: { readonly [key: string]: unknown }; readonly registrationId?: string }[] {
  if (!Array.isArray(message.content)) return []
  return message.content.flatMap((block: { readonly type?: unknown; readonly name?: unknown; readonly id?: unknown; readonly input?: { readonly [key: string]: unknown }; readonly registrationId?: unknown }) =>
    block.type === "tool_use" && typeof block.name === "string" && typeof block.id === "string"
      ? [{ name: block.name, id: block.id, input: block.input ?? {}, ...(typeof block.registrationId === "string" ? { registrationId: block.registrationId } : {}) }]
      : [])
}

/** Whether a message is produced input: a user-role message that no person
 *  typed. Notifications and messages from another session preserve the
 *  preceding turn end; an explicit continuation authorizes a request. */
export function isProducedInput(message: NonNullable<TurnEndEntry["message"]>): boolean {
  return message.kind === "user" && (message.origin === "system" || message.producer?.kind === "session")
}

function isTurnContinuation(message: NonNullable<TurnEndEntry["message"]>): boolean {
  return message.kind === "user" && message.origin === "system"
    && (message.content === CONTINUATION_MESSAGES.resumed || message.content === CONTINUATION_MESSAGES.subagent_resumed || message.content === CONTINUATION_MESSAGES.unexpected_exit)
}

/** The newest entry of a branch that says who cut its last turn, or nothing
 *  when the tail holds only entries this walk reads past. The walk reads
 *  past labels, notices, settled records, and user-role messages, such as a
 *  person's message queued behind an interrupt, because none of them ran a
 *  model step after the cut. The entry is the cut's turn-end record, or an
 *  answer or another entry that shows that no recorded cut is pending
 *  (`turnEndOfEntry` reads it as no turn end). Unlike `chatTurnEndOf`, a
 *  person's later message does not hide the record, so the record names
 *  who made the cut even while that message waits. */
export function pendingTurnEndEntry(tail: readonly TurnEndEntry[]): TurnEndEntry | undefined {
  return tail.findLast((entry) => {
    const end = turnEndOfEntry(entry)
    if (end) return end.reason !== "settled"
    return !(entry.kind === "session_info" || entry.displayOnly === true || entry.message?.kind === "user")
  })
}

/** Whether the branch ends at a person's question: an assistant message
 *  that called `ask_user`, with nothing after it but results of that
 *  message's calls. `waiting` while an ask has no result: the turn is the
 *  person's to continue, not an interrupted one, whatever stopped the
 *  process that ran it (PI-INTERACTION-009). `settled` once every ask has
 *  its result and the turn's next request has not committed yet. Undefined
 *  for any other tail. */
export function questionExchangeOf(tail: readonly TurnEndEntry[]): "waiting" | "settled" | undefined {
  const results = new Set<string>()
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const entry = tail[index]
    if (!entry || isSkippedByWalk(entry)) continue
    const message = entry.message
    if (entry.kind !== "message" || !message) return undefined
    if (message.kind === "toolResult" && message.toolUseId !== undefined) {
      results.add(message.toolUseId)
      continue
    }
    if (message.kind !== "assistant" || !Array.isArray(message.content)) return undefined
    const asks: string[] = message.content.flatMap((block: { readonly type?: unknown; readonly name?: unknown; readonly id?: unknown }) =>
      block.type === "tool_use" && block.name === "ask_user" && typeof block.id === "string" ? [block.id] : [])
    if (asks.length === 0) return undefined
    return asks.every((id) => results.has(id)) ? "settled" : "waiting"
  }
  return undefined
}

/** Whether the branch ends at a record of how the model's turn ended, with
 *  nothing but notices and settled records after it: no request has run
 *  since the turn it records ended. */
export function endsAtTurnEnd(tail: readonly TurnEndEntry[]): boolean {
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const entry = tail[index]
    if (!entry || isSkippedByWalk(entry)) continue
    return turnEndOfEntry(entry) !== undefined
  }
  return false
}

/** An interrupted or crashed turn continues from its committed context with
 *  no new message; a turn the person discarded, or one the runtime settled,
 *  does not. */
export function isResumableTurnEnd(end: TurnEnd | undefined): boolean {
  return end?.reason === "paused" || end?.reason === "crash"
}

const CONTEXT_RESET_RECORD_PREFIX = turnEndEntryId({ reason: "settled" }, "context-reset:")

/** The id of a message that opens the fresh context of a reset that no
 *  request follows, as a compaction that parks after it: the note listing
 *  and the recovery text. No model answer is owed to them, so they are
 *  settled records, and the chat reads as its last turn ended before the
 *  reset. A reset that a request follows gives them ordinary ids: a process
 *  that dies before that request answers left an unanswered turn. */
export function contextResetRecordId(): string {
  return `${CONTEXT_RESET_RECORD_PREFIX}${crypto.randomUUID()}`
}

/** Whether an entry opens the fresh context of a reset that no request
 *  follows. The transcript shows it no row: like the same messages under a
 *  reset that a request follows, it is model-facing prose. */
export function isContextResetRecord(entryId: string): boolean {
  return entryId.startsWith(CONTEXT_RESET_RECORD_PREFIX)
}

/** A copy of a turn-end record under a fresh id with the same reason. */
interface CarriedTurnEnd {
  readonly id: string
  readonly message: ConversationMessage
}

/** The copy of the turn-end record that a context reset carries past itself
 *  while the turn that record ended waits for the person, as a compaction
 *  of an interrupted or crashed chat runs before its Resume. The reset and
 *  the checkpoint before it follow the record, and the readers of the
 *  branch's tail stop at a reset, so without the copy the turn would read
 *  as answered or unrecorded. The copy keeps the record's words, so the
 *  fresh context still states how the turn ended. The record is the newest
 *  one on the branch, read past settled records and the checkpoint's own
 *  messages. Nothing is carried when that record does not wait for the
 *  person, or when a person's message or an older reset comes first: the
 *  person's message started a turn after it. */
export function carriedTurnEndRecord(branch: readonly TurnEndEntry[]): CarriedTurnEnd | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (!entry || entry.kind === "compaction" || (entry.message?.kind === "user" && entry.message.origin === "human")) return undefined
    const end = turnEndOfEntry(entry)
    if (!end || end.reason === "settled") continue
    const content = entry.message?.content
    if (!isResumableTurnEnd(end) || typeof content !== "string") return undefined
    return { id: turnEndEntryId(end, crypto.randomUUID()), message: { kind: "user", content, origin: "system" } }
  }
  return undefined
}

/** Whether the last turn waits for a person: a recorded interrupt, by the
 *  person, the parent agent, or the runtime, or a recorded unexpected exit,
 *  with no answer since. The parent may also continue a turn that a person
 *  did not cut (`parentMayContinue`).
 *  Nothing produced starts a turn then, so a background completion is folded
 *  into the history and lands on Resume or the next message
 *  (PI-INTERACTION-102). A turn that the runtime or an unexpected exit cut
 *  while it waited on background work (`backgroundWait`) does not wait for
 *  the person: it still waits on that work, so a completion wakes it, as it
 *  wakes a turn that no restart cut. Close chat's cut is not such a cut: the
 *  close ended that work, so the turn waits for the person. The unrecorded
 *  crash shape does not wait: an idle tail that a notification follows
 *  reads the same way. */
export function waitsForPerson(turnEnd: ChatTurnEnd | undefined): boolean {
  return turnEnd?.recorded === true && isResumableTurnEnd(turnEnd.end) && turnEnd.backgroundWait !== true
}

/** Whether a person sees the last turn as interrupted: it waits for the
 *  person (`waitsForPerson`), and no planned replacement cut it
 *  (`isVisibleTurnEnd`). A planned replacement's successor continues its
 *  turn, so that agent still runs, as an agent does whose runtime cut came
 *  while it waited on background work (PI-REMOTE-012). */
export function holdsForPerson(turnEnd: ChatTurnEnd | undefined): boolean {
  return isVisibleTurnEnd(turnEnd?.end) && waitsForPerson(turnEnd)
}

/** Whether the branch still waits where the runtime interrupted it: its last
 *  turn end is the runtime's interrupt, planned or not, and no Resume has
 *  continued that turn since. A planned replacement's cut and its stop
 *  record the planned interrupt; an ordinary one counts too, so an owed
 *  session is never left behind. A person's or an agent's interrupt, a
 *  crash, or a discard is not the runtime's interrupt. A Resume commits its
 *  continuation message before its first request, so a resume that began
 *  reads here, even when its process exited before the turn answered: its
 *  turn then ends as any interrupted turn does, for a person to resume. */
export function waitsAtRuntimeInterrupt(tail: readonly TurnEndEntry[]): boolean {
  const end = chatTurnEndOf(tail)?.end
  if (end?.reason !== "paused" || end.pausedBy !== "runtime") return false
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const entry = tail[index]
    if (!entry || isSettledRecord(entry)) continue
    if (turnEndOfEntry(entry)) return true
    const message = entry.message
    if (message && isTurnContinuation(message)) return false
  }
  return true
}

/** The texts of the continuation messages that the runtime records to restart a turn. */
export const CONTINUATION_MESSAGES = {
  unexpected_exit: "Your process exited unexpectedly. Continue where you left off.",
  // A Resume of an interrupted turn. The turn-end record before it says who
  // interrupted the turn; this message is the only one that asks to continue.
  resumed: "The interrupted turn is resumed. Continue it from where it stopped; do not repeat work that finished.",
  subagent_resumed: "Continue the saved assignment from where it stopped. Do not repeat work that finished.",
  stream_stalled: "Your previous response stalled while composing one oversized operation. Produce one small sequential batch in this response. For an edit or generated payload, produce one small section. For parallel calls, launch one small batch. Do not retry the oversized operation as one tool call, and do not wait for the user. Normal batching resumes after this response completes.",
} as const

/** The continuation of a failed workflow agent that a person or its parent
 *  resumed, with `failure`, the reason its attempt recorded. */
export function reopenedContinuation(failure: string): string {
  return `Your previous attempt at this work failed, and a person or your parent resumed you. The recorded failure: ${failure}\n\nContinue from where you stopped. Do not repeat work that finished. Finish with your handoff.`
}
