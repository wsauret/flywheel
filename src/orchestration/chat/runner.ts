import { captureModuleRequestSections } from "../agent-runtime/request-config.js"
import { Effect, Exit, Scope } from "effect"
import { errorMessage as extractErr } from "../../infra/error-message.js"
import { createEmit, EventBus } from "../../infra/event-bus.js"
import { Log } from "../../infra/log.js"
import { EventStoreWriterService, type EventStoreRuntime } from "../../infra/event-store-effect.js"
import type { ChatRunner } from "./runner-types.js"
import type { StartModelWorkflow } from "../agent-runtime/tools/workflow-tool.js"
import { createChatSession, type ChatSessionDeps } from "./session.js"
import { createConversationTreeWriterController } from "./tree-writer.js"
import type { ChatCallbacks } from "./types.js"
import { TITLE_GENERATION_ROLE_ID } from "../config/roles.js"
import type { FlywheelConfig } from "../config/schema.js"
import { bindWorkflowDepsToSession, type PrepareWorkflowDepsInput, type WorkflowDeps } from "../workflow-host/deps.js"
import { personaRoleIds, type ProjectDefinitionRegistry } from "../../workflows/definition-registry.js"
import type { ModuleServices } from "../../infra/module-service.js"
import { createSessionRoleResolver, ensureSessionRoleSnapshot } from "../config/session-role-resolver.js"
import { acquireSessionResources } from "../session/session-resources-service.js"
import { reconcilePendingFileMutations } from "../session/file-mutation-recovery.js"
import { installedChildSessionHistory } from "../session/module-session-operations.js"
import type { SessionManager } from "../session/manager.js"
import { createSessionMessaging } from "../session/session-messaging.js"
import type { ChildSessionControl } from "../session/child-session-control.js"
import type { SessionAuthAdmission } from "../session/session-auth-profile.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { CommandHandoverAuthority } from "../agent-runtime/command-handover.js"
import { ownedCommandRunner } from "../../infra/owned-command.js"
import type { KeyResolver } from "../../infra/auth/resolve-key.js"
import type { ChatEntryPatch } from "../session-store/types.js"
import type { WorkflowsMode } from "../../protocol/module-protocol-types.js"
import type { ModulePolicy } from "../config/module-policy.js"
import { capabilityAccessFor } from "../agent-runtime/tools/types.js"

import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import type { AttachChildSessionProjection } from "../module-seams.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
type ChatUpdateEntryFn = (patch: ChatEntryPatch) => void

export interface ChatRunnerDeps {
  rootChatCompletion?: ChatSessionDeps["rootChatCompletion"]
  sessionId: string
  projectRoot: string
  /** Session's recorded execution directory. Agent tools resolve relative paths here. */
  executionCwd: string
  /** Startup-selected account data root every runner this chat builds reads
   *  account-global state from. */
  userDataRoot: string
  /** Account home `userDataRoot` was derived from, for the account paths
   *  outside it: global memory, global `AGENTS.md`, and `~/.agents`. */
  accountHome: string
  /** Definition owner of this project: briefs, workflows, and skill revisions. */
  definitions: ProjectDefinitionRegistry
  updateEntry: ChatUpdateEntryFn
  attachChildProjection?: AttachChildSessionProjection
  runtime: EventStoreRuntime
  projectionReader: AsyncEventStateReadSurface
  manager: Pick<SessionManager, "allocateId" | "publishSubagent" | "read" | "updateLifecycleState" | "publishActivation" | "captureRolesIfAbsent" | "replaceRoleSnapshot" | "subscribe">
  onSessionName?: (labels: { label: string; shortLabel: string }) => void
  onChatMetadata?: (patch: { providerConversationId?: string; seedContext?: string }) => void
  onError: (message: string) => void
  onEnded: () => void
  /** True when the shell already holds display blocks (a reactivated durable
   *  tail or a cold send's pre-runner turn); skips title regeneration unless
   *  generateTitleForNextMessage requests it. The blocks themselves arrive via
   *  seedDisplayBlocks at attach, never through the create call. */
  hasPriorBlocks?: boolean
  generateTitleForNextMessage?: boolean
  /** True when the user explicitly named this session; skips title generation
   *  entirely (updateLabel's user-named gate is the durable backstop). */
  suppressTitleGeneration?: boolean
  config?: FlywheelConfig
  proactiveCompactionThreshold?: () => number
  idleCompaction?: ChatSessionDeps["idleCompaction"]
  workflowMode: () => WorkflowsMode
  /** Global capability authority of this process (ARCH-RUNTIME-066). The chat's own
   *  boundary is derived from it: nothing about Learning, Skills, Subagents, or
   *  Workflows is copied into session state. Absent in focused tests. */
  capabilities?: Pick<ModulePolicy, "admit" | "state">
  readonly moduleSelection: PrepareWorkflowDepsInput["moduleSelection"]
  moduleServices?: ModuleServices
  /** Launch authority this chat's runners hand to their tools. */
  launcher?: LauncherScope
  /** The executor's command handover, which this chat's background owner
   *  hands its commands over and adopts them through. */
  commandHandover?: CommandHandoverAuthority
  /** The parent agent's controls of the children it started, which its
   *  `process` and `message_session` tools use. */
  childSessions: ChildSessionControl
  persistentProcesses?: PrepareWorkflowDepsInput["persistentProcesses"]
  allowPersistentProcesses?: PrepareWorkflowDepsInput["allowPersistentProcesses"]
  /** Resolves stored credentials, running the helper a `!` key names. */
  resolveKey: KeyResolver
  /** Session-scoped admission supplies immutable profile state for each turn. */
  authAdmission: SessionAuthAdmission<WorkflowDeps>
  /** Calls `listener` after each publication of the profiles, which hold the profile's role assignments. Other settings
   *  change no role, so they call nothing. Returns the removal. */
  subscribeProfiles: (listener: () => void) => () => Promise<void>
  /** Stable Flywheel key for the durable conversation tree this chat owns. */
  conversationId: string
  /** Provider continuation token from a prior run, replayed to resume the
   *  same prompt-cache slot. Absent on a brand-new chat. */
  providerConversationId?: string
  seedContext?: string
  /** Launch a workflow as a background session. Provided by the runtime supervisor. */
  startWorkflow: StartModelWorkflow
  /** Conversation recall executes in the runtime's bounded background Worker. */
  recall: (conversationId: string, input: RecallInput) => Promise<RecallResult>
}

