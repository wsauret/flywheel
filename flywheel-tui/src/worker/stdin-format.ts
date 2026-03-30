/**
 * Format a message for Claude's --input-format stream-json mode.
 * Claude expects NDJSON lines with type "user" and a message object.
 */
export function formatClaudeStdinMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}
