import type { StreamTelemetryObserveResult, StreamTelemetrySink } from "./types.js";
import type { ThinkingStallError } from "./thinking-stall.js";

interface UnknownFields { [key: string]: unknown }

export function observeProviderTelemetry(
  telemetry: StreamTelemetrySink | undefined,
  kind: string | undefined,
  metadata: UnknownFields = {},
): StreamTelemetryObserveResult {
  if (!kind) return;
  return telemetry?.observe({ source: "provider", kind, metadata: compactMetadata(metadata) });
}

export function observeWatchdogStall(
  telemetry: StreamTelemetrySink | undefined,
  event: { lastChunkAgeMs: number; idleDeadlineMs: number; thresholdMs: number },
): StreamTelemetryObserveResult {
  return telemetry?.observe({
    source: "watchdog",
    kind: "stall",
    metadata: event,
  });
}

export function observeWatchdogTimeout(
  telemetry: StreamTelemetrySink | undefined,
  metadata: UnknownFields,
): StreamTelemetryObserveResult {
  return telemetry?.observe({
    source: "watchdog",
    kind: "timeout",
    metadata: compactMetadata(metadata),
  });
}

export function observeThinkingStall(
  telemetry: StreamTelemetrySink | undefined,
  error: ThinkingStallError,
): StreamTelemetryObserveResult {
  return telemetry?.observe({
    source: "watchdog",
    kind: "thinking_stall",
    metadata: {
      ...(error.blockKey ? { blockKey: error.blockKey } : {}),
      elapsedMs: Math.round(error.elapsedMs),
      summaryChars: error.summary.length,
    },
  });
}

function compactMetadata(metadata: UnknownFields): UnknownFields {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}
