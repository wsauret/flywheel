import type { StreamTelemetryObserveResult, StreamTelemetrySink, TelemetryFields } from "../types.js";
import type { ThinkingStallError } from "./thinking-stall.js";

/** Counts one provider frame by its kind. `metadata` builds the frame's fields
 *  and runs only when the telemetry records that frame. */
export function observeProviderTelemetry(
  telemetry: StreamTelemetrySink | undefined,
  kind: string | undefined,
  metadata?: () => TelemetryFields,
): StreamTelemetryObserveResult {
  if (!kind) return;
  return telemetry?.observe({ source: "provider", kind, ...(metadata ? { metadata: () => compactMetadata(metadata()) } : {}) });
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
  metadata: TelemetryFields,
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
  summaryChars: number,
): StreamTelemetryObserveResult {
  return telemetry?.observe({
    source: "watchdog",
    kind: "thinking_stall",
    metadata: {
      ...(error.blockKey ? { blockKey: error.blockKey } : {}),
      elapsedMs: Math.round(error.elapsedMs),
      summaryChars,
    },
  });
}

function compactMetadata(metadata: TelemetryFields): TelemetryFields {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}
