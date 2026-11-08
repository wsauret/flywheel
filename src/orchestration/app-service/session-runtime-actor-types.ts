import type { ChildSessionReconciliation, ChildSessionReconciliationOptions } from "../session/child-session-reconciliation.js"
import type { SessionChangesUndo, SessionChangesUndoResult } from "../../protocol/session-changes-protocol-types.js"
import type { ChatInputLike } from "../../infra/chat-input.js"
import type { ProjectDirectories } from "../../infra/directory-authorities.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import type { EventStoreRuntime } from "../../infra/event-store-effect.js"
import type { ChatRunner } from "../chat/runner-types.js"
import type { AgentInputAnswer } from "../../protocol/question-protocol-types.js"
import type { SessionManager } from "../session/manager.js"
import type { SessionStore } from "../session-store/types.js"
import type { SessionViewLoader } from "../session-store/view.js"
import type { SessionRuntimeView, SessionTitlePatch } from "../../protocol/app-service-types.js"
import type { QuestionSettlementOutcome, ResumeChatOutcome, RuntimeRunnerCapabilities, SendChatOutcome } from "./runtime-supervisor-types.js"
import type { TranscriptProjectionCache } from "./transcript-projection-cache.js"
import type { WorkflowController } from "../workflow-host/controller.js"
import type { RuntimeInterruption } from "../session/conversation/turn-end-record.js"
import type { ModuleRetainedOperationAuthority, RetainedOperationAcceptance } from "../module-seams.js"
import type { ChildSessionDeletionPlan } from "../session/child-session-deletion.js"

export interface AgentInputAnswers {
  readonly [question: string]: AgentInputAnswer
}
/** A payload-carrying command the actor executes through its serialized mailbox.
 *  Its `kind`s are the same dot-delimited tags the classifier routes (plus the
 *  query-only `recall` and internal `chat.finish` callback), so the router and the actor speak one vocabulary and no
 *  per-call name translation sits between them. `session.activate` loads the
 *  durable view and opens the shell INSIDE the mailbox, so two racing entry
 *  points (open-from-picker and a cold send's auto-activation) cannot both call
 *  openSessionRuntime and detach a just-attached runner. `session.release` ends the
 *  runner of a chat no client shows once its turn is at rest, and leaves the
 *  durable session as it is. `session.send` is the only
 *  command with a cold-start path; the delegated commands act on the attached
 *  runner. `session.close`/`session.delete`/`session.discard_transient` are the
 *  lifecycle commands: `dispatch` marks them closing before mailbox entry, and
 *  the ordered body awaits runner stop and resource teardown. A close `atRest`
 *  is marked closing only once its turn is at rest. `session.discard_transient` is the tombstone
 *  disposition the supervisor reaches only after its synchronous
 *  `shouldTombstone` guard passes. */
export type SessionMutation =
  | { readonly kind: "session.changes.undo"; readonly request: SessionChangesUndo }
  /** `shown` when a client shows the session; absent when the runtime opens it for work of its own. */
  | { readonly kind: "session.activate"; readonly shown?: true }
  | { readonly kind: "session.release" }
  /** No client shows the session, while its runner stays for a client that comes back. */
  | { readonly kind: "session.hide" }
  | { readonly kind: "session.send"; readonly input: ChatInputLike }
  | { readonly kind: "chat.resume" }
  | { readonly kind: "operation.accept"; readonly operation: RetainedOperationAcceptance }
  | { readonly kind: "chat.request_context"; readonly input: ChatInputLike; readonly context: string }
  | { readonly kind: "question.answer"; readonly toolUseId: string; readonly answers: AgentInputAnswers }
  | { readonly kind: "question.cancel"; readonly toolUseId: string }
  | { readonly kind: "background.terminate"; readonly toolUseId: string }
  | { readonly kind: "chat.compact" }
  | { readonly kind: "chat.learn" }
  | { readonly kind: "chat.finish"; readonly message?: string }
  | { readonly kind: "recall-input" }
  /** `atRest` when the chat's tab closed: no work ends, and the chat closes once its turn is at rest. */
  | { readonly kind: "session.close"; readonly atRest?: true }
  | { readonly kind: "session.delete"; readonly inactiveBefore?: number }
  | { readonly kind: "session.discard_transient" }
  | ({ readonly kind: "session.rename" } & SessionTitlePatch)

