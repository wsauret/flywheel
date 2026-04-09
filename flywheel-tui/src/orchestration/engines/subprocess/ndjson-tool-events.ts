/**
 * NDJSON Tool Event Parser
 *
 * Extracts tool_use and tool_result records from Claude's NDJSON stream.
 * Shared by chat-tracing (TraceCollector) and trace-event-handler (EmitFn).
 */

import type { NDJSONEvent } from "./ndjson-parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolUseRecord {
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
}

export interface ToolResultRecord {
  toolUseId: string;
  isError: boolean;
  toolOutput: unknown;
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/**
 * Extract tool_use records from an assistant NDJSON event.
 * Returns an empty array for non-assistant events or events without tool_use blocks.
 */
export function extractToolUseRecords(event: NDJSONEvent): ToolUseRecord[] {
  if (event.type !== "assistant") return [];

  const message = event.data.message as Record<string, unknown> | undefined;
  if (!message) return [];

  const content = message.content;
  if (!Array.isArray(content)) return [];

  const records: ToolUseRecord[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typedBlock = block as Record<string, unknown>;
    if (typedBlock.type !== "tool_use") continue;

    records.push({
      toolUseId: String(typedBlock.id ?? ""),
      toolName: String(typedBlock.name ?? ""),
      toolInput: typedBlock.input,
    });
  }
  return records;
}

/**
 * Extract a tool_result record from a tool_result NDJSON event.
 * Returns null for non-tool_result events.
 */
export function extractToolResultRecord(event: NDJSONEvent): ToolResultRecord | null {
  if (event.type !== "tool_result") return null;

  return {
    toolUseId: String(event.data.tool_use_id ?? ""),
    isError: Boolean(event.data.is_error),
    toolOutput: event.data.content ?? "",
  };
}
