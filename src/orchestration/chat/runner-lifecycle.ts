import { createChatModuleHosts } from "../chat-module-host.js"
import { errorMessage } from "../../infra/error-message.js"
import { createEmit, type EventBus } from "../../infra/event-bus.js"
import { Log } from "../../infra/log.js"
import type { ConnectionState } from "../../infra/output-blocks.js"
import type { ChatInputLike } from "../../infra/chat-input.js"
import { PersistenceWriteRefused, type StoredFact } from "../../infra/event-store-types.js"
import { wakeInput, type AgentLoopWakeInput, type TurnEndedContext } from "../../infra/agent-loop-events.js"
import { randomUUID } from "node:crypto"

import { createAgentHost } from "../runner/host.js"
import type { AgentHostContextOptions, AgentHostTurnLease } from "../runner/types.js"
import { createReconnectNoticeConnectionStateHandler, reportPersistenceWriteRefusal, resolveProviderNotices } from "../agent-runtime/agent-resilience.js"
import { AgentTurnAborted } from "../runner/agent-turn-types.js"
import type { ChatSessionState } from "./types.js"
import type { ChatPorts } from "./host-ports.js"
import { createForegroundBashHoldController } from "../agent-runtime/foreground-bash-hold.js"
import type { RetryState } from "../agent-runtime/llm/retry-budget.js"
import type { AgentRunResult, AgentRunTerminal } from "../agent-runtime/types.js"
import type { AgentLoopMaintenance } from "../agent-runtime/agent-loop-types.js"
import type { ChatSessionDeps } from "./session.js"
import { ChatTurnMailbox } from "./turn-mailbox.js"
import { createChatMessageDelivery, type IdleLanding } from "./runner-message-delivery.js"
import type { OutputSession } from "../runner/output-session.js"
import { createRunnerBusBridge } from "../runner/bus-bridge.js"
import { completionWorkIds } from "../agent-runtime/background-work-notifications.js"
import type { AskUserController } from "../runner/ask-user-controller.js"
import type { ModuleChatObserver } from "../module-seams.js"
import { createModuleChatObservers } from "./module-observers.js"
import { readChatTurnEndEvidence } from "../session/chat-session-run-evidence.js"
import { createChatWaitState } from "./runner-wait-state.js"
import { awaitPlannedChildResumes } from "../session/planned-session-continuation.js"
import { waitsForPerson } from "../session/conversation/turn-end-record.js"
import { NO_MODULE_RUNTIMES, type ModuleRuntimes } from "../../infra/module-runtime.js"
import { createIdleCompaction } from "./idle-compaction.js"
import { createChatInvocationCompletion, createChatTurnDurability } from "./runner-completion.js"
import { createChatCapacityWait } from "./chat-capacity-wait.js"
import { createChatBackground } from "./chat-background.js"
import { createSessionEngines } from "./session-engines.js"
import { createChatRequestOptions } from "./chat-request-options.js"

const log = Log.create({ service: "chat" })

/** Remove after 2027-04-13, with the conversion that uses them. */
const CHAT_SEED_CONTEXT_ENTRY_ID = "chat-seed-context"
const RESTATED_SEED_CONTEXT = "Context that this session started with follows. It still applies."

interface RunningChatTurn {
  readonly completion: ReturnType<typeof createChatInvocationCompletion>
  readonly lease: AgentHostTurnLease
  preparatoryContextBuilt: boolean
  /** A maintenance start's decision: whether the last turn waits for the person. */
  readonly maintenance?: Promise<AgentLoopMaintenance>
}

type TurnStartupPurpose = "interactive" | "maintenance"

interface ChatRunnerLifecycleInput {
  deps: ChatSessionDeps
  eventBus: EventBus
  session: OutputSession
  applyNestedStoredFact: (event: StoredFact) => void | Promise<void>
  state: ChatSessionState
  askUser: AskUserController
  setConnectionState: (state: ConnectionState) => void
  awaitDurableFacts: () => Promise<void>
  installModuleObserver?: (observer: ModuleChatObserver | undefined) => void
}

