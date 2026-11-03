import { Effect, Exit, Scope } from "effect"
import type { AuthContext } from "../../infra/auth/auth-context.js"
import { chatInputText, type ChatInputLike } from "../../infra/chat-input.js"
import type { EnvCaptureResolver } from "../../infra/env-detection.js"
import type { OwnedCommandRunner } from "../../infra/owned-command.js"
import { createEmit, type EventBus, type Unsubscribe } from "../../infra/event-bus.js"
import { Log } from "../../infra/log.js"
import { errorMessage } from "../../infra/error-message.js"
import type { ModelFamily } from "../../infra/llm/model-family.js"
import type { AnyBlock, ConnectionState } from "../../infra/output-blocks.js"
import { toRuntimeEvent } from "../../infra/events.js"
import { RUNTIME_EVENT_TYPES, type RuntimeEvent } from "../../infra/runtime-event-types.js"
import { nestedFactProjectionEvents } from "../../infra/output/nested-fact-projection.js"
import { hydrateToolContentFact } from "../../infra/tool-content-hydration.js"
import { mapRuntimeEventToAgentStreamEvents } from "../agent-runtime/runtime-event-mapper.js"
import { createChatControls } from "./controls.js"
import type { ChatRunner } from "./runner-types.js"
import type { ControlInterruption, PlannedCutInterrupt, RuntimeInterruption } from "../session/conversation/turn-end-record.js"
import { ChatSessionState, type ChatCallbacks } from "./types.js"
import { createChatRunnerLifecycle } from "./runner-lifecycle.js"
import type { LLMClientFactory } from "../agent-runtime/factory.js"
import type { AgentFactory, AgentOptions, CreateChildConversation } from "../agent-runtime/types.js"
import type { CommandHandoverAuthority } from "../agent-runtime/command-handover.js"
import type { ConversationTreeWriterController } from "./tree-writer.js"
import { TITLE_GENERATION_ROLE_ID, type RoleResolver } from "../config/roles.js"
import type { CapturedModuleConfig } from "../review-host.js"
import type { CapabilityAccess } from "../agent-runtime/tools/types.js"
import type { StartModelWorkflow } from "../agent-runtime/tools/workflow-tool.js"
import { type MetricsWriter, type SessionInfra, wireSessionSubscribers } from "../session/create-session-infra.js"
import { createOutputSession } from "../runner/output-session.js"
import { SessionEventAdapter } from "../session-store/event-adapter.js"
import { deleteSessionArtifacts } from "../session/session-artifacts.js"
import type { ChatEntryPatch } from "../session-store/types.js"
import { generateSessionTitle, type SessionTitleGeneration } from "../session/session-title.js"
import { createAskUserController } from "../runner/ask-user-controller.js"
import { voidUnclaimedDecisions } from "../session/agent-input-decision.js"
import { readChatTurnEnd } from "../session/chat-session-run-evidence.js"
import type { ProjectDefinitionRegistry } from "../../workflows/definition-registry.js"
import type { AgentDefinition } from "../../infra/agent-definition.js"
import type { FirstPartyModuleSnapshot } from "../modules.js"
import type { WorkflowsMode } from "../../protocol/module-protocol-types.js"
import type { ChildSessionAuthority, ModuleChatObserver } from "../module-seams.js"
import type { SessionMessaging } from "../session/session-messaging.js"
import type { createChatInvocationCompletion } from "./runner-completion.js"

const log = Log.create({ service: "chat" })

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
  prepareRequest: import("../agent-runtime/request-preparation.js").RequestPreparer
  createLLMClient: LLMClientFactory
  captureProviderConnection: import("../agent-runtime/factory.js").CaptureProviderConnection
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

/** Detects the provider's hard context overflow on a completed turn and drops
 *  the provider continuation token so the next request rebuilds from the
 *  session tree instead of replaying the oversized provider conversation. */
function handleChatContextOverflow(event: RuntimeEvent, state: ChatSessionState): void {
  if (event.type !== "model.turn.completed") return
  const isError = event.data.is_error === true || (typeof event.data.subtype === "string" && event.data.subtype !== "success")
  const resultText = typeof event.data.result === "string" ? event.data.result : ""
  if (isError && /prompt is too long/i.test(resultText)) {
    log.warn("prompt too long - resetting provider conversation id", { providerConversationId: state.providerConversationId })
    state.clearProviderConversationId()
  }
}

/** The words a chat title summarizes. A command's turn titles from what the
 *  person typed, its label and arguments, because its text can be a whole
 *  rendered skill method that the person never wrote. */
