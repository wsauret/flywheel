import type { ProjectDirectories, StartupDirectories } from "../infra/directory-authorities.js"
import type { LauncherScope } from "../infra/process-supervisor.js"
import type { AsyncEventReadSurface, AsyncEventStateReadSurface, AsyncEventWriter, AsyncGuardedEventWriter, EventPayload, EventStoreAppend, GuardedEventStoreAppend, InFlightSwap, StoredFact } from "../infra/event-store-types.js"
import type { ModuleRuntimes } from "../infra/module-runtime.js"
import type { RetainedOperationHosts } from "../infra/retained-operation-hosts.js"
import type { ModuleServices } from "../infra/module-service.js"
import type { ChildCut } from "./session/child-continuation.js"
import type { ChildRunStatus } from "../protocol/app-service-types.js"
import type { AgentFailureDisplay, AgentGroupBlock, PausedBy, WorkflowCard } from "../infra/output-blocks.js"
import type { SkillRegistryRevision } from "../workflows/skill-schema.js"
import type { AgentLifecycleCallbacks, AgentStreamEvent, ChildConversation } from "./agent-runtime/types.js"
import type { AskUserToolDeps } from "./agent-runtime/tools/ask-user.js"
import type { KernelToolDeps } from "./agent-runtime/tools/kernel-tool-deps.js"
import type { ExternalSkillChildGrant } from "./agent-runtime/tools/skill.js"
import type { SessionFactWriter } from "./session/session-fact-writer.js"
import type { CapabilityAccess, RuntimeToolExecution } from "./agent-runtime/tools/types.js"
import type { ChatInput } from "../infra/chat-input.js"
import type { RecallInput, RecallResult } from "../protocol/conversation-recall.js"
import type { ReplayedSession, RoleSettings } from "./session/schemas.js"
import type { SessionManager } from "./session/manager.js"
import type { LiveChildControl } from "./session/live-session-control.js"
import type { UnreadSettlement } from "./session/session-input-delivery.js"
import type { HeldBackgroundNotification } from "./session/conversation/queued-background-notifications.js"
import type { ModuleId } from "../protocol/module-ids.js"
import type { RuntimeEvent } from "../infra/runtime-event-types.js"
import type { FlywheelEvent } from "../infra/events.js"
import type { RecordedRuntimeInvocation } from "../infra/runtime-fact-types.js"
import type { MetricsWriter } from "./session/create-session-infra.js"
import type { ActiveBackgroundCommandDescriptor, BackgroundWorkTracking } from "./agent-runtime/background-work.js"
import type { RoleResolver } from "./config/roles.js"
import type { ConversationMessage } from "./agent-runtime/llm/types.js"
import type { WorkflowDeliveryAddress } from "./session/conversation/addressed-workflow-messages.js"
import type { ChildExecutionResources } from "./session/child-execution-resources.js"
import type { WorkflowRunCut, WorkflowRunReader, WorkflowRunWriter } from "./workflow-host/run-record.js"
import type { WorkflowPublication, WorkflowLaunchBinding } from "./session/child-session-publication.js"
import type { WorkflowSessionFact } from "../workflows/vm/session-facts.js"

/** Installed run reads stay available when new workflow admission is disabled. */
/** Where workflows sit in the session tree, for an owner that walks
 *  ancestors on every commit. */
export interface WorkflowPlacements {
  /** The session that launched `workflowId`, or undefined for a workflow the
   *  store does not hold. Makes no durable request after the first read until
   *  `observe` meets a placement fact or a batch after facts it never met. */
  parent(workflowId: string): Promise<string | undefined>
  /** Advances the placements by a committed batch. A caller passes every
   *  batch it observes, before it reads. */
  observe(events: readonly StoredFact[]): void
}

