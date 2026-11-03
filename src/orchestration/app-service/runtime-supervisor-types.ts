import type { WorkflowController } from "../workflow-host/controller.js"
import type { SuccessorRows } from "./project-executor-protocol.js"
import type { CommandKeeper } from "./command-keeper.js"
import type { ChildSessionReconciliation, ChildSessionReconciliationOptions } from "../session/child-session-reconciliation.js"
import type { SessionChangesUndo, SessionChangesUndoResult } from "../../protocol/session-changes-protocol-types.js"
import type { ChatInputLike } from "../../infra/chat-input.js"
import type { ProjectDirectories } from "../../infra/directory-authorities.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import type { EventStoreRuntime } from "../../infra/event-store-effect.js"
import type { PublishedWorkflowLaunch } from "../agent-runtime/tools/workflow-tool.js"
import type { ChatRunnerDeps } from "../chat/runner.js"
import type { ChatRunner } from "../chat/runner-types.js"
import type { AgentInputAnswer } from "../../protocol/question-protocol-types.js"
import type { SessionManager } from "../session/manager.js"
import type { SessionKind } from "../session/types.js"
import type { SessionStore } from "../session-store/types.js"
import type { SessionViewLoader } from "../session-store/view.js"
import type { SessionRuntimeView, SessionTitlePatch } from "../../protocol/app-service-types.js"
import type { ModuleServices } from "../../infra/module-service.js"
import type { ProjectDefinitionRegistry } from "../../workflows/definition-registry.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { CommandHandoverAuthority } from "../agent-runtime/command-handover.js"
import type { ChildSessionControl } from "../session/child-session-control.js"
import type { PersistentProcessClient } from "../../infra/persistent-process-manager.js"
import type { BridgedPersistentProcessClient } from "../../infra/persistent-process-bridge.js"
import type { KeyResolver } from "../../infra/auth/resolve-key.js"
import type { WorkflowsMode } from "../../protocol/module-protocol-types.js"
import type { ModulePolicy } from "../config/module-policy.js"
import type { ModelWorkflowLaunchRequest, WorkflowLaunchRefusal } from "../workflow-host/launch-origin.js"
import type { TranscriptProjectionCache } from "./transcript-projection-cache.js"
import type { ChatRunnerLoader } from "./chat-runner-loader.js"
import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import type { ControlInterruption, WorkflowInterruption } from "../session/conversation/turn-end-record.js"
import type { ContinuationLanes } from "../session/planned-session-continuation.js"
import type { ModuleRetainedOperationAuthority, RetainedOperationAcceptance } from "../module-seams.js"
import type { SessionStops } from "../session/module-session-operations.js"
import type { WorkflowDeliveryAddress } from "../session/conversation/addressed-workflow-messages.js"

interface AgentInputAnswers {
  readonly [question: string]: AgentInputAnswer
}
/** The outcome of a chat send. Success means the chat accepted the input: an
 *  attached runner took it, or, with no runner attached, the input is durable in
 *  the conversation. A cold send resolves at that commit and does not wait for
 *  the runner it starts; that runner takes the input when it attaches, and a
 *  startup failure shows in the session, not in this outcome (ARCH-SUBSTRATE-036).
 *  `confirmedSubmissionIds` is the receipt for a message the conversation
 *  already held under its submission: a resend that recorded nothing
 *  (ARCH-SESSIONS-030). The failure variant carries the reason, such as a
 *  durable-write error or a missing session, so the handler can tell them
 *  apart. */
export type SendChatOutcome =
  | { readonly ok: true; readonly confirmedSubmissionIds?: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/** Why a resume did not start a request, in words a client shows: nothing
 *  waits, a turn already runs, or the runner refused. */
export type ResumeChatOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** Why a person's answer or skip did not settle a question: someone already
 *  answered or skipped it, it no longer waits (withdrawn, unreadable, or never
 *  asked), the answer does not fit its choices, or the session is not one
 *  that asks the person. */
export type QuestionRefusal = "already_answered" | "already_skipped" | "not_pending" | "invalid_answer" | "not_chat"

/** The outcome of a person's answer or skip. Success means the settlement is
 *  durable; the turn it continues reports through the session. */
export type QuestionSettlementOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: QuestionRefusal }

