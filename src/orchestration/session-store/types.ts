import type { Unsubscribe } from "../../infra/event-bus.js"
import type { AnyBlock, ConnectionState, StreamPhase, ToolStreamingText } from "../../infra/output-blocks.js"
import type { OutputChangeBatch } from "../../infra/output/output-block-delta.js"
import type { SessionNotice, SessionNoticeOperation } from "../../infra/session-notice.js"
import type { ChatRunner } from "../chat/runner-types.js"
import type { SessionKind } from "../session/types.js"
import type { WorkflowDeliveryAddress } from "../session/conversation/addressed-workflow-messages.js"
import type { ActiveBackgroundCommandDescriptor } from "../agent-runtime/background-work.js"
import type { AgentInputAnswers } from "../../protocol/question-protocol-types.js"
import type { ControlInterruption, RuntimeInterruption } from "../session/conversation/turn-end-record.js"


/** Patch shape for store entries: callers always hand the store a plain block
 *  array; the store owns the per-entry mutable box that `outputBlocks` reads
 *  from.
 *  `kind`/`runner`/`startedAt`/`conversationId` are construction-time fields
 *  (written when the entry is created or replaced, never patched), so omitting
 *  them keeps base patches assignable
 *  to the kind-specific patch types without casts. `outputChanges` is not an
 *  entry field at all - it accumulates in a per-session drain queue read
 *  once by `drainOutputChanges`, the write-site-minted counterpart to the
 *  `outputBlocks` full-snapshot accessor. */
type WithOutputBlocksPatch<T> = Partial<Omit<T, "outputBlocks" | "visibleMessageCountSuffix" | "kind" | "runner" | "startedAt" | "activityStartedAt" | "conversationId" | "notices" | "entryEpoch">> & ({
  outputBlocks: readonly AnyBlock[]
  visibleMessageCountSuffix: number
} | {
  outputBlocks?: undefined
  visibleMessageCountSuffix?: undefined
}) & {
  outputChanges?: OutputChangeBatch
  /** Notices mutate only by operation: the patcher folds the operation against
   *  the entry's current notices, so event adapters (which live per runner
   *  attach) never carry a copy that could reset the list on reattach. */
  noticeOperation?: { operation: SessionNoticeOperation; timestamp: number }
}
export type SessionEntryBasePatch = WithOutputBlocksPatch<SessionEntryBase>
export type ChatEntryPatch = WithOutputBlocksPatch<ConversationSessionEntry> & Partial<Pick<WorkflowAgentSessionEntry, "operations">>

