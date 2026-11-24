import { assertNever } from "../../../../infra/assert-never.js";
import { maxEventLoopLagBetween } from "../../../../infra/event-loop-lag.js";
import { DebugLog } from "../../../../infra/debug-log.js";
import type { ProviderRequestOutcome, ProviderStreamSummary } from "../../../session/runtime-facts/provider-request-audit-types.js";
import type { ProviderStreamEvent, StreamTelemetryObservation, StreamTelemetryObserveResult, StreamTelemetrySink, TelemetryFields } from "../../llm/types.js";
import type { ProviderRequestAuditHandle, ProviderRequestAuditWriter } from "../../llm/provider-request-audit.js";
import { createGenerationMeasurement, type GenerationMeasurementTokenizer, type SettledTextOf } from "./generation-measurement.js";

interface NumberByKey {
  [key: string]: number;
}

const RAW_STREAM_RECENT_EVENT_LIMIT = 500;
const RAW_STREAM_SAMPLE_EVERY = 50;
const STREAM_SUMMARY_VISIBLE_DELTA_KINDS = new Set(["thinking_delta", "text_delta", "tool_input_delta"]);
const RAW_STREAM_ALWAYS_KEEP_KINDS = new Set([
  "provider_response_started",
  "stream_attempt_start",
  "stream_retry",
  "timeout",
  "stall",
  "thinking_stall",
  "context_update",
  "tool_input_start",
  "tool_use",
  "thinking_complete",
  "text_complete",
  "usage",
  "done",
]);
const BIG_GAP_MS = 5_000;

interface RequestStreamTelemetry extends StreamTelemetrySink {
  /** Counts one canonical stream event. It returns a promise only when the debug tier records the event and its
   *  writer acknowledges asynchronously; otherwise it is synchronous. */
  observeNormalized(event: ProviderStreamEvent): StreamTelemetryObserveResult;
  /** Records the stream summary once. `textOf` reads the settled text of each streamed text block. */
  complete(outcome: ProviderRequestOutcome, textOf: SettledTextOf): Promise<void>;
}

// Stream telemetry is raw audit data. It records provider/normalized facts for
// writer/projection consumers only; presentation-filtered UI updates are emitted
// from the session layer.
export function createRequestStreamTelemetry(
  writer: ProviderRequestAuditWriter | undefined,
  handle: ProviderRequestAuditHandle | undefined,
  tokenizer?: GenerationMeasurementTokenizer,
): RequestStreamTelemetry | undefined {
  return writer && handle ? createTelemetry(writer, handle, tokenizer) : undefined;
}

