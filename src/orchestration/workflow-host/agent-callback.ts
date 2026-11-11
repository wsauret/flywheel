import type { AuthContext } from "../../infra/auth/auth-context.js"
import { errorMessage } from "../../infra/error-message.js"
import { emitBackgroundCommandRecorded, emitToolExecutionOutput, emitToolExecutionOutputRecorded } from "../agent-runtime/emit.js"
import type { EmitFn } from "../../infra/event-bus.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import type { ModelFamily } from "../../infra/llm/model-family.js"
import type { ControlInterruption, PlannedCutInterrupt, TurnInterruption } from "../session/conversation/turn-end-record.js"
import type { ModuleRuntimes } from "../../infra/module-runtime.js"
import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import { resolveSessionDir } from "../../infra/paths.js"
import type { AttemptRow } from "../../workflows/view/types.js"
import type { SkillRegistryRevision } from "../../workflows/skill-schema.js"
import type { DefinitionAvailabilitySnapshot } from "../app-service/definition-availability.js"
import type { ResolvedAgent } from "../../workflows/agent-resolution.js"
import { agentPersonaRun, personaTask } from "./agent-persona.js"
import type { AgentOutput } from "../../workflows/vm/agent-outcome.js"
import type { ComposeAttemptBrief } from "../../workflows/vm/attempt-runner.js"
import type { CapabilityPlanner } from "../agent-runtime/request-preparation.js"
import { createAgentHost } from "../runner/host.js"
import { createBackgroundNotificationDelivery } from "../runner/background-notification-delivery.js"
import type { AgentHostContextOptions } from "../runner/types.js"
import { CONTINUATION_MESSAGES } from "../agent-runtime/continuation-messages.js"
import { readAuthorizedRestoredWait, readChatTurnEndEvidence } from "../session/chat-session-run-evidence.js"
import type { SessionFactWriter } from "../session/session-fact-writer.js"
import { resolveWorkflowAgentRole } from "../config/role-selection.js"
import type { RoleResolver } from "../config/roles.js"
import { createReconnectNoticeConnectionStateHandler } from "../agent-runtime/agent-resilience.js"
import { createUnattendedRecovery } from "../agent-runtime/unattended-recovery.js"
import { capacityWaitAuthority } from "../session/capacity-wait.js"
import { workerOutcome } from "./worker-outcome.js"
import { HandoffCorrectionExhausted } from "../agent-runtime/errors.js"
import { HandoffInvalidError } from "../../workflows/context-bundle/handoff-errors.js"
import { workflowAgentSubagents } from "../../workflows/agents/subagent-reachability.js"
import { createBackgroundExecutionOwner, type BackgroundExecutionOwner } from "../agent-runtime/background-execution-owner.js"
import type { CommandHandoverAuthority } from "../agent-runtime/command-handover.js"
import { createBackgroundWorkRegistry, type ActiveBackgroundCommandDescriptor, type BackgroundWorkTracking } from "../agent-runtime/background-work.js"
import { createForegroundBashHoldController } from "../agent-runtime/foreground-bash-hold.js"
import type { FirstPartyModuleComposition } from "../modules.js"
import type { RetryState } from "../agent-runtime/llm/retry-budget.js"
import type { Agent, AgentFactory, AgentOptions, CreateChildConversation } from "../agent-runtime/types.js"
import type { CaptureProviderConnection, LLMClientFactory } from "../agent-runtime/factory.js"
import { handoffToolSchemaFromOutput } from "./handoff-tool-schema.js"
import { createRunnerBusBridge } from "../runner/bus-bridge.js"
import { createWorkflowLoopObservers } from "./loop-observers.js"
import { AssistantPrefillSessionContextError } from "../session/conversation/conversation-tree-context.js"
import type { CapabilityAccess } from "../agent-runtime/tools/types.js"
import type { AttachChildSessionProjection, ChildSessionAuthority } from "../module-seams.js"
import type { SessionMessaging } from "../session/session-messaging.js"
import type { CommandEvidenceSource } from "./command-evidence.js"
import type { WorkflowAgentInput, WorkflowAgentInputs } from "./agent-inputs.js"
import { loadQueueSnapshotFromReader } from "../../workflows/view/view-store.js"
import { startedAgents } from "../../workflows/vm/host-commit-controller.js"
import { historicalWorkerTaskRootId } from "./historical-worker-task.js"
import { awaitPlannedChildResumes } from "../session/planned-session-continuation.js"
import { createWorkflowTurnInterruptions, type WorkflowTurnInterruptions } from "./turn-interruptions.js"
import type { RuntimeEvent } from "../../infra/runtime-event-types.js"
import { briefEntryId, recordedEntryText } from "../session/conversation/brief-entry.js"
import { createToolUseCounter } from "../../infra/runtime-tool-records.js"
import { conversationToolUseIds } from "./started-agent-states.js"
import { openChildExecutionResources, type ChildExecutionResources } from "../session/child-execution-resources.js"
import { workflowMembershipReader } from "../session/workflow-membership.js"
import { createSessionRoleResolver } from "../config/session-role-resolver.js"
import { createConversationTreeWriterController, type ConversationTreeWriterController } from "../chat/tree-writer.js"
import { registerLiveSessionControl } from "../session/live-session-control.js"
import { createWorkflowMemberInputs } from "./member-inputs.js"
import { workflowMemberDelivery } from "./member-delivery.js"

