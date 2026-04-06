/**
 * Format a message for Claude's --input-format stream-json mode.
 * Claude expects NDJSON lines with type "user" and a message object.
 */
function formatClaudeStdinMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

/**
 * Engine-aware stdin message formatter.
 *
 * Routes to the correct format based on engine ID. Currently only Claude
 * is supported — all engines use NDJSON format.
 */
export function formatStdinMessage(_engineId: string, text: string): string {
  return formatClaudeStdinMessage(text);
}
