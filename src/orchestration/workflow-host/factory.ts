import { createEmit, type EventBus, type EmitFn } from "../../infra/event-bus.js"
import { personaRoleIds } from "../../workflows/definition-registry.js"
import type { ControlInterruption, PlannedCutInterrupt, TurnInterruption } from "../session/conversation/turn-end-record.js"
import type { ModuleRuntimes } from "../../infra/module-runtime.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter, StoredFact } from "../../infra/event-store-types.js"
import type { SessionManager } from "../session/manager.js"
import { createSessionMessaging } from "../session/session-messaging.js"
import { installedChildSessionHistory } from "../session/module-session-operations.js"
import { workflowStopRefusal } from "../session/chat-session-run-evidence.js"
import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import { DEFAULT_BUDGET, toBudgetLimits, workflowBudgetRefusal } from "../../workflows/budget.js"
import type { WorkflowView } from "../../workflows/view/types.js"
import { resolveWorkflowAgents } from "../../workflows/agent-resolution.js"
import { createAttemptExecutor } from "../../workflows/vm/attempt-runner.js"
import { createWorkflowVmHost } from "../../workflows/vm/host.js"
import type {
  WorkflowVmHost,
  WorkflowVmStartMode,
} from "../../workflows/vm/host-types.js"
import type { ActiveBackgroundCommandDescriptor, BackgroundWorkTracking } from "../agent-runtime/background-work.js"
import { createObserverChain } from "../agent-runtime/batch-observers.js"
import type { RoleResolver } from "../config/roles.js"
import type { WorkflowAgentInputs } from "./agent-inputs.js"
import type { AdmittedWorkflowDeps } from "./deps.js"
import { composeWorkflowHostLifecycle, type WorkflowOuterLifecycle } from "./lifecycle.js"
import type { MetricsWriter } from "../session/create-session-infra.js"
import { wireSessionSubscribers } from "../session/create-session-infra.js"

import type { SessionResources } from "../session/session-resources-service.js"
import { createWorkerCallback } from "./agent-callback.js"
import { disabledToolReason } from "../tool-catalog.js"
import { readParentMessages } from "./request-addenda.js"
import { readAddressedWorkflowMessages, retireAddressedWorkflowMessages } from "../session/conversation/addressed-workflow-messages.js"
import { buildArtifactContext } from "./artifact-context.js"
import { conversationsWithServedResponse, memberConversationCheckpoint } from "./attempt-progress.js"
import { createCommandEvidenceSource } from "./command-evidence.js"
import { resolveSessionRoles } from "../config/session-role-resolver.js"
import { disabledAgentTypes, workflowRunReader } from "../module-catalog.js"
import { definitionAvailabilityOf } from "../app-service/definition-availability.js"
import { createConversationTreeWriterController } from "../chat/tree-writer.js"
import type { AttachChildSessionProjection } from "../module-seams.js"
import type { WorkflowDefinition } from "../../workflows/workflow-schema.js"
import { readWorkflowUsage } from "./member-totals.js"

interface CreateWorkflowHostInput {
  deps: AdmittedWorkflowDeps
  eventBus: EventBus
  sessionId: string
  /** The definition admission resolved for this run. */
  workflow: WorkflowDefinition
  description: string
  startMode: WorkflowVmStartMode
  /** Canonical directory that owns this project's durable state. */
  projectRoot: string
  /** Directory where this workflow's workers and their tools execute. */
  executionCwd: string
  eventStore: AsyncEventStateReadSurface
  projectionReader: AsyncEventStateReadSurface
  eventWriter: AsyncEventWriter
  manager?: SessionManager
  attachChildProjection?: AttachChildSessionProjection
  recall: (conversationId: string, input: RecallInput) => Promise<RecallResult>
  initializeInfra: () => SessionResources
  agentInputs: WorkflowAgentInputs
  metricsWriter?: MetricsWriter
  onBackgroundCommandsChanged?: (commands: readonly ActiveBackgroundCommandDescriptor[]) => void
  applyNestedStoredFact: (event: StoredFact) => void | Promise<void>
  /** Runs after durable definition replay accepts the pinned revision and before any model role is resolved. */
  onDefinitionAccepted?: () => void | Promise<void>
  onPostPreflight?: () => void | Promise<void>
  lifecycle: WorkflowOuterLifecycle
}

