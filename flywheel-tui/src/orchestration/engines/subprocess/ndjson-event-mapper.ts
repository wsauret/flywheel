/**
 * NDJSON-to-EngineEvent mapper.
 *
 * Converts NDJSONEvent (subprocess-specific) to EngineEvent (engine-agnostic)
 * for consumption by stream observers.
 */

import type { NDJSONEvent } from "./ndjson-parser.js";
import type { EngineEvent } from "../stream-observers.js";
import { extractToolUseRecords, extractToolResultRecord } from "./ndjson-tool-events.js";

/**
 * Map a single NDJSONEvent to one or more EngineEvents.
 * Returns an array because one assistant NDJSON event can contain multiple tool_use blocks.
 */
export function mapNDJSONToEngineEvents(event: NDJSONEvent): EngineEvent[] {
  // tool_result events
  const toolResult = extractToolResultRecord(event);
  if (toolResult) {
    return [{ type: "tool_result", isError: toolResult.isError }];
  }

  // assistant events — may contain tool_use blocks, text, or both
  if (event.type === "assistant") {
    const toolUseRecords = extractToolUseRecords(event);
    if (toolUseRecords.length > 0) {
      return toolUseRecords.map((rec) => ({
        type: "tool_use" as const,
        toolName: rec.toolName,
        toolInput: (rec.toolInput as Record<string, unknown>) ?? {},
      }));
    }

    // Assistant with content but no tool_use blocks → text event
    const rawMessage = event.data.message;
    const message = typeof rawMessage === "object" && rawMessage !== null
      ? (rawMessage as Record<string, unknown>)
      : undefined;
    const content = message?.content;
    if (Array.isArray(content) && content.length > 0) {
      return [{ type: "text" }];
    }

    // Assistant with no meaningful content
    return [{ type: "other" }];
  }

  // result events
  if (event.type === "result") {
    return [{ type: "result" }];
  }

  // Everything else (system, user, step_finish, error, unknown, etc.)
  return [{ type: "other" }];
}
