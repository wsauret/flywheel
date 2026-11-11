import {
  recordProviderRequest,
  recordProviderRequestDispatched,
  recordProviderResponse,
  recordProviderStreamCompleted,
  recordProviderStreamEvent,
  recordProviderStreamStarted,
  recordProviderStreamSummary,
  recordProviderUsage,
  type ConversationDedup,
  type ProviderRequestAuditContext,
} from "../../session/provider-request-audit-recorder.js";
import type { ProviderRequestAuditFact } from "../../session/provider-request-audit-facts.js";
import {
  providerRequestAuditOptions,
  type PromptHistoryLowering,
  type PromptStaleMasking,
  type PromptToolHistoryProjection,
  type ProviderRequestIdentity,
  type ProviderRequestAuditOmittedTool,
  type ProviderRequestAuditResponseInput,
  type ProviderRequestAuditContextApplication,
  type ProviderRequestAuditTool,
  type ProviderRequestUsageInput,
  type ProviderStreamSummary,
  type ProviderStreamTelemetryCompletedInput,
  type ProviderStreamTelemetryEventInput,
} from "../../session/provider-request-audit-types.js";
import type { ProviderRequestOptions } from "../../../infra/llm/provider-options.js";
import type { ReasoningEffort } from "../../../infra/llm/models.js";
import type { CacheRetention, ConversationMessage, ProviderRequestAttribution } from "./types.js";
import type { PromptKind } from "../system-prompt.js";
import type { ModelInteractionProfileId } from "../model-interaction-profile.js";
import type { SessionFactWriter } from "../../session/session-fact-writer.js";
import type { DurableOwner } from "../../../infra/durable-owner.js";

export interface ProviderRequestAuditHandle {
  requestId: string;
  turn: number;
}

// Request, response, usage, context, and aggregate stream-summary records are
// durable session facts. Raw stream observations are retention-bounded debug
// records. Durable writes are acknowledged before their recording call settles.
export interface ProviderRequestAuditWriter {
  /** Opens the audit context for one provider request. The attribution is the
   *  serving client's, captured at the moment the request is sent: an
   *  automatic-chain failover sends a second request under a second
   *  attribution, and each gets its own record. */
  recordRequest(input: {
    requestId: string;
    turn: number;
    interactionProfileId: ModelInteractionProfileId;
    requestPurpose?: "compaction";
    attribution: ProviderRequestAttribution;
    systemPrompt: string;
    messages: ReadonlyArray<ConversationMessage>;
    tools: ReadonlyArray<ProviderRequestAuditTool>;
    omittedTools: ReadonlyArray<ProviderRequestAuditOmittedTool>;
    messageCount: number;
    estimatedContextTokens: number;
    attemptStaticTokens: number;
    reasoningEffort: ReasoningEffort | undefined;
    cacheRetention: CacheRetention | undefined;
    cacheKey: string | undefined;
    providerOptions: ProviderRequestOptions | undefined;
    staleMasking: PromptStaleMasking | undefined;
    toolHistoryProjection?: PromptToolHistoryProjection;
    historyLowering?: PromptHistoryLowering;
    requestContext: string | undefined;
    contextApplication?: ProviderRequestAuditContextApplication;
    /** The durable conversation-tree leaf that `messages` were assembled from (`captureTreeLeaf`). Absent for a
     *  conversation that has no durable tree. */
    treeLeafEntryId?: string | null;
  }): ProviderRequestAuditHandle | Promise<ProviderRequestAuditHandle>;
  /** Reads the durable conversation-tree leaf that a request's history ends at. A request reads it once when it
   *  assembles its messages and records it for every attempt that sends them, because an attempt's own partial can
   *  move the leaf before the walk resamples the same prepared request. Present only for a conversation that has a
   *  durable tree. */
  captureTreeLeaf?(): Promise<string | null>;
  recordDispatch?(handle: ProviderRequestAuditHandle): void;
  recordResponse(handle: ProviderRequestAuditHandle, input: {
    outcome: ProviderRequestAuditResponseInput["outcome"];
    stopReason?: string;
    responseId?: string;
    error?: ProviderRequestAuditResponseInput["error"];
    transportContext?: ProviderRequestAuditResponseInput["transportContext"];
  }): void | Promise<void>;
  recordAbandonedResponse?(handle: ProviderRequestAuditHandle, input: {
    outcome: ProviderRequestAuditResponseInput["outcome"];
    error: ProviderRequestAuditResponseInput["error"];
  }): void | Promise<void>;
  recordUsage(
    handle: ProviderRequestAuditHandle,
    input: Omit<ProviderRequestUsageInput, "requestId" | "identity" | "turn" | "workflowAttemptId" | "parentToolUseId">,
  ): void | Promise<void>;
  recordStreamStarted(handle: ProviderRequestAuditHandle): void | Promise<void>;
  recordStreamEvent(
    handle: ProviderRequestAuditHandle,
    input: Omit<ProviderStreamTelemetryEventInput, "requestId" | "identity" | "turn">,
  ): void | Promise<void>;
  recordStreamCompleted(
    handle: ProviderRequestAuditHandle,
    input: Omit<ProviderStreamTelemetryCompletedInput, "requestId" | "turn">,
  ): void | Promise<void>;
  recordStreamSummary?(
    handle: ProviderRequestAuditHandle,
    input: Omit<ProviderStreamSummary, "requestId" | "identity" | "turn">,
  ): void | Promise<void>;
}

