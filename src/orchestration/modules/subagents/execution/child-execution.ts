import { probeLoopUnit, trackLoopSpan } from "../../../../infra/event-loop-lag.js";
import { Log } from "../../../../infra/log.js";
import { createRuntimeEvent } from "../../../../infra/runtime-event-factory.js";
import type { RuntimeEvent } from "../../../../infra/runtime-event-types.js";
import { createHandoffObserver } from "../../../../workflows/shared/handoff-observer.js";
import type { Agent, AgentRunResult, RunnableAgentOptions } from "../../../agent-runtime/types.js";
import { deriveChildRuntimeSurfaces } from "../../../agent-runtime/tools/tool-registry.js";
import { mergeAbortSignals } from "../../../../infra/abort.js";
import type { RetryState } from "../../../agent-runtime/llm/retry-budget.js";
import { createAgentHost } from "../../../runner/host.js";
import { AgentTurnAborted } from "../../../runner/agent-turn-types.js";
import { createSubagentRunInputs } from "./run-inputs.js";
import { awaitsWork, type BackgroundKillSource, type BackgroundWorkResult, type EndedWorkResult } from "../../../agent-runtime/background-work.js";
import type { ModuleRuntimes } from "../../../../infra/module-runtime.js";
import { createChildBackgroundExecution } from "./child-background.js";
import { isReadOnlyPersona } from "../../../agent-runtime/persona-tool-rules.js";
import { SUBAGENT_HANDOFF_SCHEMA } from "./prompts.js";
import { recordSubagentCompletion } from "./run-recorder.js";
import { buildSubagentPaused } from "../history/subagent-run-fact-writers.js";
import { interruptedTurnEnd, isVisibleTurnEnd, type TurnInterruption } from "../../../session/conversation/turn-end-record.js";
import { emitToolResultAvailable } from "../../../agent-runtime/emit.js";
import {
  failedRunResult,
  resolveSubagentResult,
  usageFromStats,
  type SubagentResultContext,
} from "./result-resolver.js";
import {
  createFilteredSubagentStream,
  createSubagentStats,
} from "./stream-filter.js";
import { createSubagentTurnLog } from "./work-log.js";
import { resultCharBudget } from "./result-budget.js";
import type { ChildSlotReservation } from "../../../agent-runtime/child-slot-registry.js";
import { withCapabilityGrant } from "../../../agent-runtime/tools/types.js";
import { readConversationQueuedUserInputs, readUnreadMessages, type QueuedUserInputCell } from "../../../session/conversation/queued-user-inputs.js";
import { readConversationBackgroundNotifications, type HeldBackgroundNotification } from "../../../session/conversation/queued-background-notifications.js";
import { observeOpenReplyWaits } from "../../../session/reply-waits.js";
import type { ContinuationTarget, SubagentContext, SubagentInput } from "./control-actions.js";
import type { prepareSubagentDispatch, prepareSubagentTools } from "./dispatch-preparation.js";
import type { SubagentDispatchDeps } from "./dispatch-deps.js";
import { resolveChildRole } from "./dispatch-configuration.js";
import { canonicalModelId } from "../../../../infra/llm/model-id.js";
import { AssistantPrefillSessionContextError } from "../../../session/conversation/conversation-tree-context.js";
import { launchAssignmentText, recordedEntryText } from "../../../session/conversation/brief-entry.js";
import { readRecordedInheritedIntent } from "../../../session/conversation-checkpoint.js";
import { CONTINUATION_MESSAGES } from "../../../agent-runtime/continuation-messages.js";
import { readAuthorizedRestoredWait } from "../../../session/chat-session-run-evidence.js";
import { awaitPlannedChildResumes } from "../../../session/planned-session-continuation.js";
import { recallQueuedInput } from "../../../session/queued-input-recall.js";
import { createUnattendedRecovery, endingCapacityWaitOnPersonMessage } from "../../../agent-runtime/unattended-recovery.js";
import { capacityWaitAuthority } from "../../../session/capacity-wait.js";

const log = Log.create({ service: "subagent-tool" });

/** The entry id of a child's task in its conversation, so a retry or a
 *  continuation commits the task at most once. */
function subagentTaskEntryId(conversationId: string): string {
  return `subagent-task:${conversationId}`;
}

/** How long a child may make no progress before its generation restarts. */
const STALL_TIMEOUT_MS = 600_000;

/** Remove after 2027-04-13, with the restatement that uses it. */
const RESTATED_SUBAGENT_TASK = "Your task follows. It applies to all of the work above and to the rest of this assignment.";

type PreparedDispatch = Extract<Awaited<ReturnType<typeof prepareSubagentDispatch>>, { ok: true }>;
type PreparedTools = Extract<ReturnType<typeof prepareSubagentTools>, { ok: true }>;

/** Owns a published child's live resources through durable settlement. The launch
 * promise resolves once queued or running, and rejects after cleanup on startup failure. */