export function createChatRunnerLifecycle(lifecycleInput: ChatRunnerLifecycleInput): ChatPorts {
  const { deps, session, state, askUser, setConnectionState, applyNestedStoredFact, awaitDurableFacts } = lifecycleInput
  const emit = createEmit(lifecycleInput.eventBus)
  const host = createAgentHost({ createRunner: deps.createAgent })
  const { sessionId } = deps
  const setRecoveredConnectionState = createReconnectNoticeConnectionStateHandler(
    setConnectionState,
    (operation) => { emit("agent.notice.changed", { sessionId, data: { operation } }) },
  )
  // Chat input is purely next-turn: external arrivals (user messages,
  // subagent completion batches) defer to the next turn deterministically.
  // No current-turn channel exists today; see chat/turn-mailbox.ts.
  const idleCompaction = createIdleCompaction({
    enabled: () => !state.ended && deps.idleCompaction?.enabled() === true && deps.proactiveCompactionThreshold() > 0,
    request: () => { mailbox.enqueueCompact("idle") },
  })
  const mailbox = new ChatTurnMailbox(idleCompaction.cancel)
  const cancelIdleCompaction = (): void => {
    idleCompaction.cancel()
    mailbox.cancelIdleCompaction()
  }
  const unsubscribeIdleCompaction = deps.idleCompaction?.subscribe(cancelIdleCompaction)
  const wait = createChatWaitState({
    host, sessionId,
    readLastTurnWaitsForPerson: async () => waitsForPerson((await readChatTurnEndEvidence(deps.infra.projectionReader, deps.conversationId, { restoreWait: true }))?.turnEnd),
  })
  const capacity = createChatCapacityWait({ sessionId, conversationId: deps.conversationId, eventStore: deps.infra.eventStore, onNotice: (operation) => { emit("agent.notice.changed", { sessionId, data: { operation } }) } })
  const durability = createChatTurnDurability(() => deps.treeWriter.endTurn(), (error) => deps.onTreeFailure(error))
  const { background, notifications, onBackgroundEvent } = createChatBackground({
    deps, emit, mailbox, awaitDurableFacts, admitsInput: () => !state.ended && !deps.rootChatCompletion?.sealed,
    deliver: (text, notificationKey) => submit(text, { source: "background", notificationKey }),
  })
  const foregroundBashHold = createForegroundBashHoldController((activeIds) => deps.updateEntry({ activeForegroundBashToolCallIds: activeIds }))
  let moduleRuntimes: ModuleRuntimes = NO_MODULE_RUNTIMES
  const runtimeListeners = new Set<(modules: ModuleRuntimes) => void>()
  const moduleObserver = createModuleChatObservers(deps.moduleSelection, {
    sessionId,
    eventStore: deps.infra.eventStore,
    projectionReader: deps.infra.projectionReader,
    writer: deps.infra.sessionEventWriter,
    enqueueSilentSystem: (message) => { mailbox.enqueueSilentSystem(message) },
    showSystemMessage: (message) => { session.pushSystemMessage(message, Date.now()); session.flush() },
  })
  lifecycleInput.installModuleObserver?.(moduleObserver)
  background.addSettle(async () => { await moduleObserver.dispose() })

  const moduleHosts = createChatModuleHosts({ deps, state, emit, background, foregroundBashHold, mailbox, applyNestedStoredFact, hasActiveTurn })

  // A chat with no provider session identity yet takes one now, which its pre-start and its first run share: the
  // client that the pre-start built serves the run, and holds the identity that it was built with. The first run's
  // result records it as the chat's identity (`captureProviderConversationId`).
  let mintedProviderSessionKey: string | undefined
  const chatProviderSessionKey = (): string => state.providerConversationId ?? (mintedProviderSessionKey ??= `agent-${randomUUID()}`)

  const requestOptions = createChatRequestOptions({
    deps, surfaces: { background, foregroundBashHold, askUser }, applyNestedStoredFact, providerSessionKey: chatProviderSessionKey,
  })
  // The session's engines live while a client shows it, which the session's owner reports (`ChatRunner.setShown`).
  const engines = createSessionEngines({
    sessionId, prepareRequest: deps.prepareRequest, resolveRoles: deps.resolveRoles,
    chatOptions: requestOptions.prestart,
    hostOptions: requestOptions.host,
  })
  const unsubscribeRoleChanges = deps.subscribeRoleChanges(() => { engines.rolesChanged() })

  function ownsRunningTurn(turn: RunningChatTurn): boolean {
    return host.ownsTurn(turn.lease)
  }

  function isLiveTurn(turn: RunningChatTurn): boolean {
    return ownsRunningTurn(turn) && !turn.lease.signal.aborted
  }

  function hasActiveTurn(): boolean {
    return host.turnState === "active"
  }


  async function completeCurrentModelTurn(turn: RunningChatTurn, runtimeConfig?: TurnEndedContext["runtimeConfig"]): Promise<void> {
    if (!isLiveTurn(turn)) return
    // Per-turn boundaries: the runner parks in the input source reservation
    // between turns, so durability and output-projection turn-end semantics
    // fire here, not at runner exit. The adapter handles the output reset
    // from the explicit logical lifecycle event before this flush lands.
    emit("agent.logical_turn.ended", { sessionId, data: { status: "completed" } })
    await moduleObserver.onTurnComplete("turn_end")
    session.flush()
    await durability.end()
    moduleHosts.onTurnCompleted(runtimeConfig?.moduleSections)
  }

  function setCurrentTurnConnectionState(turn: RunningChatTurn, next: ConnectionState): void {
    if (isLiveTurn(turn)) setRecoveredConnectionState(next)
  }

  async function buildRunnerContextOptions(
    turn: RunningChatTurn,
    providerConversationId?: string,
    startupPurpose: TurnStartupPurpose = "interactive",
  ): Promise<AgentHostContextOptions> {
    turn.completion.bindInputSource(() => mailbox.hasPending)
    turn.completion.beginAttempt()
    let requestContext: string | undefined
    if (mailbox.pendingInput?.kind === "request-context") {
      const pending = mailbox.pendingInput
      mailbox.drainPending()
      // A cold runner must read a trailing canonical user turn. The loop
      // cannot commit this invocation because strict context assembly precedes it.
      await deps.treeWriter.commitUserTurn(pending.input)
      if (!isLiveTurn(turn)) throw new AgentTurnAborted()
      requestContext = pending.text
      emit("agent.logical_turn.started", { sessionId, data: { origin: "user", reason: "queued_input" } })
    }
    const roles = await deps.resolveRoles()
    if (!isLiveTurn(turn)) throw new AgentTurnAborted()
    const selectedModel = roles.get("chat")
    // The session tree IS the model-visible context. Build it after any
    // commitUserTurn has settled so the trailing user message is included;
    // the agent runtime treats that trailing user as the current turn and
    // does not re-seed the instruction.
    await moduleHosts.beforeTurn()
    // A chat that a build before 2026-10-14 seeded kept its seed context in
    // the system prompt. Its first interactive turn now commits that context
    // once as a turn of its own. Remove after 2027-04-13.
    if (deps.seedContext && startupPurpose === "interactive") {
      await deps.treeWriter.commitSystemTurn(`${RESTATED_SEED_CONTEXT}\n\n${deps.seedContext}`, CHAT_SEED_CONTEXT_ENTRY_ID)
    }
    const preparatoryMaintenanceBuild = startupPurpose === "maintenance" && !turn.preparatoryContextBuilt
    const treeContext = await deps.treeWriter.buildContext(
      preparatoryMaintenanceBuild ? { allowAssistantTail: true } : undefined,
    )
    turn.preparatoryContextBuilt = true
    if (preparatoryMaintenanceBuild && treeContext.messages.length === 0) {
      mailbox.drainPending()
      throw new AgentTurnAborted()
    }
    // A maintenance start parks where the last turn ended (`decideMaintenance`).
    const maintenance = turn.maintenance ? await turn.maintenance : undefined
    const restoredWait = maintenance && !maintenance.awaitsPerson
      ? (await readChatTurnEndEvidence(deps.infra.projectionReader, deps.conversationId, { restoreWait: true }))?.restoredWait : undefined
    if (!isLiveTurn(turn)) throw new AgentTurnAborted()
    await moduleHosts.replay(treeContext.messages)

    const busBridge = createRunnerBusBridge({ emit, sessionId, isLive: () => isLiveTurn(turn) })

    return {
      ...requestOptions.send(selectedModel, engines.chat),
      conversation: {
        kind: "durable-tree",
        sessionId,
        conversationId: deps.conversationId,
        providerSessionKey: providerConversationId,
        priorMessages: treeContext.messages,
        resolveLeafId: () => deps.treeWriter.getLeafId(),
        committedTree: () => deps.treeWriter.getState(),
        captureCommittedForkMessages: () => deps.treeWriter.captureCommittedForkMessages(),
        recordInterruption: () => deps.treeWriter.commitTurnEnd("person"),
        reserveMessageId: deps.treeWriter.reserveMessageId,
        releaseMessageId: deps.treeWriter.releaseMessageId,
        append: (message, entryId) => {
          if (!isLiveTurn(turn)) return
          if (message.kind === "assistant") moduleHosts.noteAssistantMessage(message.content)
          return deps.treeWriter.recordCanonicalMessage(message, entryId)
        },
        recordCompaction: (compactionInput) => deps.treeWriter.recordCompaction(compactionInput).then((result) => result?.messages),
        flush: (protectedToolUseIds, finalizedCheckpointSwaps) =>
          deps.treeWriter.flushSavePoint(protectedToolUseIds, finalizedCheckpointSwaps),
        awaitDurableFacts,
      },
      ...(requestContext ? { requestContext } : {}),
      ...busBridge,
      waitForEventCapacity: (signal) => lifecycleInput.eventBus.waitForCapacity(signal),
      onNotification: deps.onNotification,
      onSystemMessage: (message, level) => {
        if (!isLiveTurn(turn)) return
        emit("agent.system_message.recorded", { sessionId, data: { message, level } })
      },
      lifecycle: {
        ...(turn.completion.seal ? { kind: "complete-on-idle" as const, seal: turn.completion.seal } : { kind: "parkable" as const }),
        ...busBridge.lifecycle,
        inputSource: mailbox,
        ...(maintenance ? { maintenance } : {}),
        ...(restoredWait ? { restoredWait } : {}),
        // The tree writer's phase follows the logical turn, not the runner's
        // life: a parked runner consuming queued input opens a turn, and a
        // park closes one. An interrupt parks without onTurnEnded, so the
        // park is what lands the interrupt marker and anything else held
        // behind the killed turn.
        onLogicalTurnStarted: (ctx) => {
          engines.turnStarted()
          wait.resumed()
          durability.begin()
          if (ctx.origin === "user") wait.clearStall()
          if (isLiveTurn(turn)) deps.treeWriter.beginTurn()
          busBridge.lifecycle.onLogicalTurnStarted(ctx)
        },
        onTurnParked: async (ctx) => {
          wait.parked(ctx.park)
          await capacity.parked(ctx.park)
          busBridge.lifecycle.onTurnParked(ctx)
          if (isLiveTurn(turn)) await durability.end()
          if (isLiveTurn(turn) && !mailbox.hasPending) idleCompaction.park(ctx)
          durability.finish()
          // A turn that waits on its background work still uses the chat's client; its settle ends it.
          if (ctx.park !== "waiting_on_work") engines.turnEnded()
        },
        onTurnResumed: () => {
          engines.turnStarted()
          cancelIdleCompaction()
          wait.resumed()
          durability.begin()
          busBridge.lifecycle.onTurnResumed()
        },
        onCompactionContinuation: () => moduleObserver.onCompactionContinuation(),
        onTurnEnded: ({ runtimeConfig }) => completeCurrentModelTurn(turn, runtimeConfig),
        onConnectionState: (next) => { setCurrentTurnConnectionState(turn, next) },
        onRuntimeAssembled: async ({ modules }) => {
          moduleRuntimes = modules
          for (const listener of runtimeListeners) {
            try { listener(modules) } catch (error) { log.warn("module runtime listener failed", { error: errorMessage(error) }) }
          }
          if (restoredWait) await awaitPlannedChildResumes({
            reader: deps.infra.eventStore, projectionReader: deps.infra.projectionReader,
            parentSessionId: sessionId, parentConversationId: deps.conversationId,
          })
        },
      },
      onBackgroundEvent,
      onChildEvent: (childSessionId, event) => { emit(event.type, { sessionId: childSessionId, data: event.data }) },
    }
  }

  function startTurn(
    message: string | AgentLoopWakeInput,
    opts: {
      source?: "user" | "background"
      reason?: "new_input" | "queued_input"
      skipLogicalStart?: boolean
      purpose?: TurnStartupPurpose
    } = {},
  ): void {
    const lease = host.takeReservedTurn() ?? host.reserveTurn()
    if (!lease) throw new Error("startTurn requires an idle or reserved runner host")
    engines.turnStarted()
    const turn: RunningChatTurn = { lease, completion: deps.rootChatCompletion ?? createChatInvocationCompletion(undefined), preparatoryContextBuilt: false, ...(opts.purpose === "maintenance" ? { maintenance: wait.decideMaintenance(lease) } : {}) }
    let runnerStarted = false
    let userInputAfterStartupStop: (() => boolean) | undefined
    const observeStartupInterrupt = (): void => {
      if (!runnerStarted) userInputAfterStartupStop = mailbox.observeUserInput()
    }
    lease.signal.addEventListener("abort", observeStartupInterrupt, { once: true })
    durability.begin()
    const userInitiated = opts.source !== "background"
    if (userInitiated && opts.purpose !== "maintenance") wait.clearStall()

    if (opts.skipLogicalStart !== true) {
      emit("agent.logical_turn.started", {
        sessionId,
        data: {
          origin: opts.source === "background" ? "background" : "user",
          reason: opts.reason ?? "new_input",
        },
      })
    }

    emit("agent.run.started", { sessionId, data: { stepIndex: 0 } })

    // Moving forward clears the action-needed notice: starting a turn resolves
    // any blocked provider notice a prior terminal failure left behind, before
    // the first stream event would.
    emit("agent.notice.changed", { sessionId, data: { operation: resolveProviderNotices() } })

    // providerConversationId is the chat runner's provider session identity,
    // never its prompt-cache key. It is NOT Flywheel's chat context source;
    // the session tree owns that.
    const providerConversationId = chatProviderSessionKey()

    const run = async (): Promise<void> => {
      // Per-attempt bookkeeping only: the runner's typed terminal already says
      // why it exited, so nothing here infers liveness from side-channel flags.
      const classifyResult = (result: AgentRunResult): AgentRunResult => {
        if (!ownsRunningTurn(turn)) return result
        if (result.providerSessionKey && state.captureProviderConversationId(result.providerSessionKey)) {
          // A newly observed provider continuation token lands in the live
          // entry and in durable chat metadata at the same moment.
          deps.updateEntry({ providerConversationId: result.providerSessionKey })
          deps.onChatMetadata?.({ providerConversationId: result.providerSessionKey })
        }
        const captured = { ...result, providerSessionKey: state.providerConversationId ?? result.providerSessionKey }
        session.flush()
        return captured
      }

      // Clean exits read as a finished turn; failures and mid-turn kills read as paused work.
      const detachStatus = (terminal: AgentRunTerminal): "completed" | "paused" =>
        state.ended || terminal.kind === "completed" || terminal.kind === "budget_exhausted" ? "completed" : "paused"

      let result: AgentRunResult | undefined
      try {
        // A command a previous build handed to this conversation is this
        // chat's before any request, so the turn parks on it as on its own.
        await background.adoptHandedOver()
        result = await host.runTurn({
          createContextOptions: async ({ providerSessionKey }: RetryState) =>
            buildRunnerContextOptions(turn, providerSessionKey ?? providerConversationId, opts.purpose),
          onContextCreated: (ctx) => {
            if (!isLiveTurn(turn)) {
              ctx.end()
              throw new AgentTurnAborted()
            }
            state.attachRunner(ctx)
            deps.treeWriter.beginTurn()
          },
          onContextStarted: () => { runnerStarted = true },
          message,
          resilience: {
            setConnectionState: (next) => { setCurrentTurnConnectionState(turn, next) },
            pushSystemMessage: (msg, level) => {
              if (!isLiveTurn(turn)) return
              session.pushSystemMessage(msg, Date.now(), { level })
              session.flush()
            },
            onNotice: (operation) => {
              // Resilience clears notices before publishing a startup failure.
              // Input accepted in response must count as new authorization.
              if (!runnerStarted) userInputAfterStartupStop ??= mailbox.observeUserInput()
              if (!isLiveTurn(turn)) return
              emit("agent.notice.changed", { sessionId, data: { operation } })
            },
            signal: turn.lease.signal,
            originalProviderSessionKey: providerConversationId,
            ...capacity.resilience,
          },
          classifyResult,
          onAttemptFailure: async () => {
            if (!isLiveTurn(turn)) return
            try {
              await deps.treeWriter.flushSavePoint()
            } catch (err) {
              deps.onTreeFailure(err)
              throw err
            }
          },
        })
        if (!ownsRunningTurn(turn)) return
        // A startup interrupt has no parked loop to record the person's cut,
        // and neither has an interrupt that cut a capacity wait.
        if ((capacity.takeCutInterrupt() !== undefined || (!runnerStarted && turn.lease.signal.aborted)) && !state.ended) {
          await deps.treeWriter.commitTurnEnd("person")
        }
        // The runner is done: pending assistant/tool_result entries become
        // durable as one batch before any next provider request observes
        // them via `buildContext`, and the writer is idle for the next one.
        await turn.completion.finish(result.terminal, durability.end)
        if (result.terminal.kind === "stream_stalled") wait.stall()
        state.detachRunner(session, detachStatus(result.terminal))
      } catch (err) {
        if (!ownsRunningTurn(turn)) return
        if (err instanceof PersistenceWriteRefused && result?.terminal.kind !== "local_persistence_error") {
          reportPersistenceWriteRefusal(err, { pushSystemMessage: (notice, level) => { session.pushSystemMessage(notice, Date.now(), { level }); session.flush() } })
        }
        if (!runnerStarted) userInputAfterStartupStop ??= mailbox.observeUserInput()
        if (!state.ended && !(err instanceof PersistenceWriteRefused)) log.warn("agent turn exited unexpectedly", { error: errorMessage(err) })
        // Even on failure, completed messages already buffered must land:
        // committed pending writes are preserved across abort.
        await durability.end().catch(() => undefined)
        state.detachRunner(session, "paused")
      } finally {
        lease.signal.removeEventListener("abort", observeStartupInterrupt)
        const owned = ownsRunningTurn(turn)
        if (owned) durability.finish()
        // The turn settled on every exit here, and its run no longer uses the chat's client. A turn that a newer turn
        // replaced leaves the newer turn's end to it.
        if (owned) engines.turnEnded()
        // A stopped preparation never consumed its queue. Only later explicit
        // input can authorize a fresh lease after durable teardown, not old
        // queued input or background completion. Running-agent interrupts keep
        // the loop's existing in-memory continuation behavior.
        const authorized = runnerStarted && !turn.lease.signal.aborted || userInputAfterStartupStop?.() === true
        const canResume = !wait.stalled || mailbox.hasPendingUserMessage
        if (owned && authorized && !state.ended && !turn.completion.sealed && mailbox.hasPending && canResume) {
          host.continueAfterTurn(turn.lease, startQueuedInputTurn)
        }
      }
    }

    host.startTurn(lease, run)
  }

  /** Starts the turn that drains the mailbox, for input that waits there
   *  with no loop left to consume it. */
  function startQueuedInputTurn(): void {
    startTurn(wakeInput(), { source: "user", reason: "queued_input", skipLogicalStart: true })
  }

  // Single submission channel for both user input and subagent completion
  // batches. Branch-not-both: if a runner is attached, enqueue for the
  // parked loop's drainPending; otherwise spawn a fresh runner whose
  // buildContext picks up the already-committed user turn from the tree.
  // After state.end() (session shutdown) drop silently.
  //
  // A background notification is held before either delivery branch. With an
  // attached runner it keeps the existing silent mailbox path. Without one,
  // its system-origin conversation entry commits before the respawn reads context.
  //
  // Two producers can deliver one keyed notification at once: an adopted
  // command's own completion and the drain of held notices that a
  // continuation runs. The conversation knows a repeat only after the first
  // delivery commits, so the runner also keeps each key it is delivering. A
  // key that lands while no turn runs leaves the set when it lands; a key in
  // the mailbox lands with the turn's own writes and stays for the runner's life.
  const deliveringKeys = new Set<string>()
  async function submit(input: ChatInputLike, opts?: { source: "user" | "background"; notificationKey?: string }): Promise<boolean> {
    cancelIdleCompaction()
    if (state.ended || deps.rootChatCompletion?.sealed) return false
    // Every user-source submission is one real user turn: the review's
    // memory counter. Background notifications are not the user speaking.
    if (opts?.source !== "background") moduleHosts.noteUserTurn()
    const backgroundText = opts?.source === "background" ? (typeof input === "string" ? input : input.text) : undefined
    let backgroundNotification
    if (backgroundText !== undefined) {
      const registryOwned = opts?.notificationKey !== undefined && completionWorkIds(opts.notificationKey).length > 0
      try {
        backgroundNotification = await deps.treeWriter.holdBackgroundNotification(backgroundText, opts?.notificationKey)
      } catch (err) {
        deps.onTreeFailure(err)
        return false
      }
      // A repeat of a keyed notification the conversation already committed
      // has nothing new to deliver, and wakes no turn.
      if (backgroundNotification === undefined) return true
      // Nor does a repeat of one this runner is still delivering.
      if (!registryOwned && backgroundNotification.key !== undefined && deliveringKeys.has(backgroundNotification.key)) return true
      if (!registryOwned && backgroundNotification.key !== undefined) deliveringKeys.add(backgroundNotification.key)
      // Shutdown after the durable hold leaves the accepted notification for reactivation.
      if (state.ended) return true
    }
    const activeTurn = host.activeTurnLease
    if (activeTurn) {
      if (backgroundNotification) {
        mailbox.enqueueBackgroundNotification(backgroundNotification)
        return true
      }
      mailbox.enqueueNextTurn(input)
      // A person's message ends a capacity wait: the turn continues with it.
      capacity.continueNow()
      return true
    }

    const reservation = host.reserveTurn()
    if (!reservation) {
      if (backgroundNotification) mailbox.enqueueBackgroundNotification(backgroundNotification)
      return backgroundNotification !== undefined
    }
    if (backgroundNotification) {
      // With no runner, the held notification commits before the respawn
      // reads context. With a runner parked after an interrupt, the loop's
      // own gate folds it in; with none (after a restart) the durable turn
      // end is the same gate: the committed notification lands on Resume or
      // the next message.
      const notification = backgroundNotification
      try {
        await landWhileIdle(reservation, {
          admit: (waits) => ({ result: true, landing: waits ? "hold" : "wake" }),
          commit: () => deps.treeWriter.commitBackgroundNotification(notification),
          wake: () => startTurn(typeof input === "string" ? input : input.text, opts),
        })
      } catch {
        return false
      } finally { if (notification.key !== undefined) deliveringKeys.delete(notification.key) }
      return true
    }
    startTurn(typeof input === "string" ? input : input.text, opts)
    return true
  }

  /** The one turn-slot sequence for input that lands in history while no
   *  turn runs: a background notification, or a message from another
   *  session that is already held in its cell. The caller holds the slot's
   *  reservation, so a Resume or a person's message that arrives meanwhile
   *  waits in the mailbox. `admit` reads whether the last turn waits for the
   *  person, as an interrupt, an unexpected exit, or a stall leaves it, and
   *  answers whether the input commits and whether it starts its own turn.
   *  After the commit, the sequence starts that turn, or the turn the
   *  mailbox now waits with, or releases the slot. No turn starts after the
   *  runner ended. A failed commit releases the slot and rejects. */
  async function landWhileIdle<T>(reservation: AgentHostTurnLease, landing: IdleLanding<T>): Promise<T> {
    const userInputArrived = mailbox.observeUserInput()
    const admission = landing.admit(await wait.awaitsPerson())
    if (admission.landing === "refuse") {
      host.releaseTurn(reservation)
      return admission.result
    }
    try {
      await landing.commit()
    } catch (err) {
      host.releaseTurn(reservation)
      deps.onTreeFailure(err)
      throw err
    }
    // The one ended check after the last await: the runner can end during
    // the commit, and no turn starts after it ended.
    if (state.ended) host.releaseTurn(reservation)
    else if (admission.landing === "wake") landing.wake()
    else if (userInputArrived()) startQueuedInputTurn()
    else host.releaseTurn(reservation)
    return admission.result
  }

  const messages = createChatMessageDelivery({
    host,
    mailbox,
    session,
    ended: () => state.ended || deps.rootChatCompletion?.sealed === true,
    wait,
    landWhileIdle,
    commitHeldMessage: (input) => deps.treeWriter.commitHeldMessage(input),
    wake: (input) => startTurn(input.text, { source: "background" }),
  })

  function restartWithQueuedInputs(inputs: readonly ChatInputLike[]): void {
    if (state.ended || deps.rootChatCompletion?.sealed) return
    for (const input of inputs) mailbox.enqueueNextTurn(input)
    if (hasActiveTurn()) return
    startQueuedInputTurn()
  }

  function requestWithContext(input: ChatInputLike, context: string): boolean {
    if (state.ended || deps.rootChatCompletion?.sealed) return false
    mailbox.enqueueRequestWithContext(input, context)
    if (!hasActiveTurn() && !wait.stalled) startTurn(wakeInput(), { skipLogicalStart: true })
    return true
  }

  function resumeCommitted(options?: Parameters<ChatPorts["resumeCommitted"]>[0]): boolean {
    if (state.ended || deps.rootChatCompletion?.sealed || (wait.stalled && options?.explicit !== true)) return false
    // A person's Resume is the loop's authorizing input: a runner parked
    // after an interrupt continues on it, and a fresh runner consumes it
    // first and records the continuation. The automatic wake after a
    // settled question authorizes nothing and records nothing.
    if (options?.explicit) {
      wait.clearStall()
      mailbox.enqueueResume()
    }
    if (host.turnState === "active") {
      if (!options?.explicit) mailbox.enqueueWake()
      return true
    }
    emit("agent.turn.resumed", { sessionId, data: {} })
    startTurn(wakeInput(), { skipLogicalStart: true })
    return true
  }

  return {
    get invocationCompletion() { return deps.rootChatCompletion },
    get turnState() { return host.turnState },
    onModuleRuntimesChange: (listener) => { runtimeListeners.add(listener); return () => runtimeListeners.delete(listener) },
    interruptGeneration: () => {
      cancelIdleCompaction()
      // A turn that waits for capacity runs no generation: the interrupt cuts
      // the wait, and the turn ends with the person's turn end. Both run.
      const interrupted = [capacity.cutWait("person"), host.interruptGeneration()].includes(true)
      if (interrupted) emit("agent.turn.interrupted", { sessionId, data: {} })
      return interrupted
    },
    get turnRunning() { return wait.turnRunning() },
    setShown: engines.setShown,
    servingChanged: engines.servingChanged,
    // The teardown abort, not a person's interrupt: an interrupted loop parks
    // in its turn slot with its in-memory history, but the runtime's planned
    // stop ends the runner, and its resume after the restart builds context
    // from the committed leaf, where the turn-end record is. The aborted run
    // still lands what it committed.
    abortRunningTurn: () => {
      cancelIdleCompaction()
      if (!wait.turnRunning()) return false
      host.abortGeneration()
      return true
    },
    abortGeneration: () => { cancelIdleCompaction(); host.abortGeneration() },
    enqueueInput: submit,
    deliverHeldMessage: messages.deliverHeldMessage,
    messageState: messages.messageState,
    deliverBackgroundNotification: async (notification) => {
      if (state.ended || deps.rootChatCompletion?.sealed) return false
      const accepted = background.tasks.deliverDurableSubagentNotification(notification) !== undefined
      await notifications.settle()
      return accepted
    },
    drainQueuedUserInputs: () => mailbox.drainUserMessages(),
    recallQueuedUserInput: () => mailbox.recallLastUserMessage(),
    restartWithQueuedInputs,
    requestWithContext,
    get moduleRuntimes() { return moduleRuntimes },
    backgroundTasks: background.tasks,
    chatModuleHosts: moduleHosts,
    resumeCommitted,
    // The Resume runs as any turn does, under the host: its walk finds the
    // routes spent until the row's time, from the account's durable
    // availability, and the turn waits as it waited before the exit.
    async awaitOwedCapacity() {
      return await capacity.owesWaitAhead() && !hasActiveTurn() && resumeCommitted({ explicit: true })
    },
    hold: () => new Promise<ModuleRuntimes>((resolve, reject) => {
      if (state.ended) { reject(new Error("The runner has ended")); return }
      if (moduleRuntimes !== NO_MODULE_RUNTIMES) { resolve(moduleRuntimes); return }
      const listener = (modules: ModuleRuntimes): void => { runtimeListeners.delete(listener); resolve(modules) }
      runtimeListeners.add(listener)
      // An active turn is assembling already. Otherwise a maintenance turn
      // assembles the runtime, consumes the hold, and parks on background work.
      if (hasActiveTurn()) return
      mailbox.enqueueHold()
      try {
        startTurn(wakeInput(), { skipLogicalStart: true, purpose: "maintenance" })
      } catch (error) {
        runtimeListeners.delete(listener)
        reject(error)
      }
    }),
    requestCompact: () => {
      if (deps.rootChatCompletion?.sealed) throw new Error("The one-shot Chat invocation has already completed")
      const queued = !mailbox.parked
      mailbox.enqueueCompact()
      if (!hasActiveTurn()) {
        startTurn(wakeInput(), { skipLogicalStart: true, purpose: "maintenance" })
        return false
      }
      return queued
    },
    settle: host.settle,
    get pendingTurnSettlement() { return durability.pendingTurnSettlement },
    awaitLogicalTurnDurability: durability.awaitDurable,
    learn() {
      if (deps.rootChatCompletion?.sealed) return false
      return moduleHosts.review()
    },
    // Session end runs after turn settlement. Close managed work first, then
    // verify that every pre-transfer hold cleaned itself up before disposing
    // the transient hold authority.
    terminateBackgroundWorks: async () => {
      cancelIdleCompaction()
      await unsubscribeIdleCompaction?.()
      await background.close()
      runtimeListeners.clear()
      await foregroundBashHold.awaitSettlement()
      foregroundBashHold.dispose()
      await unsubscribeRoleChanges()
      await engines.close()
    },
    terminateBackgroundWork: (toolUseId) => background.tasks.terminate(toolUseId),
    releaseForegroundBash: (toolUseId) => foregroundBashHold.release(toolUseId),
    transferForegroundForReplacement: () => foregroundBashHold.transferForReplacement(),
    adoptHandedOver: () => background.adoptHandedOver(),
  }
}
