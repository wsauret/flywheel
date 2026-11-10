/** One wire attempt, its partial canonical content, and its audit and usage closure. */

import { DebugLog } from "../../infra/debug-log.js";
import { errorDetail, errorMessage } from "../../infra/error-message.js";
import { mergeAbortSignals } from "../../infra/abort.js";
import type { ProviderRequestOptions } from "../../infra/llm/provider-options.js";
import type { MeasuredUsageEntry, UsageEntry } from "../../infra/llm/usage-entry.js";
import { Log } from "../../infra/log.js";
import type { ReasoningEffort } from "../../infra/llm/models.js";
import { durationMs } from "../../infra/operation-log.js";
import { probeLoopUnit } from "../../infra/event-loop-lag.js";
import { summarizeProviderError, type ProviderErrorDiagnostic } from "../../infra/llm/provider-error-diagnostic.js";
import { classifyApiError } from "../../infra/llm/provider-error-copy.js";
import { type AgentRuntimeError, ApiError, fromStreamError, ProviderAuditSettlementError, StreamStalled } from "./errors.js";
import { ProviderAttemptFailure, type ProviderFailure } from "./llm/provider-failure.js";
import {
  type ConversationMessage,
  type LLMClient,
  type LlmStopReason,
  type ProviderRequestAttribution,
  providerRequestAttribution,
  presentToolHistory,
  type ProviderStreamEvent,
  type RepetitionGuard,
  type ServingAttempt,
  type StreamOptions,
} from "./llm/types.js";
import { ContextLengthExceededError, StreamIdleTimeoutError } from "./llm/errors.js";
import { modelFamilyApi } from "./llm/messages.js";
import { renderSystemPrompt, type SystemPromptTiers } from "./llm/system-prompt-tiers.js";
import type { ProviderRequestAuditHandle, ProviderRequestAuditWriter } from "./llm/provider-request-audit.js";
import type { ModelInteractionProfile } from "./model-interaction-profile.js";
import type { PromptHistoryLowering, PromptStaleMasking, ProviderRequestIdentity } from "../session/provider-request-audit-types.js";
import { applyHistoryLowering, imageLimitCut, planHistoryLowering, type ProviderHistoryTarget } from "./llm/provider-history.js";
import type { PreparedRequestAttempt } from "./request-tool-surface.js";
import { type AssistantTurnResult, handleStreamEvent, type TurnOutcome } from "./assistant-turn-result.js";
import { hasAssistantOutput } from "./assistant-output.js";
import { createRequestStreamTelemetry } from "./stream-telemetry.js";
import type { UsageSettlement } from "./usage-settlement.js";

const log = Log.create({ service: "assistant-turn-stream" });



interface AssistantUsageSettlementContext {
  settlement: UsageSettlement;
  profileId: string;
  budgetStreamId: string;
  identity: ProviderRequestIdentity;
  workflowAttemptId?: string;
  parentToolUseId?: string;
}

