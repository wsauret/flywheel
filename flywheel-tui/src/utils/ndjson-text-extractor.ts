/**
 * Shared NDJSON text extraction utility.
 *
 * Used by both dispatcher and evaluator subprocess transports to extract
 * AI response text from OpenCode's NDJSON output format.
 */

/**
 * Extract AI response text from NDJSON output produced by `opencode run --format json`.
 * Parses each line as JSON and concatenates `part.text` from events with `type === "text"`.
 * Returns empty string if no text events found (caller falls back to raw output).
 */
export function extractTextFromNDJSON(output: string): string {
  const parts: string[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event?.type === "text" && typeof event.part?.text === "string") {
        parts.push(event.part.text);
      }
    } catch {
      // Not JSON — skip
    }
  }
  return parts.join("");
}
