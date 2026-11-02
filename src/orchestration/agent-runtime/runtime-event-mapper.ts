import type { RuntimeEvent } from "../../infra/runtime-event-types.js";
import { extractToolResultRecords } from "../../infra/runtime-tool-records.js";
import type { AgentStreamEvent } from "./types.js";

/** The stream events that observers read from one runtime event. Most runtime
 *  events, such as every streamed delta, map to none, so an observer chain
 *  does no work for them. */
export function mapRuntimeEventToAgentStreamEvents(event: RuntimeEvent): AgentStreamEvent[] {
  const toolResults = extractToolResultRecords(event);
  if (toolResults.length > 0) {
    return toolResults.map((toolResult) => ({ type: "tool_result", toolUseId: toolResult.toolUseId, outcome: toolResult.outcome }));
  }

  if (event.type === "tool.input.completed") {
    const { tool_use } = event.data;
    return [{ type: "tool_use", toolUseId: tool_use.id, toolName: tool_use.name, toolInput: { ...tool_use.input } }];
  }

  if (event.type === "model.assistant_message.recorded") {
    // tool_use blocks on assistant messages are the streaming placeholders
    // emitted at tool_input_start with input: {} (runner-stream-events.ts);
    // the real arguments arrive as tool.input.completed, mapped above.
    // Mapping the placeholder would collapse every call of a tool to one
    // empty signature and false-positive the repetition guard on any run
    // of same-tool calls with different arguments.
    const content = event.data.message?.content;
    return Array.isArray(content) && content.some((block) => block.type === "text") ? [{ type: "text" }] : [];
  }

  if (event.type === "model.turn.completed") {
    return [{ type: "result" }];
  }

  return [];
}