export interface ModuleWorkflowRuns {
  protocolServices(input: {
    readonly modules: ModuleServices
    readonly projectRoot: string
    readonly controller: import("./workflow-host/controller.js").WorkflowController
    readonly auth: import("./workflow-host/auth-owner.js").WorkflowAuthOwner
    readonly authStatus: Pick<import("./app-service/auth-status-projection.js").AuthStatusProjection, "view">
    readonly supervisor: Pick<import("./app-service/runtime-supervisor-types.js").RuntimeSupervisor, "interruptSession">
    readonly deletion: Pick<SessionManager, "admitDeletion" | "finalizeDeletionTarget">
    readonly bus: import("./app-service/runtime-ui-bus.js").RuntimeUiBus
    readonly hosts: Pick<import("./workflow-host/host-collection.js").WorkflowHosts, "isRunning" | "onChange" | "abort">
  }): ModuleServices
  cut(workflowId: string, cut: WorkflowRunCut | null): EventStoreAppend
  deleted(reader: AsyncEventStateReadSurface, workflowId: string): Promise<boolean>
  settles(facts: readonly WorkflowSessionFact[]): boolean
  /** Conversion registration alone does not make a historical result stale. */
  hasExecutionAfter(facts: readonly StoredFact[], position: number): boolean
  readonly work: ModuleWorkControl<WorkflowWorkTarget>
  state(input: WorkflowWorkTarget): Promise<import("./session/session-messaging.js").SessionListState>
  /** Where the workflows of `reader` sit in the session tree. */
  placements(reader: AsyncEventReadSurface): WorkflowPlacements
  readonly accounting: {
    readonly factTypes: readonly string[]
    ancestry(event: StoredFact): { readonly owner: string; readonly parent: string } | null
  }
  hosts(input: {
    readonly runtime: import("../infra/event-store-effect.js").EventStoreRuntime
    readonly projectionReader: AsyncEventStateReadSurface
    readonly attachChildProjection: AttachChildSessionProjection
  }): import("./workflow-host/host-collection.js").WorkflowHosts
  create(reader: AsyncEventStateReadSurface): WorkflowRunReader
  settings(reader: AsyncEventReadSurface): Pick<WorkflowRunReader, "read">
  /** Run settings changes that invalidate each member's next-request selection. */
  roleChanges(facts: readonly StoredFact[]): readonly string[]
  writer(reader: AsyncEventStateReadSurface, commit: SessionManager["commitWorkflow"]): WorkflowRunWriter
  registration(input: WorkflowPublication, executionCwd: string, now: string): readonly WorkflowSessionFact[]
  startedAttempt(facts: readonly WorkflowSessionFact[]): { readonly attemptId: string; readonly conversationId: string } | null
  /** The human title of the session that runs `attemptId`, which its creation writes as its label. */
  agentTitle(reader: AsyncEventStateReadSurface, workflowId: string, attemptId: string): Promise<string | undefined>
  adoption(binding: WorkflowLaunchBinding, now: string): WorkflowSessionFact
  deletion(workflowId: string, now: number): readonly EventStoreAppend[]
  settleDeletion(input: Omit<Parameters<ModuleSessionDeletion["settle"]>[0], "sessionId" | "session"> & {
    readonly workflowId: string
    readonly run: import("./workflow-host/run-record.js").WorkflowRunRecord
  }): Promise<void>
}

export interface DefinitionReconciliationInput {
  readonly directories: ProjectDirectories
  readonly capabilities: Pick<CapabilityAccess, "admit">
}

/** Delivers a child's completion notice, which the parent's reconciliation
 *  just held, to the runner the parent has attached in this process, the
 *  same way a live child's completion reaches it: a parked parent wakes, and
 *  a running turn takes the notice at its next boundary. False when no
 *  runner of the parent is attached here: the notice stays held, and the
 *  parent's next activation, message, or Resume delivers it. */
export type ParentNotificationDelivery = (parentSessionId: string, notification: HeldBackgroundNotification) => Promise<boolean>

/** The one tool whose call a runtime invocation records in a parent chat
 *  (`tool.runtime_invocation.recorded`): the call that a person's command, a
 *  headless run, or an adoption makes with no model. Kernel readers build the
 *  timeline entry of such a call from this owner and recognize the tool's
 *  calls by it, so a runtime call and a model's call of the tool read alike
 *  in the card, the result display, and child reconciliation. */
export interface ModuleRuntimeInvocationTool {
  readonly name: string
  readonly execution: Required<RuntimeToolExecution>
  /** The call input, in the words of the tool's own schema, that one
   *  recorded invocation of any version stands for. */
  input(operation: RecordedRuntimeInvocation["operation"]): { readonly [key: string]: unknown }
}

/** Installed kind owner settles durable work before deletion removes its facts. */
export interface ModuleSessionDeletion {
  readonly kind: ReplayedSession["kind"]
  settle(input: {
    projectRoot: string
    sessionId: string
    session: ReplayedSession
    reader: AsyncEventStateReadSurface
    projectionReader: AsyncEventStateReadSurface
    writer: AsyncEventWriter
    abort?: (sessionId: string) => Promise<void>
    /** Absent where no runner can be attached, such as startup recovery. */
    deliverNotification?: ParentNotificationDelivery
  }): Promise<void>
}
/** What a kind owner's control of one child reads and runs: the
 *  composition's hosts, module services, and store (`reader` is the store
 *  that keys live run controls). */
