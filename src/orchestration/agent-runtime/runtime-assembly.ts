/**
 * Single boundary that turns `AgentOptions` plus a live `ModelClient`
 * into a ready-to-run `AgentLoopOptions`. The runner owns lifecycle only.
 * The inputs of the run's requests (tool exposure, system prompt, history
 * source) come from request-inputs.ts, which a pre-start reads too; this
 * file adds the resources of the run's turns: usage, the provider request
 * audit, the model-fallback notice, event mapping, and lifecycle hooks.
 */

import { accountAuthDir } from "../../infra/paths.js";
import { canonicalPathWithMissingTail } from "../../infra/canonical-path.js";
import { mergeAbortSignals } from "../../infra/abort.js";
import type { AgentLoopOptions } from "./agent-loop-types.js";
import type { ContentBlock as LLMContentBlock } from "./llm/types.js";
import { createExecutionNotesHook } from "./execution-notes.js";
import type { AgentOptions, RunnableAgentOptions } from "./types.js";
import { createThinkingAccumulator, emitTurnAssistant, emitUser } from "./emit.js";
import { prepareRuntimeUsage } from "./runtime-usage.js";
import type { UsageSettlement } from "./usage-settlement.js";
import { createRuntimeRequestAudit, type RuntimeConversation } from "./runtime-conversation.js";
import { composeAttributionAudit, createRequestAttribution } from "./request-attribution.js";
import { createRuntimeStreamEventHandler } from "./runtime-stream-events.js";
import { workflowPromptPrefixHold } from "./prompt-prefix-hold.js";
import { createModelFallbackNotice } from "./model-fallback-notice.js";
import { openRequestInputs, type RequestInputsSource } from "./request-inputs.js";
import { isChatFacing } from "./request-system-prompt.js";

interface AssembleInput extends RequestInputsSource {
  signal: AbortSignal;
  /** Durable runner signal, distinct from the merged per-turn interrupt signal. */
  disposalSignal: AbortSignal;
  /** User-typed instruction this send() represents. The loop seeds it as the
   *  trailing user message unless the caller supplied `priorMessages` (chat
   *  path), in which case the seed is skipped. `null` is a respawn wake: the
   *  loop life exists only to drain its mailbox, so there is nothing to seed. */
  instruction: string | null;
  /** Effect-owned current-turn interruption seam for the active runner. */
  currentTurn: AgentLoopOptions["currentTurn"];
}

/** The run's stop signal: the caller-supplied lifecycle signal merged with the
 *  runner bridge's abort, so either side stops the run. */
export function resolveRunnerSignal(options: AgentOptions, abortSignal: AbortSignal): AbortSignal {
  return mergeAbortSignals(options.lifecycle.signal, abortSignal);
}

function resolveParentToolUseId(options: AgentOptions): string | undefined {
  return options.purpose.kind === "subagent" ? options.purpose.parentToolUseId : undefined;
}


