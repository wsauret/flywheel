/**
 * Agent loop state helpers. The conversation's `messages` array is the
 * authoritative state — this module just provides the two shape transforms
 * the loop needs: rendering tool results as user content, and replacing the
 * history wholesale during a handoff.
 */

import type { Message, ContentBlock } from "./llm/types.js";
import type { Handoff } from "./context/summarizer.js";

export interface ToolResultEntry {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export function renderToolResults(results: ReadonlyArray<ToolResultEntry>): ContentBlock[] {
  return results.map((r) => ({
    type: "tool_result" as const,
    tool_use_id: r.toolCallId,
    content: r.content,
    ...(r.isError ? { is_error: true } : {}),
  }));
}

export function applyHandoff(messages: Message[], handoff: Handoff): void {
  messages.splice(0, messages.length, ...handoff.messages);
}

/** Append text into the trailing text block, or push a new block if none. */
export function appendTextBlock(blocks: ContentBlock[], text: string): void {
  const last = blocks[blocks.length - 1];
  if (last?.type === "text") {
    last.text += text;
  } else {
    blocks.push({ type: "text", text });
  }
}