interface CreateWorkflowHostResult {
  emitToAgent(attemptId: string): EmitFn | undefined
  releaseForegroundBash(toolUseId: string): boolean
  transferForegroundForReplacement(): Promise<void>
  host: WorkflowVmHost
  resolveRoles: RoleResolver
  readQueue: () => Promise<WorkflowView>
  /** The addressed workers whose attempt cuts were accepted, including generation assembly. */
  interruptWorkers: (by: TurnInterruption, attemptIds?: readonly string[]) => readonly string[]
  awaitWorkerParks(attemptIds: readonly string[]): Promise<void>
  continueMemberMessages(): Promise<void>
  /** A person's interrupt of the agents the runtime's cut ended, through the
   *  workers that hold the agents' conversations; `ended` when none
   *  does. */
  interruptPlannedCut: (by: ControlInterruption, attemptIds?: readonly string[]) => Promise<PlannedCutInterrupt>
  /** Waits for an admitted agent's host, bounded by the caller's live workflow. */
  workerModules: (conversationId: string, signal: AbortSignal) => Promise<ModuleRuntimes | undefined>
  workerBackgroundTasks: (conversationId: string) => BackgroundWorkTracking | undefined
  terminateBackgroundWork: (toolUseId: string) => void
}

/** Build the sole production workflow authority: an Effect-owned VM host with a persistence-free attempt runner. */
export function createWorkflowHost(input: CreateWorkflowHostInput): CreateWorkflowHostResult {
  const { deps, eventBus, sessionId, projectRoot, executionCwd } = input
  const revision = deps.definitionRevision
  const { workflow } = input
  const skills = revision.skills
  const resolvedAgents = resolveWorkflowAgents(workflow)
  const personas = revision.personas
  const emit = createEmit(eventBus)
  const moduleSelection = deps.moduleSelection()
  const infra = input.initializeInfra()
  let awaitDurableFacts: (() => Promise<void>) | undefined
  const commandEvidenceSource = createCommandEvidenceSource({
    workflowId: sessionId,
    projectRoot,
    projectionReader: input.projectionReader,
    awaitDurableFacts: async () => {
      if (!awaitDurableFacts) throw new Error("Runtime fact persistence is not initialized")
      await awaitDurableFacts()
    },
  })
  const readQueue = async (): Promise<WorkflowView> => {
    const queue = await infra.queueStore.loadQueue()
    if (!queue) throw new Error("Workflow VM host has no durable queue projection")
    return queue
  }
  const initialConfig = deps.captureRuntimeConfig()
  const runs = workflowRunReader(input.projectionReader)
  const resolveRoles: RoleResolver = async (capture) => {
    const run = await runs.read(sessionId)
    if (!run) throw new Error(`Workflow not found: ${sessionId}`)
    return resolveSessionRoles(run.roleAssignments, capture ?? await deps.captureProviderConnection(), deps.userDataRoot, personaRoleIds(personas))
  }
  const createChildConversation = (childRunId: string) => createConversationTreeWriterController({
    conversationId: childRunId,
    sessionId,
    projectRoot,
    store: input.eventStore,
    projectionReader: input.projectionReader,
    writer: input.eventWriter,
    recall: (contract) => input.recall(childRunId, contract),
  })
  const subagentSessions = input.manager ? installedChildSessionHistory().createAuthority({
    manager: input.manager, eventStore: input.eventStore, projectionReader: input.projectionReader, eventWriter: input.eventWriter, projectRoot, recall: input.recall,
    attachProjection: input.attachChildProjection,
  }) : undefined
  const sessionMessaging = input.manager && deps.childSessions ? createSessionMessaging({ manager: input.manager, projectionReader: input.projectionReader, eventWriter: input.eventWriter }, deps.childSessions) : undefined
  const observerContext = {
    getBudgetInfo: async () => {
      const { max_invocations, max_tokens } = toBudgetLimits(deps.captureRuntimeConfig().budget ?? DEFAULT_BUDGET)
      if (max_invocations === 0 && max_tokens === null) return null
      return {
        remainingCalls: max_invocations > 0 ? Math.max(0, max_invocations - await infra.budgetStore.getInvocationsUsed()) : Number.POSITIVE_INFINITY,
        remainingTokens: max_tokens !== null ? Math.max(0, max_tokens - await infra.budgetStore.getTokensUsed()) : Number.POSITIVE_INFINITY,
      }
    },
    getContextPercent: async () => (await infra.budgetStore.getContextUtilization()).percent,
  }
  // The chat seam belongs to the chat runner; the workflow host composes only
  // the batch observers declared for its own seam. Each agent gets its own.
  const createAgentObserverChain = () => createObserverChain(moduleSelection.observers.flatMap((declaration) =>
    declaration.seam === "workflow" ? [declaration.observer(observerContext)] : []))
  let workerCallback: ReturnType<typeof createWorkerCallback> | null = null
  const getWorkerCallback = (): ReturnType<typeof createWorkerCallback> => {
    if (workerCallback) return workerCallback
    const created = createWorkerCallback({
      deactivateSession: (id) => {
        if (!input.manager) throw new Error("Workflow execution requires session lifecycle authority")
        return input.manager.updateLifecycleState(id, "inactive")
      },
      createAgent: deps.createAgent,
      planCapabilities: deps.planCapabilities,
      createLLMClient: deps.createLLMClient,
      captureProviderConnection: deps.captureProviderConnection,
      auth: deps.auth,
      resolveRoles,
      availableModels: deps.availableModels,
      activeProfileId: deps.activeProfileId,
      proactiveCompactionThreshold: () => deps.captureRuntimeConfig().proactiveCompactionThreshold,
      emit,
      sessionId,
      projectRoot,
      userDataRoot: deps.userDataRoot,
      accountHome: deps.accountHome,
      executionCwd,
      agentInputs: input.agentInputs,
      attachChildProjection: input.attachChildProjection,
      createObserverChain: createAgentObserverChain,
      sessionEventWriter: infra.sessionEventWriter,
      applyNestedStoredFact: input.applyNestedStoredFact,
      commandEvidenceSource,
      onBackgroundCommandsChanged: input.onBackgroundCommandsChanged,
      resolvedAgents,
      skills,
      // The workflow's admitted modules and the agent types turned off now: an agent that starts after a type was
      // turned off is judged as a dispatch of it is.
      availability: () => definitionAvailabilityOf(revision, moduleSelection.enabledModuleIds, disabledAgentTypes(deps.captureRuntimeConfig().moduleSections)),
      eventStore: input.eventStore,
      projectionReader: input.projectionReader,
      eventWriter: input.eventWriter,
      createChildConversation,
      ...(subagentSessions ? { subagentSessions } : {}),
      ...(sessionMessaging ? { sessionMessaging } : {}),
      recall: input.recall,
      ...(deps.capabilityAccess ? { capabilityAccess: deps.capabilityAccess } : {}),
      moduleSelection,
      reviewConfig: initialConfig.moduleSections,
      ...(deps.commandHandover ? { commandHandover: deps.commandHandover } : {}),
      awaitModelAccessSettled: deps.awaitModelAccessSettled,
    })
    workerCallback = created
    return created
  }
  const attemptRunner = createAttemptExecutor({
    resolvedAgents,
    skills,
    context: infra.contextStore,
    worker: (...args) => getWorkerCallback().worker(...args),
    recordInvocation: async () => { await infra.budgetStore.recordInvocation() },
    buildArtifactContext: (writers, signal) => buildArtifactContext(writers, { executionCwd, projectRoot, reader: input.projectionReader, workflowId: sessionId }, signal),
    // A tool that the live selection serves is refused by the persona that the agent runs as.
    unavailableToolReason: (term) => disabledToolReason(term, moduleSelection) ?? `${term} is not one of the tools of its persona`,
    earlierCheckpoint: (conversationId, capabilities) => memberConversationCheckpoint(input.projectionReader, sessionId, conversationId, capabilities),
  })
  const host = createWorkflowVmHost({
    startMode: input.startMode,
    sessionId,
    reader: input.projectionReader,
    writer: input.eventWriter,
    commitBatch: (events) => {
      if (!input.manager) throw new Error("Workflow execution requires structural publication authority")
      return input.manager.commitWorkflow({ workflowId: sessionId, events })
    },
    queueStore: infra.queueStore,
    contextStore: infra.contextStore,
    definitionRevision: revision,
    workflow,
    attemptRunner,
    conversationId: () => `agent-${crypto.randomUUID()}`,
    emit: (event) => { emit(event.type, { sessionId, data: event.data }) },
    preAttemptPolicy: async () => {
      // A child whose parent's call holds a Stop starts no attempt. The
      // Stop's teardown finds no runner to abort while the child's runtime
      // still starts, and a launch, a Resume, or a message reads the Stop only
      // before its start, so only this read, where work begins, holds for
      // every start.
      const stopped = await workflowStopRefusal(input.projectionReader, (await runs.read(sessionId))?.launchedFrom)
      if (stopped) return stopped
      return await workflowBudgetRefusal({
        budget: deps.captureRuntimeConfig().budget ?? DEFAULT_BUDGET,
        usage: {
          getInvocationsUsed: () => infra.budgetStore.getInvocationsUsed(),
          getTokensUsed: async () => {
            const { policy } = await readWorkflowUsage(input.projectionReader, sessionId)
            return { reported: policy.totalInputTokens + policy.totalOutputTokens, unmeasuredRequests: policy.unmeasuredRequests }
          },
        },
        reader: input.projectionReader,
        sessionId,
      })
    },
    requestAddenda: ({ conversationId }) => readParentMessages(input.projectionReader, conversationId),
    servedConversations: (since) => conversationsWithServedResponse(input.projectionReader, since),
    addressedMessages: {
      read: () => readAddressedWorkflowMessages(input.projectionReader, sessionId),
      retire: (keys) => retireAddressedWorkflowMessages(input.eventWriter, sessionId, keys),
    },
    onPostPreflight: async () => {
      await input.onDefinitionAccepted?.()
      const sessionSubscribers = wireSessionSubscribers(eventBus, infra, input.metricsWriter, sessionId)
      awaitDurableFacts = sessionSubscribers.awaitDurableFacts
      await input.onPostPreflight?.()
    },
    lifecycle: composeWorkflowHostLifecycle(infra.lifecycle, {
      ...input.lifecycle,
      // The review outlives its triggering attempt. Abort and settle it before
      // the event-bus drain so final usage and stream cleanup become durable.
      settleBackground: async () => {
        await workerCallback?.settleLearningReview()
        await input.lifecycle.settleBackground?.()
        await subagentSessions?.settleReconciliation()
      },
    }),
  })
  return {
    emitToAgent: (attemptId) => workerCallback?.emitToAgent(attemptId),
    releaseForegroundBash: (id) => workerCallback?.releaseForegroundBash(id) ?? false,
    transferForegroundForReplacement: async () => { await workerCallback?.transferForegroundForReplacement() },
    host,
    resolveRoles,
    readQueue,
    interruptWorkers: (by, attemptIds) => workerCallback?.interruptWorkers(by, attemptIds) ?? [],
    awaitWorkerParks: async (attemptIds) => { await workerCallback?.awaitWorkerParks(attemptIds) },
    continueMemberMessages: async () => { await workerCallback?.continueMemberMessages() },
    interruptPlannedCut: (by, attemptIds) => workerCallback?.interruptPlannedCut(by, attemptIds) ?? Promise.resolve("ended"),
    workerModules: (conversationId, signal) => getWorkerCallback().workerModules(conversationId, signal),
    workerBackgroundTasks: (conversationId) => getWorkerCallback().workerBackgroundTasks(conversationId),
    terminateBackgroundWork: (toolUseId) => { workerCallback?.terminateBackgroundWork(toolUseId) },
  }
}
