import type { NDJSONEvent } from "../../../infra/subprocess-types.js";
import { extractToolUseRecords, extractToolResultRecord } from "./ndjson-tool-events.js";
import type { EmitFn } from "../../../infra/event-bus.js";
import { truncateField } from "../../../infra/trace-types.js";

const SUBAGENT_TOOL_NAMES = new Set(["Task", "dispatch_agent"]);

const MAX_FIELD_BYTES = 4096;

interface TraceEventHandlerDeps {
  emit: EmitFn;
  workflowId: string;
}

export interface TraceEventHandler {
  handleEvent(event: NDJSONEvent): void;
}

export function createTraceEventHandler(deps: TraceEventHandlerDeps): TraceEventHandler {
  const { emit, workflowId } = deps;

  // Track which toolUseIds are subagents for matching tool_result events
  const subagentToolUseIds = new Set<string>();

  function handleEvent(event: NDJSONEvent): void {
    const wfId = workflowId;

    for (const record of extractToolUseRecords(event)) {
      const rawInput = truncateField(record.toolInput, MAX_FIELD_BYTES);

      if (SUBAGENT_TOOL_NAMES.has(record.toolName)) {
        subagentToolUseIds.add(record.toolUseId);
        const input = record.toolInput as Record<string, unknown> | undefined;
        const description = String(input?.description ?? input?.task ?? record.toolName);
        const prompt = truncateField(input?.prompt ?? input?.task ?? "", MAX_FIELD_BYTES);
        emit("trace:subagent-started", { workflowId: wfId, toolUseId: record.toolUseId, agentType: record.toolName, description, prompt });
      } else {
        emit("trace:tool-started", { workflowId: wfId, toolUseId: record.toolUseId, toolName: record.toolName, toolInput: rawInput });
      }
    }

    const result = extractToolResultRecord(event);
    if (result) {
      const rawOutput = truncateField(result.toolOutput, MAX_FIELD_BYTES);

      if (subagentToolUseIds.has(result.toolUseId)) {
        subagentToolUseIds.delete(result.toolUseId);
        emit("trace:subagent-completed", { workflowId: wfId, toolUseId: result.toolUseId, result: rawOutput, isError: result.isError });
      } else {
        emit("trace:tool-completed", { workflowId: wfId, toolUseId: result.toolUseId, toolOutput: rawOutput, isError: result.isError });
      }
    }
  }

  return { handleEvent };
}