export interface AssistantAttemptInput {
  interactionProfile: ModelInteractionProfile;
  requestPurpose?: "compaction";
  messages: ConversationMessage[];
  tools?: StreamOptions["tools"];
  systemPrompt?: SystemPromptTiers;
  prepareAttempt?: (attempt: ServingAttempt) => PreparedRequestAttempt;
  reasoningEffort: ReasoningEffort | undefined;
  toolChoice?: StreamOptions["toolChoice"];
  signal: AbortSignal | undefined;
  /** Resolved by the agent loop (single defaulting site); never re-defaulted
   *  here. Undefined for a request that has no prompt-cache slot of its own,
   *  such as compaction. */
  cacheRetention: StreamOptions["cacheRetention"];
  cacheRetentionPolicies?: StreamOptions["cacheRetentionPolicies"];
  /** The runner's provider session identity (`StreamOptions.providerSessionKey`). */
  providerSessionKey: string | undefined;
  /** The request's prompt-cache group (`StreamOptions.promptCacheKey`). */
  promptCacheKey: string | undefined;
  providerOptions: ProviderRequestOptions | undefined;
  /** Request audit writer for the exact provider call. The agent loop owns
   *  the counters; the stream owns the recording. */
  requestAudit: ProviderRequestAuditWriter | undefined;
  usageSettlement?: AssistantUsageSettlementContext;
  /** Stale tool-result masking applied to `messages` for this request; recorded
   *  on `prompt.assembled` so reconstruction can replay the mask. */
  staleMasking: PromptStaleMasking | undefined;
  /** Historical tool contracts lowered for this request. */
  toolHistoryProjection?: import("../session/provider-request-audit-types.js").PromptToolHistoryProjection;
  /** Request-only user context appended after stale masking. */
  requestContext: string | undefined;
  turn: number;
  /** The image-limit cut that the request's owner last recorded at INFO (`recordImageLimitCut`). Absent for a
   *  request whose owner keeps no record, such as compaction: its bounded requests record at DEBUG only. */
  imageLimitCut?: ImageLimitCutRecord;
  messageCount: number;
  estimatedContextTokens: number;
  onEvent: (event: ProviderStreamEvent) => void;
  reserveMessageId?: () => Promise<string>;
  releaseMessageId?: (id: string) => void;
  /** Pauses source reads at the session event bus watermark. */
  waitForEventCapacity?: (signal?: AbortSignal) => void | Promise<void>;
  /** Settles only unfinished input previews before this attempt loses ownership. */
  onStreamAbandoned?: (reason: "failed" | "interrupted" | "retry") => void;
  /** Canonicalizes a provider-emitted tool name without dispatching the incomplete call. */
  canonicalizeToolName?: (name: string) => string;
  onHandoffStarted?: (call: Pick<import("./llm/types.js").ToolCall, "id" | "modelRequestId">) => void;
  canonicalizeToolCall?: (toolCall: import("./llm/types.js").ToolCall) => import("./llm/types.js").ToolCall;
}

function publishToConsumers(input: AssistantAttemptInput, event: ProviderStreamEvent, signal: AbortSignal | undefined): void | Promise<void> {
  if (event.kind === "done" || event.kind === "transport_context") return;
  // One probed unit per delta, named by the event kind only, so an event-loop
  // stall names the stream consumers that ran across it.
  probeLoopUnit("stream-consumer", event.kind, () => input.onEvent(event));
  if (signal?.aborted) return;
  const pressure = input.waitForEventCapacity?.(signal);
  // Cancellation stops waiting, then the adapter iterator drains its terminal
  // usage. Throwing here would close that iterator before settlement evidence.
  return pressure?.catch((error: unknown) => { if (!signal?.aborted) throw error; });
}

function canonicalizeToolEvent(input: AssistantAttemptInput, event: ProviderStreamEvent): ProviderStreamEvent {
  const startedTool = event.kind === "tool_input_start" ? event.name : event.kind === "tool_use" ? event.toolCall.name : undefined;
  // Close input admission before canonicalizeToolCall registers the call for dispatch.
  if (startedTool !== undefined && (input.canonicalizeToolName?.(startedTool) ?? startedTool) === "handoff") {
    if (event.kind === "tool_input_start") input.onHandoffStarted?.({ id: event.toolUseId, modelRequestId: event.modelRequestId });
    else if (event.kind === "tool_use") input.onHandoffStarted?.(event.toolCall);
  }
  return event.kind === "tool_input_start" && input.canonicalizeToolName
    ? { ...event, name: input.canonicalizeToolName(event.name) }
    : event.kind === "tool_use" && input.canonicalizeToolCall
      ? { ...event, toolCall: input.canonicalizeToolCall(event.toolCall) }
      : event;
}

/** The request of one attempt as its serving client takes it: the prepared revision and the conversation's request
 *  values, without the stream's callbacks. A client that anticipates the request reads the same values
 *  (`LLMClient.anticipate`). */