export interface WorkerCallbackDeps {
  deactivateSession(sessionId: string): Promise<void>
  createAgent: AgentFactory
  /** Plans an agent's run before its brief commits, so the brief renders for the agent's check (ARCH-CONTEXT-033). */
  planCapabilities: CapabilityPlanner
  createLLMClient: LLMClientFactory
  captureProviderConnection: CaptureProviderConnection
  auth: AuthContext
  proactiveCompactionThreshold: () => number
  availableModels?: ReadonlyMap<ModelFamily, ReadonlySet<string>>
  activeProfileId?: string
  resolveRoles: RoleResolver
  emit: EmitFn
  sessionId: string
  /** Canonical directory that owns this project's durable state: the memory
   *  snapshot, the session directory, and project instructions all name the
   *  project through it. */
  projectRoot: string
  /** Startup-selected account data root every runner this worker builds reads
   *  account-global state from. */
  userDataRoot: string
  /** Account home `userDataRoot` was derived from, for the account paths
   *  outside it: global memory, global `AGENTS.md`, and `~/.agents`. */
  accountHome: string
  /** Directory where this workflow's workers and their tools execute. */
  executionCwd: string
  /** The workflow's one consumer of accepted messages: each agent opens its
   *  own input, adopts the held messages at its start, and releases the
   *  rest when it ends. */
  agentInputs: WorkflowAgentInputs
  attachChildProjection?: AttachChildSessionProjection
  /** Builds the batch observers of one agent, whose notices reach only that agent. */
  createObserverChain?: () => AgentObserverChain
  sessionEventWriter: SessionFactWriter
  /** Workflow session barrier shared by every production worker and nested child. */
  applyNestedStoredFact?: AgentOptions["applyNestedStoredFact"]
  onNotification?: AgentOptions["onNotification"]
  onBackgroundCommandsChanged?: (commands: readonly ActiveBackgroundCommandDescriptor[]) => void
  /** Admitted agents keyed by definition id. Each owns its output contract,
   *  the personas its worker may dispatch, and the persona it runs as. */
  resolvedAgents: ReadonlyMap<string, ResolvedAgent>
  /** Skill revision and personas the workflow host bound. Passed to every
   *  runner this worker builds so deterministic required-skill composition,
   *  for the agent and for any persona it dispatches, uses the pinned bytes. */
  skills: SkillRegistryRevision
  /** The definition availability an agent starts under, over the bound definition revision: which persona it may run
   *  as, which ones it may dispatch, and the installed personas that scope its dispatch. */
  availability: () => DefinitionAvailabilitySnapshot
  eventStore: AsyncEventStateReadSurface
  projectionReader: AsyncEventStateReadSurface
  eventWriter: AsyncEventWriter
  createChildConversation?: CreateChildConversation
  subagentSessions?: ChildSessionAuthority
  /** The project's session messaging authority, which the agent's tools and
   *  every child it launches use. */
  sessionMessaging?: SessionMessaging
  recall: (conversationId: string, input: RecallInput) => Promise<RecallResult>
  commandEvidenceSource?: CommandEvidenceSource
  /** Capability boundary every runner this worker builds passes: the admitted
   *  workflow's own grant, so a capability disabled mid-run cannot refuse a
   *  agent's tools, plus the policy anything the grant does not cover admits
   *  against. */
  capabilityAccess?: CapabilityAccess
  moduleSelection: FirstPartyModuleComposition
  /** The executor's command handover: each attempt's background owner hands
   *  its commands over through it and adopts what a previous build handed to
   *  the attempt's conversation. */
  commandHandover?: CommandHandoverAuthority
  /** Resolves when the profile's model discovery, its access audit included,
   *  has settled (`WorkflowDeps.awaitModelAccessSettled`). */
  awaitModelAccessSettled: (signal: AbortSignal) => Promise<void>
}

interface WorkerHandoffContent {
  [field: string]: unknown
}

/** The batch observers of one agent. */
interface AgentObserverChain {
  onBatchSettled(): Promise<string[]>
  reset(): void
}

/** One agent that runs. Several run at the same time, each in its
 *  own attempt and conversation. */
interface WorkerSlot {
  readonly resources: ChildExecutionResources
  readonly foreground: ReturnType<typeof createForegroundBashHoldController>
  readonly input: WorkflowAgentInput
  readonly conversationId: string
  readonly interruptions: WorkflowTurnInterruptions
  readonly background: BackgroundExecutionOwner
  /** The agent's recovery between failed runs, whose capacity wait an
   *  interrupt ends. */
  readonly recovery: ReturnType<typeof createUnattendedRecovery>
  runner: Agent | null
  modules: ModuleRuntimes | undefined
  parkAcknowledgement?: PromiseWithResolvers<void>
  readonly continueHeldInput: () => Promise<void>
}