export interface DiscardTransientOutcome {
  readonly removed: boolean
}

export interface RuntimeSupervisorDeps {
  readonly workflowHosts: import("../workflow-host/host-collection.js").WorkflowHosts
  readonly undoChanges: (request: SessionChangesUndo, signal: AbortSignal) => Promise<SessionChangesUndoResult>
  readonly transcriptCache?: TranscriptProjectionCache
  readonly sessionStore: SessionStore
  readonly manager: SessionManager
  /** Directory authorities every chat runner this supervisor starts resolves
   *  paths from. */
  readonly directories: ProjectDirectories
  readonly runtime: EventStoreRuntime
  readonly store?: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer?: AsyncEventWriter
  readonly runnerCapabilities: () => Promise<RuntimeRunnerCapabilities>
  /** The auth profile a new chat records at creation: the one that serves it. */
  readonly authProfileId: () => string
  /** Stable settlements owned by the composition ledger. */
  readonly lifecycle: {
    /** Aborts every workflow run with the interruption `causeOf` names for
     *  it, then settles the session store. */
    settleSessionStore(causeOf: (sessionId: string) => WorkflowInterruption): Promise<void>
    settleAuthAdmission(): Promise<void>
  }
  readonly onRunnerDone?: (id: string) => void
  readonly onRunnerError?: (id: string, message: string) => void
  readonly startWorkflow?: (request: ModelWorkflowLaunchRequest) => Promise<PublishedWorkflowLaunch | WorkflowLaunchRefusal>
  /** Resumes a workflow after the person settles a question that an agent of
   *  a workflow of an earlier build left open (PI-AGENT-024). Remove after 2027-04-03. */
  readonly resumeWorkflow?: WorkflowController["resumeWorkflow"]
  readonly retainedOperations?: readonly ModuleRetainedOperationAuthority[]
  /** Installed kind owners' Stop of a bound child (`bindSessionStops`). */
  readonly sessionStops?: SessionStops
  readonly reconcileChildSessionCompletions?: (
    parentSessionId: string,
    options?: ChildSessionReconciliationOptions,
  ) => Promise<ChildSessionReconciliation>
  readonly sessionViewLoader?: SessionViewLoader
  /** The handoff of the account's planned replacement, once its cut has
   *  begun: the account's one replacement state, as this executor last
   *  heard it. The stop reads it and runs the cut's steps for what the cut
   *  has not reached. Absent in a composition no account serves. */
  readonly replacementHandoff?: () => string | undefined
  /** The executor's one set of continuation lanes, shared with every other
   *  owner of a step that decides a session's planned continuation, so the
   *  cut's steps and a person's interrupt of a session take turns. */
  readonly continuationLanes: ContinuationLanes
  /** Whether a client holds the project as this supervisor stops, as the
   *  account's stop request says. Each tab such a client shows attaches its
   *  session again, so the stop keeps every empty chat for it. A stop that no
   *  client holds the project through removes the project's empty chats:
   *  each one open here, as the close of its tab does, and each paused one
   *  (PI-INTERACTION-075, ARCH-RUNTIME-024). */
  readonly clientsHold: () => boolean
  /** Told once, when the stop begins after the executor heard a handoff and
   *  before the stop's first step: every host that closes from then on
   *  closes for the replacement, and hands its running commands over. */
  readonly onReplacementStop?: () => void
  /** The executor's keeper of handed-over commands no session host holds.
   *  Stop reaches a kept command through it, and the stop closes it once
   *  every host has closed with its runner, so at a planned replacement its
   *  commands are handed over and counted with the rest. Absent where no
   *  account serves. */
  readonly keeper?: Pick<CommandKeeper, "terminate" | "close">
  /** Override the grace a lifecycle command waits for an in-flight startup to
   *  settle before tearing down. Defaults to the production constant; tests set it
   *  small so a deliberately-wedged cold-start can be asserted without a real wait. */
  readonly closeStartupGraceMs?: number
}