export function attemptRequest(candidate: Readonly<{ attempt: ServingAttempt; prepared: import("./llm/types.js").PreparedServingRequest; repetitionGuard?: RepetitionGuard }>, input: AssistantAttemptInput, signal: AbortSignal | undefined): StreamOptions {
  const outputTokenLimit = candidate.prepared.outputTokenLimit ?? candidate.attempt.outputLimit;
  return {
    messages: input.messages,
    ...(input.requestContext === undefined ? {} : { requestContext: input.requestContext }),
    tools: candidate.prepared.tools,
    systemPrompt: candidate.prepared.systemPrompt,
    reasoningEffort: candidate.repetitionGuard === "reasoning_off" ? "off" : input.reasoningEffort,
    toolChoice: input.toolChoice,
    signal,
    cacheRetention: candidate.prepared.cacheRetention,
    providerSessionKey: input.providerSessionKey,
    promptCacheKey: input.promptCacheKey,
    estimatedContextTokens: input.estimatedContextTokens,
    ...(outputTokenLimit < candidate.attempt.outputLimit ? { outputTokenLimit } : {}),
    providerOptions: candidate.prepared.providerOptions,
    ...(candidate.repetitionGuard === undefined ? {} : { repetitionGuard: candidate.repetitionGuard }),
  };
}

/** Settles usage at stream exit. The owner closes audit after canonical barriers. The serving client receives the
 *  history lowered for its target (`lowerProviderHistory`), and the audit records the lowered prompt with its edits. */