/** The outcome of a dispatched command, correlated to its kind so a recall payload
 *  cannot be mistaken for a send outcome or a settlement boolean. */
export type DispatchResult<C extends SessionMutation> =
  C extends { kind: "session.send" } ? SendChatOutcome
  : C extends { kind: "chat.resume" } ? ResumeChatOutcome
  : C extends { kind: "session.changes.undo" } ? SessionChangesUndoResult
  : C extends { kind: "recall-input" } ? ChatInputLike | null
  : C extends { kind: "question.answer" | "question.cancel" } ? QuestionSettlementOutcome
  : boolean

/** Every `DispatchResult` flattened to its value union. `orderedSection` returns
 *  this because TypeScript cannot reduce the open-generic `DispatchResult<C>`
 *  through a value-discriminated switch; `dispatch` re-correlates it to `C` once
 *  at the boundary, with the switch as the proof. */
export type DispatchOutcome = SessionChangesUndoResult | SendChatOutcome | ResumeChatOutcome | QuestionSettlementOutcome | boolean | (ChatInputLike | null)

/** Process-wide collaborators every actor shares, plus the supervisor-owned
 *  `disposed` flag read through `isDisposed`. The actor owns per-session live
 *  state; this context is the slice of the supervisor it reads and writes
 *  through. The actor only receives the runner-creation capability it needs;
 *  startup warming and process-wide disposal stay on the supervisor surface. */
export interface SessionRuntimeActorContext {
  readonly undoChanges: (request: SessionChangesUndo, signal: AbortSignal) => Promise<SessionChangesUndoResult>
  readonly transcriptCache: TranscriptProjectionCache
  readonly sessionStore: SessionStore
  readonly manager: SessionManager
  readonly eventStore: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
  /** Runs admitted kind settlement and target finalization outside the actor mailbox. */
  readonly executeChildSessionDeletion: (plan: ChildSessionDeletionPlan) => Promise<void>
  /** The auth profile a new chat records at creation: the one that serves it. */
  readonly authProfileId: () => string
  readonly sessionViewLoader?: SessionViewLoader
  /** Directory authorities every runner this session starts resolves paths from. */
  readonly directories: ProjectDirectories
  readonly runtime: EventStoreRuntime
  readonly runnerCapabilities: () => Promise<RuntimeRunnerCapabilities>
  readonly onRunnerDone?: (id: string) => void
  readonly onRunnerError?: (id: string, message: string) => void
  /** Resumes a workflow after the person settles a question that an agent of
   *  a workflow of an earlier build left open (PI-AGENT-024). Remove after 2027-04-03. */
  readonly resumeWorkflow?: WorkflowController["resumeWorkflow"]
  readonly retainedOperations?: readonly ModuleRetainedOperationAuthority[]
  readonly reconcileChildSessionCompletions?: (
    parentSessionId: string,
    options?: ChildSessionReconciliationOptions,
  ) => Promise<ChildSessionReconciliation>
  /** Grace a lifecycle command waits for an in-flight startup to settle before
   *  tearing down anyway; defaults to CLOSE_STARTUP_GRACE_MS. Injected for tests. */
  readonly closeStartupGraceMs?: number
  isDisposed(): boolean
  /** Whether a client shows the session: from a client's activation that shows it to the release of its last client
   *  or its close. The supervisor holds it, so it outlives an actor that ends while a client shows its session, and
   *  every later runner of the session runs its engines (`ChatRunner.setShown`). */
  isShown(sessionId: string): boolean
  /** Drops the actor from the supervisor map once its runner has finished and the
   *  session has left the store, so a settled session keeps no live runtime state
   *  (and `runtimeState` reports it absent, as before the extraction). */
  forget(sessionId: string): void
}

