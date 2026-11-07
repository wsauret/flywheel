import type { LearningReviewRun } from "./review-types.js";
import type { AgentDefinition } from "../../infra/agent-definition.js";
import type { AuthContext } from "../../infra/auth/auth-context.js";
import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js";
import type { AccessProviderId, ModelUnavailableMissing } from "../../infra/llm/access-provider.js";
import type { ModelFamily } from "../../infra/llm/model-family.js";
import type { ProviderErrorCopy, ProviderRecovery } from "../../infra/llm/provider-error-copy.js";
import type { ProviderRequestOptions } from "../../infra/llm/provider-options.js";
import type { UsageEntry } from "../../infra/llm/usage-entry.js";
import type { RuntimeEvent } from "../../infra/runtime-event-types.js";
import type { ConnectionState } from "../../infra/output-blocks.js";
import type { WebSearchPort, WebSearchProviderId } from "./web-search/types.js";
import type { SessionNoticeOperation } from "../../infra/session-notice.js";
import type { AgentLoopWakeInput, InputSource, LogicalTurnStartedContext, TurnEndedContext, TurnParkedContext } from "../../infra/agent-loop-events.js";
import type { ToolAction } from "../../infra/workflow-types.js";
import type { BriefScope } from "../config/role-selection.js";
import type { RoleResolver } from "../config/roles.js";
import type { AskUserController } from "../runner/ask-user-controller.js";
import type { HandoffToolSchema } from "../workflow-host/handoff-tool-schema.js";
import type { ReadCommandEvidence } from "../../workflows/output-contract/evidence.js";
import type { ProviderRequestAuditFact } from "../session/provider-request-audit-facts.js";
import type { SessionFactWriter } from "../session/session-fact-writer.js";
import type { DurableOwner } from "../../infra/durable-owner.js";
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js";
import type { ConversationMessage } from "./llm/types.js";
import type { AgentRunTally } from "./agent-loop-state.js";
import type { CommittedTree, ConversationTreeProjectionState } from "../session/conversation/conversation-projection.js";
import type { CaptureProviderConnection } from "./factory.js";
import type { BackgroundExecutionOwner } from "./background-execution-owner.js";
import type { CommandHandoverAuthority } from "./command-handover.js";
import type { PromptKind } from "./system-prompt.js";
import type { UsageSettlementAuthorityLease } from "./usage-settlement.js";
import type { ChildSlotRegistry } from "./child-slot-registry.js";
import type { StartModelWorkflow } from "./tools/workflow-tool.js";
import type { CapabilityAccess, ToolProfile } from "./tools/types.js";
import type { ModuleRuntimes } from "../../infra/module-runtime.js";
import type { ToolOutcome } from "../../infra/tool-outcome.js";
import type { AgentLoopMaintenance, AgentLoopPersistence, AgentLoopTerminal, FinalizedCheckpointSwap, RestoredAgentWait } from "./agent-loop-types.js";
import type { RecallPort } from "../../protocol/conversation-recall.js";
import type { ModuleServices } from "../../infra/module-service.js";
import type { EnvCaptureResolver } from "../../infra/env-detection.js";
import type { LauncherScope } from "../../infra/process-supervisor.js";
import type { PersistentProcessClient } from "../../infra/persistent-process-manager.js";
import type { BridgedPersistentProcessClient } from "../../infra/persistent-process-bridge.js";
import type { SkillRegistryRevision } from "../../workflows/skill-schema.js";
import type { ForegroundBashHoldController } from "./foreground-bash-hold.js";
import type { FirstPartyModuleComposition, FirstPartyModuleSnapshot } from "../modules.js";
import type { WorkflowsMode } from "../../protocol/module-protocol-types.js";
import type { GitAiAttributionService } from "./git-ai-attribution-service.js";
import type { StreamingEditValidationService } from "./tools/streaming-edit-validation.js";
import type { ChildSessionAuthority } from "../module-seams.js";
import type { SessionContext } from "../session/conversation/conversation-tree-context.js";
import type { ShellRuntimeClient } from "./tools/shell-runtime-types.js";

import type { SessionMessaging } from "../session/session-messaging.js";
import type { ExternalSkillChildGrant } from "./tools/skill.js";
import type { CaptureRuntimeConfig } from "./request-config.js";
export type HeadlessPrompt =
  | { readonly kind: "assembled"; readonly corePrompt: "You are a helpful AI Agent." }
  | { readonly kind: "literal"; readonly systemPrompt: string };