export function createAssistantAttempt(candidate: Readonly<{ attempt: ServingAttempt; client: Pick<LLMClient, "streamWithTools" | "historyTarget">; prepared: import("./llm/types.js").PreparedServingRequest; sample?: number; repetitionGuard?: RepetitionGuard }>, input: AssistantAttemptInput, prepared: PreparedRequestAttempt | undefined) {
  const result = initialResult();
  const start = performance.now();
  let auditHandle: ProviderRequestAuditHandle | undefined;
  let streamTelemetry: ReturnType<typeof createRequestStreamTelemetry>;
  let attemptId: string | undefined;
  let unmeasured: Extract<UsageEntry, { coverage: "unmeasured" }> | undefined;
  // The served verdict: a response started, or the request went out and the attempt ended by a caller abort or a
  // watchdog timeout, which leaves the provider's handling unknown.
  let dispatched = false;
  let responseStarted = false;
  let endedUnanswered = false;
  const serving = candidate.attempt;
  // The identity that the turn's metadata names when the stream ends before the provider's own `done`: the replay
  // identity that the serving adapter lowers history for, once the request has one.
  let replayIdentity: TurnIdentity = { accessProvider: serving.accessProvider, provider: serving.modelFamily, api: modelFamilyApi(serving.modelFamily), model: serving.model };
  let failure: ProviderFailure | undefined;
  let localFailure: { error: unknown } | undefined;
  let diagnostic: ProviderErrorDiagnostic | undefined;
  let closure: Promise<void> | undefined;
  const settleUsage = async (): Promise<void> => {
    try {
      if (attemptId) await input.usageSettlement?.settlement.settle(attemptId, { served: responseStarted || (dispatched && endedUnanswered) });
    } catch (error) {
      // Preserve tool cleanup and audit closure before surfacing a local failure.
      localFailure ??= { error };
    }
  };
  const close = (): Promise<void> => {
    closure ??= (async () => {
      try {
        await recordAuditResponse(input, auditHandle, result, diagnostic);
      } catch (error) {
        localFailure ??= { error };
      }
      if (!hasAssistantOutput(result.assistantContent)) releaseIdentity();
      if (localFailure) throw localFailure.error;
    })();
    return closure;
  };
  const releaseIdentity = (): void => {
    if (result.entryId !== undefined) input.releaseMessageId?.(result.entryId);
  };
  const stream = async (settlementSignal?: AbortSignal): Promise<AssistantTurnResult> => {
    const signal = settlementSignal ? mergeAbortSignals(input.signal, settlementSignal) : input.signal;
    result.entryId = await input.reserveMessageId?.() ?? crypto.randomUUID();
    try {
    // Every field here is already an INFO fact of its own: model.requested
    // carries the model, provider, turn and cache keys, prompt.assembled the
    // message count and estimated context, tool_surface.selected the tools. A
    // diagnostic that restates facts earns DEBUG, not a second copy per request.
    log.debug("assistant turn stream start", {
      turn: input.turn,
      model: serving.model,
      provider: serving.modelFamily,
      messageCount: input.messageCount,
      tools: input.tools?.length ?? 0,
      estimatedContextTokens: input.estimatedContextTokens,
      providerSessionKey: input.providerSessionKey ? "present" : "missing",
      cacheRetention: input.cacheRetention,
    });
    signal?.throwIfAborted();
      // Runs immediately before each attempt's wire request, and never for a
      // candidate the chain skips: the request is built for the provider that
      // actually sends it, and the audit record is opened against that same
      // provider so telemetry and terminal facts join the request that ran.
        const attempt = serving;
        const outputTokenLimit = candidate.prepared.outputTokenLimit ?? attempt.outputLimit;
        if (outputTokenLimit < 1) throw new ContextLengthExceededError();
        attemptId = crypto.randomUUID();
        const { systemPrompt, tools: wireTools } = candidate.prepared;
        const renderedPrompt = renderSystemPrompt(systemPrompt);
        const attemptStaticTokens = prepared?.attemptStaticTokens
          ?? Math.ceil((renderedPrompt.length + JSON.stringify(wireTools).length) / 4);
        const request = attemptRequest(candidate, input, signal);
        const target = await candidate.client.historyTarget(request);
        replayIdentity = { accessProvider: target.accessProvider, provider: target.provider, api: target.api, model: target.model };
        const edits = planHistoryLowering(request.messages, target);
        const messages = applyHistoryLowering(request.messages, edits);
        recordImageLimitCut(request.messages, target, input.turn, input.imageLimitCut);
        auditHandle = await recordAuditRequest(input, messages, edits.length === 0 ? undefined : { edits }, attemptId, providerRequestAttribution(attempt), renderedPrompt, request, attemptStaticTokens, prepared, attempt.toolPresentation);
        streamTelemetry = createRequestStreamTelemetry(input.requestAudit, auditHandle);
        const settlement = input.usageSettlement;
        if (settlement) {
          unmeasured = { ...usageAttempt(attemptId, new Date().toISOString(), settlement.profileId, serving), coverage: "unmeasured" };
          await settlement.settlement.begin(settlementDraft(settlement, attemptId, input.turn, unmeasured));
        }
        const options: StreamOptions = {
          ...request,
          messages,
          telemetry: streamTelemetry,
          onDispatch: () => {
            dispatched = true;
            return auditHandle ? input.requestAudit?.recordDispatch?.(auditHandle) : undefined;
          },
        };
    for await (const event of candidate.client.streamWithTools(options)) {
      // Adapters can yield observed usage from their catch path before
      // rethrowing a local failure. Drain that closure without admitting work.
      if (signal?.aborted && event.kind !== "usage" && event.kind !== "done") continue;
      const attributed = event.kind === "done" && event.metadata && serving
        ? { ...event, metadata: { ...event.metadata, accessProvider: serving.accessProvider } }
        : event.kind === "usage" && serving
          ? {
              ...event,
              accessProvider: serving.accessProvider,
              ...(serving.accessProviderCandidate === undefined ? {} : { accessProviderCandidate: serving.accessProviderCandidate }),
            }
          : event;
      // Stamp the request id before canonicalization: canonicalizeToolCall
      // hands the call to the dispatcher, and every durable fact the executing
      // call emits (tool.result.recorded, tool.execution_output.recorded) must
      // carry the same modelRequestId as its tool.input.completed fact.
      const stamped = attachModelRequestId(attributed, auditHandle?.requestId);
      const canonicalEvent = canonicalizeToolEvent(input, stamped);
      const publication = handleStreamEvent(canonicalEvent, result);
      await streamTelemetry?.observeNormalized(canonicalEvent);
      if (canonicalEvent.kind === "provider_response_started") responseStarted = true;
      if (canonicalEvent.kind === "usage" && input.usageSettlement && unmeasured && attemptId) {
        await input.usageSettlement.settlement.checkpoint(settlementDraft(input.usageSettlement, attemptId, input.turn, measuredEntry(unmeasured, serving, canonicalEvent)));
      }
      // The terminal event is retained on the result, never forwarded: the
      // turn's terminal runtime projection belongs after the assistant and its
      // tool results are durable, and the settlement coordinator owns that
      // publication (agent-turn-settlement.ts).
      const pressure = publishToConsumers(input, publication, signal);
      if (pressure) await pressure;
    }
    if (signal?.aborted) {
      endedUnanswered = true;
      finalizeOutcome(result, { kind: "aborted" }, replayIdentity);
    }
    return result;
  } catch (err) {
    if (signal?.aborted && err === signal.reason) {
      endedUnanswered = true;
      finalizeOutcome(result, { kind: "aborted" }, replayIdentity);
      return result;
    }
    diagnostic = summarizeProviderError(err);
    if (err instanceof ProviderAttemptFailure) failure = err.failure;
    else localFailure = { error: err };
    const cause = err instanceof ProviderAttemptFailure ? err.cause : err;
    // A watchdog timeout in either phase routes as a disconnect or a stall, but for the served verdict it is an
    // unanswered request: the provider may still have handled it.
    endedUnanswered = cause instanceof StreamIdleTimeoutError;
    const streamError = fromStreamError(cause, failure);
    // Both watchdog stall variants have the same routing remedy once a serving
    // attempt exists. Normalize them so resilience receives one attributed
    // failure instead of knowing each watchdog's internal error shape.
    const stalledProvider = serving?.accessProvider;
    const needsAttribution = stalledProvider !== undefined && (
      streamError._tag === "ThinkingStall"
      || (streamError._tag === "StreamStalled" && streamError.attribution.kind === "unattributed")
    );
    const typed = needsAttribution
      ? new StreamStalled({ message: streamError.message, attribution: { kind: "provider", provider: stalledProvider } })
      : attributedAuthFailure(streamError, failure, serving);
    const recoverable = classifyRecoverable(typed);
    // The attempt records its own trip, because a turn can settle on the trip without the walk resampling it.
    if (failure?._tag === "DegenerateRepetitionFailure") {
      DebugLog.record({ type: "model.reasoning.repetition_detected", payload: {
        model: serving.model,
        accessProvider: serving.accessProvider,
        attempt: candidate.sample,
        ratio: Math.round(failure.ratio * 1_000) / 1_000,
        windowChars: failure.windowChars,
        reasoningChars: failure.reasoningChars,
      } });
    }
    if (recoverable) {
      log[typed._tag === "DegenerateRepetition" ? "debug" : "warn"]("assistant turn stream failed", {
        error: diagnostic,
        errorDetail: errorDetail(err),
        outcome: recoverable.kind,
        textBlocks: result.assistantContent.length,
        toolCalls: result.toolCalls.length,
        durationMs: durationMs(start),
      });
      finalizeOutcome(result, recoverable, replayIdentity);
      return result;
    }
    log.error("assistant turn stream failed (fatal)", {
      error: diagnostic,
      errorDetail: errorDetail(err),
      tag: typed._tag,
      textBlocks: result.assistantContent.length,
      toolCalls: result.toolCalls.length,
      durationMs: durationMs(start),
    });
    finalizeOutcome(result, { kind: "stream_error", error: typed }, replayIdentity);
    return result;
  } finally {
    await settleUsage();
    try {
      await streamTelemetry?.complete(auditOutcome(result.outcome));
    } catch (error) {
      localFailure ??= { error };
    }
  }};
  return { stream, close, releaseIdentity, failure: () => failure };
}

