/**
 * Running token counter for harness context management.
 *
 * Uses a ~4 chars/token heuristic. Only used to decide WHEN to summarize,
 * not for billing. Counts all block types including tool_use JSON and images.
 */

import type { Message, ContentBlock } from "../llm/types.js";

export interface TokenCounter {
  addMessage(message: Message): void;
  addToolResult(content: string): void;
  readonly total: number;
}

function estimateChars(content: string | ContentBlock[]): number {
  if (typeof content === "string") return content.length;

  let chars = 0;
  for (const block of content) {
    switch (block.type) {
      case "text":
        chars += block.text.length;
        break;
      case "image":
        chars += block.data.length;
        break;
      case "tool_use":
        chars += block.name.length + JSON.stringify(block.input).length;
        break;
      case "tool_result":
        chars += block.content.length;
        break;
    }
  }
  return chars;
}

export function createTokenCounter(): TokenCounter {
  let totalTokens = 0;

  return {
    addMessage(message: Message) {
      totalTokens += Math.ceil(estimateChars(message.content) / 4);
    },

    addToolResult(content: string) {
      totalTokens += Math.ceil(content.length / 4);
    },

    get total() {
      return totalTokens;
    },
  };
}