export type AgentPurpose =
  | { readonly kind: "interactive-chat" }
  | { readonly kind: "chat-learning-review"; readonly review: LearningReviewRun }
  | {
      readonly kind: "workflow-agent";
      readonly briefScope: BriefScope;
      readonly workflowAttemptId: string;
      /** Approved parent intent retained by the launch seed, shared by every agent of this workflow. */
      readonly inheritedIntent?: string;
    }
  | { readonly kind: "workflow-follow-up" }
  | { readonly kind: "workflow-learning-review"; readonly review: LearningReviewRun }
  | {
      readonly kind: "subagent";
      readonly renderAs: PromptKind;
      readonly parentToolUseId: string;
      /** Approved parent intent that the subagent's publication recorded. */
      readonly inheritedIntent?: string;
    }
  | { readonly kind: "headless-task"; readonly prompt: HeadlessPrompt }
  | { readonly kind: "learning-review-audit"; readonly prompt: HeadlessPrompt }
  | { readonly kind: "session-title" }
  /** A one-shot call that replays a chat's conversation and answers beside it with the chat's prompting. */
  | { readonly kind: "chat-side-call" }
  | { readonly kind: "subagent-failure-summary"; readonly prompt: HeadlessPrompt }
  | { readonly kind: "chat-routing-benchmark" }
  | { readonly kind: "persona-benchmark" };

export type AgentConversation =
  | {
      readonly kind: "durable-tree";
      readonly sessionId: string;
      readonly conversationId: string;
      readonly priorMessages: ReadonlyArray<ConversationMessage>;
      readonly append: (message: ConversationMessage, entryId?: string) => void | Promise<void>;
      readonly reserveMessageId: () => Promise<string>;
      readonly releaseMessageId?: (id: string) => void;
      readonly captureCommittedForkMessages: () => Promise<ReadonlyArray<ConversationMessage>>;
      readonly providerSessionKey?: string;
      readonly flush?: (
        protectedToolUseIds?: ReadonlySet<string>,
        finalizedCheckpointSwaps?: readonly FinalizedCheckpointSwap[],
      ) => Promise<void>;
      readonly awaitDurableFacts?: () => Promise<void>;
      readonly resolveLeafId: () => Promise<string | null>;
      /** The committed tree as the storage that `append` writes holds it. */
      readonly committedTree: () => Promise<CommittedTree>;
      readonly recordInterruption?: AgentLoopPersistence["recordInterruption"];
      readonly recordCompaction?: AgentLoopPersistence["recordCompaction"];
    }
  | {
      readonly kind: "replay";
      readonly priorMessages: ReadonlyArray<ConversationMessage>;
      readonly providerSessionKey?: string;
      /** Quotes historical tool calls and results as context data for a tool-free replay.
       * This changes history presentation only and grants no execution authority. */
      readonly historyProjection?: "context-only";
    } & (
      | { readonly sessionId?: string; readonly requestAccounting?: never }
      | {
          readonly sessionId?: string;
          /** Persists request evidence under this session without owning its conversation or recovery.
           * The caller supplies a distinct usage stream and a fresh providerSessionKey. */
          readonly requestAccounting: {
            readonly owner: DurableOwner;
            readonly streamId: string;
            readonly writer: SessionFactWriter;
            readonly reader: AsyncEventStateReadSurface;
          };
        }
    )
  | { readonly kind: "ephemeral"; readonly append: (message: ConversationMessage) => void | Promise<void> }
  | { readonly kind: "stateless" };

export interface ChildConversation {
  buildContext(options?: { allowAssistantTail?: boolean }): Promise<SessionContext>;
  captureCommittedForkMessages(): Promise<ReadonlyArray<ConversationMessage>>;
  beginTurn(): void;
  endTurn(): Promise<void>;
  recordCanonicalMessage(message: ConversationMessage, entryId?: string): Promise<void>;
  reserveMessageId(): Promise<string>;
  releaseMessageId(id: string): void;
  flushSavePoint(
    protectedToolUseIds?: ReadonlySet<string>,
    finalizedCheckpointSwaps?: readonly FinalizedCheckpointSwap[],
  ): Promise<void>;
  getLeafId(): Promise<string | null>;
  getState(): Promise<ConversationTreeProjectionState>;
  recordCompaction(input: Parameters<NonNullable<AgentLoopPersistence["recordCompaction"]>>[0]): Promise<{ messages: ReadonlyArray<ConversationMessage> } | null>;
  recall: RecallPort;
  dispose(): Promise<void>;
}