export interface ChildSessionPorts {
  readonly hosts: RetainedOperationHosts
  readonly modules: ModuleServices
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly projectRoot: string
  readonly deliverNotification: ParentNotificationDelivery
}

/** One child that a parent's call launched, resolved from its durable
 *  binding. */
export interface ChildSessionTarget extends ChildSessionPorts {
  readonly sessionId: string
  readonly session: ReplayedSession
}
export interface WorkflowWorkTarget extends ChildSessionPorts {
  readonly workflowId: string
  readonly run: import("./workflow-host/run-record.js").WorkflowRunRecord
}

/** The answer of a child control: done, or why not, in words the parent
 *  reads. */
export type ChildControlAnswer = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** A Stop reports the durable outcome, which can have won before the request. */
export type ChildStopAnswer =
  | { readonly ok: true; readonly status: "completed" | "partial" | "failed" | "stopped" | "cancelled" | "settled" }
  | { readonly ok: false; readonly error: string }

/** Installed kind owner of the children that a parent's call launches. The
 *  kernel resolves the child from its durable binding, never from a runner's
 *  memory, so each control works for every origin of the launch, in every
 *  lifecycle of the child, and after the parent's runner restarts or ends.
 *  The owner reads the host that runs its kind from `hosts`, or settles a
 *  child that no work runs for over the composition's store, so a control
 *  and the live work it cuts have one settlement. The one Interrupt of a
 *  child is the kernel's (`RuntimeSupervisor.interruptSession`), so this
 *  owner holds no interrupt of its own. */
export interface ModuleWorkControl<Target> {
  /** Reattaches an observer of a still-running child without resuming it. */
  restoreTracking?(input: Target & { readonly tasks: BackgroundWorkTracking }): Promise<void>
  /** A Stop by a person or by the parent agent: a person's shows as
   *  Stopped and the parent's as Canceled. A Stop of a call that already
   *  holds a result changes nothing. */
  stop(input: Target & { readonly by: "person" | "agent" }): Promise<ChildStopAnswer>
  /** The parent agent's Resume of its own child. It is admitted only when
   *  `parentMayContinue` admits the child's latest cut, so work that a
   *  person interrupted or stopped continues only when a person continues
   *  it. */
  resume(input: Target & { readonly address?: WorkflowDeliveryAddress }): Promise<ChildControlAnswer>
  /** The latest cut that the child waits on, or nothing for a child that no
   *  cut ended. */
  cut(input: Target): Promise<ChildCut | undefined>
  /** Where the child is in its work, as the lines of the parent's status
   *  read, in the owner's own words. They are read from the child's own
   *  records on each call, never stored in the parent, and carry no
   *  handoff content. */
  progress(input: Target): Promise<readonly string[]>
  /** The parts of the child that a message can address, one line each,
   *  as both `process list` and `process status` show them: the items of a
   *  workflow's lists and its agents. A kind with no such parts has none. */
  addresses?(input: Target): Promise<readonly string[]>
}
export interface ModuleChildSession extends ModuleWorkControl<ChildSessionTarget> {
  readonly kind: "subagent"
}
export interface ModuleDefinitionReconciliation {
  prepare(input: DefinitionReconciliationInput): Promise<((reader?: AsyncEventStateReadSurface) => Promise<void>) | undefined>
}
export interface ModuleMaintenanceInput {
  readonly directories: StartupDirectories
  readonly launcher: LauncherScope
  /** The project's store, read through the state Worker. */
  readonly reader: AsyncEventStateReadSurface
  /** Every maintenance write reaches the project's one writer through this
   *  port, so a live project's committed facts have one source (ARCH-SUBSTRATE-018). */
  readonly writer: AsyncGuardedEventWriter
  readonly signal: AbortSignal
}
export interface ModuleMaintenance {
  readonly phase: "before-store" | "after-store"
  run(input: ModuleMaintenanceInput): Promise<void>
}

/** A module constructs its own projections when one chat generation begins. */
export interface ModuleChatObserverContext {
  readonly sessionId: string
  readonly eventStore: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventReadSurface
  readonly writer: SessionFactWriter
  readonly enqueueSilentSystem: (message: string) => void
  readonly showSystemMessage: (message: string) => void
}

export interface ModuleChatObserver {
  onEvent?(event: AgentStreamEvent): void
  onTurnComplete?(reason: "turn_end"): Promise<void>
  onCompactionContinuation?(): Promise<void>
  dispose?(): void | Promise<void>
}

