/**
 * Format a message for Claude's --input-format stream-json mode.
 * Claude expects NDJSON lines with type "user" and a message object.
 */
function formatClaudeStdinMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/**
 * Format a text message as NDJSON for the subprocess stdin pipe.
 *
 * All engines use the same Claude-style NDJSON format.
 */
export function formatStdinMessage(text: string): string {
  return formatClaudeStdinMessage(text);
}