/** The image-limit cut that one request owner last recorded at INFO. The owner holds it across its attempts and turns,
 *  so a retry or a failover that sends the same history does not record the move again. */
export interface ImageLimitCutRecord { replaced: number }

/** Records a request that its model's image limit bounds (`imageLimitCut`): DEBUG for each such request, and INFO
 *  once more when the cut differs from the one that `record` holds, which it then advances. A steady cut between moves
 *  therefore adds nothing above DEBUG. Counts only, no content. */
function recordImageLimitCut(history: readonly ConversationMessage[], target: ProviderHistoryTarget, turn: number, record: ImageLimitCutRecord | undefined): void {
  const cut = imageLimitCut(history, target);
  if (cut === undefined || cut.replaced === 0) return;
  const fields = { turn, model: target.model, limit: cut.limit, images: cut.images, replaced: cut.replaced };
  log.debug("image limit bounded request", fields);
  if (record === undefined || record.replaced === cut.replaced) return;
  log.info("image limit cut moved", { ...fields, previouslyReplaced: record.replaced });
  record.replaced = cut.replaced;
}

/** Opens the audit context for one provider request. `attribution`,
 *  `systemPrompt`, and `request` all come from the attempt that sends it, so
 *  the record states the prompt, tools, and reasoning effort that the provider
 *  actually received. */
