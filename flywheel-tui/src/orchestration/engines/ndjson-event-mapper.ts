import type { NDJSONEvent } from "../../infra/ndjson-event-types.js";
import type { EngineEvent } from "./core/types.js";
import { extractToolUseRecords, extractToolResultRecord } from "./ndjson-tool-events.js";

export function mapNDJSONToEngineEvents(event: NDJSONEvent): EngineEvent[] {
  const toolResult = extractToolResultRecord(event);
  if (toolResult) {
    return [{ type: "tool_result", isError: toolResult.isError }];
  }

  if (event.type === "assistant") {
    const toolUseRecords = extractToolUseRecords(event);
    if (toolUseRecords.length > 0) {
      return toolUseRecords.map((rec) => ({
        type: "tool_use" as const,
        toolName: rec.toolName,
        toolInput: (rec.toolInput as Record<string, unknown>) ?? {},
      }));
    }

    const content = event.data.message?.content;
    if (Array.isArray(content) && content.length > 0) {
      return [{ type: "text" }];
    }

    return [{ type: "other" }];
  }

  if (event.type === "result") {
    return [{ type: "result" }];
  }

  return [{ type: "other" }];
}