export interface SkillChildGrantContribution {
  readonly order: number
  readonly create: (input: { readonly modules: ModuleRuntimes; readonly revision: SkillRegistryRevision }) => ExternalSkillChildGrant | undefined
}

export interface MemoryContribution {
  readonly snapshot: (directories: Pick<ProjectDirectories, "projectRoot" | "accountHome">) => string | null
}

export interface QuestionDecisionContribution {
  readonly tool: string
  readonly create: (input: { readonly kernel: KernelToolDeps; readonly modules: ModuleRuntimes }) => Pick<AskUserToolDeps, "workflowLaunch" | "definitionOverrideProposal">
}

/** Exact UTF-8 content keyed by a path inside one managed package. */
interface ManagedPackageFiles { readonly [path: string]: string }
export type ManagedPackageMutation =
  | { readonly kind: "replace_package"; readonly name: string; readonly files: ManagedPackageFiles }
  | { readonly kind: "remove_package"; readonly name: string }
type ManagedPackageWriteResult = { readonly kind: "written"; readonly auditPending?: boolean } | { readonly kind: "refused"; readonly error: string }
export type ManagedPackageReach = "global" | "project"
export interface ManagedPackageWrites {
  readonly review: boolean
  readonly consent?: { readonly store: AsyncEventStateReadSurface; readonly sessionId: string }
  /** Plans the mutation and writes nothing. It answers the refusal the
   *  publication would give now, so a caller can refuse before it asks the
   *  person and before it spends an approval. */
  check(input: { readonly projectRoot: string; readonly mutation: ManagedPackageMutation; readonly reach: ManagedPackageReach }): string | undefined
  applyGlobal(input: { readonly projectRoot: string; readonly mutation: ManagedPackageMutation; readonly toolUseId: string; readonly writer: SessionFactWriter }): Promise<ManagedPackageWriteResult>
  applyProject(input: { readonly projectRoot: string; readonly mutation: ManagedPackageMutation; readonly writer: SessionFactWriter }): Promise<ManagedPackageWriteResult>
}

interface WorkspaceMigrationContext {
  readonly dbFile: string
  readonly directories: ProjectDirectories
}
export interface WorkspaceMigration {
  readonly phase: "definition-overlays" | "stored-facts" | "startup-recovery"
  readonly order: number
  readonly label: string
  readonly requiresExclusiveOwner?: true
  /** Required conversions refuse a shared start while historical input remains. */
  readonly requiredWhen?: (context: WorkspaceMigrationContext) => boolean
  run(context: WorkspaceMigrationContext): void
}

/** Published transcript metadata. The module retains its private run ledger. */
interface ToolHistorySummaryBase {
  readonly toolUseId: string
  readonly duration?: number
  readonly activeStartedAt?: number
  readonly totalTokens?: number
  readonly totalToolCount: number
  readonly model?: string
  readonly linkUri?: string
  /** Ordinary members whose live turns take precedence over recorded aggregate pauses. */
  readonly memberSessionIds?: readonly string[]
  readonly description?: string
  /** The selected attempt's handoff summary sentence, absent without a string summary. */
  readonly summary?: string
  /** The run's persona name, which labels a retry or resume row. */
  readonly agentType?: string
  /** A workflow run's bounded fold of its plan, which its card draws. */
  readonly card?: WorkflowCard
  /** A workflow run's name, which its card names in place of the name its
   *  launching call gave, such as the file name of a launched file. */
  readonly label?: string
  readonly ownsSettlement: boolean
  /** Ordered attempts of this parent call, derived from the child's run facts.
   * Accepted Resume calls identify the attempt admitted before their acknowledgement. */
  readonly attempts?: readonly {
    readonly summary: ToolHistorySummary
    readonly resumes: readonly { readonly toolUseId: string; readonly sameRun: boolean }[]
  }[]
}
/** The card state a run's history settles to: the same variants the card
 *  block carries, so a paused run names who paused it and a failed run its
 *  failure at the one place the status is read. */
type ToolHistorySummaryState =
  | { readonly status: Exclude<AgentGroupBlock["status"], "paused" | "error"> }
  | { readonly status: "paused"; readonly pausedBy: PausedBy }
  | { readonly status: "error"; readonly failure: AgentFailureDisplay }