function titleText(input: ChatInputLike): string {
  if (typeof input === "string" || input.invocation === undefined) return chatInputText(input)
  const { label, args } = input.invocation
  return args === undefined ? label : `${label} ${args}`
}

/** The single owner of one live chat session. Builds the output projection,
 *  event wiring, ask-user controller, turn lifecycle, and controls as internal
 *  collaborators, and returns the ChatRunner the session store pools. Every
 *  public method runs with the session id ambient for logging. The runner
 *  never exits after a turn; it parks and waits for input until dispose. */
export function createChatSession(callbacks: ChatCallbacks, deps: ChatSessionDeps): ChatRunner {
  const { projectRoot, executionCwd, eventBus, sessionId, infra, updateEntry } = deps
  const emit = createEmit(eventBus)
  const inSession = <T,>(fn: () => T): T => Log.runWithSession(sessionId, fn)

  const state = new ChatSessionState(deps.initialProviderConversationId, updateEntry)

  const wiredSubscribers = wireSessionSubscribers(eventBus, infra, deps.metricsWriter, sessionId)
  const eventUnsubs: Unsubscribe[] = [...wiredSubscribers.unsubscribes]

  // The chat seam module observer reads the agent's own normalized runtime events.
  let moduleObserver: ModuleChatObserver | undefined
  eventUnsubs.push(
    eventBus.subscribeToTypes(RUNTIME_EVENT_TYPES, (e) => {
      const data = e.data
      if ("parent_tool_use_id" in data && data.parent_tool_use_id != null) return
      for (const event of mapRuntimeEventToAgentStreamEvents(toRuntimeEvent(e))) moduleObserver?.onEvent?.(event)
    }, { deliveryClass: "ui", label: "chat-module-observer" }),
  )

  const session = createOutputSession({ updateEntry, sessionId, executionCwd })
  const applyNestedStoredFact = async (stored: Parameters<typeof infra.toolExecutionStore.applyStoredFact>[0]): Promise<void> => {
    // Hydrate before the fact crosses the infra boundary: nested-fact
    // projection reads payload text directly and must never see a
    // tool-content reference.
    const hydrated = hydrateToolContentFact(stored, await infra.eventStore.contentFor([stored]))
    await infra.toolExecutionStore.applyStoredFact(hydrated)
    for (const event of nestedFactProjectionEvents(hydrated)) session.applyProjectionEvent(event)
  }


  const adapter = new SessionEventAdapter({
    updateEntry,
    outputSession: session,
  })
  adapter.connect(eventBus)

  const askUser = createAskUserController({ host: session, emit, sessionId })

  eventUnsubs.push(
    eventBus.subscribeToType("model.turn.completed", (e) => {
      handleChatContextOverflow({ type: e.type, data: e.data }, state)
    }, { deliveryClass: "ui", label: "chat-context-overflow" }),
    () => adapter.disconnect(),
  )

  const setConnectionState = (next: ConnectionState) => {
    updateEntry({ connectionState: next })
  }

  const lifecycle = createChatRunnerLifecycle({
    deps, eventBus, session, state, askUser, setConnectionState, applyNestedStoredFact,
    awaitDurableFacts: wiredSubscribers.awaitDurableFacts,
    installModuleObserver: (observer) => { moduleObserver = observer },
  })

  // Both interruption writes (a turn-end record no parked loop writes,
  // approval voiding) settle here, so settlement at end() owns them instead
  // of leaving detached promises.
  let interruptionSettlement: Promise<void> = Promise.resolve()
  const controls = createChatControls({
    lifecycle, session, callbacks, eventUnsubs, state,
    treeWriter: deps.treeWriter,
    onTreeFailure: deps.onTreeFailure,
    drainEvents: () => eventBus.drain(),
    recordInterruption: (by) => {
      // A runtime cut's record queues behind the cut turn's save-point
      // flush, so it lands after every result the turn committed; the
      // successor resumes from it.
      const record = deps.treeWriter.commitTurnEnd(by)
        .then(() => undefined, (err) => deps.onTreeFailure(err))
      interruptionSettlement = interruptionSettlement.then(() => record)
    },
    supersedeInterruptedTurn: () => {
      // The durable turn end is the one authority on whether the last turn
      // was interrupted, live or after a restart. A Resume keeps the
      // approvals; only a new message that leaves the turn behind voids them.
      const voiding = readChatTurnEnd(infra.projectionReader, deps.conversationId).then(async (turnEnd) => {
        if (turnEnd?.end.reason !== "paused") return
        const result = await voidUnclaimedDecisions({
          store: infra.eventStore,
          writer: infra.sessionEventWriter,
          sessionId,
          claimId: "voided:user-interrupt",
        })
        if (result.unvoided.length > 0) {
          // The approval is still claimable; this must read as a failure, not a no-op.
          log.error("superseded interrupt could not void standing decision approvals", { unvoided: result.unvoided })
        } else if (result.voided.length > 0) {
          log.info("superseded interrupt voided standing decision approvals", { voided: result.voided })
        }
      }).catch((err) => {
        log.warn("voiding standing decision approvals failed", { error: errorMessage(err) })
      })
      interruptionSettlement = interruptionSettlement.then(() => voiding)
    },
  })
  let suspendedOnQuestion = false

  // Pre-runner user output reaches the display via the attach-time seed, but
  // the first committed delivery still needs to generate the chat title.
  let firstMessageSent = deps.hasPriorBlocks === true && deps.generateTitleForNextMessage !== true
  let titleGeneration: SessionTitleGeneration | null = null

  function markFirstMessageSent(input: ChatInputLike): void {
    if (firstMessageSent) return
    firstMessageSent = true
    if (deps.suppressTitleGeneration) return
    // Without a consumer for the generated labels, generation would only
    // spend an LLM call; the actor always supplies onSessionName in production.
    const onSessionName = deps.onSessionName
    if (!onSessionName) return
    titleGeneration = generateSessionTitle(
      titleText(input),
      ({ full, short }) => { onSessionName({ label: full, shortLabel: short }) },
      async () => {
        const current = (await deps.resolveRoles()).get(TITLE_GENERATION_ROLE_ID)
        return {
          ...current,
          resolveRoles: deps.resolveRoles,
          createRunner: deps.createAgent,
          auth: deps.auth,
          projectRoot,
          userDataRoot: deps.userDataRoot,
          accountHome: deps.accountHome,
          // A chat is the root of its tree.
          treeRootSessionId: sessionId,
        }
      },
    )
  }

  async function compact(): Promise<boolean> {
    if (lifecycle.requestCompact()) {
      session.pushSystemMessage("Queued /compact; it will run after the current response. Interrupt to start it sooner.", Date.now())
      session.flush()
    }
    return true
  }

  /** A turn that waits on a person's answer is the person's to continue,
   *  not running work a planned replacement carries: every stop keeps its
   *  question open, and the next runtime shows it unanswered. */
  function holdsRunningTurn(): boolean {
    return !askUser.hasPendingQuestions() && controls.holdsRunningTurn()
  }

  /** A planned replacement's cut of the running turn. False when no turn
   *  runs, it waits on a question, or a person already interrupted it. */
  function interruptForReplacementCut(): boolean {
    return holdsRunningTurn() && controls.interruptForRuntime("replacement")
  }

  /** The runtime's stop of this runner. A stop that a planned replacement
   *  owns (`replacement`) ends a running turn as the cut ends it, with the
   *  planned record, which no surface shows. Any other stop, and a runner
   *  with no turn to cut, takes the stop below, which records `by`. */
  function prepareForShutdown(by: RuntimeInterruption): void {
    if (by === "replacement" && interruptForReplacementCut()) return
    // A pending question survives the stop for the person to answer after
    // the restart.
    suspendedOnQuestion = askUser.suspendAll() || suspendedOnQuestion
    if (suspendedOnQuestion) {
      deps.treeWriter.suspendPending()
      controls.abort()
      return
    }
    // A turn the runtime stops is interrupted, not lost: its record says the
    // runtime interrupted it (ARCH-SESSIONS-018). An idle runner, or one whose turn
    // has answered, has nothing to interrupt and shelves queued input as
    // before, recording nothing.
    if (!controls.interruptForRuntime(by)) controls.abort()
  }

  /** A planned replacement interrupts running work and settles its durable record. */
  async function interruptForReplacement(): Promise<boolean> {
    const interrupted = interruptForReplacementCut()
    // Only a turn this cut ended settles; a turn a person interrupted stays
    // parked in its slot, waiting for them, and is not waited for.
    if (interrupted) {
      await lifecycle.settle()
      await interruptionSettlement
    }
    return interrupted
  }

  /** An interrupt of the turn the planned cut ended; resolves once its turn
   *  end is durable, or at once when it recorded none. */
  async function interruptPlannedCut(by: ControlInterruption): Promise<PlannedCutInterrupt> {
    const answer = controls.interruptPlannedCut(by)
    if (answer === "recorded") await interruptionSettlement
    return answer
  }

  async function end(): Promise<void> {
    askUser.suspendAll()
    // The interruption marker must be enqueued before the tree writer's final
    // flush, or a graceful shutdown right after an interrupt would drop it.
    await interruptionSettlement
    await controls.end(suspendedOnQuestion ? { suspendedOnQuestion: true } : undefined)
  }

  async function dispose(): Promise<void> {
    await inSession(async () => {
      titleGeneration?.abort()
      prepareForShutdown("runtime")
      // Tree writer flush must complete before the resource scope closes;
      // output/budget/transcript dispose after the tree.
      await end()
      await Effect.runPromise(Scope.close(deps.resourceScope, Exit.void))
      if (!firstMessageSent) {
        deleteSessionArtifacts(sessionId, projectRoot)
      }
    })
  }

  return {
    sessionId,
    awaitTurnSettlement: () => inSession(() => lifecycle.settle()),
    get pendingTurnSettlement() { return lifecycle.pendingTurnSettlement },
    applyProjectionEvent: (event) => inSession(() => {
      session.applyProjectionEvent(event)
      session.flush()
    }),
    awaitLogicalTurnDurability: () => inSession(() => lifecycle.awaitLogicalTurnDurability()),
    send: (input) => inSession(() => {
      markFirstMessageSent(input)
      return controls.send(input)
    }),
    deliverHeldMessage: (input, decide) => inSession(() => {
      markFirstMessageSent(input)
      return lifecycle.deliverHeldMessage(input, decide)
    }),
    messageState: () => inSession(() => lifecycle.messageState()),
    deliverCommitted(input) {
      return inSession(() => {
        markFirstMessageSent(input)
        return controls.deliverCommitted(input)
      })
    },
    acceptRetainedOperation: (operation) =>
      inSession(() => deps.treeWriter.acceptRetainedOperation(operation)),
    deliverBackgroundNotification: (notification) =>
      inSession(() => lifecycle.deliverBackgroundNotification(notification)),
    requestWithContext: (input, context) => inSession(() => {
      markFirstMessageSent(input)
      return controls.requestWithContext(input, context)
    }),
    get moduleRuntimes() { return lifecycle.moduleRuntimes },
    backgroundTasks: lifecycle.backgroundTasks,
    chatModuleHosts: lifecycle.chatModuleHosts,
    onModuleRuntimesChange: lifecycle.onModuleRuntimesChange,
    hold: () => inSession(() => lifecycle.hold()),
    setShown: (shown) => inSession(() => { lifecycle.setShown(shown) }),
    seedDisplayBlocks: (blocks: readonly AnyBlock[]) => inSession(() => session.seedBlocks(blocks)),
    publishCommittedNotice: (notice) => inSession(() => { session.pushSystemMessage(notice.message, notice.timestamp, { id: notice.id }); session.flush() }),
    answerQuestion: (toolUseId, answers) => inSession(() => askUser.answerQuestion(toolUseId, answers)),
    cancelQuestion: (toolUseId) => inSession(() => askUser.cancelQuestion(toolUseId)),
    resumeCommitted: () => inSession(() => lifecycle.resumeCommitted()),
    awaitOwedCapacity: () => inSession(() => lifecycle.awaitOwedCapacity()),
    learn: () => inSession(() => lifecycle.learn()),
    // controls.interrupt() pushes the "Interrupted" message itself, placed
    // before drainQueued so the transcript reads: queued ticket ->
    // Interrupted -> now-unqueued message.
    interrupt: () => inSession(() => controls.interrupt()),
    resume: (options) => inSession(() => controls.resume(options)),
    terminateBackgroundWork: (toolUseId) => inSession(() => { lifecycle.terminateBackgroundWork(toolUseId) }),
    releaseForegroundBash: (toolUseId) => inSession(() => lifecycle.releaseForegroundBash(toolUseId)),
    transferForegroundForReplacement: () => inSession(() => lifecycle.transferForegroundForReplacement()),
    adoptHandedOver: () => inSession(() => lifecycle.adoptHandedOver()),
    recallQueuedMessage: () => inSession(() => controls.recallQueuedMessage()),
    abort() {
      inSession(() => {
        askUser.suspendAll()
        controls.abort()
      })
    },
    holdsRunningTurn,
    prepareForShutdown: (by) => inSession(() => prepareForShutdown(by)),
    interruptForReplacement: () => inSession(interruptForReplacement),
    interruptPlannedCut: (by) => inSession(() => interruptPlannedCut(by)),
    dispose,
    compact: () => inSession(compact),
    refreshDeps: () => inSession(async () => {
      await deps.refreshEnvironment()
      lifecycle.servingChanged()
      titleGeneration?.retry()
    }),
  }
}