// oxlint-disable-next-line complexity -- this owner holds one child's execution, interruption, and terminal cleanup in one lifetime.
export function createChildExecution(options: {
  readonly context: SubagentContext;
  readonly deps: SubagentDispatchDeps;
  readonly continuation?: ContinuationTarget;
  readonly preparation: PreparedDispatch;
  readonly tools: PreparedTools;
  readonly published: Awaited<ReturnType<SubagentDispatchDeps["subagentSessions"]["publish"]>>;
  readonly childRunId: string;
  readonly childSessionId: string;
  readonly childConversationId: string;
  readonly parentConversationId: string;
  readonly toolUseId: string;
  readonly descriptionText: string;
  readonly acquireSlot: SubagentDispatchDeps["childSlots"]["acquire"];
}): Promise<ReturnType<SubagentDispatchDeps["childSlots"]["acquire"]>> {
  const { context, deps: suppliedDeps, continuation, published, childRunId, childSessionId, childConversationId, parentConversationId, toolUseId, descriptionText, acquireSlot } = options;
  const summarize = suppliedDeps.failureSummarizerForChild?.({
    sessionId: childSessionId, conversationId: childConversationId, eventWriter: published.eventWriter, reader: published.projectionReader,
    projectRoot: context.projectRoot, executionCwd: options.preparation.executionCwd,
  }) ?? suppliedDeps.summarizeOnFailure;
  const deps = summarize ? {
    ...suppliedDeps,
    summarizeOnFailure: summarize,
  } : suppliedDeps;
  const { executionCwd, agentType, prompt, agent, access, model: modelString, effort: effortForRunner, providerOptions: providerOptionsForRunner } = options.preparation;
  const { toolNames, withheldTools, promptKind: promptKindForRunner, task: subagentTask, maxTurns, grantedTypes } = options.tools;
  const modelRequestId = context.modelRequestId;
  const capabilityAccess = continuation ? withCapabilityGrant(access, continuation.capabilityGrant) : access;
  const stats = createSubagentStats();
  const runStartedAtMs = Date.now();
  const textState = { finalAssistantText: "" };
  const { records: turnLog, observer: turnLogObserver } = createSubagentTurnLog();
  const filteredOnEvent = createFilteredSubagentStream({
    onRenderEvent: (event) => deps.onChildRenderEvent(childSessionId, event),
    agentType,
    stats,
    textState,
    turnLog: turnLogObserver,
  });
  let capturedHandoff: SubagentInput | null = null;
  const childConversation = published.conversation;
  /** Commits held messages, then held `notices`, into the child
   *  conversation, so a resumed or retried run reads them. A pause commits
   *  every message and leaves the notices to the resumed run; a settle
   *  commits the person's messages and every notice, and returns the
   *  sessions' messages (ARCH-SESSIONS-031). */
  const commitHeldMessages = async (cells: readonly QueuedUserInputCell[], notices: readonly HeldBackgroundNotification[] = []): Promise<void> => {
    for (const queued of cells) {
      if (queued.target === "conversation" && queued.conversationId === childConversationId) await childConversation.commitQueuedUserInput(queued);
    }
    for (const notice of notices) await childConversation.commitBackgroundNotification(notice);
  };

  // Acquire before constructing the runner so concurrent dispatches cannot
  // race past the cap. At capacity the dispatch queues instead of failing:
  // the registry grants reservations in FIFO order as running subagents
  // release their slots, and the runner is only constructed on the grant.
  // One reservation covers every recovery attempt of the dispatch.
  let acquisition: ReturnType<SubagentDispatchDeps["childSlots"]["acquire"]> | undefined;
  let reservation: ChildSlotReservation | undefined;
  const launched = Promise.withResolvers<NonNullable<typeof acquisition>>();
  let startupError: unknown;

  let runner: Agent | undefined;
  // Set when the stall watchdog ends the running generation, so that its
  // aborted run reads as stalled and the recovery policy runs it again.
  let stalledGeneration = false;
  let modules: ModuleRuntimes | undefined;
  const firstAssembly = Promise.withResolvers<ModuleRuntimes | undefined>();
  let cancelledBeforeStart = false;
  let cancellationSource: BackgroundKillSource | undefined;
  // Set by `pause`: the run settles as paused by this actor instead of
  // recording a completion, and its session goes inactive with its binding kept.
  let pausedBy: TurnInterruption | undefined;
  // A delete that ends the run returns the unread messages of every sender
  // but the parent with its tombstone, so the settle below leaves them.
  let deleting = false;
  // Cancellation fans out to every lifecycle phase: a still-queued dispatch
  // is withdrawn from the slot queue, a running attempt aborts its runner,
  // and the abort signal stops the resilience loop from starting another
  // attempt (or cuts its backoff sleep short).
  const dispatchAbort = new AbortController();
  const dispatchSignal = mergeAbortSignals(context.signal, dispatchAbort.signal);
  const cancelDispatch = (source: BackgroundKillSource): void => {
    cancellationSource = source;
    cancelledBeforeStart = true;
    if (acquisition?.status === "queued") acquisition.cancel();
    dispatchAbort.abort();
    runner?.abort();
  };

  // The tracked promise adopts the complete execution before its first asynchronous acquisition.
  const settled = Promise.withResolvers<BackgroundWorkResult>();
  let stopLoginWaitKeepAlive: (() => void) | undefined;
  const backgroundMeta = {
    id: childRunId,
    type: "subagent",
    settlementOwner: "child_session" as const,
    description: descriptionText,
    ...(toolUseId ? { toolUseId } : {}),
    ...(context.parentToolUseId ? { parentToolUseId: context.parentToolUseId } : {}),
    ...(modelRequestId ? { modelRequestId } : {}),
  };
  const { bump: bumpStall, rearm: rearmStall } = deps.backgroundTasks.track({
    done: settled.promise,
    meta: modelString === undefined ? backgroundMeta : {
      ...backgroundMeta,
      model: modelString,
      roleSessionId: childSessionId,
      ...(typeof effortForRunner === "string" ? { effort: effortForRunner } : {}),
    },
    kill: { run: cancelDispatch },
    stall: {
      isIdle: () => stopLoginWaitKeepAlive === undefined && inFlightToolIds.size === 0 && childBackground.owner.tasks.awaitedTaskCount() === 0,
      abort: () => { stalledGeneration = true; runner?.abort(); },
      timeoutMs: STALL_TIMEOUT_MS,
    },
  });

  // The stall watchdog measures idleness, not wall clock: every child event
  // bumps it, and a phase that is legitimately idle by design holds a scoped
  // keep-alive that feeds it for exactly the phase's duration.
  const keepAliveIntervalMs = deps.keepAliveIntervalMs ?? 60_000;
  const startStallKeepAlive = (): (() => void) => {
    const timer = setInterval(() => { bumpStall(); }, keepAliveIntervalMs);
    return () => { clearInterval(timer); };
  };
  // Runs a failed run again from its recorded conversation. Its waits hold
  // the stall watchdog open, and its notice shows on the child's session.
  const recovery = createUnattendedRecovery({
    sessionId: childSessionId,
    runId: childRunId,
    caller: "subagent",
    agentName: agentType,
    holdAlive: startStallKeepAlive,
    onNotice: (operation) => { published.emit("agent.notice.changed", { sessionId: childSessionId, data: { operation } }); },
    awaitAccessSettled: deps.awaitModelAccessSettled,
    capacity: capacityWaitAuthority(published.eventStore, { target: { kind: "subagent", sessionId: childSessionId }, runId: childRunId }),
  });
  const withStallKeepAlive = async <T>(work: () => Promise<T>): Promise<T> => {
    bumpStall();
    const stop = startStallKeepAlive();
    try {
      return await work();
    } finally {
      stop();
    }
  };
  // An in-flight tool execution is activity, not silence: a foreground tool
  // call is bounded by its own contract (bash enforces its kill timer and a
  // post-exit drain cap; nested subagents carry their own stall watchdog in
  // the child registry), so the stall clock must not preempt a legitimately
  // quiet long-running tool. While any of the child's tool calls is between
  // `tool.input.completed` and its result, or its registry still awaits
  // background work, the keep-alive feeds the watchdog.
  const inFlightToolIds = new Set<string>();
  // A child that waits on a reply is not stalled, so the keep-alive holds
  // while the wait is open. The end rules bound the wait (PI-INTERACTION-050):
  // its addressee replies, yields, or can no longer read, and a park of the
  // addressee on this child's run alone is a yield.
  let stopReplyWaitKeepAlive: (() => void) | undefined;
  let stopWorkWaitKeepAlive: (() => void) | undefined;
  const stopObservingReplyWaits = observeOpenReplyWaits(published.projectionReader, childSessionId, (open) => {
    if (open) stopReplyWaitKeepAlive ??= startStallKeepAlive();
    else {
      stopReplyWaitKeepAlive?.();
      stopReplyWaitKeepAlive = undefined;
    }
  });
  const trackToolActivity = (event: RuntimeEvent): void => {
    if (event.type === "tool.input.completed") {
      inFlightToolIds.add(event.data.tool_use.id);
    } else if (event.type === "tool.result.recorded" || event.type === "tool.validation.failed") {
      const id = event.data.tool_use_id;
      if (id) inFlightToolIds.delete(id);
    }
  };
  const onEventWithStallBump = (event: RuntimeEvent): void => {
    bumpStall();
    trackToolActivity(event);
    published.onEvent(event);
    filteredOnEvent(event);
  };

  // Subagent loop drains its own injection queue. The handoff observer
  // nudges on every text-only turn until the handoff lands; once written,
  // the loop exits through its completion path (canComplete).
  const runInputs = createSubagentRunInputs((message) => published.projection?.queueUserMessage(message),
    () => recallQueuedInput({ queue: runInputs.queue, retire: (keys) => published.conversation.dropQueuedUserInputs(keys), projection: published.projection }));
  const injectionQueue = runInputs.queue;
  const { commandHandover } = deps.inheritableRuntimeSurfaces;
  const childBackground = createChildBackgroundExecution({
    conversation: childConversation, queue: injectionQueue, abort: () => runner?.abort(), onChildEvent: onEventWithStallBump,
    awaitDurableFacts: () => published.awaitDurableFacts(),
    onCommandsChanged: (commands) => published.projection?.updateBackgroundCommands(commands),
    ...(commandHandover ? { handover: { authority: commandHandover, sessionId: childSessionId, conversationId: childConversationId } } : {}),
  });
  const unregisterLiveControl = deps.subagentSessions.registerLiveControl({
    sessionId: childSessionId,
    child: {
      runId: childRunId,
      parentSessionId: deps.sessionId,
      parentConversationId,
      parentToolCallId: toolUseId,
      modules: async () => modules ?? firstAssembly.promise,
      backgroundTasks: childBackground.owner.tasks,
      stop: (by) => { deleting = by === "deletion"; cancelDispatch(by === "agent" ? "agent" : "user"); },
      async interrupt(by) {
        pausedBy = by;
        // The replacement's pause ends the child ahead of its executor's stop,
        // so the child's close hands its running commands to the next build.
        if (by === "replacement") childBackground.owner.handOverAtClose();
        cancelDispatch("runtime");
        await settled.promise.catch(() => {});
      },
      progress: () => ({ toolUses: stats.toolUseCount, totalTokens: stats.totalInputTokens + stats.totalOutputTokens, startedAtMs: runStartedAtMs }),
    },
    // Settlement, not outcome: a rejected terminal publication is delivered
    // to the parent by the registry, so this observer only waits for it.
    settled: settled.promise.then(() => {}, () => {}),
    // A live child runs until it settles: an interrupt pauses the run and
    // ends this control.
    state: runInputs.state,
    deliver: endingCapacityWaitOnPersonMessage(recovery, runInputs.deliver),
    notify: runInputs.notify,
    recallQueuedMessage: runInputs.recallQueuedMessage,
    withInputAdmission: runInputs.withInputAdmission,
  });
  // A child has message_session exactly when it inherits session messaging.
  const handoffObserver = createHandoffObserver({ injectionQueue, parentChannel: deps.inheritableRuntimeSurfaces.sessions !== undefined });
  // Registry callbacks only report command descriptor changes, not every
  // awaited task transition. Read the authority on each owned keep-alive tick.
  const activityKeepAlive = setInterval(() => {
    if (inFlightToolIds.size > 0 || childBackground.owner.tasks.awaitedTaskCount() > 0) bumpStall();
  }, keepAliveIntervalMs);

  const runnerOptions: Omit<RunnableAgentOptions, "conversation" | "model"> = {
    effort: typeof effortForRunner === "string" ? effortForRunner : undefined,
    requestSelection: (currentRoles) => resolveChildRole(agent, currentRoles, deps.briefScope) ?? { roleId: agent.kind === "persona" ? agent.role : "chat" },
    proactiveCompactionThreshold: deps.proactiveCompactionThreshold,
    purpose: { kind: "subagent", renderAs: promptKindForRunner, parentToolUseId: toolUseId },
    executionCwd,
    projectRoot: context.projectRoot,
    userDataRoot: deps.userDataRoot,
    accountHome: deps.accountHome,
    sessionDir: published.sessionDir,
    sessionEventStore: published.eventStore,
    sessionEventReader: published.projectionReader,
    onEvent: onEventWithStallBump,
    waitForEventCapacity: async (signal) => {
      await published.waitForEventCapacity(signal);
      await deps.waitForEventCapacity?.(signal);
    },
    onChildEvent: deps.onChildRenderEvent,
    lifecycle: {
      kind: "parkable",
      ...published.projection?.lifecycle,
      onRuntimeAssembled: async (runtime) => {
        modules = runtime.modules;
        firstAssembly.resolve(modules);
        if (continuation) await awaitPlannedChildResumes({
          reader: published.eventStore, projectionReader: published.projectionReader,
          parentSessionId: childSessionId, parentConversationId: childConversationId,
        });
      },
      onTurnParked: async (ctx) => {
        runInputs.parked(ctx.park);
        // A park on work waits for its result or its wait's expiry. A command
        // launched in the background is a service, which the awaited count
        // leaves out, so the park itself holds the keep-alive.
        if (ctx.park === "waiting_on_work") stopWorkWaitKeepAlive ??= startStallKeepAlive();
        await published.projection?.lifecycle.onTurnParked?.(ctx);
      },
      onHandoffStarted: () => { if (runInputs.handoffStarted()) log.info("subagent handoff admission closed", { childSessionId, childRunId }); },
      onTurnResumed: () => {
        stopWorkWaitKeepAlive?.();
        stopWorkWaitKeepAlive = undefined;
        runInputs.resumed();
        published.projection?.lifecycle.onTurnResumed?.();
      },
      onLoginWait: (waiting) => {
        bumpStall();
        if (waiting) stopLoginWaitKeepAlive ??= startStallKeepAlive();
        else {
          stopLoginWaitKeepAlive?.();
          stopLoginWaitKeepAlive = undefined;
        }
        published.projection?.lifecycle.onLoginWait?.(waiting);
      },
      signal: context.signal,
      inputSource: injectionQueue,
      onTurnEnded: (ctx) => {
        if (awaitsWork(childBackground.owner.tasks.assertHandoffReady())) return;
        handoffObserver.onTurnEnded(ctx);
      },
    },
    // The bounded boundary this dispatch was admitted on, forwarded whole: the
    // child advertises and runs optional tools through the same authority its
    // parent holds, never through an absent one.
    capabilityAccess,
    // A child's tools are a grant, not a narrower surface: it sees the tools
    // of every agent of its chat tree and shares their agent host and prompt
    // cache, and a call outside its grant is refused.
    toolGrant: toolNames,
    ...(withheldTools.length > 0 ? { withheldTools } : {}),
    maxLLMCalls: maxTurns,
    // The registry is scoped by the grant, so a child without granted roles
    // has the dispatch tool an agent of a workflow has, with an empty
    // catalog. The deepest child keeps the registry too: its grant, not an
    // absent registry, refuses the dispatch.
    agentRegistry: deps.agentRegistry,
    // A grandchild persona composes from the same pinned revision this
    // dispatch used, so nesting cannot re-read the live registry.
    skills: deps.skills,
    moduleSelection: deps.moduleSelection,
    captureRuntimeConfig: deps.captureRuntimeConfig,
    awaitModelAccessSettled: deps.awaitModelAccessSettled,
    allowedSubagentTypes: grantedTypes,
    runtimeSurfaces: {
      ...deriveChildRuntimeSurfaces(deps.inheritableRuntimeSurfaces, {
        handoff: { onContent: (content) => { capturedHandoff = content }, schema: SUBAGENT_HANDOFF_SCHEMA },
        background: childBackground.owner,
      }),
      // Recall is controller-bound state, never an inheritable authority.
      recall: childConversation.recall,
    },
    // Shared cap: grandchildren reserve from the same registry as this child.
    childSlots: deps.childSlots,
    subagentSessions: deps.subagentSessions,
    ...(isReadOnlyPersona(agent) ? { readOnly: true } : {}),
    resolveRoles: async (capture) => published.resolveRoles(capture ?? await deps.captureProviderConnection?.()),
    sessionEventWriter: published.eventWriter,
    ...(deps.usageProfile ? { usageProfile: deps.usageProfile } : {}),
    ...(deps.auditObserver ? { auditObserver: deps.auditObserver } : {}),
    ...(deps.usageObserver ? { usageObserver: deps.usageObserver } : {}),
  };

  // Read once per execution: the publication recorded it, and it never changes.
  let inheritedIntent: Promise<string | undefined> | undefined;
  const startRunner = (): Promise<AgentRunResult> => createAgentHost<RunnableAgentOptions>({ createRunner: deps.createRunner }).runTurn({
    createContextOptions: async (attempt: RetryState) => {
      if (cancelledBeforeStart) throw new AgentTurnAborted();
      await childBackground.adoptHandedOver();
      if (continuation) {
        await commitHeldMessages([], await readConversationBackgroundNotifications(published.projectionReader, childSessionId, childConversationId));
      }
      const selectedModel = resolveChildRole(agent, await published.resolveRoles(await deps.captureProviderConnection?.()), deps.briefScope);
      {
        const { restoredWait, continuedWait } = continuation
          ? await readAuthorizedRestoredWait(published.projectionReader, childConversationId) : {};
        let priorMessages;
        try {
          priorMessages = (await childConversation.buildContext(restoredWait ? { allowAssistantTail: true } : undefined)).messages;
        } catch (error) {
          if (!(error instanceof AssistantPrefillSessionContextError)) throw error;
          // Explicit continuation can follow a normally settled assistant turn.
          await childConversation.recordCanonicalMessage({
            kind: "user", origin: "system",
            content: continuation && continuation.interruptionReason !== "runtime_restarted"
              ? CONTINUATION_MESSAGES.subagent_resumed
              : CONTINUATION_MESSAGES.unexpected_exit,
          });
          await childConversation.flushSavePoint();
          priorMessages = (await childConversation.buildContext()).messages;
        }
        // The child's task follows the parent's assignment as its own turn
        // under one entry id, so a continuation commits nothing again. A
        // retry runs inside the turn that already holds the task, where the
        // entry id is not yet committed, so only the first run commits it. A
        // child that a build before 2026-10-14 started held its task in the
        // system prompt, so its tree has no such entry, and its continuation
        // restates the task once. Remove the restatement after 2027-04-13.
        if (!attempt.isRetry) await childConversation.commitSystemTurn(continuation ? `${RESTATED_SUBAGENT_TASK}\n\n${subagentTask}` : subagentTask, subagentTaskEntryId(childConversationId));
        priorMessages = (await childConversation.buildContext()).messages;
        childConversation.beginTurn();
        inheritedIntent ??= readRecordedInheritedIntent(published.projectionReader, childSessionId);
        const intent = await inheritedIntent;
        return {
          ...runnerOptions,
          ...(intent === undefined ? {} : { purpose: { ...runnerOptions.purpose, inheritedIntent: intent } }),
          lifecycle: { ...runnerOptions.lifecycle, ...(restoredWait ? { restoredWait } : {}), ...(continuedWait ? { continuedWait } : {}) },
          model: selectedModel?.model ?? (modelString === undefined ? undefined : canonicalModelId(modelString)),
          providerOptions: selectedModel?.providerOptions ?? providerOptionsForRunner,
          standingBrief: async () => {
            const tree = await childConversation.getState();
            const brief = [launchAssignmentText(tree, deps.sessionId), recordedEntryText(tree, subagentTaskEntryId(childConversationId))].filter((part) => part !== undefined);
            return brief.length > 0 ? brief.join("\n\n") : undefined;
          },
          conversation: {
            kind: "durable-tree",
            sessionId: childSessionId,
            conversationId: childConversationId,
            priorMessages,
            providerSessionKey: childConversationId,
            append: childConversation.recordCanonicalMessage,
            reserveMessageId: childConversation.reserveMessageId,
            releaseMessageId: childConversation.releaseMessageId,
            captureCommittedForkMessages: childConversation.captureCommittedForkMessages,
            flush: childConversation.flushSavePoint,
            resolveLeafId: childConversation.getLeafId,
            committedTree: childConversation.getState,
            recordCompaction: (compactionInput) => childConversation.recordCompaction(compactionInput).then((result) => result?.messages),
          },
        };
      }
    },
    onAttemptFailure: async () => { await childConversation.flushSavePoint(); },
    onContextCreated: (runnerContext) => {
      runner = runnerContext;
      if (acquisition) launched.resolve(acquisition);
    },
    onContextStarted: (_context, attempt) => {
      rearmStall();
      const isRetry = attempt.isRetry;
      // The one record of a dispatch. The model-written description and the
      // tool names live in the durable tool input and the child session.
      log.info(isRetry ? "subagent recovery attempt" : "subagent dispatched", {
        toolUseId,
        childSessionId,
        agentType,
        model: modelString,
        effort: effortForRunner,
        maxTurns,
        toolCount: toolNames.length,
      });
      if (toolUseId && !isRetry) {
        deps.onRenderEvent(createRuntimeEvent("agent.subagent.dispatched", { tool_use_id: toolUseId, link_uri: `flywheel://session/${childSessionId}` }));
      }
    },
    message: prompt,
    // A cancelled dispatch stays aborted, even when the watchdog fired first.
    classifyResult: (result) => {
      const stalled = stalledGeneration && !dispatchSignal.aborted && result.terminal.kind === "aborted";
      stalledGeneration = false;
      return stalled ? { ...result, terminal: { kind: "stream_stalled", message: `The subagent made no progress for ${STALL_TIMEOUT_MS / 60_000} minutes.`, attribution: { kind: "unattributed" } } } : result;
    },
    resilience: {
      signal: dispatchSignal,
      originalProviderSessionKey: childRunId,
      recover: recovery.recover, settle: recovery.settle,
    },
  });

  // A queued dispatch is idle by design, not stalled: hold the keep-alive
  // until the grant lands; after that the runner's own events bump it.
  const startWhenSlotFrees = async (grant: Promise<ChildSlotReservation>): Promise<AgentRunResult> => {
    try {
      reservation = await withStallKeepAlive(() => grant);
    } catch (err) {
      // A cancelled queued dispatch is an intentional stop, not a failure:
      // settle it as `aborted` so the parent gets an interrupted result.
      if (cancelledBeforeStart) return { durationMs: 0, servedRequests: 0, terminal: { kind: "aborted" } };
      throw err;
    }
    return startRunner();
  };

  const started = Promise.resolve().then(async (): Promise<AgentRunResult> => {
    try {
      if (continuation) runInputs.adopt(await readConversationQueuedUserInputs(published.projectionReader, childSessionId, childConversationId));
      if (cancelledBeforeStart) return { durationMs: 0, servedRequests: 0, terminal: { kind: "aborted" } };
      acquisition = acquireSlot();
      if (acquisition.status === "acquired") reservation = acquisition.reservation;
    } catch (error) {
      startupError = error;
      throw error;
    }
    if (acquisition.status === "queued") {
      log.info("subagent queued for a slot", { toolUseId, childSessionId, agentType, position: acquisition.position, limit: acquisition.limit });
      deps.onRenderEvent(createRuntimeEvent("agent.subagent.queued", { tool_use_id: toolUseId, link_uri: `flywheel://session/${childSessionId}` }));
      launched.resolve(acquisition);
    }
    if (modelString !== undefined) {
      const modelLabel = effortForRunner ? `${modelString} ${effortForRunner}` : modelString;
      deps.onRenderEvent(createRuntimeEvent("agent.subagent_model.selected", { tool_use_id: toolUseId, model: modelLabel }));
    }
    return acquisition.status === "acquired"
      ? startRunner()
      : startWhenSlotFrees(acquisition.reservation);
  });
  const runnerDone = started.then((result) => {
    if (result.terminal.kind === "aborted"
      && cancellationSource !== "user" && cancellationSource !== "agent") pausedBy ??= "runtime";
    return result;
  }).finally(async () => {
    const end = trackLoopSpan("subagent-teardown", childSessionId);
    try {
      probeLoopUnit("subagent-teardown", "release-run", () => {
        reservation?.release();
        clearInterval(activityKeepAlive);
      });
      await runInputs.close();
      await childBackground.close();
    } finally {
      end();
    }
  });

  const reconcileParentCompletion = (): void => {
    if (pausedBy) return;
    deps.subagentSessions.reconcileParentCompletion(deps.sessionId, async (notification) => {
      if (await deps.deliverParentNotification?.(deps.sessionId, notification)) return true
      const deliver = deps.backgroundTasks.deliverDurableSubagentNotification
      if (!deliver) return false
      deliver(notification)
      return true
    });
  };
  const settleParent = async (): Promise<void> => {
    if (pausedBy) await deps.subagentSessions.deactivate(childSessionId);
    else reconcileParentCompletion();
  };
  const publishLiveParentResult = (result: BackgroundWorkResult): void => {
    // A partial run is a successful tool call whose work stopped early; the
    // outcome stays `ok` and the detail carries the cap for the client card.
    emitToolResultAvailable(
      deps.onRenderEvent,
      toolUseId,
      [{ type: "text", text: result.content }],
      result.status === "failed" ? "error" : result.status === "cancelled" || result.status === "stopped" ? result.status : "ok",
      {
        details: {
          ...(result.usage ? { totalTokens: result.usage.totalTokens } : {}),
          ...(result.status === "partial" ? { partial: true } : {}),
        },
      },
    );
  };
  // The result budget is sized when the run settles: what the parent's
  // admission budget has left, divided across the batch of children
  // completing alongside this one. The cap is held in that budget until the
  // parent's history takes the notification that delivers this run.
  const resultCap = (): number => {
    const cap = resultCharBudget(context.contextAdmission?.remainingChars(), deps.backgroundTasks.activeSubagentCount());
    context.contextAdmission?.reserve(childRunId, cap);
    return cap;
  };
  // What the resolver reads when the run settles.
  const resultContext = (): SubagentResultContext => ({
    agentType, childRunId, childSessionId, toolUseId, descriptionText, maxTurns,
    model: modelString,
    getCapturedHandoff: () => capturedHandoff, textState, modelRequestId, stats, deps, turnLog,
    parentToolUseId: context.parentToolUseId,
    budget: {
      cap: resultCap(),
      executionCwd,
      projectRoot: context.projectRoot,
      artifactScopeId: context.artifactScopeId,
      agentType,
    },
    ...(cancellationSource ? { cancellationSource } : {}),
    signal: dispatchSignal,
  });
  const resolveSettledRun = async (result: AgentRunResult): Promise<EndedWorkResult> => {
    const end = trackLoopSpan("subagent-completion", childSessionId);
    try {
      if (pausedBy) {
        return { status: "stopped", content: "Subagent interrupted.", usage: usageFromStats(stats, result.durationMs) };
      }
      return await probeLoopUnit("subagent-completion", "resolve-result", () => resolveSubagentResult(result, resultContext()));
    } finally {
      end();
    }
  };
  const resolveFailedRun = async (err: unknown, phase: "run" | "settlement"): Promise<EndedWorkResult> => {
    // A persistence or owner-close failure is a defect, not a resumable cut.
    pausedBy = undefined;
    return failedRunResult(err, phase, resultContext());
  };
  // Exactly one terminal publication per dispatch, whatever the run did: the
  // durable completion fact, then the live parent row and the terminal drain.
  // A refused completion append rejects `settled`, and the registry then
  // delivers its own failed notification so the parent is never parked on a
  // child it will never hear from again. Once the completion is durable,
  // reconciliation owns delivery, so a later drain failure is reported but
  // does not reject: rejecting would hand the parent a second, contradictory
  // notification for the same child.
  const publishTerminal = async (settledResult: EndedWorkResult): Promise<BackgroundWorkResult> => {
    // The run's own commits retire the cells it read, so every read of the
    // unread cells comes after them. The loop has returned, so its turn is
    // over: the writer commits what the turn held and goes idle, and every
    // commit of the settle lands after the turn.
    if (startupError !== undefined) {
      await published.failBeforeStart(startupError);
      publishLiveParentResult(settledResult);
      return settledResult;
    }
    await published.awaitDurableFacts();
    const successfulHandoff = capturedHandoff !== null && !pausedBy && (settledResult.status === "completed" || settledResult.status === "partial");
    if (!successfulHandoff) await childConversation.endTurn();
    let backgroundResult: BackgroundWorkResult = settledResult;
    if (pausedBy) {
      // A pause is not a completion: the run keeps its binding for resume,
      // the parent gets no result, and its card learns who paused the child.
      // The interrupt ends the turn in the child's own conversation, as a
      // chat's does, so the resumed child and a successor's recovery read
      // who interrupted it, not that its process died. The record lands at
      // the cut, before any held message: it states whether a running tool
      // call was cut, which it reads from the tail of the branch. The
      // resumed run then reads every held message after the record.
      // A planned replacement's cut shows nothing: the card stays active and
      // the successor resumes the child.
      await childConversation.commitTurnEnd(pausedBy);
      await commitHeldMessages(await readUnreadMessages(published.projectionReader, childSessionId));
      const end = interruptedTurnEnd(pausedBy);
      // `subagent.paused` stays version 1, which an older build reads: the
      // parent agent's interrupt is saved there as a person's, and the turn
      // end above, the one authority for who interrupted the child, names
      // the parent agent.
      await published.eventWriter.record(buildSubagentPaused({ childRunId, pausedBy: end.pausedBy === "agent" ? "person" : end.pausedBy }));
      if (isVisibleTurnEnd(end)) deps.onRenderEvent(createRuntimeEvent("agent.subagent.paused", { tool_use_id: toolUseId, paused_by: end.pausedBy }));
      // The parent's process record reads the run as interrupted, the word
      // every surface uses, and never as failed (PI-AGENT-020). A planned
      // replacement's cut names nobody, so the parent gets no notice: the
      // successor resumes the child.
      backgroundResult = { ...settledResult, status: "interrupted", ...(isVisibleTurnEnd(end) ? { interruptedBy: end.pausedBy } : {}) };
    } else {
      // A recorded handoff returns unread human input before idle recovery can adopt it.
      await deps.subagentSessions.settleUnreadMessages({
        recipientSessionId: childSessionId,
        reason: deleting ? "deleting" : "settled",
        ...(!deleting && successfulHandoff ? { humanReturn: { name: descriptionText } } : {}),
        parent: { sessionId: deps.sessionId, conversationId: parentConversationId },
        end: async (parentReturn) => {
          if (successfulHandoff) {
            for (let item = injectionQueue.withdrawHuman(); item; item = injectionQueue.withdrawHuman()) published.projection?.withdrawQueuedMessage?.(item.input.dispatchIds ?? []);
            await childConversation.endTurn();
          }
          const completed = parentReturn ? { ...settledResult, content: parentReturn.completion(settledResult.content) } : settledResult;
          backgroundResult = completed;
          await recordSubagentCompletion(published.eventWriter, { childRunId, result: completed }, parentReturn?.retirements);
          return true;
        },
        commitHeld: async (person) => commitHeldMessages(person, await readConversationBackgroundNotifications(published.projectionReader, childSessionId, childConversationId)),
      });
      publishLiveParentResult(backgroundResult);
    }
    const terminalDrain = await published.eventWriter.drain?.();
    if (terminalDrain?.kind === "failed") {
      log.error("child facts failed to drain after a durable settlement", { agentType, toolUseId, childRunId, error: terminalDrain.error.message });
    }
    return backgroundResult;
  };
  const taskDone = runnerDone
    .then(resolveSettledRun, (err) => resolveFailedRun(err, "run"))
    .catch((err) => resolveFailedRun(err, "settlement"))
    .then(publishTerminal)
    .finally(async () => {
      firstAssembly.resolve(undefined);
      unregisterLiveControl();
      if (toolUseId) {
        deps.onRenderEvent(createRuntimeEvent("budget.stream.completed", { parent_tool_use_id: toolUseId }));
      }
      inFlightToolIds.clear();
      stopObservingReplyWaits();
      stopReplyWaitKeepAlive?.();
      stopWorkWaitKeepAlive?.();
      stopLoginWaitKeepAlive?.();
      stopLoginWaitKeepAlive = undefined;
      await published.settle();
    }).then(
    // Projection disposal persists duration in the child aggregate before
    // lifecycle settlement. Reconciliation runs on the failure path too, so
    // a terminal fact that did land is folded even when the drain failed. A
    // paused child settles its own lifecycle instead: nothing reaches the
    // parent until the run resumes and completes.
    async (result) => { await settleParent(); return result; },
    async (err: unknown) => { await settleParent(); throw err; },
  );

  settled.resolve(taskDone);
  void taskDone.then(
    () => launched.reject(startupError ?? new Error("Subagent ended before its runner started")),
    (error: unknown) => launched.reject(error),
  );
  return launched.promise;
}
