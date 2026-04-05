/**
 * Message classification predicates for Claude Code JSONL output.
 *
 * Pure functions that determine the type of a JSONL message without
 * performing any state management or event emission.
 */

import { isSubagentToolName, type ClaudeJsonlMessage } from './types.js';

/**
 * Check if a message represents a Task tool invocation (subagent spawn).
 * Handles both "Task" (Claude) and "task" (OpenCode) tool names.
 */
export function isTaskToolInvocation(message: ClaudeJsonlMessage): boolean {
  // Subagent invocations appear as tool_use with name "Task" or "Agent"
  if (message.tool?.name && isSubagentToolName(message.tool.name)) {
    return true;
  }

  // Also check raw message for tool_use content blocks
  // Claude's format: {"type": "assistant", "message": {"content": [...]}}
  const raw = message.raw;
  const rawMessage = raw.message as { content?: unknown[] } | undefined;
  const contentArray = Array.isArray(raw.content)
    ? raw.content
    : Array.isArray(rawMessage?.content)
      ? rawMessage.content
      : null;

  if (raw.type === 'assistant' && contentArray) {
    for (const block of contentArray) {
      if (
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_use' &&
        'name' in block &&
        typeof block.name === 'string' &&
        isSubagentToolName(block.name)
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a message represents a tool result.
 */
export function isToolResult(message: ClaudeJsonlMessage): boolean {
  const raw = message.raw;
  return raw.type === 'tool_result' || message.type === 'result';
}

/**
 * Check if a message represents an error.
 */
export function isErrorMessage(message: ClaudeJsonlMessage): boolean {
  const raw = message.raw;
  return (
    raw.type === 'error' ||
    message.type === 'error' ||
    (typeof raw.error === 'object' && raw.error !== null)
  );
}
