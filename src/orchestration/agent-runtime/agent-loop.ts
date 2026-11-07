// Agent turn state machine: stream collection, compaction, tool execution. Input arrives through `options.inputSource`; observers are notified at lifecycle moments and may enqueue back into the source.
import { Effect, Exit, Scope } from "effect";
import { mergeAbortSignals } from "../../infra/abort.js";
import type { AgentLoopInput } from "../../infra/agent-loop-events.js";
import { Log } from "../../infra/log.js";
import { runBudgetExhaustionTurn } from "./budget-exhaust.js";
import { createBudgetNudge } from "./budget-nudge.js";
import { attemptContextOverflowRecovery, type PlannedCompactionOperation } from "./compaction/triggers.js";
import { captureForkMessages, recordInterruptedTurn, seedAgentLoopTurn } from "./agent-loop-history.js";
import { createPendingWorkNudge } from "./pending-work-nudge.js";
import { agentLoopTransition as loopTransition, createAgentRunTally, initialAgentLoopState as initialLoopState, openWaitFor, OUTPUT_OVERFLOW_CONTINUATION_LIMIT, tallyToolResults } from "./agent-loop-state.js";
import { createHandoffTracker, HANDOFF_OWED_NOTICE } from "./agent-loop-handoff.js";
import type { PersistenceWriteRefused } from "../../infra/event-store-types.js";
import { createContentFilterRecovery } from "./agent-loop-content-filter.js";
import { createAgentLoopToolContext } from "./agent-loop-tool-context.js";
import { hasAssistantOutput } from "./assistant-output.js";
import { createSettledBatchObservation, createWaitToolPolicy, endsOpenWait, restoreAgentLoopWait, type OpenWaitInput } from "./agent-loop-wait.js";
import { finalReplyText, hasLiveBackgroundWork, inputClosedTerminal, missingHandoffReminder, resolveAgentLoopClosureMode } from "./agent-loop-closure.js";
import { streamAssistantTurn, type AssistantTurnRequest } from "./assistant-turn-stream.js";
import { openRequestPreparation } from "./request-preparation.js";
import { createTurnDispatcher, stampToolRegistration } from "./agent-loop-tools.js";
import { repairToolName } from "./tools/tool-dispatch.js";
import { settleTurn, type SettledTurn } from "./agent-turn-settlement.js";
import { openStandaloneTurn, type OwnedTurn } from "./run-lifecycle.js";
import type { AssistantTurnResult } from "./assistant-turn-result.js";
import { createAssistantMessageSettlement } from "./assistant-message-settlement.js";
import { createToolResultCommit } from "./agent-loop-result-commit.js";
import { createAgentLoopCompactionState } from "./agent-loop-compaction-state.js";
import { consumeAgentLoopMessageInput, consumeAgentLoopResumeInput } from "./agent-loop-input.js";
import { consumeAgentLoopInput, createAgentLoopInputWaiter } from "./agent-loop-input-consumer.js";
import type { AgentLoopOptions, AgentLoopTerminal } from "./agent-loop-types.js";
import { createReplyNudge, SILENT_REPLY_NUDGE } from "./reply-nudge.js";
import { createContextAdmission, shouldCompact } from "./compaction/compaction-policy.js";
import type { ConversationMessage, LlmStopReason, ToolCall } from "./llm/types.js";
import { repairContentRefusal } from "./llm/content-repair.js";
import { createStreamedEditTurn } from "./streamed-edit-turn.js";
import { prepareLocalTokenizer } from "../../infra/local-tokenizer.js";
import { CONTINUATION_MESSAGES } from "./continuation-messages.js";
import { trackTurnHop } from "./turn-hop.js";