/** Opens the durable conversation identified by one child run. The host owns
 * the session and storage resources; callers own and dispose the returned controller. */
export type CreateChildConversation = (childRunId: string) => ChildConversation;

export interface AgentLifecycleCallbacks {
  readonly onHandoffStarted?: () => void;
  /** A runtime-cut background wait, rebuilt from its committed tool batch. */
  readonly restoredWait?: RestoredAgentWait;
  /** The open wait of a running turn that a planned replacement cut
   *  (`continuedWaitOf`). The successor's Resume continues the turn, and
   *  this wait with it, where a person's Resume would end the wait. A
   *  child's continuation, which has no Resume input, opens it at its start. */
  readonly continuedWait?: RestoredAgentWait;
  /** Set for a maintenance runner (`AgentLoopMaintenance`). */
  readonly maintenance?: AgentLoopMaintenance;
  readonly onCompactionContinuation?: () => void | Promise<void>;
  readonly onTurnEnded?: (ctx: TurnEndedContext) => void | Promise<void>;
  /** After each settled tool batch; a runtime notice enqueued here reaches the next request with the batch's results. */
  readonly onToolBatchSettled?: () => void | Promise<void>;
  readonly onTurnParked?: (ctx: TurnParkedContext) => void | Promise<void>;
  readonly onTurnResumed?: () => void;
  /** Brackets an account login wait after its failed request has settled. Stop ends the wait. */
  readonly onLoginWait?: (waiting: boolean) => void;
  readonly onLogicalTurnStarted?: (ctx: LogicalTurnStartedContext) => void;
  readonly onConnectionState?: (state: ConnectionState) => void;
  /** The runner's current generation of module runtimes. A host that reads a
   *  module's per-runner state, such as a session view over it, follows the
   *  generation here. Called before the runner's first request, and again
   *  before the first request after a module selection change alters which
   *  module runtimes are enabled. That request waits for a returned promise. */
  readonly onRuntimeAssembled?: (runtime: { readonly modules: ModuleRuntimes }) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

type AgentLifecycle = AgentLifecycleCallbacks & (
  | { readonly kind: "one-shot"; readonly inputSource?: never }
  | { readonly kind: "parkable"; readonly inputSource: InputSource }
  | {
    readonly kind: "complete-on-idle";
    readonly inputSource: InputSource;
    /** Accepts the final reply as the run's result; false when input arrived first. */
    readonly seal?: (finalReply: string) => boolean;
  }
);

export interface RunnerToolSurfaces {
  handoff?: {
    onContent: (content: AgentToolInput) => void;
    readCommandEvidence?: ReadCommandEvidence;
    schema?: HandoffToolSchema;
  };
  askUser?: AskUserController;
  startWorkflow?: StartModelWorkflow;
  workflowMode?: () => WorkflowsMode;
  recall?: RecallPort;
  background?: BackgroundExecutionOwner;
  foregroundBashHold?: ForegroundBashHoldController;
  externalSkillChildGrant?: ExternalSkillChildGrant;
  /** The project's session messaging authority. A child inherits it. */
  sessions?: SessionMessaging;
}

export interface RuntimeToolSurfaces extends RunnerToolSurfaces {
  /** The process-scoped services of the enabled modules, one generation's; a runner's module runtimes read their own through their handles. */
  moduleServices?: ModuleServices;
  webSearch?: (moduleSnapshot: FirstPartyModuleComposition, preference: WebSearchProviderId) => WebSearchPort;
  launcher?: LauncherScope;
  /** The executor's command handover. A child inherits it, so the background
   *  owner of a child hands its commands over and adopts them as its parent's
   *  does. */
  commandHandover?: CommandHandoverAuthority;
  shell?: ShellRuntimeClient;
  persistentProcesses?: PersistentProcessClient | BridgedPersistentProcessClient;
  allowPersistentProcesses?: () => boolean | Promise<boolean>;
  /** Reads the person's `shell_write_guard` when the shell checks a command (`shellWriteGuardObserver`). */
  enforcedShellWriteGuard?: () => Promise<boolean>;
  gitAiAttribution?: GitAiAttributionService;
  streamingEditValidation?: StreamingEditValidationService;
  /** The runtime has no client that reviews file changes: no shell command
   *  of its agents runs in a private copy (PI-AGENT-119). A child inherits it. */
  headless?: true;
}

export interface AgentToolInput {
  [field: string]: unknown;
}

interface AgentBaseOptions {
  model?: string;
  /** Model context for the current logical turn. Sent to providers but never appended to conversation history. */
  requestContext?: string;
  /** Fixed effort for a call without live roles, or an accessor for a fixed
   *  runner whose effort is resolved at each request boundary. */
  effort?: string | (() => Promise<string | undefined>);
  /** Live role for request admission. Absent for intentionally fixed model calls. */
  requestSelection?: (roles: Awaited<ReturnType<RoleResolver>>) => { roleId?: string; model?: string; effort?: string; providerOptions?: ProviderRequestOptions } | Promise<{ roleId?: string; model?: string; effort?: string; providerOptions?: ProviderRequestOptions }>;
  providerOptions?: ProviderRequestOptions;
  /** The recorded brief of an unattended agent, which every reset opening restates. */
  standingBrief?: () => Promise<string | undefined>;
  /** Token cap for proactive compaction before ratio-based context pressure.
   *  An accessor read per compaction check so live settings edits apply. */
  proactiveCompactionThreshold?: () => number;
  /** Tool authorities pinned to this runner generation. Optional here because
   *  a completion seam attaches them; RunnableAgentOptions requires them. */
  runtimeSurfaces?: RuntimeToolSurfaces;
  /** Live module composition resolver. Each provider request captures one
   *  immutable result. Optional here because a completion seam attaches it;
   *  RunnableAgentOptions requires it. */
  moduleSelection?: FirstPartyModuleSnapshot;
  sessionDir?: string;
  toolActions?: ReadonlyArray<ToolAction>;
  toolNames?: ReadonlyArray<string>;
  /** The tools this agent may call. Unlike `toolNames`, it does not narrow what
   *  the request advertises: a persona child sees the tools of an agent of a workflow and shares
   *  their prompt cache, and a call outside its grant is refused. */
  toolGrant?: ReadonlyArray<string>;
  /** Ambient tools that `toolGrant` would leave callable and this agent may
   *  not call: the deepest subagent's `process`. They stay advertised. */
  withheldTools?: ReadonlyArray<string>;
  /** The root session of the chat tree whose agent host serves this runner,
   *  for a runner whose own session identity does not name it: a side call
   *  of a chat or a workflow, such as a title or a learning review. */
  treeRootSessionId?: string;
  /** Overrides ordinary tool selection, including ambient and nested authority. */
  toolProfile?: ToolProfile;
  /** Directory this runner's tools execute in. */
  executionCwd: string;
  /** Canonical directory that owns the project's durable state: its memory,
   *  its skill store, its instructions, and the learning audits attributed to
   *  it. Distinct from `executionCwd` on purpose: a runner whose tools execute
   *  the project still reads and writes exactly this project. Every caller
   *  states it, so nothing downstream derives a project root again. */
  projectRoot: string;
  /** Startup-selected account data root (ARCH-DIRECTORIES-001): the account-global skill
   *  store, agent registry, and provider state this runner reads. */
  userDataRoot: string;
  /** Account home `userDataRoot` was derived from, for the few account paths
   *  outside it: global `AGENTS.md`, `~/.agents`, and global memory. */
  accountHome: string;
  onEvent: (event: RuntimeEvent) => void;
  /** Observes the initial policy read used by this turn. The observer settles before provider preparation. */
  onRuntimeConfigCapture?: (config: import("./request-config.js").RuntimeConfigRequestCapture) => Promise<void>;
  /** Shared session delivery watermark, inherited by nested producers. */
  waitForEventCapacity?: (signal?: AbortSignal) => void | Promise<void>;
  onSystemMessage?: (message: string, level?: "info" | "error") => void;
  onNotice?: (operation: SessionNoticeOperation) => void;
  /** Host-owned sink for durable actionable warning occurrences. */
  onNotification?: (episode: NotificationEpisodeInput) => void;
  auth?: AuthContext;
  availableModels?: ReadonlyMap<ModelFamily, ReadonlySet<string>>;
  /** Active profile is contextual input; request-captured profile values remain authoritative. */
  activeProfileId?: string;
  /** Exact profile authority captured with this runtime generation. */
  usageProfile?: {
    readonly profileId: string
    readonly authorityIncarnation: string
    readonly acquireAuthority: (profileId: string) => Promise<UsageSettlementAuthorityLease>
  };
  maxLLMCalls?: number;
  /** The model calls that the earlier runs of this turn started, which count
   *  against `maxLLMCalls`: a run that recovery starts again keeps the budget
   *  that the failed run used (ARCH-RUNTIME-003). */
  priorLLMCalls?: number;
  /** The run's counts, owned by the turn that hosts the run, which reads them
   *  also when the run rejects. A run with no host keeps its own. */
  tally?: AgentRunTally;
  agentRegistry?: ReadonlyMap<string, AgentDefinition>;
  /** Skill revision this runner's deterministic required-skill composition
   *  reads. A workflow passes the revision its host bound; chat and one-off
   *  dispatches leave it absent and the current revision is captured. The
   *  model-callable `skill` tool is unaffected: it always reads live. */
  skills?: SkillRegistryRevision;
  /** Fixed project instructions that never reload. Absent means the runner
   *  loads the chain for its own directory at its start and at each person
   *  message, which is how every subagent gets its chain. */
  agentsMd?: string;
  /** Frozen memory snapshot override. The workflow host captures one snapshot
   *  per workflow and passes the same bytes to every agent of the workflow
   *  and to its review. Absent means the runner captures memory at its start
   *  and at each person message; null means no snapshot on purpose. */
  memorySnapshot?: string | null;
  resolveRoles?: RoleResolver;
  /** When false, the prompt omits the engineering doctrine (writing, elegance,
   *  and anti-pattern guidance). Set by headless direct tasks; absent means true. */
  engineeringDoctrine?: boolean;
  /** Set for a read-only persona (`isReadOnlyPersona`), by a subagent
   *  dispatch or for an agent of a workflow that runs as the persona: the shell
   *  tool refuses a command that writes a project file. Absent means the
   *  agent may write. */
  readOnly?: boolean;
  allowedSubagentTypes?: ReadonlySet<string>;
  /** Shared slot registry capping concurrent subagents across the whole
   *  dispatch tree. Passed by a dispatching parent so grandchildren count
   *  against the same limit; absent for top-level runners, which create
   *  their own. */
  childSlots?: ChildSlotRegistry;
  createChildConversation?: CreateChildConversation;
  /** Durable child-session publication authority. A subagent tool is absent without it. */
  subagentSessions?: ChildSessionAuthority;
  sessionEventWriter?: SessionFactWriter;
  /** In-memory observer of every provider-request audit record this run and
   * its subagents emit. A caller that summarizes its own run (headless)
   * accumulates request and tool-surface evidence without re-reading a store. */
  auditObserver?: (fact: ProviderRequestAuditFact) => void;
  /** In-memory observer of each canonical usage entry after settlement commits it. */
  usageObserver?: (entry: UsageEntry) => void;
  /** Applies directly persisted nested tool facts to the owning session projection. */
  applyNestedStoredFact?: (event: StoredFact) => void | Promise<void>;
  /** Capability boundary of this run (ARCH-RUNTIME-068): what its tool calls may do and
   *  the grant of the operation that admitted it. The host that owns a
   *  capability policy wires it; a realm that owns none wires nothing. */
  capabilityAccess?: CapabilityAccess;
  /** Read side of the session aggregate. A global skill mutation reads the
   *  answered decision it claims through this, so a context without it cannot
   *  confirm one. */
  sessionEventStore?: AsyncEventStateReadSurface;
  /** Asynchronous read authority for registered session projections. */
  sessionEventReader?: AsyncEventStateReadSurface;
  /** Resolves the `<env>` block this runner's prompt carries. Absent means the
   *  prompt renders no environment, which is what prompt tooling and unit
   *  tests want. */
  resolveEnvSnapshot?: EnvCaptureResolver;
  /** Captures the account this runner's own clients spend. A child run this
   *  runner launches (a benchmark) plans and admits every client it builds from
   *  one capture, so the child reads no credential store and no model cache of
   *  its own. Injected by the runtime factory; absent for a runner built outside
   *  it, and absent under an admission. */
  captureProviderConnection?: CaptureProviderConnection;
  /** Captures the owning session's current model-serving revision before each
   *  provider request. Children inherit the same authority from their runner. */
  captureModelRuntime?: import("./factory.js").CaptureModelRuntime;
  /** The provider runtime of the session that this run serves, which outlives the run (`ProviderSession`). Absent:
   *  the run owns its own, which ends with the run. */
  providerSession?: import("./provider-runtime-cache.js").ProviderSession;
  /** Render-event sink for background tools. `onEvent` bridges are gated on
   *  turn liveness and drop events once their turn dies; background work
   *  outlives turns, so its dispatch, stream, and terminal events route
   *  here. Defaults to `onEvent`. */
  onBackgroundEvent?: (event: RuntimeEvent) => void;
  /** Emits one child-owned runtime event for live projection without assigning it to the parent session. */
  onChildEvent?: (childSessionId: string, event: RuntimeEvent) => void;
}

export type AgentOptions = AgentBaseOptions & {
  readonly purpose: AgentPurpose;
  readonly conversation: AgentConversation;
  readonly lifecycle: AgentLifecycle;
};


export interface Agent {
  send(input: string | AgentLoopWakeInput): void;
  end(): void;
  abort(): void;
  interruptGeneration?(): boolean;
  readonly done: Promise<AgentRunResult>;
}

/** Options an agent is actually constructed with: the caller's AgentOptions
 *  plus the fields the loop cannot run without, attached by exactly one
 *  completion seam per construction path (the agent factory's hosting, or
 *  subagent dispatch inheriting from its parent). The runner constructor takes
 *  only this type, so a path that skips completion cannot compile; the runtime
 *  guards this replaces fired on the first model request in production. */
export type RunnableAgentOptions = AgentOptions & {
  readonly runtimeSurfaces: RuntimeToolSurfaces;
  readonly moduleSelection: FirstPartyModuleSnapshot;
  readonly captureRuntimeConfig: CaptureRuntimeConfig;
  /** Resolves when the profile's model discovery, its access audit included,
   *  has settled; rejects when it fails or `signal` aborts. The children this
   *  runner dispatches wait on it before they retry a model whose access is
   *  pending. */
  readonly awaitModelAccessSettled: (signal: AbortSignal) => Promise<void>;
};

/** The completing seam: takes caller options, attaches the generation
 *  authorities, and constructs the runner. */
export type AgentFactory = (options: AgentOptions) => Agent;

export interface AgentRunResult {
  durationMs: number;
  providerSessionKey?: string;
  /** The model requests of the run that the provider served: the progress an
   *  unattended recovery policy reads. */
  servedRequests: number;
  terminal: AgentRunTerminal;
}

/** The single typed statement of how a run ended: the loop's own terminal
 *  (`AgentLoopTerminal`) plus the runner's typed error channel. Consumers
 *  switch on `kind`; there is no optional `failure` field to reconstruct
 *  liveness from. */
export type AgentRunTerminal = AgentLoopTerminal | AgentFailureReason;

type StallAttribution =
  | { kind: "provider"; provider: AccessProviderId }
  | { kind: "unattributed" };

export type AgentFailureReason =
  | { kind: "local_persistence_error"; error: import("../../infra/event-store-types.js").PersistenceWriteRefused }
  | { kind: "context_overflow" }
  | { kind: "output_overflow" }
  /** `candidatesExhausted` marks a request that no access provider candidate could serve, which an optional side
   *  call, such as a failure summary, answers with its fallback. `contentRefused` marks the provider's refusal of
   *  the conversation content that no repair cleared. Every other api_error is a fault of the request. */
  | { kind: "api_error"; message: string; copy?: ProviderErrorCopy; recovery: ProviderRecovery; candidatesExhausted?: true; contentRefused?: true }
  | { kind: "model_unavailable"; message: string; missing: ModelUnavailableMissing }
  | { kind: "transient_disconnect"; message: string }
  | { kind: "stream_stalled"; message: string; attribution: StallAttribution }
  | { kind: "api_overloaded"; message: string }
  | { kind: "aborted" };

/** Narrows a terminal to its failure member, or null for the clean-exit
 *  kinds. `aborted` counts as a failure: it means the run was killed, not
 *  that it finished its work. */
export function failureTerminal(terminal: AgentRunTerminal): AgentFailureReason | null {
  switch (terminal.kind) {
    case "completed":
    case "budget_exhausted":
    case "interrupted":
    case "input_closed":
      return null;
    default:
      return terminal;
  }
}

export type AgentStreamEvent =
  | { type: "tool_use"; toolUseId: string; toolName: string; toolInput: AgentToolInput }
  | { type: "tool_result"; toolUseId: string; outcome: ToolOutcome }
  | { type: "text" }
  | { type: "result" };
