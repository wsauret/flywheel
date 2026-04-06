/**
 * Trace Event Handler — converts NDJSONEvents into trace FlywheelEvents.
 *
 * Receives NDJSONEvent objects from the NDJSON parser pipeline (same
 * interface as BudgetTracker.handleEvent) and emits trace-specific
 * FlywheelEvents via the FlywheelEmitter.
 *
 * Detection heuristics:
 * - tool_use blocks with name "Task" or "dispatch_agent" → subagent events
 * - All other tool_use blocks → tool events
 * - tool_result events are matched to their originating tool_use via toolUseId
 *
 * Single-threaded assumption: same as BudgetTracker.
 */

import type { NDJSONEvent } from "./ndjson-parser";
import type { FlywheelEmitter } from "../../../infra/event-bus";
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
  emitter: FlywheelEmitter;
  workflowIdRef: { current: string };
}

export interface TraceEventHandler {
  /** Handle a single NDJSONEvent — same signature as BudgetTracker.handleEvent. */
  handleEvent(event: NDJSONEvent): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTraceEventHandler(deps: TraceEventHandlerDeps): TraceEventHandler {
  const { emitter, workflowIdRef } = deps;

  // Track which toolUseIds are subagents for matching tool_result events
  const subagentToolUseIds = new Set<string>();

  function handleEvent(event: NDJSONEvent): void {
    const wfId = workflowIdRef.current;

    if (event.type === "assistant") {
      handleAssistantEvent(event, wfId);
    } else if (event.type === "tool_result") {
      handleToolResultEvent(event, wfId);
    }
  }

  function handleAssistantEvent(event: NDJSONEvent, wfId: string): void {
    // Extract content blocks from assistant message
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
      const rawInput = truncateField(typedBlock.input, MAX_FIELD_BYTES);

      if (SUBAGENT_TOOL_NAMES.has(toolName)) {
        subagentToolUseIds.add(toolUseId);
        // Extract description/prompt from input for subagent spans
        const input = typedBlock.input as Record<string, unknown> | undefined;
        const description = String(input?.description ?? input?.task ?? toolName);
        const prompt = truncateField(input?.prompt ?? input?.task ?? "", MAX_FIELD_BYTES);
        emitter.traceSubagentStarted(wfId, toolUseId, toolName, description, prompt);
      } else {
        emitter.traceToolStarted(wfId, toolUseId, toolName, rawInput);
      }
    }
  }

  function handleToolResultEvent(event: NDJSONEvent, wfId: string): void {
    const toolUseId = String(event.data.tool_use_id ?? "");
    const isError = Boolean(event.data.is_error);
    const rawOutput = truncateField(event.data.content ?? "", MAX_FIELD_BYTES);

    if (subagentToolUseIds.has(toolUseId)) {
      subagentToolUseIds.delete(toolUseId);
      emitter.traceSubagentCompleted(wfId, toolUseId, rawOutput, isError);
    } else {
      emitter.traceToolCompleted(wfId, toolUseId, rawOutput, isError);
    }
  }

  return { handleEvent };
}
