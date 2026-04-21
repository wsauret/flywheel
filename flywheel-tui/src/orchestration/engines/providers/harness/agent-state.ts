/**
 * Agent loop state types and message history management.
 *
 * The NextInput union represents every possible reason for the next
 * user message in the conversation. Each variant carries exactly the
 * data needed to render that turn's prompt.
 */

import type { Message, ContentBlock } from "./llm/types.js";
import type { Handoff } from "./context/summarizer.js";

export type NextInput =
  | { kind: "initial"; text: string }
  | { kind: "observation"; toolResults: ToolResultEntry[] }
  | { kind: "recovered"; handoff: string }
  | { kind: "resume-truncation" };

export interface ToolResultEntry {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export function renderNextInput(input: NextInput): string | ContentBlock[] {
  switch (input.kind) {
    case "initial":
      return input.text;
    case "observation":
      return input.toolResults.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.toolCallId,
        content: r.content,
        ...(r.isError ? { is_error: true } : {}),
      }));
    case "recovered":
      return input.handoff;
    case "resume-truncation":
      return "Your previous response was cut off at the output-length limit. Continue from where you stopped.";
  }
}

export function applyHandoff(messages: Message[], handoff: Handoff): void {
  messages.splice(0, messages.length, ...handoff.messages);
}