/** The loop's usage settlement: the run's settlement under its profile, keyed by the conversation that it bills. */
function loopUsageSettlement(input: {
  readonly options: RunnableAgentOptions;
  readonly conversation: RuntimeConversation;
  readonly settlement: UsageSettlement | undefined;
  readonly budgetStreamId: string;
  readonly parentToolUseId: string | undefined;
}): Pick<AgentLoopOptions, "usageSettlement"> {
  const { options, conversation, settlement, parentToolUseId } = input;
  if (settlement === undefined || options.usageProfile === undefined) return {};
  return {
    usageSettlement: {
      settlement,
      profileId: options.usageProfile.profileId,
      budgetStreamId: input.budgetStreamId,
      identity: {
        providerSessionKey: conversation.providerSessionKey,
        ...(!conversation.requestAccounting ? { conversationId: conversation.aggregateId ?? conversation.artifactScopeId } : {}),
      },
      ...(options.purpose.kind === "workflow-agent" ? { workflowAttemptId: options.purpose.workflowAttemptId } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
    },
  };
}

/** Assembles the loop of one run: its request inputs (`openRequestInputs`) and the resources of its turns, which
 *  are the usage tracker and settlement, the request audit, the model-fallback notice, the checkpoint notes' legacy
 *  import, and the lifecycle hooks. */
export async function assembleRuntimeForTurn(input: AssembleInput): Promise<AgentLoopOptions> {
  const { options, signal, conversation } = input;
  const parentId = resolveParentToolUseId(options);
  const { runtimeSurfaces } = options;
  const usage = await prepareRuntimeUsage(options, conversation, parentId);
  const { usageTracker, usageSettlement, budgetStreamId } = usage;
  const inputs = await (await openRequestInputs(input, { kind: "send", turn: {
    usage,
    auxiliaryRequestAudit: createRuntimeRequestAudit(options, conversation),
    recordServingSelection: createModelFallbackNotice(conversation, options.onSystemMessage),
  } })).build();
  await inputs.importLegacyNotes();
  const { request, moduleRuntimes, checkpoint, scratchDir } = inputs;
  const toolSurface = request.tools;
  const sessionId = conversation.sessionId;
  const conversationAggregateId = conversation.aggregateId;
  const requestAttribution = createRequestAttribution(options, conversationAggregateId, toolSurface);
  const requestAudit = composeAttributionAudit(createRuntimeRequestAudit(options, conversation), requestAttribution);
  const background = runtimeSurfaces.background;
  const loadedBundledSkillIds = input.loadedBundledSkillIds;
  const thinking = createThinkingAccumulator();
  const runtimeEventParentToolUseId = parentId;
  // A child with its own conversation writes durable facts under that
  // conversation's identity. The parent dispatch id remains render routing.
  const durableToolParentUseId = conversationAggregateId ? undefined : parentId;
  const onEvent = createRuntimeStreamEventHandler({
    options,
    contextWindow: () => toolSurface.current().providerRuntime?.plannedAttempt.contextLimit ?? inputs.planned.contextLimit,
    costTracker: usageTracker,
    providerSessionKey: conversation.providerSessionKey,
    sessionId,
    parentToolUseId: runtimeEventParentToolUseId,
    thinking,
    surface: toolSurface,
  });

  const onTurnAssistantMessage = (content: LLMContentBlock[], entryId?: string): void => {
    thinking.take();
    emitTurnAssistant(options.onEvent, content, usageTracker, runtimeEventParentToolUseId, entryId);
  };

  const protectedTraversalRoots = [
    accountAuthDir(options.userDataRoot),
  ].map(canonicalPathWithMissingTail);
  const onPersonTurn = inputs.onPersonTurn;
  return {
    ...request,
    // Only the agents of a workflow are staggered: a chat or a
    // subagent never shares its session tier with a sibling, so it never waits.
    ...(options.purpose.kind === "workflow-agent" ? { promptPrefixHold: workflowPromptPrefixHold } : {}),
    afterToolCall: createExecutionNotesHook(),
    instruction: input.instruction,
    ...(runtimeSurfaces.streamingEditValidation ? { streamingEditValidation: runtimeSurfaces.streamingEditValidation } : {}),
    projectRoot: options.projectRoot,
    userDataRoot: options.userDataRoot,
    protectedTraversalRoots,
    effectiveBundledSkillIds: loadedBundledSkillIds,
    handoff: runtimeSurfaces.handoff,
    moduleRuntimes,
    signal,
    disposalSignal: input.disposalSignal,
    background,
    onEvent: conversation.requestAccounting
      ? (event) => { if (event.kind !== "context_update") onEvent(event); }
      : onEvent,
    onSystemMessage: options.onSystemMessage,
    onNotice: options.onNotice,
    onNotification: options.onNotification,
    onUserMessage: (content, origin, identity) => { emitUser(options.onEvent, content, origin, runtimeEventParentToolUseId, identity); },
    onTurnAssistantMessage,
    inputSource: options.lifecycle.kind === "one-shot" ? undefined : options.lifecycle.inputSource,
    completeOnIdle: options.lifecycle.kind === "complete-on-idle" ? { seal: options.lifecycle.seal } : undefined,
    ...(isChatFacing(options) ? { humanFacing: true } : {}),
    lifecycle: {
      onHandoffStarted: options.lifecycle.onHandoffStarted,
      restoredWait: options.lifecycle.restoredWait,
      maintenance: options.lifecycle.maintenance,
      onCompactionContinuation: options.lifecycle.onCompactionContinuation,
      onTurnEnded: options.lifecycle.onTurnEnded,
      onToolBatchSettled: options.lifecycle.onToolBatchSettled,
      onTurnParked: options.lifecycle.onTurnParked,
      onTurnResumed: options.lifecycle.onTurnResumed,
      onLoginWait: options.lifecycle.onLoginWait,
      onLogicalTurnStarted: (ctx) => {
        if (ctx.origin === "user") onPersonTurn?.();
        options.lifecycle.onLogicalTurnStarted?.(ctx);
      },
    },
    artifactScopeId: conversation.artifactScopeId,
    retrievalSessionId: conversation.retrievalSessionId,
    parentToolUseId: durableToolParentUseId,
    flushCanonicalMessages: conversation.flush,
    waitForEventCapacity: options.waitForEventCapacity,
    ...(conversation.awaitDurableFacts ? { awaitDurableFacts: conversation.awaitDurableFacts } : {}),
    scratchDir,
    checkpoint,
    ...(options.standingBrief ? { standingBrief: options.standingBrief } : {}),
    launcher: runtimeSurfaces.launcher,
    persistentProcesses: runtimeSurfaces.persistentProcesses,
    allowPersistentProcesses: runtimeSurfaces.allowPersistentProcesses,
    maxLLMCalls: options.maxLLMCalls,
    priorLLMCalls: options.priorLLMCalls,
    requestAudit,
    ...loopUsageSettlement({ options, conversation, settlement: usageSettlement, budgetStreamId, parentToolUseId: durableToolParentUseId }),
    ...(requestAttribution ? { requestAttribution } : {}),
    sessionEventWriter: options.sessionEventWriter,
    applyNestedStoredFact: options.applyNestedStoredFact,
    ...(options.capabilityAccess ? { capabilityAccess: options.capabilityAccess } : {}),
    currentTurn: input.currentTurn,
    onConnectionState: options.lifecycle.onConnectionState,
  };
}
