/**
 * Extracts a compact dialogue summary from chat output blocks.
 *
 * Used when transitioning from chat to workflow — the summary gives the
 * dispatcher awareness of what the user discussed before launching the workflow.
 */

import type { AnyBlock } from "../infra/output-blocks.js";

const MAX_CHARS = 2000;

/**
 * Extract recent conversation turns from chat output blocks.
 * Returns a compact dialogue string, or undefined if no meaningful content.
 */
export function extractChatContext(blocks: readonly AnyBlock[]): string | undefined {
  const lines: string[] = [];
  let chars = 0;

  // Walk blocks in reverse — most recent turns are most relevant
  for (let i = blocks.length - 1; i >= 0 && chars < MAX_CHARS; i--) {
    const block = blocks[i]!;
    if (block.kind === "userMessage" && !block.injected) {
      lines.unshift(`User: ${block.content}`);
      chars += block.content.length + 6;
    } else if (block.kind === "text") {
      lines.unshift(`Assistant: ${block.content}`);
      chars += block.content.length + 11;
    }
  }

  if (lines.length === 0) return undefined;

  // Truncate from the front if over budget (keeps most recent turns)
  let result = lines.join("\n");
  if (result.length > MAX_CHARS) {
    result = result.slice(result.length - MAX_CHARS);
    const firstNewline = result.indexOf("\n");
    if (firstNewline > 0) result = result.slice(firstNewline + 1);
  }

  return result;
}