function recordAuditRequest(
  input: AssistantAttemptInput,
  messages: ConversationMessage[],
  historyLowering: PromptHistoryLowering | undefined,
  requestId: string,
  attribution: ProviderRequestAttribution,
  systemPrompt: string,
  request: Pick<StreamOptions, "tools" | "reasoningEffort">,
  attemptStaticTokens: number,
  prepared: PreparedRequestAttempt | undefined,
  presentation: ServingAttempt["toolPresentation"],
): Promise<ProviderRequestAuditHandle> | ProviderRequestAuditHandle | undefined {
  return input.requestAudit?.recordRequest({
    requestId,
    turn: input.turn,
    interactionProfileId: prepared?.interactionProfileId ?? input.interactionProfile.id,
    ...(input.requestPurpose ? { requestPurpose: input.requestPurpose } : {}),
    attribution,
    systemPrompt,
    messages: presentToolHistory(messages, presentation),
    tools: prepared?.auditTools ?? request.tools.map((tool) => ({ ...tool, name: presentation.wireName?.(tool.name) ?? tool.name, registrationId: tool.name, executableId: tool.name })),
    omittedTools: prepared?.omittedTools ?? [],
    messageCount: input.messageCount,
    estimatedContextTokens: input.estimatedContextTokens,
    attemptStaticTokens,
    reasoningEffort: request.reasoningEffort,
    cacheRetention: input.cacheRetention,
    cacheKey: input.cacheRetention === "none" ? undefined : input.promptCacheKey,
    providerOptions: input.providerOptions,
    staleMasking: input.staleMasking,
    toolHistoryProjection: input.toolHistoryProjection,
    ...(historyLowering === undefined ? {} : { historyLowering }),
    requestContext: input.requestContext,
    contextApplication: prepared?.contextApplication,
  });
}

async function recordAuditResponse(
  input: AssistantAttemptInput,
  handle: ProviderRequestAuditHandle | undefined,
  result: AssistantTurnResult,
  diagnostic?: ProviderErrorDiagnostic,
  override?: Parameters<ProviderRequestAuditWriter["recordResponse"]>[1],
): Promise<void> {
  if (!handle || !input.requestAudit) return;
  try {
    await input.requestAudit.recordResponse(handle, override ?? {
      outcome: auditOutcome(result.outcome),
      ...(result.assistantMetadata?.stopReason ? { stopReason: result.assistantMetadata.stopReason } : {}),
      ...(result.assistantMetadata?.responseId ? { responseId: result.assistantMetadata.responseId } : {}),
      ...(result.transportContext ? { transportContext: result.transportContext } : {}),
      ...("error" in result.outcome
        ? { error: { tag: result.outcome.error._tag, message: diagnostic?.message ?? errorMessage(result.outcome.error), ...(diagnostic ? { diagnostic } : {}) } }
        : {}),
    });
  } catch (error) {
    throw new ProviderAuditSettlementError({ message: errorMessage(error) });
  }
}


