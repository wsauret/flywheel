/**
 * Chat Tracing — feeds NDJSON events from chat sessions into a TraceCollector.
 *
 * Chat mode doesn't use an EventBus, so we detect tool_use / tool_result
 * events directly from the NDJSON stream and call TraceCollector.startSpan /
 * endSpan. This mirrors the detection logic in TraceEventHandler but skips
 * the EventBus intermediary.
 *
 * Extracted as a standalone function for testability — chat-session.ts calls this
 * from its ndjsonParser.onEvent handler.
 */

import type { NDJSONEvent } from "./engines/subprocess/ndjson-parser";
import { extractToolUseRecords, extractToolResultRecord } from "./engines/subprocess/ndjson-tool-events";
import type { TraceCollector } from "./session/trace-collector";

/**
 * Process a single NDJSON event for trace collection.
 *
 * - assistant events with tool_use blocks → startSpan("tool_call", ...)
 * - tool_result events → endSpan(...) for the matching tool_use
 *
 * @param toolSpanMap Caller-owned Map<toolUseId, spanId> for tracking open tool spans.
 */
export function feedChatEventToTrace(
  event: NDJSONEvent,
  collector: TraceCollector,
  toolSpanMap: Map<string, string>,
): void {
  for (const record of extractToolUseRecords(event)) {
    const spanId = collector.startSpan("tool_call", record.toolName, {
      toolName: record.toolName,
      toolInput: record.toolInput,
    });
    toolSpanMap.set(record.toolUseId, spanId);
  }

  const result = extractToolResultRecord(event);
  if (result) {
    const spanId = toolSpanMap.get(result.toolUseId);
    if (!spanId) return;

    collector.endSpan(
      spanId,
      { toolOutput: result.toolOutput, isError: result.isError },
      result.isError ? "error" : "ok",
      result.isError ? { message: "tool returned error" } : undefined,
    );
    toolSpanMap.delete(result.toolUseId);
  }
}