function createTelemetry(writer: ProviderRequestAuditWriter, handle: ProviderRequestAuditHandle, tokenizer?: GenerationMeasurementTokenizer): RequestStreamTelemetry {
  const generation = createGenerationMeasurement(tokenizer);
  // Resolved once per request: with the raw event family's tier off, an event
  // updates the summary's counters and builds no record.
  const recordsEvents = DebugLog.records("model.stream.event_observed");
  const startedAt = performance.now();
  const startedWallAt = Date.now();
  let previousAt = startedAt;
  let sequence = 0;
  let rawStored = 0;
  let lastEventKind: string | undefined;
  let completed = false;
  const countsBySource = new Map<string, number>();
  const countsByKind = new Map<string, number>();
  let firstVisibleDeltaMs: number | undefined;
  let previousVisibleDelta: { readonly elapsedMs: number; readonly kind: string } | undefined;
  const interDeltaGaps: number[] = [];
  const watchdogStalls: number[] = [];
  const bigGapTransitions = new Map<string, number>();
  let streamRetryCount = 0;
  let reasoningDisabledRetryCount = 0;
  const pendingStart = Promise.resolve(writer.recordStreamStarted(handle));

  function observe(observation: StreamTelemetryObservation): StreamTelemetryObserveResult {
    if (completed) return;
    const now = performance.now();
    sequence++;
    lastEventKind = observation.kind;
    const elapsedMs = Math.round(now - startedAt);
    const sincePreviousMs = Math.round(now - previousAt);
    previousAt = now;
    increment(countsBySource, observation.source);
    increment(countsByKind, observation.kind);
    if (observation.source === "watchdog" && observation.kind === "thinking_stall") {
      watchdogStalls.push(stallDurationMs(fieldsOf(observation), sincePreviousMs));
    }
    if (observation.source === "normalized" && STREAM_SUMMARY_VISIBLE_DELTA_KINDS.has(observation.kind)) {
      firstVisibleDeltaMs ??= elapsedMs;
      if (previousVisibleDelta) {
        const gap = Math.max(0, elapsedMs - previousVisibleDelta.elapsedMs);
        interDeltaGaps.push(gap);
        if (gap >= BIG_GAP_MS) increment(bigGapTransitions, `${previousVisibleDelta.kind}->${observation.kind}`);
      }
      previousVisibleDelta = { elapsedMs, kind: observation.kind };
    }
    if (!recordsEvents || !shouldRecordRaw(observation.kind, sequence, rawStored)) return;
    rawStored++;
    return writer.recordStreamEvent(handle, {
      sequence,
      source: observation.source,
      kind: observation.kind,
      elapsedMs,
      sincePreviousMs,
      metadata: fieldsOf(observation),
    });
  }

  function observeNormalized(event: ProviderStreamEvent): StreamTelemetryObserveResult {
    if (completed) return;
    generation.observe(event, performance.now());
    if (event.kind === "stream_retry") streamRetryCount += 1;
    if (event.kind === "stream_attempt_start" && event.disableReasoning) reasoningDisabledRetryCount += 1;
    return observe({ source: "normalized", kind: event.kind, metadata: () => normalizedMetadata(event) });
  }

  async function complete(outcome: ProviderRequestOutcome, textOf: SettledTextOf): Promise<void> {
    if (completed) return;
    completed = true;
    const completedAt = Date.now();
    const durationMs = Math.round(performance.now() - startedAt);
    const loopLagMs = maxEventLoopLagBetween(startedAt, performance.now());
    const measurement = await generation.complete(textOf);
    await pendingStart;
    await writer.recordStreamSummary?.(handle, {
      rawEventCount: sequence,
      generation: measurement,
      startedAt: startedWallAt,
      completedAt,
      durationMs,
      outcome,
      ...(lastEventKind ? { lastEventKind } : {}),
      countsBySource: sortedRecord(countsBySource),
      countsByKind: sortedRecord(countsByKind),
      ...(firstVisibleDeltaMs === undefined ? {} : { firstVisibleDeltaMs }),
      loopLagMs,
      interDelta: summarizeInterDelta(interDeltaGaps),
      watchdog: {
        thinkingStallCount: watchdogStalls.length,
        ...(watchdogStalls.length > 0 ? { maxStallMs: Math.max(...watchdogStalls) } : {}),
      },
      recovery: { streamRetryCount, reasoningDisabledRetryCount },
      bigGapTransitions: [...bigGapTransitions.entries()]
        .map(([transition, count]) => ({ transition, count }))
        .sort((a, b) => a.transition.localeCompare(b.transition)),
    });
    await writer.recordStreamCompleted(handle, {
      durationMs,
      eventCount: sequence,
      outcome,
      ...(lastEventKind ? { lastEventKind } : {}),
      stallCount: watchdogStalls.length,
    });
  }

  return { observe, observeNormalized, complete };
}

/** A copy of the observation's fields, built at most once per recorded observation. */
function fieldsOf(observation: StreamTelemetryObservation): TelemetryFields {
  const { metadata } = observation;
  if (metadata === undefined) return {};
  return typeof metadata === "function" ? metadata() : { ...metadata };
}

type BasicMetadataEvent = Extract<ProviderStreamEvent, {
  kind:
    | "provider_response_started"
    | "text_delta"
    | "text_terminal"
    | "thinking_delta"
    | "text_complete"
    | "thinking_complete"
    | "reasoning"
    | "usage"
    | "context_update"
    | "done";
}>;
type ToolMetadataEvent = Extract<ProviderStreamEvent, { kind: "tool_input_start" | "tool_input_delta" | "tool_use" }>;
type NoticeMetadataEvent = Extract<ProviderStreamEvent, { kind: "provider_status" }>;
type RetryMetadataEvent = Extract<ProviderStreamEvent, { kind: "stream_attempt_start" | "stream_retry" | "stream_resample" }>;

function normalizedMetadata(event: ProviderStreamEvent): TelemetryFields {
  if (isBasicMetadataEvent(event)) return basicMetadata(event);
  if (isToolMetadataEvent(event)) return toolMetadata(event);
  if (isNoticeMetadataEvent(event)) return noticeMetadata(event);
  if (isRetryMetadataEvent(event)) return retryMetadata(event);
  if (event.kind === "transport_context") {
    return { identity: event.context.identity, additions: event.context.additions.length, hiddenRequests: event.context.hiddenRequests.length };
  }
  return assertNever(event);
}

function isBasicMetadataEvent(event: ProviderStreamEvent): event is BasicMetadataEvent {
  switch (event.kind) {
    case "provider_response_started":
    case "text_delta":
    case "text_terminal":
    case "thinking_delta":
    case "text_complete":
    case "thinking_complete":
    case "reasoning":
    case "usage":
    case "context_update":
    case "done":
      return true;
    default:
      return false;
  }
}

function isToolMetadataEvent(event: ProviderStreamEvent): event is ToolMetadataEvent {
  return event.kind === "tool_input_start" || event.kind === "tool_input_delta" || event.kind === "tool_use";
}

function isNoticeMetadataEvent(event: ProviderStreamEvent): event is NoticeMetadataEvent {
  return event.kind === "provider_status";
}