interface WorkerCallbackControls {
  emitToAgent(attemptId: string): EmitFn | undefined
  releaseForegroundBash(toolUseId: string): boolean
  transferForegroundForReplacement(): Promise<void>
  worker: (attempt: AttemptRow, brief: ComposeAttemptBrief, signal?: AbortSignal, conversationId?: string, onToolUses?: (count: number) => void, inheritedIntent?: string) => Promise<AgentOutput>
  /** Cuts every running agent's worker, each of which parks in its attempt
   *  and records its turn end as interrupted by `by`. The attempts whose
   *  cuts it accepted, including workers still assembling their generation. */
  interruptWorkers(by: TurnInterruption, attemptIds?: readonly string[]): readonly string[]
  awaitWorkerParks(attemptIds: readonly string[]): Promise<void>
  continueMemberMessages(): Promise<void>
  /** A person's interrupt of the agents the runtime's cut ended, recorded
   *  through each agent's own writer (`WorkflowTurnInterruptions`):
   *  `recorded` when it recorded one, `running` when no cut ended a turn,
   *  and `ended` while no worker holds an agent's conversation. */
  interruptPlannedCut(by: ControlInterruption, attemptIds?: readonly string[]): Promise<PlannedCutInterrupt>
  /** Waits for an admitted agent's assembly or settlement; the caller cancels if the workflow ends first. */
  workerModules(conversationId: string, signal: AbortSignal): Promise<ModuleRuntimes | undefined>
  workerBackgroundTasks(conversationId: string): BackgroundWorkTracking | undefined
  terminateBackgroundWork(toolUseId: string): void
}

async function settleMember(resources: ChildExecutionResources, foreground: ReturnType<typeof createForegroundBashHoldController>, deactivate: () => Promise<void>): Promise<void> {
  const failures: unknown[] = []
  try { await foreground.awaitSettlement() } catch (error) { failures.push(error) }
  foreground.dispose()
  try { await resources.settle() } catch (error) { failures.push(error) }
  try { await deactivate() } catch (error) { failures.push(error) }
  if (failures.length > 0) throw new AggregateError(failures, "Workflow member settlement failed")
}

/** Remove after 2027-04-13, with the restatement that uses it. */
const RESTATED_BRIEF = "Your brief follows. It applies to all of the work above and to the rest of your work."

async function recoverableBuildContext(tree: ConversationTreeWriterController, allowAssistantTail = false): Promise<Awaited<ReturnType<ConversationTreeWriterController["buildContext"]>>> {
  try {
    return await tree.buildContext({ allowAssistantTail })
  } catch (err) {
    if (!(err instanceof AssistantPrefillSessionContextError)) throw err
    // A resumed worker can be parked after an assistant wait marker, unlike
    // chat paths that commit a fresh user turn before reading context.
    await tree.commitSystemTurn(CONTINUATION_MESSAGES.unexpected_exit)
    return await tree.buildContext()
  }
}

