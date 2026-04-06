/**
 * Chat Tracing — feeds NDJSON events from chat sessions into a TraceCollector.
 *
 * Chat mode doesn't use an EventBus, so we detect tool_use / tool_result
 * events directly from the NDJSON stream and call TraceCollector.startSpan /
 * endSpan. This mirrors the detection logic in TraceEventHandler but skips
 * the EventBus intermediary.
 *
 * Extracted as a standalone function for testability — chat.ts calls this
 * from its ndjsonParser.onEvent handler.
 */

import type { NDJSONEvent } from "../orchestration/engines/subprocess/ndjson-parser";
import type { TraceCollector } from "../orchestration/session/trace-collector";

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
  if (event.type === "assistant") {
    handleAssistantEvent(event, collector, toolSpanMap);
  } else if (event.type === "tool_result") {
    handleToolResultEvent(event, collector, toolSpanMap);
  }
}

function handleAssistantEvent(
  event: NDJSONEvent,
  collector: TraceCollector,
  toolSpanMap: Map<string, string>,
): void {
  const message = event.data.message as Record<string, unknown> | undefined;
  if (!message) return;

  const content = message.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type !== "tool_use") continue;

    const toolUseId = String(typedBlock.id ?? "");
    const toolName = String(typedBlock.name ?? "");
    const toolInput = typedBlock.input;

    const spanId = collector.startSpan("tool_call", toolName, {
      toolName,
      toolInput,
    });
    toolSpanMap.set(toolUseId, spanId);
  }
}

function handleToolResultEvent(
  event: NDJSONEvent,
  collector: TraceCollector,
  toolSpanMap: Map<string, string>,
): void {
  const toolUseId = String(event.data.tool_use_id ?? "");
  const spanId = toolSpanMap.get(toolUseId);
  if (!spanId) return;

  const isError = Boolean(event.data.is_error);
  const toolOutput = event.data.content ?? "";

  collector.endSpan(
    spanId,
    { toolOutput, isError },
    isError ? "error" : "ok",
    isError ? { message: "tool returned error" } : undefined,
  );
  toolSpanMap.delete(toolUseId);
}