function auditOutcome(outcome: TurnOutcome): Parameters<ProviderRequestAuditWriter["recordResponse"]>[1]["outcome"] {
  switch (outcome.kind) {
    case "ok": return "ok";
    case "incomplete": return "stream_error";
    case "aborted": return "aborted";
    case "context_overflow": return "context_overflow";
    case "output_overflow": return "output_overflow";
    case "stream_error": return "stream_error";
  }
}

function attachModelRequestId(
  event: ProviderStreamEvent,
  requestId: string | undefined,
): ProviderStreamEvent {
  if (!requestId) return event;
  switch (event.kind) {
    case "tool_input_start":
    case "tool_input_delta":
      return { ...event, modelRequestId: requestId };
    case "tool_use":
      return { ...event, toolCall: { ...event.toolCall, modelRequestId: requestId } };
    default:
      return event;
  }
}


/** A rejected credential is the serving provider's own. The error text names
 *  whichever SDK the provider speaks, so only the attempt can say which
 *  provider failed, and the failure copy names that provider. */
function attributedAuthFailure(error: AgentRuntimeError, failure: ProviderFailure | undefined, serving: ServingAttempt | undefined): AgentRuntimeError {
  if (failure?._tag !== "AuthFailure" || error._tag !== "ApiError" || serving?.providerIdentity === undefined) return error;
  return new ApiError({ message: error.message, copy: classifyApiError(error.message, serving.providerIdentity), recovery: error.recovery });
}

/** Maps a raw stream error into a recoverable outcome. Returns null for
 *  errors the agent loop can't recover from (auth, exit code, etc.); those
 *  are rethrown by `streamAssistantTurn` and propagate to the runner. */
function classifyRecoverable(typed: AgentRuntimeError): TurnOutcome | null {
  switch (typed._tag) {
    case "ContextOverflow": return { kind: "context_overflow", error: typed };
    case "OutputOverflow": return { kind: "output_overflow", error: typed };
    case "TransientDisconnect":
    case "StreamStalled":
    case "ApiOverloaded":
    case "DegenerateRepetition":
    case "ContentRefused": return { kind: "stream_error", error: typed };
    // The filter stopped an accepted response: it settles as one, with the
    // content streamed so far, and the loop's content-filter nudge continues it.
    case "ContentFiltered": return { kind: "ok", stopReason: "content_filter" };
    default: return null;
  }
}

type TurnIdentity = Omit<ProviderHistoryTarget, "sharedHost">;

/** Single site that records the outcome and tags assistantMetadata so
 *  heal-messages can filter the persisted turn by stopReason on replay.
 *  A turn that ended without the provider's metadata takes `identity`, the
 *  exact replay identity of the adapter that served it, so a later request
 *  replays its deliberation only where that adapter would. */
function finalizeOutcome(
  result: AssistantTurnResult,
  outcome: TurnOutcome,
  identity: TurnIdentity,
): void {
  result.outcome = outcome;
  const stopReason = outcomeStopReason(outcome);
  if (!result.assistantMetadata) {
    result.assistantMetadata = { ...identity, timestamp: Date.now(), stopReason };
  } else {
    result.assistantMetadata = { ...result.assistantMetadata, stopReason };
  }
}