interface ProviderRequestAuditWriterDeps {
  owner?: DurableOwner;
  /** Session tag for raw stream diagnostics. */
  sessionId?: string;
  /** Durable owner for session-backed audit facts. */
  writer?: Pick<SessionFactWriter, "record" | "recordBatch">;
  identity: ProviderRequestIdentity;
  promptKind: PromptKind;
  parentToolUseId?: string;
  workflowAttemptId?: string;
  /** In-memory observer of every recorded fact; a run that summarizes its own
   *  requests (headless) accumulates from here instead of re-reading a store. */
  observe?: (fact: ProviderRequestAuditFact) => void;
  /** Resolves the durable conversation-tree leaf (`captureTreeLeaf`), recorded
   *  as the Tier-1 tree pointer so the reconstruction helper can
   *  historical-fold the exact history. Injected by the orchestration layer
   *  that owns the tree (chat, workflow worker). Absent for subagents; they
   *  record Tier-1 metadata only. */
  resolveTreeLeafEntryId?: () => Promise<string | null>;
}

export function createProviderRequestAuditWriter(
  deps: ProviderRequestAuditWriterDeps,
): ProviderRequestAuditWriter {
  const audit: ProviderRequestAuditContext = {
    ...(deps.owner ? { owner: deps.owner } : {}),
    ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
    ...(deps.writer ? { writer: deps.writer } : {}),
    ...(deps.observe ? { observe: deps.observe } : {}),
  };
  const starts = new Map<string, number>();
  // One register per writer, pinned to one conversation. Prompt/tool hashes
  // retain reusable bodies; transformer evidence retains only the active request.
  const dedup: ConversationDedup = {};

  async function recordRequest(input: Parameters<ProviderRequestAuditWriter["recordRequest"]>[0]): Promise<ProviderRequestAuditHandle> {
    const auditOptions = providerRequestAuditOptions(input.providerOptions);
    const requestId = await recordProviderRequest(audit, {
      requestId: input.requestId,
      identity: deps.identity,
      turn: input.turn,
      interactionProfileId: input.interactionProfileId,
      promptKind: deps.promptKind,
      ...(input.requestPurpose ? { requestPurpose: input.requestPurpose } : {}),
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      messageCount: input.messageCount,
      estimatedContextTokens: input.estimatedContextTokens,
      attemptStaticTokens: input.attemptStaticTokens,
      contextWindow: input.attribution.contextLimit,
      tools: input.tools,
      omittedTools: input.omittedTools,
      model: input.attribution.model,
      accessProvider: input.attribution.accessProvider,
      accessProviderCandidate: input.attribution.accessProviderCandidate,
      ...(input.attribution.catalogProvenance === undefined ? {} : { catalogProvenance: input.attribution.catalogProvenance }),
      modelFamily: input.attribution.modelFamily,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.cacheRetention ? { cacheRetention: input.cacheRetention } : {}),
      ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
      ...(auditOptions !== undefined ? { providerOptions: auditOptions } : {}),
      ...(input.staleMasking ? { staleMasking: input.staleMasking } : {}),
      ...(input.toolHistoryProjection ? { toolHistoryProjection: input.toolHistoryProjection } : {}),
      ...(input.historyLowering ? { historyLowering: input.historyLowering } : {}),
      ...(input.requestContext ? { requestContext: input.requestContext } : {}),
      ...(input.contextApplication ? { contextApplication: input.contextApplication } : {}),
      ...(input.treeLeafEntryId === undefined ? {} : { treeLeafEntryId: input.treeLeafEntryId }),
      ...(deps.parentToolUseId ? { parentToolUseId: deps.parentToolUseId } : {}),
    }, dedup);
    starts.set(requestId, performance.now());
    return { requestId, turn: input.turn };
  }

  async function recordDispatch(handle: ProviderRequestAuditHandle): Promise<void> {
    await recordProviderRequestDispatched(audit, {
      requestId: handle.requestId,
      identity: deps.identity,
      turn: handle.turn,
    });
  }

  async function recordResponse(
    handle: ProviderRequestAuditHandle,
    input: Parameters<ProviderRequestAuditWriter["recordResponse"]>[1],
  ): Promise<void> {
    const start = starts.get(handle.requestId);
    starts.delete(handle.requestId);
    // durationMs is monotonic awake time. Across a system sleep it is smaller
    // than the fact's wall-clock span (recorded timestamps keep running while
    // the monotonic clock freezes), and that divergence is the evidence a
    // request straddled a suspend - keep both clocks as they are.
    await recordProviderResponse(audit, {
      requestId: handle.requestId, identity: deps.identity, turn: handle.turn,
      outcome: input.outcome, durationMs: start === undefined ? 0 : Math.round(performance.now() - start),
      ...(input.stopReason ? { stopReason: input.stopReason } : {}),
      ...(input.responseId ? { responseId: input.responseId } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.transportContext ? { transportContext: input.transportContext } : {}),
    });
  }

  async function recordAbandonedResponse(
    handle: ProviderRequestAuditHandle,
    input: {
      outcome: ProviderRequestAuditResponseInput["outcome"];
      error: ProviderRequestAuditResponseInput["error"];
    },
  ): Promise<void> {
    await recordResponse(handle, input);
  }

  async function recordUsage(
    handle: ProviderRequestAuditHandle,
    input: Parameters<ProviderRequestAuditWriter["recordUsage"]>[1],
  ): Promise<void> {
    await recordProviderUsage(audit, {
      requestId: handle.requestId,
      identity: deps.identity,
      turn: handle.turn,
      ...(deps.workflowAttemptId ? { workflowAttemptId: deps.workflowAttemptId } : {}),
      ...(deps.parentToolUseId ? { parentToolUseId: deps.parentToolUseId } : {}),
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadInputTokens: input.cacheReadInputTokens,
      cacheCreationInputTokens: input.cacheCreationInputTokens,
      reasoningTokens: input.reasoningTokens,
      promptTokens: input.promptTokens,
      deltaCostUsd: input.deltaCostUsd,
    });
  }

  function recordStreamStarted(handle: ProviderRequestAuditHandle): void {
    recordProviderStreamStarted(audit, { requestId: handle.requestId, identity: deps.identity, turn: handle.turn });
  }

  function recordStreamEvent(handle: ProviderRequestAuditHandle, input: Parameters<ProviderRequestAuditWriter["recordStreamEvent"]>[1]): void {
    recordProviderStreamEvent(audit, { requestId: handle.requestId, identity: deps.identity, turn: handle.turn, ...input });
  }

  function recordStreamCompleted(handle: ProviderRequestAuditHandle, input: Parameters<ProviderRequestAuditWriter["recordStreamCompleted"]>[1]): void {
    recordProviderStreamCompleted(audit, { requestId: handle.requestId, turn: handle.turn, ...input });
  }

  async function recordStreamSummary(handle: ProviderRequestAuditHandle, input: Omit<ProviderStreamSummary, "requestId" | "identity" | "turn">): Promise<void> {
    await recordProviderStreamSummary(audit, { requestId: handle.requestId, identity: deps.identity, turn: handle.turn, ...input });
  }

  return {
    ...(deps.resolveTreeLeafEntryId ? { captureTreeLeaf: deps.resolveTreeLeafEntryId } : {}),
    recordRequest, recordDispatch, recordResponse, recordAbandonedResponse, recordUsage, recordStreamStarted, recordStreamEvent, recordStreamCompleted, recordStreamSummary };
}