function isRetryMetadataEvent(event: ProviderStreamEvent): event is RetryMetadataEvent {
  return event.kind === "stream_attempt_start" || event.kind === "stream_retry" || event.kind === "stream_resample";
}

function basicMetadata(event: BasicMetadataEvent): TelemetryFields {
  switch (event.kind) {
    case "provider_response_started":
    case "text_complete":
      return {};
    case "text_delta":
      return { text: summarizeText(event.text), ...(event.signature ? { hasSignature: true } : {}) };
    case "text_terminal":
      return { text: summarizeText(event.content), ...(event.signature ? { hasSignature: true } : {}) };
    case "thinking_delta":
      return { text: summarizeText(event.text), ...(event.estimatedTokens !== undefined ? { estimatedTokens: event.estimatedTokens } : {}) };
    case "thinking_complete":
      return {
        thinking: summarizeText(event.thinking),
        hasSignature: Boolean(event.signature),
        ...(event.redacted ? { redacted: true } : {}),
      };
    case "reasoning":
      return {
        id: event.id,
        encryptedBytes: Buffer.byteLength(event.encryptedContent, "utf8"),
        hasSummary: Boolean(event.summary?.length),
      };
    case "usage":
      return {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreateTokens: event.cacheCreateTokens,
        reasoningTokens: event.reasoningTokens,
      };
    case "context_update":
      return { promptTokens: event.promptTokens, contextWindow: event.contextWindow };
    case "done":
      return {
        stopReason: event.stopReason,
        ...(event.metadata?.responseId ? { responseId: event.metadata.responseId } : {}),
        ...(event.metadata?.provider ? { provider: event.metadata.provider } : {}),
        ...(event.metadata?.model ? { model: event.metadata.model } : {}),
      };
    default:
      return assertNever(event);
  }
}

function toolMetadata(event: ToolMetadataEvent): TelemetryFields {
  switch (event.kind) {
    case "tool_input_start":
      return { toolUseId: event.toolUseId, name: event.name };
    case "tool_input_delta":
      return { toolUseId: event.toolUseId, partialJson: summarizeText(event.partialJson) };
    case "tool_use":
      return {
        toolUseId: event.toolCall.id,
        name: event.toolCall.name,
        input: summarizeText(stringify(event.toolCall.input)),
        ...(event.toolCall.providerItemId ? { providerItemId: event.toolCall.providerItemId } : {}),
        ...(event.toolCall.providerCallId ? { providerCallId: event.toolCall.providerCallId } : {}),
        ...(event.toolCall.thoughtSignature ? { hasThoughtSignature: true } : {}),
      };
    default:
      return assertNever(event);
  }
}

function noticeMetadata(event: NoticeMetadataEvent): TelemetryFields {
  return {
    message: summarizeText(event.message),
    ...(event.level ? { level: event.level } : {}),
  };
}

function retryMetadata(event: RetryMetadataEvent): TelemetryFields {
  switch (event.kind) {
    case "stream_attempt_start":
      return { disableReasoning: event.disableReasoning };
    case "stream_retry":
      return {
        attempt: event.attempt,
        reason: summarizeText(event.reason),
        delayMs: Math.round(event.delayMs),
        error: event.error,
        ...(event.thinkingStall ? { thinkingStall: event.thinkingStall } : {}),
      };
    case "stream_resample":
      return { attempt: event.attempt, maxAttempts: event.maxAttempts };
    default:
      return assertNever(event);
  }
}

function shouldRecordRaw(kind: string, sequence: number, rawStored: number): boolean {
  if (rawStored < RAW_STREAM_RECENT_EVENT_LIMIT) return true;
  if (RAW_STREAM_ALWAYS_KEEP_KINDS.has(kind)) return true;
  return sequence % RAW_STREAM_SAMPLE_EVERY === 0;
}

function summarizeInterDelta(
  gaps: number[],
): ProviderStreamSummary["interDelta"] {
  if (gaps.length === 0) return { count: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0, ge1s: 0, ge2s: 0, ge5s: 0, ge10s: 0 };
  const sorted = gaps.sort((a, b) => a - b);
  return {
    count: sorted.length,
    meanMs: sorted.reduce((acc, value) => acc + value, 0) / sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
    ge1s: sorted.filter((value) => value >= 1_000).length,
    ge2s: sorted.filter((value) => value >= 2_000).length,
    ge5s: sorted.filter((value) => value >= 5_000).length,
    ge10s: sorted.filter((value) => value >= 10_000).length,
  };
}

function stallDurationMs(fields: TelemetryFields, sincePreviousMs: number): number {
  const elapsedMs = fields.elapsedMs;
  return typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? elapsedMs : sincePreviousMs;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedRecord(map: ReadonlyMap<string, number>): NumberByKey {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
}

/** The size and hash of a stream's text, never the text: conversation
 *  content lives in the event store, and the hash tells two events apart. */
function summarizeText(text: string): TelemetryFields {
  return {
    chars: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
    xxhash32: Bun.hash.xxHash32(text, 0).toString(16),
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
