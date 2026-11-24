import type { Scope } from "effect"
import type { AuthContext } from "../../infra/auth/auth-context.js"
import type { EnvCaptureResolver } from "../../infra/env-detection.js"
import type { OwnedCommandRunner } from "../../infra/owned-command.js"
import type { EventBus } from "../../infra/event-bus.js"
import type { ModelFamily } from "../../infra/llm/models/model-family.js"
import type { AgentDefinition } from "../../infra/agent-definition.js"
import type { ProjectDefinitionRegistry } from "../../workflows/definitions/definition-registry.js"
import type { WorkflowsMode } from "../../protocol/module-protocol-types.js"
import type { LLMClientFactory } from "../agent-runtime/request/model-runtime-capture.js"
import type { Agent, AgentFactory, AgentOptions, CreateChildConversation } from "../agent-runtime/types.js"
import type { CommandHandoverAuthority } from "../agent-runtime/background-execution/command-handover.js"
import type { CapabilityAccess } from "../agent-runtime/tools/types.js"
import type { StartModelWorkflow } from "../agent-runtime/tools/definitions/workflow-tool.js"
import type { RoleResolver } from "../config/roles.js"
import type { CapturedModuleConfig } from "./chat-module-host.js"
import type { FirstPartyModuleSnapshot } from "../modules.js"
import type { ChildSessionAuthority } from "../module-seams.js"
import type { MetricsWriter, SessionInfra } from "../session/persistence/create-session-infra.js"
import type { SessionMessaging } from "../session/control/messaging/session-messaging.js"
import type { OutputSession } from "../session-store/output-session.js"
import type { ChatEntryPatch, SessionEntryBasePatch } from "../session-store/types.js"
import type { createChatInvocationCompletion } from "./runner-completion.js"
import type { ConversationTreeWriterController } from "./tree-writer.js"

export interface ChatCallbacks {
  onError: (message: string) => void
  onEnded: () => void
}

type ChatInfra = Pick<SessionInfra, "budgetStore" | "sessionEventWriter" | "toolExecutionStore" | "eventStore" | "projectionReader">

