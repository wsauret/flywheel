/**
 * Extract clean text content from worker output.
 *
 * Worker output (result.output) is raw stdout from an AI CLI tool.
 * The format is NDJSON with these event types:
 *
 *   {"type":"system","subtype":"init",...}           — session init metadata
 *   {"type":"assistant","message":{"content":[       — agent text output
 *     {"type":"text","text":"## Open Questions\n"},
 *     {"type":"tool_use","name":"Read","input":{}}
 *   ]}}
 *   {"type":"user","message":{"content":[...]}}      — tool results
 *
 * The agent's actual text lives inside `assistant` events, in the
 * `message.content[]` array entries where `type === "text"`.
 *
 * This utility extracts those text fragments and concatenates them into
 * clean markdown that the question/P3 parsers can process.
 */

/**
 * Extract clean text from NDJSON worker output.
 *
 * Handles three NDJSON formats:
 *   1. OpenCode/Claude: `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}`
 *   2. Simple text events: `{"type":"text","text":"..."}`
 *   3. Plain text lines (non-JSON) — kept as-is
 */
export function extractTextFromOutput(rawOutput: string): string {
  if (!rawOutput.trim()) return "";

  const lines = rawOutput.split("\n");
  const textParts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try to parse as JSON
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null) {
          // Format 1: assistant message with content array
          if (parsed.type === "assistant" && parsed.message?.content) {
            const content = parsed.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && typeof block.text === "string") {
                  textParts.push(block.text);
                }
              }
            }
            continue;
          }

          // Format 2: simple text event ({"type":"text","text":"..."})
          if (parsed.type === "text" && typeof parsed.text === "string") {
            textParts.push(parsed.text);
            continue;
          }

          // Skip other JSON events (system, user/tool_result, etc.)
          continue;
        }
      } catch {
        // Not valid JSON — treat as plain text below
      }
    }

    // Plain text line (not JSON) — preserve newline
    textParts.push(line + "\n");
  }

  return textParts.join("");
}