function outcomeStopReason(outcome: TurnOutcome): LlmStopReason {
  switch (outcome.kind) {
    case "ok": return outcome.stopReason;
    case "incomplete": return "error";
    case "aborted": return "aborted";
    case "context_overflow":
    case "output_overflow":
    case "stream_error": return "error";
  }
}

function settlementDraft(context: AssistantUsageSettlementContext, attemptId: string, turn: number, entry: UsageEntry) {
  return {
    entry,
    budgetStreamId: context.budgetStreamId,
    requestId: attemptId,
    identity: context.identity,
    turn,
    ...(context.workflowAttemptId ? { workflowAttemptId: context.workflowAttemptId } : {}),
    ...(context.parentToolUseId ? { parentToolUseId: context.parentToolUseId } : {}),
  };
}

/** The serving attribution of one attempt, which its record holds whether or not the provider reports usage. */
function usageAttempt(attemptId: string, occurredAt: string, profileId: string, serving: ServingAttempt): Omit<Extract<UsageEntry, { coverage: "unmeasured" }>, "coverage"> {
  const candidate = serving.accessProviderCandidate;
  if (!candidate || !serving.credentialLineage) throw new Error("Usage settlement requires complete serving attribution");
  return {
    attemptId,
    occurredAt,
    profileId,
    attribution: { kind: "candidate", providerId: candidate.providerId, ...(candidate.kind === "subscription" ? { instanceId: candidate.instanceId } : {}) },
    spendMode: candidate.spendMode,
    credentialLineage: serving.credentialLineage,
    model: serving.model,
    classification: candidate.spendMode === "included" ? "subscription_equivalent" : "real_spend",
  };
}

/** The attempt's record after a usage report. A report that is not the provider's final one holds lower bounds.
 *  A charge that the provider's response states is the price, with the response as its provenance and no rate card
 *  (ARCH-PROVIDERS-077). Otherwise the rate card prices the tokens: unreported cache reads stay inside the input
 *  count, so they price at the uncached input rate, an upper bound that the price provenance names. */
function measuredEntry(attempt: Extract<UsageEntry, { coverage: "unmeasured" }>, serving: ServingAttempt, event: Extract<ProviderStreamEvent, { kind: "usage" }>): MeasuredUsageEntry {
  const tokens = { input: event.inputTokens, output: event.outputTokens, cacheRead: event.cacheReadTokens, cacheWrite: event.cacheCreateTokens, reasoning: event.reasoningTokens };
  const measured = { ...attempt, coverage: event.final ? "complete" : "partial", currency: "USD", tokens } as const;
  if (event.reportedChargeUsd !== undefined) {
    return {
      ...measured,
      price: { kind: "priced", estimatedUsd: event.reportedChargeUsd, rateCard: {}, provenance: JSON.stringify({ source: "provider-response", provider: serving.accessProvider, model: serving.model }) },
    };
  }
  const priced = serving.priceFor({
    ...tokens,
    cacheRead: tokens.cacheRead ?? 0,
    ...(event.cacheCreate1hTokens === undefined ? {} : { cacheWrite1h: event.cacheCreate1hTokens }),
  });
  return {
    ...measured,
    price: priced.status === "unavailable"
      ? { kind: "unavailable", reason: priced.reason }
      : {
          kind: "priced",
          estimatedUsd: priced.amountUsd,
          rateCard: Object.fromEntries(Object.entries(priced.rateCard).flatMap(([tier, rates]) => Object.entries<number>(rates).map(([key, value]) => [`${tier}.${key}`, value]))),
          provenance: JSON.stringify(tokens.cacheRead === null ? { ...priced.provenance, cacheRead: "unreported; input priced at the uncached rate" } : priced.provenance),
        },
  };
}

function initialResult(): AssistantTurnResult {
  return {
    outcome: { kind: "ok", stopReason: "unknown" },
    assistantContent: [],
    toolCalls: [],
    assistantMetadata: undefined,
    lastAssistantMetadata: undefined,
    usageAnchor: undefined,
    terminalEvent: undefined,
    transportContext: undefined,
  };
}