export interface RuntimeRunnerCapabilities {
  readonly rootChatCompletion?: (sessionId: string) => ChatRunnerDeps["rootChatCompletion"]
  readonly runnerLoader: ChatRunnerLoader
  readonly definitions: ProjectDefinitionRegistry
  readonly moduleSelection: ChatRunnerDeps["moduleSelection"]
  readonly proactiveCompactionThreshold?: () => number
  readonly idleCompaction?: ChatRunnerDeps["idleCompaction"]
  readonly workflowMode: () => WorkflowsMode
  readonly capabilities?: Pick<ModulePolicy, "admit" | "state">
  readonly moduleServices?: ModuleServices
  readonly launcher?: LauncherScope
  readonly commandHandover?: CommandHandoverAuthority
  /** The parent agent's controls of the children it started, which its
   *  `process` and `message_session` tools use. */
  readonly childSessions: ChildSessionControl
  readonly persistentProcesses?: PersistentProcessClient | BridgedPersistentProcessClient
  readonly allowPersistentProcesses?: () => boolean | Promise<boolean>
  readonly resolveKey: KeyResolver
  readonly authAdmission: ChatRunnerDeps["authAdmission"]
  readonly subscribeProfiles: ChatRunnerDeps["subscribeProfiles"]
  readonly startWorkflow?: (request: ModelWorkflowLaunchRequest) => Promise<PublishedWorkflowLaunch | WorkflowLaunchRefusal>
  readonly recall: (conversationId: string, contract: RecallInput) => Promise<RecallResult>
}