export interface SessionEntryBase {
  readonly kind: SessionKind
  /** Construction-time incarnation stamp minted by entryRuntimeDefaults. A new
   *  shell for the same session id gets a new epoch, and with it a new absolute
   *  output coordinate baseline (`outputSequenceStart`); projections use the
   *  epoch change as the rebase event. Never patched. */
  readonly entryEpoch: number
  description: string
  shortDescription?: string
  /** Accessor over the projector's live block array, backed by a per-entry
   *  mutable box owned by the store. The array reference is stable across
   *  syncs (the builder mutates in place, replacing element refs); readers
   *  see the current array by calling the accessor at read time. */
  outputBlocks: () => readonly AnyBlock[]
  /** Absolute transcript index represented by outputBlocks[0]. Reactivated
   *  runners retain bounded prior blocks for display continuity; this single
   *  boundary lets storage and runtime form one sequence without publishing
   *  that prior context as new output. */
  outputSequenceStart: number
  /** Visible messages before outputBlocks[0]. This is the count coordinate
   *  paired with outputSequenceStart for bounded runtime display tails. */
  visibleMessageCountPrefix: number
  /** Visible messages appended by the active writer after its durable seed.
   *  This includes qualifying retained seed blocks and is updated with the
   *  block array in the same patch. */
  visibleMessageCountSuffix: number
  /** Live partial tool-input text keyed by toolUseId (`ToolEntry.id`), delivered
   *  by the output sync alongside blocks. Per-token deltas land here; the block
   *  tree changes only on structural events. Empty when nothing streams. */
  streamingToolText: Readonly<StringMap<ToolStreamingText>>
  tokens: number
  cost: number
  /** Metered (API-key) portion of `cost`; the remainder is
   *  subscription-covered API-equivalent value. */
  billedCost: number
  priceUnavailable: boolean
  contextPercent: number
  streamingOutputChars: number
  contextPromptTokens: number
  readonly startedAt: number
  streamPhase: StreamPhase | null
  /** Discriminated activity state covering the runner's full lifecycle.
   *    - "streaming"       : model is generating or tools are executing.
   *    - "awaiting_user"   : an in-flight turn is parked inside ask_user waiting on the user; not visually active but still in-flight for shutdown.
   *    - "idle"            : runner exists but is parked in its input reservation.
   *    - "absent"          : no runner attached. Default for new shell entries.
   *  Consumers (spinner, tabs, metrics timer, model-switch) read this to
   *  derive "actively processing" vs "runner exists" vs "no runner". */
  runnerState: "streaming" | "awaiting_user" | "idle" | "absent"
  /** Runtime-owned start of the current reported activity, unchanged by output updates. */
  activityStartedAt: number
  /** Wall-clock anchor of the current active episode, null when the session is
   *  genuinely waiting on the user (awaiting_user, parked without background
   *  work, absent). Set by the session event adapter on logical turn start /
   *  agent activity resume; kept running across parks that wait on background
   *  work (subagent results, an explicit wait on a backgrounded command);
   *  cleared on logical turn end / awaiting_user / queue completion / detach.
   *  Drives the spinner's episode-elapsed reading so it survives tab
   *  switches; see useMetrics.episodeElapsed. */
  streamingStartedAt: number | null
  /** Cumulative duration of completed active episodes, in milliseconds.
   *  Folded by foldStreamingEpisode whenever a patch moves streamingStartedAt
   *  off a running episode. The header timer reads
   *  `accumulatedActiveMs + (live episode when the anchor is set)` so it stays
   *  cumulative across episodes but stops ticking on the user's turn. */
  accumulatedActiveMs: number
  connectionState: ConnectionState
  /** Ephemeral user-facing runtime notices. Retry/auth/connectivity notices live
   *  here so recoverable problems can be shown and cleared without mutating the
   *  durable transcript. Written only by the patcher's `noticeOperation` fold. */
  notices: readonly SessionNotice[]
  /** Wall-clock start of an in-flight compaction, null when idle. Drives the
   *  footer spinner; chat-window doesn't render compaction as a tool entry. */
  compactionStartedAt: number | null
  /** Subagent tool calls whose only viewport is this session and which are
   *  still in flight, keyed by toolUseId. Maintained through the
   *  runner's onActiveSubagentsChanged callback.
   *  Drives the tab's "busy" signal alongside `runnerState`. Workflow
   *  launches do NOT appear here; they have their own viewport. */
  activeSubagents: ReadonlySet<string>
  /** True while the runner is parked in its input reservation waiting on background
   *  work: subagents still running, or an explicit wait on a backgrounded
   *  command. False when the park waits on the user, even if a long-lived
   *  background process is still tracked. Set/cleared by the session event
   *  adapter from park, interrupt, resume, and teardown events; drives the
   *  prompt-bar "Waiting" status. */
  waitingOnBackgroundWork: boolean
  /** Live, stoppable background commands projected from the owning registry. */
  activeBackgroundCommands: readonly ActiveBackgroundCommandDescriptor[]
  /** Live foreground Bash tool calls that can be transferred to background execution. */
  activeForegroundBashToolCallIds: readonly string[]
}



interface ConversationSessionEntryBase extends SessionEntryBase {
  readonly runner: ChatRunner | null
  /** Stable Flywheel key for the durable conversation tree. Minted at session
   *  creation, so an active entry always
   *  carries it; the durable shape never permits undefined. */
  readonly conversationId: string
  /** Provider continuation token, refreshed each turn from the runner. */
  providerConversationId?: string
  seedContext?: string
}

export interface ChatSessionEntry extends ConversationSessionEntryBase {
  readonly kind: "chat"
}

interface SubagentSessionEntry extends ConversationSessionEntryBase {
  readonly kind: "subagent"
}

interface WorkflowAgentSessionEntry extends ConversationSessionEntryBase {
  readonly kind: "workflow-agent"
  /** The workflow the agent belongs to: a change of the agent's runtime
   *  state refreshes the workflow's card in its parent. */
  readonly workflowId: string
  /** The operations its running attempt has counted, as the attempt's
   *  outcome counts them, or null before the attempt reports a count. The
   *  workflow's live view reads this count, not the agent's durable tree. */
  operations: number | null
}

export type ConversationSessionEntry = ChatSessionEntry | SubagentSessionEntry | WorkflowAgentSessionEntry
export type SessionEntry = ConversationSessionEntry

export type SessionRuntimeOptions = SessionRuntimeOptionsBase & (
  | { kind?: "chat" | "subagent" }
  | { kind: "workflow-agent"; workflowId: string }
)

interface SessionRuntimeOptionsBase {
  sessionId: string
  conversationId: string
  description?: string
  shortDescription?: string
  priorBlocks?: AnyBlock[]
  outputSequenceStart?: number
  visibleMessageCountPrefix?: number
  initialCost?: number
  initialBilledCost?: number
  initialTokens?: number
  startedAt?: number
  accumulatedActiveMs?: number
  contextPercent?: number
  providerConversationId?: string
  seedContext?: string
}