export type ToolHistorySummary = ToolHistorySummaryBase & ToolHistorySummaryState
export interface SessionToolSummarySnapshot {
  readonly position: number
  /** Each run's state. Its figures are the ones the run's own facts record. */
  readonly summaries: ReadonlyMap<string, ToolHistorySummary>
  readonly changedToolUseIds: ReadonlySet<string>
  /** The summary with the figures its run's history measures, which a card
   *  states. A replay reads no run's history, so a transcript pays only for
   *  the cards it reads: the runs asked in one synchronous pass share one
   *  read, and a summary is measured once. A summary whose owner does not
   *  measure comes back unchanged. A live measurement returns accumulated time
   *  and its open interval as one coherent clock. */
  measure(summary: ToolHistorySummary, live?: boolean): Promise<ToolHistorySummary>
}
export interface SessionToolSummaryReader {
  replay(): Promise<SessionToolSummarySnapshot>
  /** Releases what the reader keeps held beyond its own lifetime, such as the
   *  pins of the projections it measures. Its owner calls it when it drops the
   *  reader. Idempotent; a reader that holds nothing omits it. */
  dispose?(): void
}
export interface SessionHistoryRecoveryInput {
  readonly sessionId: string
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly projectRoot: string
  readonly fallbackConversationId?: string
  readonly protectedToolUseIds?: ReadonlySet<string>
}
/** How a module's durable session history reads. The installed catalog supplies it, so a disabled module's history
 *  reads the same. */
export interface ModuleSessionHistory {
  createToolSummaryReader?(reader: AsyncEventStateReadSurface, sessionId: string): SessionToolSummaryReader
  recover?(input: SessionHistoryRecoveryInput): Promise<void>
  /** The request framing of a hidden entry that an earlier build of the module wrote into the conversation without
   *  its current label. The conversation reader applies it to the messages that it returns, never to the stored bytes. */
  readonly framing?: ModuleHistoricalFraming
}

/** `content` is the text of a system-origin user entry that is unlabeled or labeled `claude`, and `next` the message
 *  after it in the reconstructed history. Undefined keeps the entry's label. */
export type ModuleHistoricalFraming = (content: string, next: ConversationMessage | undefined) => NonNullable<Extract<ConversationMessage, { kind: "user" }>["framing"]> | undefined

export type ModuleSessionFact = {
  readonly type: string
  readonly version: number
  readonly actor: string
  readonly payload: EventPayload
}

export interface ChildSessionRun {
  readonly childSessionId?: string
  readonly childRunId: string
  readonly status: ChildRunStatus
  readonly modelRequestId?: string
  readonly conversationId?: string
  readonly parentSessionId?: string
  readonly parentConversationId?: string
  readonly parentToolUseId?: string
  readonly agentType: string
  readonly personaKind?: "general" | "persona"
  readonly capabilityGrant?: NonNullable<CapabilityAccess["grant"]>
  readonly admittedModuleIds?: readonly ModuleId[]
  readonly skillsRevision?: number
  readonly description: string
  readonly model?: string
  readonly effort?: string
  readonly maxTurns?: number
  readonly maxTokens?: number
  readonly executionCwd?: string
  readonly prompt?: string
  readonly task?: string
  readonly promptToolNames?: string[]
  readonly interruptionReason?: "runtime_restarted"
  readonly pausedBy?: PausedBy
  readonly continuationCount?: number
  readonly modelFailure?: true
  readonly durationMs?: number
  readonly totalTokens?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadInputTokens?: number
  readonly cacheCreationInputTokens?: number
  readonly reasoningTokens?: number
  readonly totalCostUsd?: number
  readonly toolUses?: number
  readonly resultPreview?: string
  readonly result?: string
}

interface PublishChildSessionExecution {
  readonly childSessionId: string
  readonly childConversationId: string
  readonly parentSessionId: string
  readonly parentConversationId: string
  readonly parentToolUseId: string
  readonly description: string
  readonly executionCwd: string
  readonly authProfileId: string
  readonly initialRoles: RoleSettings
  readonly runBinding: GuardedEventStoreAppend
  readonly promptFact: GuardedEventStoreAppend
  /** The parent conversation that a fork starts from. */
  readonly forkHistory?: readonly ConversationMessage[]
  /** The words the child works on, which its conversation starts with as a
   *  message from the parent. */
  readonly assignment: string
}