export interface ChatSessionDeps {
  /** Invocation-owned completion, published only after accepted handoff and durable turn settlement. */
  rootChatCompletion?: ReturnType<typeof createChatInvocationCompletion>
  projectRoot: string
  /** Session's recorded execution directory. Agent tools resolve relative paths here. */
  executionCwd: string
  /** Startup-selected account data root every runner this session builds reads
   *  account-global state from. */
  userDataRoot: string
  /** Account home `userDataRoot` was derived from, for the account paths
   *  outside it: global memory, global `AGENTS.md`, and `~/.agents`. */
  accountHome: string
  /** Definition owner of this project: briefs, workflows, and skill revisions. */
  definitions: ProjectDefinitionRegistry
  /** Persona map captured from the same project revision as the session roles. */
  personas: ReadonlyMap<string, AgentDefinition>
  createAgent: AgentFactory
  /** Prepares the next request of the session's chat and its hosts for their pre-starts (`SessionEngines`). */
  prepareRequest: import("../agent-runtime/loop/turn/request-preparation.js").RequestPreparer
  /** Answers the agent check of the chat's next request for `ChatRunner.capabilities`. */
  planCapabilities: import("../agent-runtime/loop/turn/request-preparation.js").CapabilityPlanner
  createLLMClient: LLMClientFactory
  captureProviderConnection: import("../agent-runtime/request/model-runtime-capture.js").CaptureProviderConnection
  onNotification?: AgentOptions["onNotification"]
  moduleSelection: FirstPartyModuleSnapshot
  proactiveCompactionThreshold: () => number
  idleCompaction?: ReturnType<typeof import("./idle-compaction.js").createIdleCompactionPolicy>
  workflowMode: () => WorkflowsMode
  resolveRoles: RoleResolver
  /** Calls `listener` after a change that can change this session's resolved roles: of its metadata, which holds its
   *  role assignments, or of the profiles, which hold the profile's assignments. Returns the removal, which
   *  waits for a call that runs. The session's engines plan again on it (`SessionEngines.rolesChanged`). */
  subscribeRoleChanges: (listener: () => void) => () => Promise<void>
  /** Resolves the `<env>` block this session's idle compaction carries, shared
   *  with every other assembly of the same directory pair. */
  resolveEnvSnapshot: EnvCaptureResolver
  /** Runs bounded experiment and Git commands through this session's owned launch scope. */
  runOwnedCommand?: OwnedCommandRunner
  /** The executor's command handover, through which this chat's background
   *  owner hands its commands to the next build and adopts what a previous
   *  build handed to its conversation. Absent where no account serves. */
  commandHandover?: CommandHandoverAuthority
  availableModels?: ReadonlyMap<ModelFamily, ReadonlySet<string>>
  activeProfileId?: string
  auth: AuthContext
  infra: ChatInfra
  /** Scope holding the session's acquired infra resources (transcript flusher,
   *  budget store, trace collector). The session owns its close: dispose()
   *  flushes and disposes the tree writer first, then closes this scope. */
  resourceScope: Scope.Closeable
  eventBus: EventBus
  sessionId: string
  conversationId: string
  updateEntry: (patch: ChatEntryPatch) => void
  metricsWriter?: MetricsWriter
  /** Persists chat metadata (provider continuation token) outside the live
   *  entry so a later process can resume the same prompt-cache slot. */
  onChatMetadata?: (patch: { providerConversationId?: string; seedContext?: string }) => void
  /** Receives generated session titles; the caller gates them against the
   *  durable label (a user-chosen name always wins). */
  onSessionName?: (labels: { label: string; shortLabel: string }) => void
  /** True when the shell already holds display blocks (a reactivated durable
   *  tail or a cold send's pre-runner turn); skips title regeneration unless
   *  generateTitleForNextMessage requests it. The blocks themselves arrive via
   *  seedDisplayBlocks at attach, never through the create call. */
  hasPriorBlocks?: boolean
  generateTitleForNextMessage?: boolean
  /** True when the user explicitly named this session; skips title generation
   *  entirely (updateLabel's user-named gate is the durable backstop). */
  suppressTitleGeneration?: boolean
  initialProviderConversationId?: string
  seedContext?: string
  /** Interval and notification config for the learning review.
   *  Absent means the review never spawns (tests). */
  reviewConfig?: CapturedModuleConfig
  /** Capability boundary of this chat (ARCH-RUNTIME-066): every optional tool call, the
   *  memory snapshot read, learning reconciliation, and each automatic review
   *  admit through it. Absent in a realm that owns no policy. */
  capabilityAccess?: CapabilityAccess
  /** The chat runs headless (`WorkflowDeps.headless`). */
  headless?: true
  treeWriter: ConversationTreeWriterController
  createChildConversation: CreateChildConversation
  subagentSessions?: ChildSessionAuthority
  /** The project's session messaging authority, which this chat's tools and
   *  every child it launches use. */
  sessionMessaging?: SessionMessaging
  /** Surfaces a save-point flush failure as a session error so the UI can
   *  warn the user that durable conversation state has diverged. */
  onTreeFailure: <ErrorValue>(err: ErrorValue) => void
  /** Reloads the environment behind the live `auth`/`availableModels` getters
   *  (config, credentials, model listing) so the next turn observes changes. */
  refreshEnvironment: () => Promise<void>
  startWorkflow?: StartModelWorkflow
}


// Tracks chat-session lifecycle state distinct from the store entry:
//   - _ended: "has end() been called?", set proactively before disposal.
//   - _providerConversationId: the chat runner's provider session identity
//     (`providerSessionKey`): session headers and provider connection
//     lifetime. Adapter metadata only, never the prompt-cache key. Cleared
//     by clearProviderConversationId (on "prompt too long") while the
//     persisted entry keeps the last-seen id for cross-process resume.
//     NEVER consulted as Flywheel's chat-context source; the session tree
//     owns that.

export class ChatSessionState {
  private _runner: Agent | null = null
  private _ended = false
  private _providerConversationId: string | null

  constructor(
    providerConversationId: string | undefined,
    private readonly updateEntry: (patch: SessionEntryBasePatch) => void,
  ) {
    this._providerConversationId = providerConversationId ?? null
  }

  get runner() { return this._runner }
  get ended() { return this._ended }
  get providerConversationId() { return this._providerConversationId }

  end() { this._ended = true }
  captureProviderConversationId(id: string) {
    if (this._providerConversationId === id) return false
    this._providerConversationId = id
    return true
  }
  clearProviderConversationId() { this._providerConversationId = null }
  attachRunner(runner: Agent) {
    this._runner = runner
    // runnerState is written by SessionEventAdapter from lifecycle events;
    // no direct store write here.
  }
  detachRunner(session: OutputSession, finalStatus: "completed" | "paused" = "completed") {
    this._runner = null
    // Chat has no workflow.run.completed/paused/failed equivalent on the bus,
    // so detach owns the transition back to "absent" directly. Workflow paths go
    // through workflow.run.completed/paused/failed in SessionEventAdapter instead.
    this.updateEntry({ runnerState: "absent", streamingStartedAt: null, waitingOnBackgroundWork: false })
    session.endTurn(finalStatus)
  }
}