/** How a closing actor leaves its session. `delete` erases it. `close` is the
 *  close of its tab, and of a stop that no client holds the project through,
 *  such as the project's sleep: a blank chat is tombstoned and any other
 *  session is kept inactive. `restart` is a stop that a client holds the
 *  project through, planned or not: each tab it shows attaches its session
 *  again (ARCH-RUNTIME-024), so every session, a blank chat too, is kept inactive, and
 *  only the close of its tab or a later stop that no client holds the project
 *  through discards a blank chat. */
export type ClosingDisposition = "delete" | "close" | "restart"

/** The actor's life. Open while it serves its session; closing from the
 *  first step of a close, delete, release end, runner finish, or stop; ended
 *  once its entry left the store and the supervisor forgot it. It never goes
 *  back, so a startup that began while open is stale exactly when the actor
 *  no longer is. `failure` is the message of a runner that finished with an
 *  error, reported at once even when Undo delays the end. */
export type ActorLifecycle =
  | { readonly kind: "open" }
  | { readonly kind: "closing"; readonly failure?: string }
  | { readonly kind: "ended" }

/** The start of the chat's runner. `failed` holds only while the store holds
 *  no runner: a start fails only before its runner attaches, and a step after
 *  the attach is the attached runner's own work. */
export type RunnerStartup =
  | { readonly kind: "none" }
  | { readonly kind: "starting"; readonly promise: Promise<ChatRunner> }
  | { readonly kind: "failed"; readonly message: string }

/** Owner of one chat session's live runtime state: its life (open, closing,
 *  ended), the start of its runner, the ordered-command mailbox, pending pre-runner deliveries,
 *  the delivered-id dedup guard, the title-pending flag, and whether a tab has
 *  asked for the chat. The supervisor holds
 *  one actor per session and the process-wide `disposed` flag; everything the
 *  supervisor used to read out of a per-session `SessionRuntime` record now lives
 *  here, scoped to a single session so no method has to look one up by id. */
export interface SessionRuntimeActor {
  /** Releases a cold actor after cleanup when no concurrent command or
   * startup acquired it. A resident session keeps its actor. */
  retireIfUnused(): void
  /** Serializes completion admission with parent commands and waits only for the active logical turn's durability barrier. */
  reconcileChildSessionCompletions(): Promise<ChildSessionReconciliation>
  /** The chat's next message is titled: an empty chat the executor opened,
   *  for a start or for a tab's command. */
  startTitleGeneration(): void
  ensureChatRunner(): Promise<ChatRunner>
  /** Enqueue an ordered command into the actor's serialized mailbox. The
   *  returned promise resolves with the command's kind-correlated outcome;
   *  commands process one at a time in arrival order and a rejected command does
   *  not poison the next dispatch. */
  dispatch<C extends SessionMutation>(command: C): Promise<DispatchResult<C>>
  /** Preemptive teardown stop: the runtime's planned stop. A running turn is
   *  recorded as interrupted by the runtime, `by` names how, and resumes
   *  after the restart; an idle runner shelves its queued input. */
  prepareForShutdown(by: RuntimeInterruption): void
  /** Marks the actor closing: a startup in flight can no longer attach its
   *  runner, and every later start is refused. An ended actor stays ended. */
  markClosing(): void
  settleStartup(): Promise<void>
  /** Join admitted command tails and startup without stopping or bounding them. */
  awaitAcceptedWork(): Promise<void>
  hasAcceptedWork(): boolean
  joinOrderedWork(): Promise<void>
  /** Whether the chat is an empty chat, which a close removes. */
  shouldTombstone(): Promise<boolean>
  /** Apply `disposition` (for a close, tombstone a blank transient,
   *  otherwise keep the session inactive) for a settled actor. `disposeAll` drives it after
   *  batch-marking every actor closing and awaiting their startups; the store
   *  entries and actor map are then torn down in bulk. The tombstone-or-deactivate
   *  decision lives here, so the supervisor loop no longer hand-rolls a copy. */
  closeSettled(disposition: ClosingDisposition): Promise<void>
  runtimeState(): Extract<SessionRuntimeView, { kind: "starting" | "failed" }> | null
}