export interface ChildSessionConversation extends ChildConversation {
  commitQueuedUserInput(input: import("./session/conversation/queued-user-inputs.js").QueuedUserInputCell): Promise<"committed" | "contended">
  /** Records the child's turn end as interrupted by `by`, the record a
   *  resumed child and the successor's recovery read. */
  commitTurnEnd(by: import("./session/conversation/turn-end-record.js").TurnInterruption): Promise<import("./agent-runtime/llm/types.js").ConversationMessage>
  /** Holds a background outcome durably for the child's next run, which
   *  commits it into the conversation before it reads its context. A key
   *  names the hold, so a repeat of the outcome commits once: nothing is held
   *  for a key the conversation already committed. */
  holdBackgroundNotification(text: string, notificationKey?: string): Promise<import("./session/conversation/queued-background-notifications.js").HeldBackgroundNotification | undefined>
  /** Commits a held background outcome into the conversation now, for a
   *  child whose first request has not run yet. */
  commitBackgroundNotification(notification: import("./session/conversation/queued-background-notifications.js").HeldBackgroundNotification): Promise<string | null>
  /** Commits a runtime-produced user turn, such as the child's task. A key
   *  names the entry, so a key the conversation already holds commits nothing. */
  commitSystemTurn(text: string, idempotencyKey?: string): Promise<string | null>
}

interface PublishedChildSessionExecution extends ChildExecutionResources {
  readonly resolveRoles: RoleResolver
  /** Publishes a guarded failure before execution starts, leaving held input untouched.
   * Rejects if the original publication changed or the failure cannot be recorded. */
  failBeforeStart(error: unknown): Promise<void>
}

/** A borrowed live view. The child execution owns its disposal after durable settlement. */
interface ChildSessionProjection {
  onEvent(event: RuntimeEvent | FlywheelEvent): void
  /** Projects a durably accepted message until its canonical user echo
   *  sends the queued batch. The row shows the raw arguments of an inline
   *  invocation, the identities its sending client shows it under, and the
   *  session that sent it. */
  queueUserMessage(input: ChatInput): void
  /** Withdraws a queued row and flushes it; the returned operation restores it on storage failure. */
  withdrawQueuedMessage?(dispatchIds: readonly string[]): (() => void) | null
  lifecycle: Pick<AgentLifecycleCallbacks, "onTurnParked" | "onTurnResumed" | "onLoginWait" | "onLogicalTurnStarted" | "onConnectionState">
  updateMetrics: MetricsWriter
  /** States the child's running background commands on its own session
   *  entry, whose status names them, as a chat runner's does. */
  updateBackgroundCommands(commands: readonly ActiveBackgroundCommandDescriptor[]): void
  updateForegroundBash(ids: readonly string[]): void
  /** States the operations that a workflow agent's running attempt has
   *  counted on the agent's own session entry. */
  updateOperations(operations: number): void
  dispose(): Promise<void>
}

export type AttachChildSessionProjection = (input: ChildSessionKind & {
  readonly sessionId: string
  readonly conversationId: string
  readonly description: string
  readonly executionCwd: string
  readonly eventStore: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
}) => Promise<ChildSessionProjection>

/** The kind of a child session, with the workflow an agent of a workflow
 *  belongs to. */
export type ChildSessionKind =
  | { readonly kind?: "subagent" }
  | { readonly kind: "workflow-agent"; readonly workflowId: string }

type RunnableChildSessionRun = ChildSessionRun & Required<Pick<
  ChildSessionRun,
  "conversationId" | "parentSessionId" | "parentConversationId" | "parentToolUseId" | "prompt" | "executionCwd" | "task"
    | "promptToolNames" | "personaKind" | "capabilityGrant" | "admittedModuleIds" | "skillsRevision" | "maxTurns" | "maxTokens"
>>

export type ChildSessionResumeAttempt =
  | { readonly kind: "same_run"; readonly expectedSeq: number }
  | { readonly kind: "new_attempt"; readonly expectedSeq: number }

