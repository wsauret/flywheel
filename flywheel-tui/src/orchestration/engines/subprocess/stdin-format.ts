// Single function, but 7 consumers across orchestration/ and workflows/.
// Extracted to avoid duplicating the wire format in every call site.

/** Format a text message as NDJSON for the subprocess stdin pipe. */
export function formatStdinMessage(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}
