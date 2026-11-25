import type { ContentBlock } from "../../../../infra/llm/conversation/conversation-message.js";

export function hasAssistantOutput(content: readonly ContentBlock[]): boolean {
  return content.some((block) => {
    switch (block.type) {
      case "text": return block.text.length > 0;
      case "image":
      case "thinking":
      case "reasoning":
      case "tool_use": return true;
    }
    return false;
  });
}
