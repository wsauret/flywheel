import type { LlmToolOutputPart } from "./llm/tool-output-part-schema.js";
import { InvariantViolation } from "./invariant.js";
import type { RuntimeEvent } from "./runtime-event-types.js";
import { toolOutcomeFromProvider, type ToolOutcome } from "./tool-outcome.js";


interface ToolResultRecord {
  toolUseId: string;
  outcome: ToolOutcome;
  toolOutput: LlmToolOutputPart[] | undefined;
  details?: unknown;
  executionOutputTail?: string;
}

/** Count unique attempted tool calls, including calls rejected before dispatch.
 *  Seed with committed ids when an attempt resumes. Call without an event to read the count. */
export function createToolUseCounter(committedIds: Iterable<string> = []): (event?: RuntimeEvent) => number {
  const ids = new Set(committedIds);
  return (event) => {
    if (event?.type === "tool.input.completed") ids.add(event.data.tool_use.id);
    else if (event?.type === "tool.validation.failed") ids.add(event.data.tool_use_id);
    return ids.size;
  };
}

export function extractToolResultRecords(event: RuntimeEvent): ToolResultRecord[] {
  if (event.type === "tool.result.recorded" || event.type === "tool.result.available") {
    return [toolResultRecord(event.data)];
  }

  if (event.type !== "model.user_message.recorded") return [];

  const content = event.data.message?.content;
  if (!Array.isArray(content)) return [];

  const records: ToolResultRecord[] = [];
  for (const item of content) {
    if (item.type !== "tool.result.recorded") continue;
    records.push(toolResultRecord(item));
  }
  return records;
}

function toolResultRecord(data: {
  tool_use_id?: string;
  is_error?: boolean;
  content?: LlmToolOutputPart[];
  interrupted?: boolean;
  outcome?: ToolOutcome;
  details?: unknown;
  execution_output_tail?: string;
}): ToolResultRecord {
  if (typeof data.tool_use_id !== "string" || data.tool_use_id.length === 0) {
    throw new InvariantViolation({
      kind: "schema-mismatch",
      eventType: "tool.result.recorded",
      eventPosition: -1,
      aggregateId: "",
      detail: `tool_result missing tool_use_id (got ${JSON.stringify(data.tool_use_id)})`,
    });
  }
  return {
    toolUseId: data.tool_use_id,
    outcome: data.outcome ?? toolOutcomeFromProvider(data.is_error, data.interrupted),
    toolOutput: data.content,
    ...(data.details != null ? { details: data.details } : {}),
    ...(data.execution_output_tail !== undefined ? { executionOutputTail: data.execution_output_tail } : {}),
  };
}