/** Assembles a chat session from the environment: config, auth, roles, and the
 *  scoped session resources. All session behavior lives on the owner that
 *  createChatSession returns; nothing is wrapped or forwarded here. */
export async function createChatRunner(deps: ChatRunnerDeps): Promise<ChatRunner> {
  return Log.runWithSession(deps.sessionId, () => createChatRunnerInner(deps))
}

async function createChatRunnerInner(deps: ChatRunnerDeps): Promise<ChatRunner> {
  const { sessionId, projectRoot, executionCwd, userDataRoot, accountHome, updateEntry } = deps
  const authAdmission = deps.authAdmission
  // A new runner captures its session's profile decision, so it never starts
  // on a revision that an invalidation retired while no runner held it.
  const initialAuth = await authAdmission.admit(sessionId)
  const workflowDeps = bindWorkflowDepsToSession(initialAuth.workflowDeps, {
    capture: async () => (await authAdmission.admit(sessionId)).workflowDeps,
    current: () => authAdmission.current(sessionId).workflowDeps,
  })
  const currentWorkflowDeps = () => workflowDeps
  const capabilityAccess = deps.capabilities ? capabilityAccessFor(deps.capabilities) : undefined
  const captured = workflowDeps.captureRuntimeConfig()
  const definitionRevision = deps.definitions.captureRevision()
  const effectivePersonaRoleIds = personaRoleIds(definitionRevision.personas)
  const requiredRoleIds = new Set([...effectivePersonaRoleIds, TITLE_GENERATION_ROLE_ID])
  const reviewConfig = deps.config ? captureModuleRequestSections(deps.config) : captured.moduleSections
  const proactiveCompactionThreshold = deps.proactiveCompactionThreshold ?? (() => workflowDeps.captureRuntimeConfig().proactiveCompactionThreshold)
  await ensureSessionRoleSnapshot({
    manager: deps.manager,
    sessionId,
  })

  const chatCallbacks: ChatCallbacks = {
    onError: (message) => { void deps.onError(message) },
    onEnded: () => { void deps.onEnded() },
  }

  const eventBus = new EventBus()
  const emit = createEmit(eventBus)
  const eventWriter = await deps.runtime.runPromise(EventStoreWriterService)
  const mutationRecoveryFailures = await reconcilePendingFileMutations({ sessionId, store: deps.projectionReader, writer: eventWriter })
  for (const failure of mutationRecoveryFailures) {
    Log.create({ service: "chat" }).error("file mutation recovery deferred", {
      sessionId,
      mutationId: failure.mutationId,
      path: failure.path,
      error: failure.message,
    })
  }

  // Acquire all resources into a scope before createChatSession. Until the
  // session owner exists to own the scope's close, a failure on this path
  // closes the scope here so the acquired resources dispose.
  const resourceScope = Scope.makeUnsafe("sequential")
  try {
    const resources = deps.runtime.runSync(
      Scope.provide(resourceScope)(
        acquireSessionResources({
          sessionId,
          projectRoot,
          emitter: emit,
          eventBus,
          projectionReader: deps.projectionReader,
          onActiveSubagentsChanged: (ids) => updateEntry({ activeSubagents: ids }),
        }),
      ),
    )

    const treeWriter = createConversationTreeWriterController({
      conversationId: deps.conversationId, sessionId, projectRoot, store: resources.eventStore, projectionReader: resources.projectionReader, writer: resources.eventWriter,
      recall: (input) => deps.recall(deps.conversationId, input),
    })
    const createChildConversation = (childRunId: string) => createConversationTreeWriterController({
      conversationId: childRunId,
      sessionId,
      projectRoot,
      store: resources.eventStore,
      projectionReader: resources.projectionReader,
      writer: resources.eventWriter,
      recall: (input) => deps.recall(childRunId, input),
    })
    const sessionMessaging = createSessionMessaging({ manager: deps.manager, projectionReader: resources.projectionReader, eventWriter: resources.eventWriter }, deps.childSessions)
    const subagentSessions = installedChildSessionHistory().createAuthority({
      manager: deps.manager,
      eventStore: resources.eventStore,
      projectionReader: resources.projectionReader,
      eventWriter: resources.eventWriter,
      projectRoot,
      recall: deps.recall,
      attachProjection: deps.attachChildProjection,
    })
    deps.runtime.runSync(Scope.addFinalizer(resourceScope, Effect.promise(() => subagentSessions.settleReconciliation())))
    const resolveRolesForRequest = createSessionRoleResolver({
      reader: resources.projectionReader,
      projectRoot,
      sessionId,
      requiredRoleIds,
      userDataRoot,
      capture: workflowDeps.captureProviderConnection,
    })


    const chatSessionDeps: ChatSessionDeps = {
      rootChatCompletion: deps.rootChatCompletion,
      projectRoot,
      executionCwd,
      userDataRoot,
      accountHome,
      definitions: deps.definitions,
      personas: definitionRevision.personas,
      createAgent: (options) => currentWorkflowDeps().createAgent(options),
      prepareRequest: (options, preparation) => currentWorkflowDeps().prepareRequest(options, preparation),
      planCapabilities: (options) => currentWorkflowDeps().planCapabilities(options),
      createLLMClient: (...args) => currentWorkflowDeps().createLLMClient(...args),
      onNotification: workflowDeps.onNotification,
      captureProviderConnection: () => currentWorkflowDeps().captureProviderConnection(),
      moduleSelection: workflowDeps.moduleSelection,
      proactiveCompactionThreshold,
      idleCompaction: deps.idleCompaction,
      workflowMode: deps.workflowMode,
      resolveRoles: resolveRolesForRequest,
      subscribeRoleChanges: (listener) => {
        const unsubscribeSession = deps.manager.subscribe((change) => { if (change.kind === "changed" && change.sessionIds.includes(sessionId)) listener() })
        const unsubscribeProfiles = deps.subscribeProfiles(listener)
        return async () => { unsubscribeSession(); await unsubscribeProfiles() }
      },
      resolveEnvSnapshot: workflowDeps.resolveEnvSnapshot,
      ...(deps.launcher ? { runOwnedCommand: ownedCommandRunner(deps.launcher) } : {}),
      ...(deps.commandHandover ? { commandHandover: deps.commandHandover } : {}),
      // Profile state is admitted by the supervisor before each interactive turn.
      get availableModels() { return currentWorkflowDeps().availableModels },
      get activeProfileId() { return currentWorkflowDeps().activeProfileId },
      get auth() { return currentWorkflowDeps().auth },
      infra: resources,
      resourceScope,
      eventBus,
      sessionId,
      conversationId: deps.conversationId,
      metricsWriter: updateEntry,
      updateEntry,
      onChatMetadata: deps.onChatMetadata,
      onSessionName: deps.onSessionName,
      hasPriorBlocks: deps.hasPriorBlocks,
      generateTitleForNextMessage: deps.generateTitleForNextMessage,
      suppressTitleGeneration: deps.suppressTitleGeneration,
      initialProviderConversationId: deps.providerConversationId,
      seedContext: deps.seedContext,
      reviewConfig,
      ...(capabilityAccess ? { capabilityAccess } : {}),
      treeWriter,
      createChildConversation,
      subagentSessions,
      sessionMessaging,
      onTreeFailure: (err) => {
        const message = extractErr(err)
        Log.create({ service: "chat" }).error("session-tree flush failed", { sessionId, error: message })
        deps.onError(`Session history flush failed: ${message}`)
      },
      refreshEnvironment: async () => { await authAdmission.admit(sessionId) },
      startWorkflow: deps.startWorkflow,
    }

    return createChatSession(chatCallbacks, chatSessionDeps)
  } catch (err) {
    await Effect.runPromise(Scope.close(resourceScope, Exit.fail(err)))
    throw err
  }
}