export interface RuntimeSupervisor {
  claimComposerReturns(sessionId: string, submissionIds: readonly string[]): Promise<import("../../protocol/composer-returns.js").ClaimComposerReturnsResult>
  reconcileChildSessionCompletions(parentSessionId: string): Promise<ChildSessionReconciliation>
  undoChanges(request: SessionChangesUndo): Promise<SessionChangesUndoResult>
  /** Opens a new chat. A name gives it that catalog name in place of
   *  "New Chat" and a generated title, as a workflow launch's parent takes. */
  openSessionRuntime(options?: { readonly name?: string }): Promise<string>
  adoptBlankChat(options: { readonly sessionId: string; readonly conversationId: string; readonly description: string }): void
  forkSession(sourceSessionId: string): Promise<string>
  ensureChatRunner(sessionId: string): Promise<ChatRunner>
  /** The kind of a session this runtime reaches: a chat the store holds,
   *  which can have no durable row yet, or the kind of its durable row.
   *  Nothing for a session that does not exist. */
  sessionKind(sessionId: string): Promise<SessionKind | undefined>
  /** A person's message to a chat, which starts or joins its turn. */
  sendChat(sessionId: string, input: ChatInputLike): Promise<SendChatOutcome>
  /** Persist module work before admitting it to the chat's ordinary save point. */
  acceptRetainedOperation(sessionId: string, operation: RetainedOperationAcceptance): Promise<boolean>
  /** Opens the session and attaches its runner. `shown` when a client shows it, which the client's hold keeps until its
   *  release (`releaseSession`); absent when the runtime opens it for work of its own. */
  activateSession(sessionId: string, options?: { readonly shown?: true }): Promise<boolean>
  /** No client shows the session any more: its runner ends once its turn is
   *  at rest, and the durable session stays as it is (ARCH-RUNTIME-023). Resolves
   *  when the session's actor has taken the release, not when the runner
   *  ends. */
  releaseSession(sessionId: string): Promise<void>
  /** No client shows the session, while its runner stays for a client that
   *  comes back: its idle engines stop (ARCH-PROVIDERS-006), and a later
   *  activation that shows it starts them again. A session that no actor
   *  holds has nothing to stop, and this creates no actor. Resolves when the
   *  session's actor has taken the hide. */
  hideSession(sessionId: string): Promise<void>
  /** Closes the chat now: its work ends, an empty chat is removed, and any
   *  other chat turns inactive. With `atRest`, the close of its tab, no work
   *  ends: the chat closes when its turn comes to rest, unless an activation
   *  comes first. Resolves when the close is done or, with `atRest`, when it
   *  waits for the turn. */
  closeChat(sessionId: string, atRest?: true): Promise<boolean>
  discardTransientChat(sessionId: string): Promise<DiscardTransientOutcome>
  deleteSession(sessionId: string, inactiveBefore?: number): Promise<boolean>
  renameSession(sessionId: string, patch: SessionTitlePatch): Promise<boolean>
  reorderSession(sessionId: string, beforeSessionId: string | null): boolean
  /** Resolve a notice scope on a session's store entry. Out-of-actor: a
   *  dismissal is a store patch, never runner coordination. */
  dismissNotice(sessionId: string, scope: string): boolean
  /** The one Interrupt of a session, a chat, a workflow, or a subagent, by
   *  a person or by the child's parent agent: a running turn, step, or run
   *  is cut before this returns its promise, and a session that a successor
   *  owes its continuation records the turn end that names `by` over the
   *  planned cut. A chat has no parent, so only a person interrupts it.
   *  Workflow addresses select only reached attempts and preserve sibling
   *  successor work. Answers whether anything was interrupted. */
  interruptSession(sessionId: string, by: ControlInterruption, address?: WorkflowDeliveryAddress): Promise<boolean>
  /** Continues a chat's interrupted or unexpectedly exited turn with no new message. */
  resumeChat(sessionId: string): Promise<ResumeChatOutcome>
  releaseForegroundBash(sessionId: string, toolUseId: string): boolean
  terminateBackgroundWork(sessionId: string, toolUseId: string): Promise<void>
  answerQuestion(sessionId: string, toolUseId: string, answers: AgentInputAnswers): Promise<QuestionSettlementOutcome>
  cancelQuestion(sessionId: string, toolUseId: string): Promise<QuestionSettlementOutcome>
  compactChat(sessionId: string): Promise<boolean>
  /** Runs the durable-learning review of the session's conversation now; false when current policy refuses it. */
  reviewChat(sessionId: string): Promise<boolean>
  /** Delivers `input` as the session's next turn with request-only `context` the model reads once. */
  requestChatContext(sessionId: string, input: ChatInputLike, context: string): Promise<boolean>
  recallQueuedMessage(sessionId: string): Promise<ChatInputLike | null>
  /** Fire the chat runner's cold-start warm-up. Reached through the app
   *  service's warmBackground (first-frame trigger); never rejects. */
  warmChatRunner(): Promise<void>
  runtimeState(sessionId: string): Extract<SessionRuntimeView, { kind: "starting" | "failed" }> | null
  /** Session actors held by this runtime, not historical project rows. */
  ownedSessionIds(): readonly string[]
  /** Join every actor's admitted tails and startup without closing admission. */
  awaitAcceptedWork(): Promise<void>
  /** A planned replacement's cut: interrupts every running child, chat turn,
   *  and agent of a workflow by the runtime, each with continuation authority for
   *  `handoffId`, and returns the sessions it interrupted. */
  interruptForReplacement(handoffId: string): Promise<readonly string[]>
  /** After a stop that followed a planned replacement's cut: how many rows
   *  its handoff holds in this project for the successor, the continuation
   *  rows of the sessions it resumes and the handover rows of the commands
   *  it adopts. Undefined before the stop, and after a stop that followed no
   *  cut. */
  replacementSuccessorRows(): SuccessorRows | undefined
  disposeAll(): Promise<void>
}

