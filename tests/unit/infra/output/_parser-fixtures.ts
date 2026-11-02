import type { ContentBlock } from "../../../../src/infra/runtime-content-blocks";
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types";

export function makeAssistantEvent(content: ContentBlock[], parentToolUseId?: string, entryId: string = crypto.randomUUID()): RuntimeEvent {
  return {
    type: "model.assistant_message.recorded",
    data: {
      type: "model.assistant_message.recorded",
      entry_id: entryId,
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      message: { content },
    },
  };
}

export function makeToolResultEvent(toolUseId: string, opts?: { is_error?: boolean; content?: string }): RuntimeEvent {
  return {
    type: "tool.result.recorded",
    data: {
      type: "tool.result.recorded",
      tool_use_id: toolUseId,
      is_error: opts?.is_error ?? false,
      content: [{ type: "text", text: opts?.content ?? "done" }],
    },
  };
}

export function makeToolResultAckEvent(toolUseId: string): RuntimeEvent {
  return createRuntimeEvent("tool.result.acknowledged", {
    type: "tool.result.acknowledged",
    tool_use_id: toolUseId,
  });
}

export function makeAgentDispatchedEvent(toolUseId: string): RuntimeEvent {
  return createRuntimeEvent("agent.subagent.dispatched", {
    type: "agent.subagent.dispatched",
    tool_use_id: toolUseId,
  });
}

export function makeUserToolResultEvent(toolResults: Array<{
  tool_use_id: string;
  is_error?: boolean;
  interrupted?: boolean;
  content?: string;
}>): RuntimeEvent {
  return {
    type: "model.user_message.recorded",
    data: {
      type: "model.user_message.recorded",
      message: {
        content: toolResults.map(r => ({
          type: "tool.result.recorded" as const,
          tool_use_id: r.tool_use_id,
          is_error: r.is_error ?? false,
          interrupted: r.interrupted,
          content: [{ type: "text" as const, text: r.content ?? "done" }],
        })),
      },
    },
  };
}
