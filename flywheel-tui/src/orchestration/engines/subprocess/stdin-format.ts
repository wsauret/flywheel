/**
 * Format a text message as NDJSON for the subprocess stdin pipe.
 * Claude expects NDJSON lines with type "user" and a message object.
 */
export function formatStdinMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}