export interface SessionStore {

  openSessionRuntime(opts: SessionRuntimeOptions): string
  /** Replace a chat's bounded derived display tail and publish one full resync.
   *  A startup failure notice that the chat shows stays after the new tail. */
  replaceChatDisplaySeed(
    sessionId: string,
    blocks: readonly AnyBlock[],
    blockCount: number,
    visibleMessageCountPrefix: number,
    visibleMessageCountSuffix: number,
  ): boolean
  /** Hands the chat's display to `runner` and makes it the chat's authority.
   *  A startup failure notice leaves the display here, once. */
  attachChatRunner(sessionId: string, runner: ChatRunner): boolean
  appendPreRunnerOutput(sessionId: string, block: AnyBlock): boolean
  /** Shows that the chat's runner could not start. A chat shows one such
   *  notice under one identity: a start that fails again changes it in place,
   *  and nothing removes it until a runner attaches. Returns false when the
   *  store holds no chat for the session. */
  showStartupFailure(sessionId: string, message: string): boolean

  get(sessionId: string): SessionEntry | undefined
  has(sessionId: string): boolean
  isRunning(sessionId: string): boolean
  abort(sessionId: string): Promise<boolean>
  /** The runtime's stop of one chat's runner (`ChatRunner.prepareForShutdown`). */
  prepareForShutdown(sessionId: string, by: RuntimeInterruption): void
  /** A planned replacement's cut of one session's running turn, by the
   *  runtime. A running shell command is never cut: the cut first moves each
   *  held foreground command to the background, and the stop hands every
   *  running command to the successor. True when it interrupted a running
   *  turn. */
  interruptForReplacement(sessionId: string): Promise<boolean>
  /** A planned replacement's move of the session's held foreground commands,
   *  its children's included, to the background. Resolves once the
   *  session's registries track each moved command or it has ended. */
  transferForegroundForReplacement(sessionId: string): Promise<void>
  /** The one Interrupt of a session's running turn or step, by a person or
   *  by the parent agent of a workflow. Only a person interrupts a
   *  conversation runner: the parent agent cuts a subagent through its live
   *  run (`liveChildRun`), and a chat has no parent. */
  interrupt(sessionId: string, by: ControlInterruption, address?: WorkflowDeliveryAddress): boolean
  releaseForegroundBash(sessionId: string, toolUseId: string): boolean
  terminateBackgroundWork(sessionId: string, toolUseId: string): void
  remove(sessionId: string): Promise<void>
  /** Shared runtime fields, including activity and metrics. */
  updateEntry(sessionId: string, patch: SessionEntryBasePatch): void
  /** Chat-only fields; no-op unless the entry is a chat session. */
  updateChatEntry(sessionId: string, patch: ChatEntryPatch): void
  answerQuestion(sessionId: string, toolUseId: string, answers: AgentInputAnswers): boolean
  cancelQuestion(sessionId: string, toolUseId: string): boolean
  compactConversation(sessionId: string): Promise<boolean>
  /** Fire the combined learning review for an active chat session.
   *  False when the session is absent, inactive, or hosts no review. */
  learnFromSession(sessionId: string): boolean
  reorder(sessionId: string, beforeSessionId: string | null): boolean
  runningCount(): number
  allIds(): string[]
  /** Monotonic per-session revision, bumped on every UI-visible entry mutation.
   *  The frontend projection diffs by `id -> revision` to re-project only the
   *  sessions that changed since the last notify. Absent sessions read 0. */
  revision(sessionId: string): number
  /** Reads and clears the output deltas queued for this session since the
   *  last drain. The app-service output projection is the sole consumer;
   *  each batch is meant to be applied once. Absent/never-queued sessions
   *  read an empty batch. */
  drainOutputChanges(sessionId: string): OutputChangeBatch
  disposeAll(): Promise<void>
  /** `label` names this subscriber in slow-loop-unit and stall-attribution
   *  warnings (session-fairness plan, phase 0). */
  /** One coalesced notification per burst. `changed` names the sessions whose
   *  entries moved since the last notification; it is undefined after a
   *  membership or order change, when every subscriber sweeps the whole store. */
  onChange(listener: (changed: ReadonlySet<string> | undefined) => void, label?: string): Unsubscribe
  /** Reload runtime dependencies for the named sessions, or every active runner
   *  when no session list is supplied. */
  refreshDeps(sessionIds?: readonly string[]): Promise<void>
}
interface StringMap<T> { [key: string]: T }