export interface ChildSessionAuthority {
  /** Reads the child's current saved selection; rejects a missing session or role snapshot. */
  resolveRoles(sessionId: string, capture?: Parameters<RoleResolver>[0]): ReturnType<RoleResolver>
  allocateId(): string
  childDepth(parentSessionId: string): Promise<number>
  publish(input: PublishChildSessionExecution): Promise<PublishedChildSessionExecution>
  reconcileParentCompletion(parentSessionId: string, deliverNotification?: (notification: HeldBackgroundNotification) => Promise<boolean>): void
  /** Joins accepted parent reconciliation before its reader and writer close.
   * Rejects after all accepted work settles if any publication failed. */
  settleReconciliation(): Promise<void>
  /** Registers a running child as live in this process until it settles. */
  registerLiveControl(control: LiveChildControl): () => void
  /** Settles the unread messages of a child run that ends (ARCH-SESSIONS-031), through
   *  the project's reader and writer, which a dispatch does not hold, and
   *  hands each returned notice to the live run of its sender. */
  settleUnreadMessages(settlement: UnreadSettlement): Promise<boolean>
  /** Settles a paused child's lifecycle: its run keeps its binding, its session goes inactive. */
  deactivate(childSessionId: string): Promise<void>
  /** Publishes a new attempt of a child whose run settled without
   *  completing: a new run binding and prompt in the same child session. */
  publishNewAttempt(input: Omit<PublishChildSessionExecution, "forkHistory" | "assignment">): Promise<PublishedChildSessionExecution>
  prepareResume(input: {
    readonly childSessionId: string
    readonly parentSessionId: string
    readonly parentConversationId: string
  }): Promise<{
    readonly ok: true
    readonly run: RunnableChildSessionRun
    readonly attempt: ChildSessionResumeAttempt
  } | { readonly ok: false; readonly error: string }>
  publishResume(input: Omit<PublishChildSessionExecution, "runBinding" | "forkHistory" | "assignment"> & { readonly expectedSeq: number }): Promise<PublishedChildSessionExecution>
}

export interface ModuleChildSessionHistory {
  readonly factTypes: readonly string[]
  /** The retained child's persona identity, read once by the serving projection. */
  readAgentType(reader: AsyncEventStateReadSurface, sessionId: string): Promise<string | undefined>
  prepareOwnershipRecovery(sessionId: string, input: {
    readonly childRunId: string
    readonly parentSessionId: string
    readonly parentConversationId: string
  }): EventStoreAppend
  loadRuns(events: readonly StoredFact[]): readonly ChildSessionRun[]
  readRuns(reader: AsyncEventStateReadSurface, sessionId: string): Promise<readonly ChildSessionRun[]>
  /** The runs of each named child of `parentSessionId`, from one held fold
   *  of the parent's children: every run of a child that maps to undefined,
   *  and only the runs that the new facts of the others name. */
  readParentReconciliationRuns(reader: AsyncEventStateReadSurface, parentSessionId: string, children: ReadonlyMap<string, readonly StoredFact[] | undefined>): Promise<ReadonlyMap<string, {
    readonly runs: readonly ChildSessionRun[]
    readonly latestRunId: string | undefined
  }>>
  /** Keeps the fold that `readParentReconciliationRuns` advances for an open
   *  parent until the returned release, which is idempotent. */
  holdParentReconciliationRuns(reader: AsyncEventStateReadSurface, parentSessionId: string): () => void
  prepareCompleted(sessionId: string, input: {
    readonly childRunId: string
    readonly status: "completed" | "failed" | "cancelled" | "stopped"
    readonly isError: boolean
    readonly content: string
    readonly durationMs: number
  }): EventStoreAppend
  prepareResumed(sessionId: string, input: {
    readonly childRunId: string
    readonly authorizationId: string
    readonly continuation: number
  }): EventStoreAppend
  createAuthority(input: {
    readonly manager: Pick<SessionManager, "allocateId" | "publishSubagent" | "read" | "publishActivation">
    readonly eventStore: AsyncEventStateReadSurface
    readonly projectionReader: AsyncEventStateReadSurface
    readonly eventWriter: AsyncEventWriter
    readonly projectRoot: string
    readonly recall: (conversationId: string, contract: RecallInput) => Promise<RecallResult>
    readonly attachProjection?: AttachChildSessionProjection
  }): ChildSessionAuthority
}

export interface SupersededFactInvalidationResult {
  readonly storeFound: boolean
  readonly dbPath: string
  readonly invalidated: readonly { readonly aggregateId: string; readonly supersededFacts: readonly string[]; readonly rowsDeleted: number }[]
  readonly rowsDeleted: number
  readonly upgradable: readonly string[]
}

/** Opaque module-owned work that a conversation writer commits after its turn. */
export interface RetainedOperationAcceptance {
  readonly kind: string
  readonly key: string
  readonly payload: unknown
}

/** What a held operation's commit did with its cell:
 *  - `committed`: published; the writer then joins `dispatch` until the
 *    accepted work has registered with its live owner. A returned settlement
 *    belongs to the parent's accepted-work owner, not the writer drain:
 *    reconciliation can wait for that drain before delivering the result.
 *  - `retained`: a concurrent change contended the publication, so the cell
 *    and every id it reserved wait for the writer's next commit. A commit
 *    of work that an earlier commit already settled answers `committed`.
 *  - `refused`: the work can never start, for a reason the module states in
 *    `notice`. The writer appends the notice under `noticeId` and applies
 *    `retire` to the cell in one guarded batch, so the conversation tells the
 *    person and the model why, and no cell is left to admit a Resume. */
