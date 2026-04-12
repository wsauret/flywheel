/**
 * Trace Event Handler — converts NDJSONEvents into trace FlywheelEvents.
 *
 * Receives NDJSONEvent objects from the NDJSON parser pipeline (same
 * interface as BudgetTracker.handleEvent) and emits trace-specific
 * FlywheelEvents via the EmitFn.
 *
 * Detection heuristics:
 * - tool_use blocks with name "Task" or "dispatch_agent" → subagent events
 * - All other tool_use blocks → tool events
 * - tool_result events are matched to their originating tool_use via toolUseId
 *
 * Single-threaded assumption: same as BudgetTracker.
 */

import type { NDJSONEvent } from "../../../infra/subprocess-types";
import { extractToolUseRecords, extractToolResultRecord } from "./ndjson-tool-events";
import type { EmitFn } from "../../../infra/event-bus";
import { truncateField } from "../../../infra/trace-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool names that indicate a subagent spawn rather than a simple tool call. */
const SUBAGENT_TOOL_NAMES = new Set(["Task", "dispatch_agent"]);

/** Max bytes for truncated fields in trace events. */
const MAX_FIELD_BYTES = 4096;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceEventHandlerDeps {
  emit: EmitFn;
  workflowId: string;
}

export interface TraceEventHandler {
  /** Handle a single NDJSONEvent — same signature as BudgetTracker.handleEvent. */
  handleEvent(event: NDJSONEvent): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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