export function createWorkerCallback(
  opts: WorkerCallbackDeps,
): WorkerCallbackControls {
  const {
    createAgent, availableModels, auth,
    sessionId: workflowId, projectRoot,
    eventStore, resolvedAgents,
  } = opts

  // The workers that run now, by attempt id, in the order they started.
  const slots = new Map<string, WorkerSlot>()
  const moduleWaiters = new Map<string, Set<(modules: ModuleRuntimes | undefined) => void>>()
  // The background commands of each running agent; the session shows them
  // all.
  const backgroundCommands = new Map<string, readonly ActiveBackgroundCommandDescriptor[]>()
  const publishBackgroundCommands = (attemptId: string, commands: readonly ActiveBackgroundCommandDescriptor[] | undefined): void => {
    if (commands === undefined || commands.length === 0) {
      if (!backgroundCommands.delete(attemptId)) return
    } else {
      backgroundCommands.set(attemptId, commands)
    }
    opts.onBackgroundCommandsChanged?.([...backgroundCommands.values()].flat())
  }
  // One captured prefix for all workers in this admitted workflow.
  const memorySnapshot = opts.moduleSelection.contributions.flatMap((entry) => entry.domain === "memory" ? [entry.value.snapshot({ projectRoot, accountHome: opts.accountHome })] : []).filter((value): value is string => value !== null).join("\n\n") || null

  const worker = async (attempt: AttemptRow, composeBrief: ComposeAttemptBrief, signal?: AbortSignal, conversationId?: string, onToolUses?: (count: number) => void, inheritedIntent?: string): Promise<AgentOutput> => {
    if (!conversationId) throw new Error("worker invoked without a conversationId; workflow host must mint and persist it before invoking the attempt runner")
    const resolvedAgent = resolvedAgents.get(attempt.definitionId)
    if (!resolvedAgent) throw new Error(`worker invoked without admitted agent '${attempt.definitionId}'`)
    // An agent whose record names a persona runs as that persona runs when a
    // subagent dispatch starts it, on the same system prompt and tool
    // surface as every other agent (refer to `agentPersonaRun`).
    const persona = agentPersonaRun({ agent: resolvedAgent, availability: opts.availability(), skills: opts.skills, sessionMessaging: opts.sessionMessaging !== undefined, modules: opts.moduleSelection })

    const member = await workflowMembershipReader(opts.projectionReader).attempt(workflowId, attempt.id)
    if (!member || member.conversationId !== conversationId) throw new Error(`Workflow attempt ${attempt.id} has no committed session for ${conversationId}`)
    const sessionId = member.sessionId
    const resources = await openChildExecutionResources({
      kind: "workflow-agent", workflowId, sessionId, conversationId, description: attempt.name,
      executionCwd: opts.executionCwd, projectRoot, eventStore,
      projectionReader: opts.projectionReader, writer: opts.eventWriter,
      recall: (input) => opts.recall(conversationId, input),
    }).catch(async (error: unknown) => { await opts.deactivateSession(sessionId); throw error })
    const resolveRoles = createSessionRoleResolver({
      reader: opts.projectionReader, projectRoot, sessionId, userDataRoot: opts.userDataRoot,
      capture: opts.captureProviderConnection, requiredRoleIds: new Set(persona?.role ? [persona.role] : []),
    })
    const foregroundBashHold = createForegroundBashHoldController((ids) => { resources.projection?.updateForegroundBash(ids) })
    try {

    // A fresh agent's tree is empty until its brief commits as its opening
    // turn, under the agent's brief entry id.
    const fresh = Object.keys((await resources.conversation.getState()).entriesById).length === 0
    // Count the committed conversation, not model context: compaction can hide
    // earlier calls from context while they still belong to this attempt.
    // The parked count of the live view reads the same rule.
    const toolUseIds = conversationToolUseIds(await resources.conversation.getState())
    // The agent's own input and its own events: every event it emits names
    // its attempt (`causality.runId`), so a client tells the agents that run
    // at the same time apart.
    const agentInput = opts.agentInputs.open({ attemptId: attempt.id, conversationId })
    let settlePrivateInput = true
    const injectionQueue = agentInput.queue
    const emitAgent: EmitFn = (type, event) => {
      const timestamp = type === "agent.turn.parked" && "park" in event.data && event.data.park === "interrupted" ? agentInput.cut?.timestamp : event.timestamp
      resources.emit<typeof type>(type, { sessionId, data: event.data, ...(timestamp === undefined ? {} : { timestamp }) })
    }
    const setRecoveredConnectionState = createReconnectNoticeConnectionStateHandler(
      (state) => resources.projection?.lifecycle.onConnectionState?.(state),
      (operation) => { emitAgent("agent.notice.changed", { sessionId, data: { operation } }) },
    )
    const observerChain = opts.createObserverChain?.()
    const countToolUses = createToolUseCounter(toolUseIds)
    // The agent's live entry carries the same count, so the workflow's live
    // view reads no durable tree while the agent runs.
    let toolUses = countToolUses()
    const reportToolUses = (): void => { onToolUses?.(toolUses); resources.projection?.updateOperations(toolUses) }
    const forward = (event: RuntimeEvent): void => {
      // An agent emits an event per streamed delta; only a new call restates
      // the count, which every view of the agent's session reads.
      const counted = countToolUses(event)
      if (counted !== toolUses) { toolUses = counted; reportToolUses() }
      emitAgent(event.type, { sessionId, data: event.data })
    }

    // The agent owns its background work: everything it dispatches is drained
    // before the agent's tree writer and injection queue are disposed, or
    // handed to the next build when the executor heard a planned
    // replacement's handoff.
    const treeWriter = resources.conversation
    const notifications = createBackgroundNotificationDelivery({
      conversation: treeWriter, queue: injectionQueue, abort: () => slot.runner?.abort(),
    })
    const privateInputs = createWorkflowMemberInputs({ sessionId, conversationId, reader: opts.projectionReader, writer: opts.eventWriter, tree: treeWriter, deactivate: () => opts.deactivateSession(sessionId), queue: injectionQueue, notifications })
    const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({
      kind: "workflow",
      enqueueNotification: notifications.enqueue,
      onChange: (commands) => { resources.projection?.updateBackgroundCommands(commands); publishBackgroundCommands(attempt.id, commands) },
      onExecutionOutput: (toolUseId, output, identity) => {
        emitToolExecutionOutput(forward, toolUseId, output, identity)
      },
      onExecutionOutputRecorded: (toolUseId, output, identity, edits) => {
        emitToolExecutionOutputRecorded(forward, toolUseId, output, identity, edits)
        return resources.awaitDurableFacts()
      },
      onCommandRecorded: (record) => { emitBackgroundCommandRecorded(forward, record) },
    }), opts.commandHandover ? {
      authority: opts.commandHandover, sessionId, conversationId, holder: "conversation",
      // Adoption runs before the agent's first request, which then reads it.
      deliver: async (completion) => { await treeWriter.commitBackgroundNotification(completion) },
    } : undefined)
    const recovery = createUnattendedRecovery({
      sessionId,
      runId: attempt.id,
      caller: "workflow-agent",
      unattendedRun: opts.capabilityAccess?.unattended === true,
      agentName: attempt.name,
      onNotice: (operation) => { emitAgent("agent.notice.changed", { sessionId, data: { operation } }) },
      awaitAccessSettled: opts.awaitModelAccessSettled,
      // Each agent holds a row of its own session, and a continuation
      // resumes only the agents that hold one.
      capacity: capacityWaitAuthority(eventStore, { target: { kind: "workflow-agent", sessionId } }),
    })
    const observers = createWorkflowLoopObservers({
      // An agent has message_session exactly when its host has session messaging.
      parentChannel: opts.sessionMessaging !== undefined,
      injectionQueue,
      observerChain,
      backgroundTasks: background.tasks,
      emit: emitAgent,
      sessionId,
    })
    observers.reset()

    const stepOutput = resolvedAgent.output
    const handoffSchema = stepOutput ? handoffToolSchemaFromOutput(stepOutput) : undefined

    // Captured by the handoff tool's in-memory sink. Null until the worker
    // submits a handoff; the orchestrator records the fact from this content.
    let capturedHandoff: WorkerHandoffContent | null = null

    // The worker's conversation is a durable `conversation:<conversationId>`
    // tree, the same mechanism and writer as chat. A paused agent resumes by
    // replaying priorMessages from this tree; there is no separate cache.
    // The brief of a fresh agent commits before its live view attaches.
    // Gated to the first attempt: only proven historical
    // operator-only trees need a missing-context append; other resumes never
    // re-seed the context.
    let firstRun = true
    // The agent's brief, composed for its check before the run starts.
    let userPrompt: string
    let task: string

    // The save point coalesces a turn's assistant + tool_result entries into
    // one fact/fsync. Returning the serialized flush keeps the loop from
    // draining input or issuing the next provider request before durability.
    let tail: Promise<void> = Promise.resolve()

    const flushAttemptFailure = async (): Promise<void> => {
      tail = tail.then(() => treeWriter.flushSavePoint())
      try {
        await tail
      } catch (err) {
        // Presentation family "runtime.tree_flush_failed": transcript channel.
        emitAgent("agent.system_message.recorded", { sessionId, data: { message: `worker tree flush failed: ${errorMessage(err)}`, level: "error" } })
        throw err
      }
    }

    const buildPriorContext = async (restoringWait: boolean): Promise<Awaited<ReturnType<typeof treeWriter.buildContext>>> => {
      if (firstRun && !fresh) {
        const rootId = await historicalWorkerTaskRootId(opts.projectionReader, workflowId, attempt.id, conversationId)
        if (rootId) {
          // This append closes an assistant-ended suffix itself, before the
          // ordinary context builder can add an unexpected-exit nudge.
          await treeWriter.commitSystemTurn(
            `Recovered original task context, not a new request. Recorded operator instructions and completed work still apply.\n\n${userPrompt}`,
            `workflow-task-recovery:${rootId}:${attempt.id}`,
          )
        }
      }
      let priorContext = await recoverableBuildContext(treeWriter, restoringWait)
      if (firstRun) {
        if (!fresh) {
          // An agent that a build before 2026-10-14 started held its brief in
          // the system prompt, so its tree has no brief entry: restate the brief
          // once. A tree that has the entry commits nothing. Remove after
          // 2027-04-13.
          if (task) {
            await treeWriter.commitSystemTurn(`${RESTATED_BRIEF}\n\n${task}`, briefEntryId(attempt.id))
            priorContext = await treeWriter.buildContext()
          }
          // An agent a person interrupted and a restart then took down resumes
          // here, in its own conversation. Its record states only the
          // interrupt, so this resume records the continuation a live Resume
          // records, and the agent goes on without its brief being seeded again.
          if (!restoringWait && (await readChatTurnEndEvidence(opts.projectionReader, conversationId))?.turnEnd.end.reason === "paused" && agentInput.cut === undefined) {
            await treeWriter.commitSystemTurn(CONTINUATION_MESSAGES.resumed)
            priorContext = await treeWriter.buildContext()
          }
        }
        if (await agentInput.adopt(treeWriter)) {
          priorContext = await treeWriter.buildContext()
        }
        if (await privateInputs.adopt()) priorContext = await treeWriter.buildContext()
        firstRun = false
      }
      return priorContext
    }

    const selectModel = (roles: Awaited<ReturnType<RoleResolver>>) => resolveWorkflowAgentRole(attempt, roles, persona?.role)
    // The options of one run of the agent. Its capability plan reads them before the brief commits, with no history.
    const runOptions = (run: {
      readonly selectedModel?: ReturnType<typeof selectModel>
      readonly providerSessionKey?: string
      readonly priorMessages: Awaited<ReturnType<ConversationTreeWriterController["buildContext"]>>["messages"]
      readonly waits?: Partial<Awaited<ReturnType<typeof readAuthorizedRestoredWait>>>
    }): AgentHostContextOptions => {
      const { selectedModel, providerSessionKey } = run
      const { restoredWait, continuedWait } = run.waits ?? {}
      const allowedSubagentTypes = persona?.allowedSubagentTypes ?? new Set(workflowAgentSubagents(resolvedAgent, opts.availability().availablePersonas))
      const busBridge = createRunnerBusBridge({ emit: emitAgent, sessionId })
      let runnerAssembled = false
      return {
        purpose: { kind: "workflow-agent", briefScope: { briefId: attempt.briefId }, workflowAttemptId: attempt.id, ...(inheritedIntent === undefined ? {} : { inheritedIntent }) },
        model: selectedModel?.model,
        providerOptions: selectedModel?.providerOptions,
        proactiveCompactionThreshold: opts.proactiveCompactionThreshold,
        auth,
        availableModels,
        activeProfileId: opts.activeProfileId,
        resolveRoles,
        allowedSubagentTypes,
        skills: opts.skills,
        agentRegistry: opts.availability().definitionRevision.personas,
        effort: selectedModel?.effort,
        requestSelection: (currentRoles) => selectModel(currentRoles) ?? { roleId: "workflow-agent" },
        ...(persona === undefined ? {} : { toolGrant: persona.toolGrant, maxLLMCalls: persona.maxTurns, ...(persona.readOnly ? { readOnly: true } : {}) }),
        executionCwd: opts.executionCwd,
        projectRoot,
        userDataRoot: opts.userDataRoot,
        accountHome: opts.accountHome,
        sessionDir: resolveSessionDir(sessionId, projectRoot),
        createChildConversation: (childRunId) => createConversationTreeWriterController({
          conversationId: childRunId, sessionId, projectRoot, store: eventStore,
          projectionReader: opts.projectionReader, writer: opts.eventWriter, recall: (input) => opts.recall(childRunId, input),
        }),
        memorySnapshot,
        moduleSelection: () => opts.moduleSelection,
        standingBrief: async () => recordedEntryText(await treeWriter.getState(), briefEntryId(attempt.id)),
        conversation: {
          kind: "durable-tree",
          sessionId, conversationId,
          priorMessages: run.priorMessages,
          providerSessionKey: providerSessionKey ?? conversationId,
          resolveLeafId: () => treeWriter.getLeafId(),
          committedTree: () => treeWriter.getState(),
          captureCommittedForkMessages: () => treeWriter.captureCommittedForkMessages(),
          // A person's interrupt of the agent records the same turn end a
          // chat's does, in the agent's own attempt conversation, so the row
          // admits Resume from it and the resume continues this conversation.
          recordInterruption: () => slot.interruptions.record(),
          reserveMessageId: treeWriter.reserveMessageId, releaseMessageId: treeWriter.releaseMessageId,
          append: (message, entryId) => treeWriter.recordCanonicalMessage(message, entryId),
          recordCompaction: (compactionInput) => treeWriter.recordCompaction(compactionInput).then((result) => result?.messages),
          flush: treeWriter.flushSavePoint,
          awaitDurableFacts: resources.awaitDurableFacts,
        },
        waitForEventCapacity: resources.waitForEventCapacity,
        runtimeSurfaces: {
          recall: (recallInput) => treeWriter.recall(recallInput),
          handoff: {
            onContent: (content) => { capturedHandoff = content },
            ...(opts.commandEvidenceSource ? { readCommandEvidence: opts.commandEvidenceSource.forConversation(conversationId) } : {}),
            ...(handoffSchema ? { schema: handoffSchema } : {}),
          },
          background,
          foregroundBashHold,
          ...(opts.sessionMessaging ? { sessions: opts.sessionMessaging } : {}),
        },
        ...busBridge,
        onEvent: forward,
        onNotification: opts.onNotification,
        onSystemMessage: (message, level) => {
          emitAgent("agent.system_message.recorded", { sessionId, data: { message, level } })
        },
        onChildEvent: (childSessionId, event) => { opts.emit(event.type, { sessionId: childSessionId, data: event.data }) },
        lifecycle: {
          kind: "parkable", ...(restoredWait ? { restoredWait } : {}), ...(continuedWait ? { continuedWait } : {}),
          ...busBridge.lifecycle,
          signal, inputSource: observers.inputSource,
          onConnectionState: setRecoveredConnectionState,
          onTurnEnded: observers.onTurnEnded,
          onToolBatchSettled: observers.onToolBatchSettled,
          onHandoffStarted: () => { injectionQueue.handoffStarted() },
          onTurnParked: async (ctx) => {
            if (ctx.userResumeRequired) {
              await treeWriter.flushSavePoint()
              await resources.awaitDurableFacts()
              slot.parkAcknowledgement?.resolve()
            }
            agentInput.parked(ctx.park)
            busBridge.lifecycle.onTurnParked(ctx)
          },
          onTurnResumed: () => {
            slot.parkAcknowledgement = undefined
            slot.interruptions.resumed()
            agentInput.resumed()
            busBridge.lifecycle.onTurnResumed()
          },
          // The agent's module runtimes are published before its first
          // request, and that request waits for any child the runtime
          // interrupted under this attempt, which the successor resumes
          // through them. A later generation, from a module selection
          // change, only replaces the published runtimes.
          onRuntimeAssembled: async ({ modules }) => {
            const firstGeneration = !runnerAssembled
            runnerAssembled = true
            slot.modules = modules
            for (const resolve of moduleWaiters.get(conversationId) ?? []) resolve(modules)
            if (firstGeneration) await awaitPlannedChildResumes({ reader: eventStore, projectionReader: opts.projectionReader, parentSessionId: sessionId, parentConversationId: conversationId })
          },
        },
        sessionEventWriter: resources.eventWriter,
        sessionEventStore: eventStore,
        sessionEventReader: opts.projectionReader,
        ...(opts.subagentSessions ? { subagentSessions: opts.subagentSessions } : {}),
        ...(opts.capabilityAccess ? { capabilityAccess: opts.capabilityAccess } : {}),
      }
    }
    const createContextOptions = async ({ providerSessionKey }: RetryState): Promise<AgentHostContextOptions> => {
      const selectedModel = selectModel(await resolveRoles())
      // Build context per attempt (resilience may rebuild the runner mid-turn):
      // a retry must see entries flushed by the prior attempt, never stale
      // history.
      const waits = agentInput.cut === undefined ? await readAuthorizedRestoredWait(opts.projectionReader, conversationId) : {}
      const priorContext = await buildPriorContext(waits.restoredWait !== undefined)
      // beginTurn after buildContext so subsequent canonical messages buffer
      // until the next save point.
      treeWriter.beginTurn()
      return runOptions({ selectedModel, ...(providerSessionKey === undefined ? {} : { providerSessionKey }), priorMessages: priorContext.messages, waits })
    }
    const finalizeResources = async (): Promise<void> => {
      const failures: unknown[] = []
      try { await background.close() } catch (error) { failures.push(error) }
      try { await notifications.settle() } catch (error) { failures.push(error) }
      try { await tail } catch (error) { failures.push(error) }
      try { await foregroundBashHold.awaitSettlement() } catch (error) { failures.push(error) }
      foregroundBashHold.dispose()
      if (settlePrivateInput) {
        try { await privateInputs.settle() } catch (error) { failures.push(error) }
      }
      try { await resources.settle() } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, "worker tree finalization failed")
    }

    const slot: WorkerSlot = { resources, foreground: foregroundBashHold, input: agentInput, conversationId, interruptions: createWorkflowTurnInterruptions({
      emit: emitAgent, sessionId, currentInterruption: agentInput.interruptionToRecord,
      overrideInterruption: (by) => { agentInput.interrupt(by) },
    }), background, recovery, runner: null, modules: undefined, continueHeldInput: privateInputs.continueHeld }
    try {
    // The brief renders for the check of the agent's first request, which its
    // run's own tool plan answers. A fresh brief commits before the live view
    // attaches, because the view's seed is the only way a committed turn
    // reaches it, and the agent view opens with the brief.
    const capabilities = await opts.planCapabilities(runOptions({ priorMessages: [] }))
    const brief = await composeBrief(capabilities)
    userPrompt = brief.userPrompt
    task = personaTask(persona, brief.task, capabilities)
    if (fresh) await treeWriter.commitSystemTurn([userPrompt, task].filter(Boolean).join("\n\n"), briefEntryId(attempt.id))
    await resources.attach(opts.attachChildProjection)
    reportToolUses()
    const initialEnd = await readChatTurnEndEvidence(opts.projectionReader, conversationId)
    const initialQueue = await loadQueueSnapshotFromReader(opts.projectionReader, workflowId)
    agentInput.initialize(startedAgents(initialQueue).find(({ attemptId }) => attemptId === attempt.id)?.agent, initialEnd?.turnEnd, initialEnd?.timestamp)
    slots.set(attempt.id, slot)
    const unregister = registerLiveSessionControl(eventStore, {
      sessionId,
      member: {
        modules: async () => slot.modules,
        backgroundTasks: background.tasks,
        compact: async () => { if (injectionQueue.isHandingOff) return false; injectionQueue.enqueueCompact(); return true },
        interrupt: (by) => interruptSlot(slot, by),
        releaseForegroundBash: (id) => foregroundBashHold.release(id),
        transferForegroundForReplacement: () => foregroundBashHold.transferForReplacement(),
        terminateBackgroundWork: (id) => { background.tasks.terminate(id) },
      },
      state: async () => opts.agentInputs.stateOf(attempt.id),
      withInputAdmission: privateInputs.withInputAdmission,
      deliver: workflowMemberDelivery({
        store: eventStore, workflowId, queue: injectionQueue, input: agentInput,
        state: () => opts.agentInputs.stateOf(attempt.id),
        claimDelivery: privateInputs.claimDelivery,
        onQueued: (input) => { resources.projection?.queueUserMessage(input) },
        continueNow: () => recovery.continueNow(),
      }),
      notify: privateInputs.notify,
    })

    emitAgent("agent.logical_turn.started", { sessionId, data: { origin: "system", reason: "new_input" } })
    emitAgent("agent.run.started", { sessionId, data: { stepIndex: 0, toolUseIds } })

    // From here until it ends, the worker holds the agent's conversation: a
    // person's interrupt of the turn the runtime's cut ended is recorded
    // through this writer. A parked worker has flushed its turn, so the save
    // point makes only the held turn ends durable.
    const releaseConversation = slot.interruptions.hold({
      commitTurnEnd: (by) => treeWriter.commitTurnEnd(by),
      settleTurnEnds: () => treeWriter.flushSavePoint(),
    })
    try {
      if (agentInput.cut !== undefined) await privateInputs.continueHeld()
      // A re-entered agent adopts the commands a previous build handed to its
      // conversation before its first request, and parks on them as on its own.
      await background.adoptHandedOver()
      const agentResult = await createAgentHost({ createRunner: createAgent }).runTurn({
        createContextOptions,
        onContextCreated: (context) => { slot.runner = context },
        onContextStarted: () => {
          const recovered = slot.recovery.takeCutInterrupt()
          if (recovered) agentInput.interrupt(recovered)
          const opening = agentInput.takeOpeningInterrupt()
          if (opening) slot.interruptions.interrupt(opening.by, () => slot.runner?.interruptGeneration?.() ?? false)
        },
        message: userPrompt,
        resilience: {
          setConnectionState: setRecoveredConnectionState,
          pushSystemMessage: (msg, level) => {
            emitAgent("agent.system_message.recorded", { sessionId, data: { message: msg, level } })
          },
          onNotice: (operation) => {
            emitAgent("agent.notice.changed", { sessionId, data: { operation } })
          },
          signal,
          originalProviderSessionKey: conversationId,
          // A run again is a new attempt of the agent, so its observers and
          // its handoff reminders start over.
          recover: async (failure, servedRequests, recoverySignal) => {
            const next = await slot.recovery.recover(failure, servedRequests, recoverySignal)
            if (next !== null) observers.reset()
            return next
          },
          settle: slot.recovery.settle,
        },
        onAttemptFailure: flushAttemptFailure,
      }).catch((error: unknown) => {
        // The runner's handoff correction bound ran out. In workflow terms the
        // agent broke its handoff contract, which is how the attempt reports it.
        if (error instanceof HandoffCorrectionExhausted) throw new HandoffInvalidError(attempt.id, error.message)
        throw error
      })

      const outcome = workerOutcome(agentResult)
      settlePrivateInput = agentResult.terminal.kind !== "aborted"
      return {
        ...outcome,
        handoffContent: capturedHandoff,
        durationMs: agentResult.durationMs,
        toolUses,
      }
    } finally {
      unregister()
      slot.runner = null
      releaseConversation()
      slots.delete(attempt.id)
      for (const resolve of moduleWaiters.get(conversationId) ?? []) resolve(undefined)
      publishBackgroundCommands(attempt.id, undefined)
    }
    } finally {
      // Close producers, flush buffered writes, and dispose the tree in order.
      // Each boundary still runs, and finalization preserves every failure.
      // The agent's input stays open until its writes are durable, so no
      // other agent adopts a cell it read.
      try {
        await finalizeResources()
      } finally {
        agentInput.release()
      }
    }
    } finally {
      await settleMember(resources, foregroundBashHold, () => opts.deactivateSession(sessionId))
    }
  }

  // An agent that waits for provider capacity runs no generation. The
  // interrupt ends the wait instead, and the run after it opens interrupted.
  function interruptSlot(slot: WorkerSlot, by: TurnInterruption): boolean {
    if (!slot.input.interrupt(by)) return false
    slot.parkAcknowledgement ??= Promise.withResolvers<void>()
    const cut = slot.interruptions.interrupt(by, () => slot.recovery.cutWait(by) || (slot.runner?.interruptGeneration?.() ?? false))
    if (cut) slot.input.takeOpeningInterrupt()
    return true
  }

  async function interruptPlannedCut(by: ControlInterruption, attemptIds?: readonly string[]): Promise<PlannedCutInterrupt> {
    const results = await Promise.all([...slots].filter(([id]) => attemptIds === undefined || attemptIds.includes(id)).map(([, slot]) =>
      slot.input.cut?.by === "person" || (slot.input.cut?.by === "agent" && by === "agent") ? "recorded" : slot.interruptions.interruptPlannedCut(by)))
    return results.includes("recorded") ? "recorded" : results.includes("running") ? "running" : "ended"
  }

  return {
    emitToAgent: (attemptId) => slots.get(attemptId)?.resources.emit,
    releaseForegroundBash: (id) => [...slots.values()].some((slot) => slot.foreground.release(id)),
    transferForegroundForReplacement: async () => { await Promise.all([...slots.values()].map((slot) => slot.foreground.transferForReplacement())) },
    worker,
    interruptWorkers: (by, attemptIds) => [...slots].flatMap(([attemptId, slot]) => (attemptIds === undefined || attemptIds.includes(attemptId)) && interruptSlot(slot, by) ? [attemptId] : []),
    awaitWorkerParks: async (attemptIds) => { await Promise.all(attemptIds.map(id => slots.get(id)?.parkAcknowledgement?.promise)) },
    continueMemberMessages: async () => { await Promise.all([...slots.values()].map(slot => slot.continueHeldInput())) },
    interruptPlannedCut,
    workerModules: async (conversationId, signal) => {
      const modules = [...slots.values()].find((slot) => slot.conversationId === conversationId)?.modules
      if (modules || signal.aborted) return modules
      const ready = Promise.withResolvers<ModuleRuntimes | undefined>()
      const waiters = moduleWaiters.get(conversationId) ?? new Set()
      moduleWaiters.set(conversationId, waiters)
      waiters.add(ready.resolve)
      const cancel = (): void => { ready.resolve(undefined) }
      signal.addEventListener("abort", cancel, { once: true })
      try { return await ready.promise } finally {
        signal.removeEventListener("abort", cancel)
        waiters.delete(ready.resolve)
        if (waiters.size === 0) moduleWaiters.delete(conversationId)
      }
    },
    terminateBackgroundWork: (toolUseId) => { [...slots.values()].some((slot) => slot.background.tasks.terminate(toolUseId)) },
    workerBackgroundTasks: (conversationId) => [...slots.values()].find((slot) => slot.conversationId === conversationId && slot.modules)?.background.tasks,
  }
}