export type RetainedOperationCommitResult =
  | { readonly kind: "committed"; readonly dispatch: () => void | { readonly settlement: Promise<void> } | Promise<void | { readonly settlement: Promise<void> }> }
  | { readonly kind: "retained" }
  | { readonly kind: "refused"; readonly notice: ConversationMessage; readonly noticeId: string; readonly retire: InFlightSwap }

/** The conversation writer orders this work without knowing its module payload. */
export interface HeldRetainedOperation {
  readonly kind: string
  readonly key: string
  commit(): Promise<RetainedOperationCommitResult>
  /** The writer calls it once the commit's record is durable: after a
   *  committed operation's dispatch, or after a refused one's notice lands.
   *  The record lands outside the turn's own events, so the session's owner
   *  reads the conversation again here to show it. */
  readonly landed?: () => void
}

/** Where one accepted operation is stored, with the exact bytes its commit
 *  retires, so a commit never retires a cell another writer replaced. */
export interface RetainedOperationCell {
  readonly sessionId: string
  readonly conversationId: string
  readonly kind: string
  readonly key: string
  readonly raw: string
}

/** Durable identity of deterministic work that a planned replacement carries
 * through the session continuation authority. The module remains responsible
 * for proving whether the accepted cell or its published child still waits,
 * and names the kind of session the work publishes. */
export interface RetainedOperationContinuation {
  readonly kind: string
  readonly key: string
  readonly ownerSessionId: string
  readonly target: RetainedOperationContinuationTarget
  readonly bindingId: string
}

export type RetainedOperationContinuationTarget =
  | { readonly kind: "workflow"; readonly workflowId: string }
  | { readonly kind: "chat" | "subagent"; readonly sessionId: string }

interface RetainedOperationContinuationInput {
  readonly reader: AsyncEventStateReadSurface
  readonly manager: Pick<SessionManager, "read"> & Partial<Pick<SessionManager, "updateLifecycleState">>
}

interface ModuleRetainedOperationContinuation {
  readonly kind: string
  /** Finds accepted work at its pre-publication cell or its post-publication
   * initialized child safe point. */
  pending(input: RetainedOperationContinuationInput & {
    readonly sessionId: string
    readonly conversationId: string
  }): Promise<readonly RetainedOperationContinuation[]>
  /** Proves the work still waits and names the ordinary Resume target. */
  resolve(input: RetainedOperationContinuationInput & {
    readonly operation: RetainedOperationContinuation
  }): Promise<RetainedOperationContinuationTarget | null>
  /** Withdraws only automatic continuation. Accepted work stays resumable. */
  withdraw(input: RetainedOperationContinuationInput & {
    readonly operation: RetainedOperationContinuation
    readonly writer: AsyncEventWriter
  }): Promise<void>
}

export interface ModuleRetainedOperationAuthority {
  readonly kind: string
  accept(input: {
    readonly sessionId: string
    readonly conversationId: string
    readonly operation: RetainedOperationAcceptance
  }): Promise<HeldRetainedOperation>
  read(input: {
    readonly sessionId: string
    readonly conversationId: string
  }): Promise<readonly HeldRetainedOperation[]>
}

/** A module owns decoding and its kind's host contract. Kernel code sees only
 *  held work. A composition binds every installed contribution over the hosts
 *  it runs (`bindRetainedOperations`), so the kinds the state Worker admits
 *  and the authorities a supervisor holds come from one installed list. */
export interface ModuleRetainedOperationContribution {
  readonly kind: string
  readonly continuation?: ModuleRetainedOperationContinuation
  /** Reads accepted work without consuming it or creating execution authority. */
  pending(reader: AsyncEventStateReadSurface, sessionId: string, conversationId: string): Promise<boolean>
  /** Reading cells uses only the reader. A commit reads its host from `hosts`
   *  when it runs, so a composition that never commits never builds one. */
  bind(input: {
    readonly reader: AsyncEventStateReadSurface
    readonly writer: AsyncEventWriter
    readonly hosts: RetainedOperationHosts
  }): ModuleRetainedOperationAuthority
}

/** The installed owner names the sessions whose control admission a fact changes. */
export interface ModuleSessionAdmission {
  affectedSessions(fact: StoredFact): readonly string[]
}