const log = Log.create({ service: "agent-loop" });
// oxlint-disable-next-line eslint/complexity -- boundary: one loop owns ordered provider-request, compaction, tool, and lifecycle state.
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopTerminal> {
  await prepareLocalTokenizer();
  const { instruction, executionCwd, handoff, signal, onEvent } = options;

  const persistence = options.persistence; const historySink = persistence.history;
  const lifecycle = options.lifecycle;
  // Human-facing loops only: a subagent's text is delivered to its dispatcher.
  const replyNudge = createReplyNudge(options.humanFacing === true);
  // Every request of the loop is built through the run's one request preparation, as a pre-start's is.
  const preparation = await openRequestPreparation(options, {
    history: historySink, onUserMessage: options.onUserMessage, onSystemMessage: options.onSystemMessage, onEvent,
    flush: options.flushCanonicalMessages,
    assistantContentCommitted: (visible) => replyNudge.assistantContentCommitted(visible),
    admitsProviderMessages: () => !handoffTracker.isHandingOff,
  });
  const { pushMessage, pushAssistant, pushUser, pushToolResults, requestContext, appendRequestEntries, initialInteractionProfile } = preparation;
  const snapshotConversation = (): Promise<ConversationMessage[]> =>
    captureForkMessages(preparation.messages, persistence.captureCommittedForkMessages);
  const turnHop = trackTurnHop(() => preparation.messages);
  // Tool batches open it per request, dispatch tools hold the results that they size, and delivered input is charged to it.
  const contextAdmission = createContextAdmission(() => ({ promptTokens: contextAnchor.estimate(), contextLimit: preparation.planned.contextLimit }));
  const { surface, toolContext, prepareCurrentPrompt } = createAgentLoopToolContext({
    options,
    executionCwd,
    signal,
    attempt: () => preparation.planned,
    handoff: handoff ? { onContent: handoff.onContent, readCommandEvidence: handoff.readCommandEvidence } : undefined,
    snapshotConversation,
    contextAdmission,
    turnHasVisibleText: replyNudge.turnHasVisibleText,
    turnHop: turnHop.current, conversationHistory: () => preparation.messages,
  });

  const maxLLMCalls = options.maxLLMCalls;
  const tally = options.tally ?? createAgentRunTally();
  const priorLLMCalls = options.priorLLMCalls ?? 0;
  let state: typeof initialLoopState = { ...initialLoopState, llmCalls: priorLLMCalls };
  let logicalTurnRequestContext = options.initialRequestContext;
  // The surface a manual compaction admitted. The request that follows at
  // once reuses it. A park or a person turn discards it, so the request after
  // either admits again and reads what changed before the person's turn.
  let admittedRequest: Awaited<ReturnType<typeof surface.resolve>> | undefined;
  // An agent of a workflow is held once, when it starts: only the first
  // request of this life can share a cold prefix with a sibling. Every later
  // request carries the agent's own messages and already finds its tools and
  // system prompt in the cache.
  let startPrefixHold = options.promptPrefixHold;
  const handoffRequired = handoff !== undefined;
  const budgetNudge = createBudgetNudge(maxLLMCalls, handoffRequired);
  const handoffTracker = createHandoffTracker({ background: options.background?.tasks, onStarted: lifecycle?.onHandoffStarted });
  const contentFilter = createContentFilterRecovery({ providerSessionKey: options.providerSessionKey, pushUser, onSystemMessage: options.onSystemMessage });
  const pendingWorkNudge = createPendingWorkNudge({ providerSessionKey: options.providerSessionKey, pushUser });

  const contextAnchor = requestContext.anchor;
  const compactionState = createAgentLoopCompactionState({
    options, messages: () => preparation.messages, surface, requestContext, initialInteractionProfile, prepareCurrentPrompt,
    selectAttempt: (attempt) => { preparation.planned = attempt; }, attempt: () => preparation.planned,
    logicalRequestContext: () => replyNudge.previewRequestContext(logicalTurnRequestContext),
    admitSurface: (next) => { admittedRequest = next; },
    compactionAllowedTools: (requestsAhead) => budgetNudge.closureWhitelist(state.llmCalls + requestsAhead)?.tools,
    carryTurnEnd: () => turnEndRecorded,
    setMessages: (next) => { preparation.messages = next; },
    onEvent,
    pushUser, pushMessage, onUserMessage: options.onUserMessage,
    checkpoint: options.checkpoint,
    recallAvailable: () => surface.current().usableToolNames.has("recall"),
  });
  const { prepareCompactedHistory, canCompact, canPlan } = compactionState;

  const messageInputEffects: Parameters<typeof consumeAgentLoopMessageInput>[3] = {
    clearRequestContext: () => { logicalTurnRequestContext = undefined; },
    logicalTurnStarted: (origin) => {
      turnEndRecorded = false;
      lifecycle?.onLogicalTurnStarted?.({ origin, reason: "queued_input" });
      if (origin === "user") { admittedRequest = undefined; pendingWorkNudge.reset(); batchObservation.reset(); }
      state = loopTransition.logicalTurnStarted(state, origin);
    },
    pushUser, admit: contextAdmission.admit,
    visibleReplyRequired: () => replyNudge.visibleReplyRequired(),
  };

  const consumeLoopInput = (input: AgentLoopInput | null | undefined, inputOptions?: Parameters<typeof consumeAgentLoopInput>[2]): Promise<"empty" | "continue"> =>
    consumeAgentLoopInput(input, {
    turnHop,
    canCompact: canPlan,
    refuseCompaction: () => options.onSystemMessage?.("Compaction is unavailable: this execution requires scoped checkpoint_read, checkpoint_replace, and checkpoint_decide tools and enough of its turn budget to save. Context has been kept.", "error"),
    consumeMessage: async (message, start, preserve) => {
      if (input?.kind === "request-context") logicalTurnRequestContext = input.text;
      const consumed = await consumeAgentLoopMessageInput(message, start, preserve, messageInputEffects);
      // Input that starts the turn before the Resume does supersedes the cut.
      if (start) continuedWait = undefined;
      meetOpenWait({ ...message, content: message.text });
      return consumed;
    },
    consumeResume: async (start) => {
      const consumed = await consumeAgentLoopResumeInput(start, messageInputEffects);
      // The successor's Resume of a planned cut continues the turn with its
      // wait; a person's Resume ends the open wait.
      const continued = continuedWait;
      continuedWait = undefined;
      meetOpenWait({ kind: "resume", continuesWait: continued !== undefined });
      if (continued) state = restoreAgentLoopWait(state, continued, options.background?.tasks, undefined);
      return consumed;
    },
    scheduleCompaction: compactionState.schedule,
    onCompactionContinuation: lifecycle?.onCompactionContinuation,
    }, inputOptions);

  // The loop waits for the person: a maintenance start whose last turn waits
  // for the person, or a park after an interrupt. A compaction then runs no
  // turn of the person's: it parks where the last turn ended, waits for the
  // person again, and records nothing new. Only a resumed turn ends the wait,
  // so a compaction after it, or after an interrupt of the maintenance
  // compaction, parks as any answered turn does.
  let awaitsPerson = lifecycle?.maintenance?.awaitsPerson === true;
  // The wait rests on a recorded turn end: one that a maintenance start read,
  // or one that this loop recorded for an interrupt. Every compaction until
  // the person's message or Resume carries that record past its reset, so
  // the conversation still reads as waiting for the person (ARCH-SESSIONS-035). A
  // stall waits for the person too, but records no turn end to carry.
  let turnEndRecorded = lifecycle?.maintenance?.turnEndWaits === true;
  let continuedWait = lifecycle?.continuedWait;
  const awaitNextLoopInput = createAgentLoopInputWaiter({
    runSignal: signal,
    providerSessionKey: options.providerSessionKey,
    prepareWaitForInput: options.inputSource?.prepareWaitForInput?.bind(options.inputSource),
    consume: consumeLoopInput,
    state: () => ({ turnCount: state.turn, handoffWritten: false, ...(state.wait ? { wait: state.wait } : {}) }),
    closeWait: () => { state = loopTransition.waitClosed(state); },
    backgroundTasks: options.background?.tasks,
    scheduleWaitExpiry: options.scheduleWaitExpiry,
    onTurnParked: (context) => {
      awaitsPerson = context.userResumeRequired;
      admittedRequest = undefined;
      tally.parks += 1;
      return lifecycle?.onTurnParked?.({ ...context, idleCache: compactionState.parkedCache() });
    },
    onTurnResumed: () => { awaitsPerson = false; turnEndRecorded = false; lifecycle?.onTurnResumed?.(); },
    recordInterruption: async () => { if (await recordInterruptedTurn(persistence, (record) => { preparation.messages.push(record); }, options.flushCanonicalMessages)) turnEndRecorded = true; },
    currentTurn: options.currentTurn,
  });

  const replyOwed = await seedAgentLoopTurn({
    seed: options.seed, messages: preparation.messages, instruction, onUserMessage: options.onUserMessage, pushUser,
  });
  if (replyOwed) replyNudge.visibleReplyRequired();
  const closureMode = resolveAgentLoopClosureMode(handoffRequired, options.completeOnIdle !== undefined, options.inputSource?.prepareWaitForInput !== undefined);

  // A turn ended with nothing left to run: queued input wins, then the loop
  // completes, parks, or nudges per the closure mode.
  const resolveTurnEnd = async (waitSignal: AbortSignal | undefined): Promise<"continue" | AgentLoopTerminal> => {
    const interruption = () => signal?.aborted ? { kind: "aborted" } as const : waitSignal?.aborted ? parkForPerson("record") : null;
    let interrupted = interruption(); if (interrupted) return await interrupted;
    const pending = await consumeLoopInput(options.inputSource?.drainPending()); interrupted = interruption();
    if (interrupted) return await interrupted;
    if (pending === "continue") return "continue";
    closeSpentWait();
    if (!state.wait && hasLiveBackgroundWork(options.background?.tasks, false) && options.inputSource?.prepareWaitForInput) {
      const runtimeWaitSeconds = await pendingWorkNudge.turnEndedWithoutWait(state.turn);
      if (runtimeWaitSeconds === undefined) return "continue";
      state = loopTransition.waitOpened(state, openWaitFor(runtimeWaitSeconds));
    }
    // Completion incorporates every settled result.
    if (closureMode === "oneshot" && hasLiveBackgroundWork(options.background?.tasks, state.wait !== undefined) && options.inputSource?.prepareWaitForInput) {
      if ((await awaitNextLoopInput(true, waitSignal)) === "continue") return "continue";
      return inputClosedTerminal(signal?.aborted);
    }
    if (closureMode === "oneshot") {
      // A task may have settled between the drain above and the count read;
      // its notification is already enqueued, so re-drain before completing.
      const finalPending = await consumeLoopInput(options.inputSource?.drainPending()); interrupted = interruption();
      if (interrupted) return await interrupted;
      if (finalPending === "continue") return "continue";
      if (options.completeOnIdle?.seal?.(finalReplyText(preparation.messages)) === false) return (await awaitNextLoopInput(false, waitSignal)) === "continue" ? "continue" : inputClosedTerminal(signal?.aborted);
      return { kind: "completed" };
    }
    const reminder = missingHandoffReminder(closureMode, options.inputSource?.prepareWaitForInput !== undefined, hasLiveBackgroundWork(options.background?.tasks, state.wait !== undefined), surface.current().tools);
    if (reminder) {
      log.warn("turn ended without a handoff; injecting a reminder instead of parking", { turnCount: state.turn, providerSessionKey: options.providerSessionKey });
      await pushUser(reminder);
      return "continue";
    }
    if ((await awaitNextLoopInput(state.wait !== undefined, waitSignal)) === "continue") return "continue";
    return inputClosedTerminal(signal?.aborted);
  };
  // An open wait with no waitable work left has nothing to wake it: an
  // interrupt of the agent's own child, for one, ends that work without a
  // notification (`waitableWork`). It ends here instead of parking.
  const closeSpentWait = (): void => {
    if (state.wait && (options.background?.tasks.waitableTaskCount() ?? 0) === 0) state = loopTransition.waitClosed(state);
  };
  const meetOpenWait = (input: OpenWaitInput): void => {
    if (state.wait && endsOpenWait(input, state.wait.replyWaitIds, (id) => options.background?.tasks.holdsWait(id) === true)) state = loopTransition.waitClosed(state);
  };
  // An interrupt gives the person the turn. The waiter records the turn end
  // first, in the tree and in this loop's history alike, so a live resume and
  // one after a restart read the same past; an interrupt that cuts a park on
  // background work takes the same record inside the waiter. Background
  // notifications still enter canonical history, but only a person's message
  // or Resume authorizes another model request.
  const parkForPerson = async (afterInterrupt: "record" | "recorded"): Promise<"continue" | AgentLoopTerminal> => {
    if (!options.inputSource?.prepareWaitForInput) return { kind: "interrupted" };
    return (await awaitNextLoopInput(false, signal, afterInterrupt)) === "continue" ? "continue" : inputClosedTerminal(signal?.aborted);
  };
  // One-shot reactive-overflow guard viewed over LoopState: acquiring it is
  // the overflowRecoveryStarted transition; logicalTurnStarted and a served
  // response reset it.
  const overflowGuard = {
    tryAcquire: (): boolean => {
      if (state.overflowRecoveryAttempted) return false;
      state = loopTransition.overflowRecoveryStarted(state);
      return true;
    },
  };
  // Wait-shaped calls (the `process` wait action or a no-op bash placeholder)
  // execute as ordinary tool calls, so every provider transcript carries a
  // result for every call: a transport with server-side response state (the
  // ChatGPT backend) permanently rejects a conversation whose recorded
  // function_call lacks an output, so no call may be erased after the fact.
  // What a wait means is settled only after the turn's tool batch, when
  // same-turn dispatches are guaranteed registered. Work still in flight:
  // mark the turn as a deliberate wait so the park that follows waits on
  // background work. Nothing in flight: nothing would ever wake a park, so
  // answer with a silent wait_notification that re-drives the loop instead.
  // Wrapped, never passed as a method reference: the InputSource
  // implementations are classes whose enqueue methods read `this`.
  const enqueueRuntimeNotice = (text: string) => options.inputSource?.enqueueRuntimeNotice?.(text);
  const batchObservation = createSettledBatchObservation(createWaitToolPolicy(
    () => (options.background?.tasks.waitableTaskCount() ?? 0) > 0,
    (seconds, replyWaitIds) => { pendingWorkNudge.reset(); state = loopTransition.waitOpened(state, openWaitFor(seconds, replyWaitIds)); },
    enqueueRuntimeNotice,
    (toolUseId) => options.background?.tasks.holdsWait(toolUseId) === true,
  ), enqueueRuntimeNotice, () => lifecycle?.onToolBatchSettled?.());
  // Every turn is owned: the run's lifecycle opens it as a scoped child of the
  // run fiber, so ESC interrupts that child and a run abort closes it from
  // above. A loop driven without a lifecycle gets a standalone turn of the same
  // shape, so there is no second, unowned settlement path.
  const openTurn = (): OwnedTurn => options.currentTurn?.beginTurn() ?? openStandaloneTurn();
  // Logical-turn end only: a tool batch that continues the loop is not a turn
  // end. The chat closes its conversation writer's turn and its transcript
  // turn here, and workflow observers nudge here, so firing it mid-loop splits
  // one turn in two. Per-request durability rides flushCanonicalMessages instead.
  const endCompletedTurn = (): Promise<void> =>
    Promise.resolve(lifecycle?.onTurnEnded?.({ handoffWritten: false, turnCount: state.turn, runtimeConfig: surface.current().runtimeConfig }));
  // A model turn finished with nothing left to run. Every human message gets
  // visible reply text before the loop goes quiet: a silent park would leave
  // the user staring at nothing while the model's answer sits in a thinking
  // block. The nudged request settles the same user input, so it runs inside
  // the logical turn, before its end, and its writes stay in that turn. Any
  // other finish ends the turn, and resolveTurnEnd drains what the end's
  // observers enqueued.
  const finishTurn = async (turnSignal: AbortSignal): Promise<"continue" | AgentLoopTerminal> => {
    if (closureMode === "park" && !turnSignal.aborted && replyNudge.consumeNudge()) {
      log.info("silent reply while user awaits; injecting reply nudge instead of ending the turn", { turnCount: state.turn, providerSessionKey: options.providerSessionKey });
      await pushUser(SILENT_REPLY_NUDGE);
      return "continue";
    }
    closeSpentWait();
    if (!state.wait || closureMode !== "handoff") await endCompletedTurn();
    return resolveTurnEnd(turnSignal);
  };
  // What follows the compaction a plan asked for, whether its checkpoint
  // request saved the notes or overflowed the context, which resets it all
  // the same: a cut of the run or of the turn, the next request, or the end
  // of a maintenance start's work, which parks where the last turn ended.
  const afterPlannedCompaction = async (operation: PlannedCompactionOperation, interruptSignal: AbortSignal, turnSignal: AbortSignal): Promise<"continue" | AgentLoopTerminal> => {
    if (signal?.aborted) return { kind: "aborted" };
    if (interruptSignal.aborted) return parkForPerson("record");
    if (operation.after === "continue") return "continue";
    if (operation.kind === "idle") {
      await endCompletedTurn();
      return resolveTurnEnd(turnSignal);
    }
    return awaitsPerson ? parkForPerson("recorded") : finishTurn(turnSignal);
  };

  const takeRequestContext = (): string | undefined => replyNudge.consumeRequestContext(logicalTurnRequestContext);

  let terminal: AgentLoopTerminal;
  execution: try {
  const initialInput = options.inputSource?.drainPending();
  const restoredWait = lifecycle?.restoredWait;
  // The restored wait opens before the input queued at the start, so that
  // input meets it as it would meet the live wait: only a wake, a person's
  // message, or their Resume ends it. Input that starts a request owes no
  // nothing-pending notice.
  const restoreNotices: string[] = [];
  if (restoredWait && !restoredWait.woken && !awaitsPerson) state = restoreAgentLoopWait(state, restoredWait, options.background?.tasks, (text) => { restoreNotices.push(text); });
  const initialConsumed = await consumeLoopInput(initialInput, lifecycle?.maintenance ? { compactAfter: "park" } : {});
  if (initialConsumed === "empty" && !restoredWait?.requestOwed) for (const notice of restoreNotices) enqueueRuntimeNotice(notice);
  // A maintenance start parks or completes after its input without a request.
  if (!restoredWait?.requestOwed && initialConsumed === "empty" && (restoredWait || ((initialInput?.kind === "compact" || initialInput?.kind === "hold") && lifecycle?.maintenance))) {
    const end = awaitsPerson && !signal?.aborted ? await parkForPerson("recorded") : await resolveTurnEnd(signal);
    if (end !== "continue") return end;
  }
  // A run that continues the cut turn with no Resume input, as a child's
  // continuation does, takes the continued wait before its first request.
  if (continuedWait && !awaitsPerson) {
    state = restoreAgentLoopWait(state, continuedWait, options.background?.tasks, undefined);
    continuedWait = undefined;
  }

  while (true) {
    state = loopTransition.turnStarted(state);

    if (!handoffTracker.isHandingOff && !compactionState.hasPlanned() && (await consumeLoopInput(options.inputSource?.drainPending())) === "continue") continue;

    if (signal?.aborted) {
      compactionState.discard();
      log.info("agent loop aborted by signal");
      return { kind: "aborted" };
    }

    // Every request advertises the surface planned for it, and everything that
    // request settles against reads this one pinned surface: the provider
    // schemas below, the dispatcher that runs what the model calls back, and
    // the audit's omission evidence. A capability the user changed while this
    // loop was parked lands here, on the next request.
    const requestSurface = admittedRequest ?? await surface.resolve();
    admittedRequest = undefined;
    if (compactionState.isIdle() && (requestSurface.runtimeConfig.idleCompaction === false || requestSurface.runtimeConfig.proactiveCompactionThreshold === 0)) {
      compactionState.discard();
      const end = await resolveTurnEnd(signal);
      if (end === "continue") continue;
      return end;
    }
    const {
      requestRoute, requestClient, interactionProfile, providerRequest,
      toolExecutionGate, turnEffort, contextTokens,
    } = await preparation.openCycle({
      surface: requestSurface, signal,
      context: { preview: replyNudge.previewRequestContext(logicalTurnRequestContext), consume: takeRequestContext },
    });
    if (!handoffTracker.isHandingOff && canPlan() && !compactionState.hasPlanned() && !state.overflowRecoveryAttempted && preparation.messages.length > 0
      && shouldCompact(contextTokens, preparation.planned.contextLimit, requestSurface.runtimeConfig.proactiveCompactionThreshold)) {
      compactionState.schedule({ kind: "automatic", after: "continue" });
    }
    await compactionState.announce();
    // Every provider request is authorized by one host-owned save point after
    // all queued and synthetic input for that request has entered the tree.
    await options.flushCanonicalMessages?.();

    if (!handoffTracker.isHandingOff && maxLLMCalls !== undefined && state.llmCalls >= maxLLMCalls) {
      log.info("hard cap reached; forcing a final summary turn", { llmCallCount: state.llmCalls, maxLLMCalls });
      // The forced handoff is a turn, so it settles inside an owned turn child
      // exactly like every other turn: one execution vehicle, not two.
      const ownedTurn = openTurn();
      const budgetSignal = mergeAbortSignals(signal, ownedTurn.signal);
      let budgetInterrupted = false;
      try {
        const exhausted = await runBudgetExhaustionTurn({
          signal: budgetSignal, onEvent, handoffTracker,
          onLoginWait: lifecycle?.onLoginWait,
          // oxlint-disable-next-line eslint/no-loop-func -- the budget turn awaits every capture before this loop can advance
          captureRequest: async (summaryAttempt) => {
            // Each exhaustion step is a model request of the run, so the run's count includes it.
            state = loopTransition.llmCallStarted(state);
            const capturedSurface = summaryAttempt === 1 ? requestSurface : await surface.resolve();
            const captured = summaryAttempt === 1
              ? { requestClient, providerRequest, interactionProfile, requestRoute, toolExecutionGate }
              : await preparation.prepareVariant(capturedSurface, signal);
            if (summaryAttempt > 1) {
              requestContext.prepareCycle(capturedSurface, preparation.planned, logicalTurnRequestContext);
            }
            return {
              client: captured.requestClient,
              request: captured.providerRequest,
              interactionProfile: captured.interactionProfile,
              providerOptions: captured.requestRoute.providerOptions,
              cacheRetentionPolicies: capturedSurface.runtimeConfig.cacheRetentionPolicies,
              tools: capturedSurface.tools,
              executionAdmission: capturedSurface.executionAdmission,
              ...(captured.toolExecutionGate ? { toolExecutionGate: captured.toolExecutionGate } : {}),
              materializeCandidatePolicy: requestContext.prepare,
              appendEntries: appendRequestEntries,
              prepareOutgoing: async (attempt) => {
                preparation.planned = attempt;
                await preparation.appendProviderMessages(attempt);
                const prepared = capturedSurface.prepareAttempt(attempt);
                const outgoing = requestContext.variant(prepared);
                return {
                  messages: outgoing.messages, prepared,
                  staleMasking: outgoing.mask.staleMasking,
                  toolHistoryProjection: outgoing.toolHistoryProjection,
                  messageCount: outgoing.messages.length,
                  estimatedContextTokens: outgoing.snapshot.messageTokens + prepared.attemptStaticTokens,
                };
              },
            };
          },
          requestAudit: options.requestAudit, turnOrdinal: state.turn + 1,
          usageSettlement: options.usageSettlement,
          waitForEventCapacity: options.waitForEventCapacity,
          cacheRetention: options.cacheRetention ?? "1h",
          providerSessionKey: options.providerSessionKey, promptCacheKey: options.promptCacheKey, artifactScopeId: options.artifactScopeId,
          maxLLMCalls, handoffConfigured: handoff !== undefined, toolContext,
          background: options.background, afterToolCall: options.afterToolCall, turn: ownedTurn,
          onTurnAssistantMessage: options.onTurnAssistantMessage,
          reserveMessageId: historySink.reserveId, releaseMessageId: historySink.releaseId,
          pushMessage, pushUser, pushToolResults,
          flushCanonicalMessages: options.flushCanonicalMessages,
        });
        if (exhausted.handoffWritten) {
          terminal = { kind: "budget_exhausted" };
          break execution;
        }
      } catch (error) {
        if (signal?.aborted) return { kind: "aborted" };
        if (!ownedTurn.signal.aborted) throw error;
        budgetInterrupted = true;
      } finally {
        await ownedTurn.end();
      }
      if (budgetInterrupted) {
        compactionState.discard();
        const parked = await parkForPerson("record");
        if (parked === "continue") continue;
        return parked;
      }
      await endCompletedTurn();
      return { kind: "budget_exhausted" };
    }

    const turnOrdinal = state.turn;
    // This turn's ordinal is state.llmCalls + 1: llmCallStarted records it
    // just below, after the dispatcher exists. A save round and the budget
    // closure are never both active: a plan is admitted only when its whole
    // save round precedes the closure (canPlan).
    const executionWhitelist = compactionState.executionWhitelist() ?? budgetNudge.closureWhitelist(state.llmCalls + 1);
    replyNudge.assistantTurnStarted();
    state = loopTransition.llmCallStarted(state);
    // This turn's ordinal and call count, captured before the settlement
    // closures read them: the loop record is replaced wholesale at every
    // transition.
    const llmCallsUsed = state.llmCalls;
    const ownedTurn = openTurn();
    const interruptSignal = ownedTurn.signal;
    const requestSignal = mergeAbortSignals(signal, interruptSignal);
    try {
    const prefixHold = startPrefixHold;
    startPrefixHold = undefined;
    const prepareTurnInput = preparation.attemptInput({
        interactionProfile, reasoningEffort: turnEffort, signal: requestSignal,
        cacheRetention: options.cacheRetention ?? "1h", providerSessionKey: options.providerSessionKey, promptCacheKey: options.promptCacheKey,
        cacheRetentionPolicies: requestSurface.runtimeConfig.cacheRetentionPolicies,
        providerOptions: requestRoute.providerOptions,
        requestAudit: options.requestAudit, usageSettlement: options.usageSettlement,
        onEvent, waitForEventCapacity: options.waitForEventCapacity,
        reserveMessageId: historySink.reserveId, releaseMessageId: historySink.releaseId,
        turn: turnOrdinal,
    });
    const turnRequest: AssistantTurnRequest<{
      settled: SettledTurn<AssistantTurnResult>;
      policy: "continue" | AgentLoopTerminal | typeof finishTurn | undefined;
    }> = {
      client: requestClient, request: providerRequest, executionCwd, signal: requestSignal,
      onLoginWait: lifecycle?.onLoginWait,
      providerOptions: requestRoute.providerOptions,
      estimatedInputTokenClasses: () => contextAnchor.estimateInputTokenClasses(),
      onEvent,
      ...(prefixHold ? { prefixHold } : {}),
      appendEntries: appendRequestEntries,
      // oxlint-disable-next-line no-loop-func -- boundary: admitted.run serializes preparation and execution before advancing the loop.
      prepare: async (candidateAttempt) => {
      const { input: attemptInput, snapshot: sentRequestSnapshot } = await prepareTurnInput(candidateAttempt);
      return {
        input: attemptInput,
        execute: async (candidate, fold) => {
      const servingStartedAt = Date.now();
      const turnSignal = requestSignal;
      const executionScope = Scope.forkUnsafe(ownedTurn.scope, "sequential");
      const streamedEditTurn = createStreamedEditTurn({
        service: options.streamingEditValidation, executionCwd, turnOrdinal, onEvent,
      });
      let observedCalls: readonly ToolCall[] = [];
      const handoffAdmission = handoffTracker.request();
      toolContext.refuseAfterHandoff = handoffAdmission.refuse;
      const dispatcher = createTurnDispatcher({
        tools: requestSurface.tools, executionAdmission: requestSurface.executionAdmission, toolContext, signal: turnSignal, background: options.background,
        turnScope: executionScope, afterToolCall: options.afterToolCall, onEvent,
        // The request is prepared, so the estimate measures its input.
        artifactScopeId: options.artifactScopeId, outputBound: contextAdmission.openRequest(),
        ...(executionWhitelist ? { executionWhitelist } : {}),
        ...(toolExecutionGate ? { toolExecutionGate } : {}),
        ...(options.requestAttribution ? { requestAttribution: options.requestAttribution } : {}),
      });
      const commitAssistant = createAssistantMessageSettlement({
        interruptSignal, runSignal: signal, observedCalls: () => observedCalls,
        onTurnAssistantMessage: options.onTurnAssistantMessage, pushAssistant,
      });
      contextAnchor.emit();
      try {
      const execution = await fold({
          onHandoffStarted: handoffAdmission.start, signal: turnSignal,
          canonicalizeToolName: (name) => repairToolName(name, requestSurface.tools) ?? name,
          canonicalizeToolCall: (toolCall) => {
            streamedEditTurn.retire(toolCall.id);
            const registeredCall = stampToolRegistration(dispatcher.onToolUse(toolCall), requestSurface.registrationIds);
            observedCalls = [...observedCalls, registeredCall];
            return registeredCall;
          },
          onEvent: (event) => {
            onEvent(event);
            streamedEditTurn.observe(event);
          },
          onStreamAbandoned: (reason) => onEvent({ kind: "stream_abandoned", reason }),
        }, async (attempt) => {
      const attemptSettled = await ownedTurn.settle<SettledTurn<AssistantTurnResult>, PersistenceWriteRefused>((publishSettlement) => settleTurn({
      dispatcher,
      turnSignal,
      stream: attempt.stream,
      commitAssistant,
      commitAssistantBarrier: (calls) => options.flushCanonicalMessages?.(new Set(calls.map((call) => call.id))) ?? Promise.resolve(),
      commitResults: createToolResultCommit((results) => pushToolResults(budgetNudge.applyTrailer(results, llmCallsUsed)), options.flushCanonicalMessages),
      commitDisplayBarrier: () => options.awaitDurableFacts?.() ?? Promise.resolve(),
      closeAttempt: attempt.close,
      onEvent,
      // The provider's own terminal event, held back by the stream boundary
      // until this turn's assistant, results, and projections are durable.
      publishTerminal: (exit) => { if (!attempt.failure() && Exit.isSuccess(exit) && exit.value.terminalEvent) onEvent(exit.value.terminalEvent); },
      publishSettlement,
    }));
      const { toolCalls, usageAnchor } = attemptSettled.turn;
      state = loopTransition.responseSettled(state, attemptSettled.turn.outcome);
      if (attemptSettled.turn.outcome.kind === "ok") tally.served += 1;
      if (attemptSettled.turn.outcome.kind === "stream_error" && attemptSettled.turn.outcome.error._tag === "StreamStalled") requestContext.appendRequestContext(CONTINUATION_MESSAGES.stream_stalled);
      if (usageAnchor) contextAnchor.observeApiUsage(usageAnchor, sentRequestSnapshot);
      if (attemptSettled.turn.outcome.kind === "ok" && !turnSignal.aborted) compactionState.observeCache(usageAnchor, sentRequestSnapshot, candidate.attempt, servingStartedAt, candidate.prepared.cacheRetention);
      const batch = attemptSettled.batch;
      let policy: "continue" | AgentLoopTerminal | typeof finishTurn | undefined;
      if (batch.suspended || signal?.aborted) policy = { kind: "aborted" };
      else if (!interruptSignal.aborted) {
        const stagedUserContent = batch.published.flatMap((call) => call.nextUserContent ?? []);
        if (stagedUserContent.length > 0) await pushUser(stagedUserContent);
        // Its notices reach the next request with this batch's results, through the drain below.
        const batchWaits = await batchObservation.observe(toolCalls, batch.toolResults, attemptSettled.turn.outcome.kind);
        tallyToolResults(tally, batch.toolResults);
        const handoffWritten = handoffTracker.recordBatch(toolCalls, batch.toolResults, attemptSettled.turn.outcome.kind);
        const askUserIds = new Set(toolCalls.filter((call) => call.name === "ask_user").map((call) => call.id));
        if (batch.toolResults.some((result) => askUserIds.has(result.toolUseId) && result.outcome === "ok")) replyNudge.visibleTextDelivered();
        if (handoffTracker.isHandingOff) compactionState.discard();
        if (handoffWritten) policy = { kind: "completed" };
        else if (!handoffTracker.isHandingOff) {
          if (!compactionState.hasPlanned() && await consumeLoopInput(options.inputSource?.drainPending()) === "continue") policy = "continue";
          else if (!compactionState.hasPlanned() && batch.terminate) policy = resolveTurnEnd;
          // A wait parks after its whole batch, whatever else the batch held:
          // the other calls have run, and their results reach the model with
          // the notification that wakes the park. Another request here would
          // follow an acknowledgement that promised a park, and a model left
          // waiting on a promised notification writes one itself.
          else if (!compactionState.hasPlanned() && batchWaits) policy = finishTurn;
        }
      }
      // After handoff admission no input enters, so only a served response
      // earns another request. A text-only one first gets the owed-handoff
      // notice, so that the request ends with a user message, which every
      // provider requires. A failed request takes the outcome switch below,
      // whose errors have their own bounds.
      if (handoffTracker.isHandingOff && policy === undefined && attemptSettled.turn.outcome.kind === "ok") { if (toolCalls.length === 0) await pushUser(HANDOFF_OWED_NOTICE); policy = "continue"; }
      return {
        value: { settled: attemptSettled, policy },
        stop: policy !== undefined || compactionState.hasPlanned(),
      };
      });
      return execution;
      } finally {
        streamedEditTurn.dispose();
        await Effect.runPromise(Scope.close(executionScope, Exit.void));
      }
      },
      };
      },
    };
    const completed = await streamAssistantTurn(turnRequest);
    const { settled } = completed;
    // A turn end can park for the person, and the park can take an interrupt
    // and resume with their next message. It runs only after the provider
    // attempt settles: an attempt that outlived its answer would still carry
    // this turn's interrupted signal into the turn the message resumes.
    const policy = typeof completed.policy === "function" ? await completed.policy(requestSignal) : completed.policy;
    if (policy && policy !== "continue") {
      terminal = policy;
      break execution;
    }
    // The one park for an interruption that lands after the request answered, such as during its tools. A turn
    // that already parked settled its policy, and an interruption that ends the request parks in the catch below.
    if (policy === undefined && interruptSignal.aborted && !signal?.aborted) {
      if (settled.turn.outcome.kind === "aborted") compactionState.discard();
      const parked = await parkForPerson("record");
      if (parked === "continue") continue;
      return parked;
    }
    if (settled.turn.outcome.kind === "output_overflow" && state.consecutiveOutputOverflows > OUTPUT_OVERFLOW_CONTINUATION_LIMIT) throw settled.turn.outcome.error;
    if (policy === "continue") continue;

    const { assistantContent, toolCalls, outcome } = settled.turn;

    const stopReason: LlmStopReason = outcome.kind === "ok" ? outcome.stopReason : "unknown";
    tally.stopReason = stopReason;

    switch (outcome.kind) {
      case "aborted": {
        compactionState.discard();
        options.onConnectionState?.("connected");
        return { kind: "aborted" };
      }
      case "context_overflow": {
        if (!canCompact()) return { kind: "context_overflow" };
        const plannedOperation = compactionState.discard();
        if (plannedOperation?.kind === "idle") {
          const end = await afterPlannedCompaction(plannedOperation, interruptSignal, requestSignal);
          if (end === "continue") continue;
          return end;
        }
        const attempt = await attemptContextOverflowRecovery({
          guard: overflowGuard, turnCount: state.turn,
          messages: preparation.messages, onEvent,
          tokensBefore: requestContext.beforeCompaction(),
          contextLimit: preparation.planned.contextLimit,
          prepareCompactedHistory: () => prepareCompactedHistory({ saved: false }), after: plannedOperation?.after ?? "continue", carryTurnEnd: turnEndRecorded,
          emitContextUpdate: () => contextAnchor.emit(), options,
        });
        if (attempt.kind === "exhausted") return { kind: "context_overflow" };
        const end = plannedOperation ? await afterPlannedCompaction(plannedOperation, interruptSignal, requestSignal) : "continue";
        if (end === "continue") continue;
        return end;
      }
      case "output_overflow": {
        if (compactionState.isIdle()) {
          // SAFETY: the one plan owner is read and cleared synchronously, without an intervening transition.
          const operation = compactionState.discard()!;
          const end = await afterPlannedCompaction(operation, interruptSignal, requestSignal);
          if (end === "continue") continue;
          return end;
        }
        log.warn("output length exceeded, auto-resuming", { contentBlocks: assistantContent.length, continuation: state.consecutiveOutputOverflows });
        await pushUser("Your previous response was cut off at the output-length limit. Resume directly: no apology, no recap of what you were doing.");
        continue;
      }
      case "stream_error": {
        if (compactionState.hasPlanned()) break;
        if (outcome.error._tag === "ContentRefused") {
          const decision = repairContentRefusal(preparation.messages, outcome.error, preparation.planned.accessProvider);
          if (decision) {
            await pushMessage(decision);
            continue;
          }
        }
        throw outcome.error;
      }
      case "incomplete": break;
    }

    const okResults = new Set(settled.batch.toolResults.flatMap((result) => result.outcome === "ok" ? [result.toolUseId] : []));
    const checkpoint = compactionState.settle(outcome.kind === "ok", toolCalls.map((call) => ({ name: call.name, ok: okResults.has(call.id) })));
    if (checkpoint) {
      await compactionState.applyCheckpoint(checkpoint, requestSignal, interruptSignal);
      const end = await afterPlannedCompaction(checkpoint.operation, interruptSignal, requestSignal);
      if (end === "continue") continue;
      return end;
    }

    if (await contentFilter.observe({ stopReason, hadToolCalls: toolCalls.length > 0, turnCount: state.turn }) === "retry") continue;

    // A one-shot single request that may call no tool, such as a side call,
    // ends on its answer: its refused calls cannot earn it another request.
    if (toolCalls.length === 0 || (closureMode === "oneshot" && options.maxLLMCalls === 1 && requestSurface.usableToolNames.size === 0)) {
      log.debug("response completed", { stopReason, turnCount: state.turn, hadOutput: hasAssistantOutput(assistantContent), toolCalls: toolCalls.length, executableTools: requestSurface.tools.size, providerSessionKey: options.providerSessionKey });
      const end = await finishTurn(requestSignal);
      if (end === "continue") continue;
      return end;
    }
    } catch (error) {
      if (signal?.aborted) return { kind: "aborted" };
      if (!interruptSignal.aborted) throw error;
      compactionState.discard();
      const parked = await parkForPerson("record");
      if (parked === "continue") continue;
      return parked;
    } finally {
      await ownedTurn.end();
    }
  }
  } finally {
    Object.assign(tally, { turns: state.turn, requests: state.llmCalls - priorLLMCalls });
  }
  return terminal;
}
