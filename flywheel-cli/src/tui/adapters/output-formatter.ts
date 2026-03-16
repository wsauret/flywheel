/**
 * Output Formatter — shared NDJSON display text extraction
 *
 * Parses stream-json NDJSON lines from Claude/OpenCode worker processes
 * and extracts human-readable display text. Used by both the ConsoleAdapter
 * (stdout printing) and the OpenTUIAdapter (store output lines).
 *
 * Handles claude stream-json format:
 * - {"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...}}
 * - {"type":"result","result":"..."}
 *
 * Returns null for non-displayable lines (system init, tool_result, etc).
 * Falls back to raw text for non-JSON input.
 */

/**
 * Extract displayable text from a stream-json NDJSON line.
 *
 * Returns null for non-displayable lines (system init, etc).
 * Falls back to raw text for non-JSON input.
 */
export function extractDisplayText(line: string): string | null {
  // Try to parse as JSON
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON — output raw (plain text mode)
    return line + "\n";
  }

  const type = parsed.type as string | undefined;

  // assistant message — extract text content
  if (type === "assistant") {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = message?.content as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block.type === "tool_use") {
          texts.push(formatToolUse(block));
        }
      }
      return texts.length > 0 ? texts.join("") : null;
    }
  }

  // result — extract final result text
  if (type === "result") {
    const result = parsed.result as string | undefined;
    if (typeof result === "string" && result.length > 0) {
      return result + "\n";
    }
  }

  // system, tool_result, etc — skip
  return null;
}

/**
 * Format a tool_use content block for display.
 */
export function formatToolUse(block: Record<string, unknown>): string {
  const name = block.name as string | undefined;
  if (!name) return "";

  const input = block.input as Record<string, unknown> | undefined;
  if (!input) return `  ▸ ${name}\n`;

  // Extract the most useful detail per tool type
  const detail = getToolDetail(name, input);
  return detail ? `  ▸ ${name}: ${detail}\n` : `  ▸ ${name}\n`;
}

/**
 * Extract a short, useful detail string from tool input.
 */
export function getToolDetail(
  name: string,
  input: Record<string, unknown>,
): string | null {
  switch (name) {
    case "Read":
      return truncate(input.file_path as string, 80);
    case "Write":
      return truncate(input.file_path as string, 80);
    case "Edit": {
      const fp = input.file_path as string | undefined;
      return fp ? truncate(fp, 80) : null;
    }
    case "Bash": {
      const cmd = input.command as string | undefined;
      return cmd ? truncate(cmd, 100) : null;
    }
    case "Glob":
      return truncate(input.pattern as string, 80);
    case "Grep":
      return truncate(input.pattern as string, 80);
    case "Agent":
    case "Task": {
      const prompt = input.prompt as string | undefined;
      const desc = input.description as string | undefined;
      return truncate(desc ?? prompt, 100);
    }
    case "WebFetch":
      return truncate(input.url as string, 100);
    case "TodoWrite":
      return null; // not interesting
    default: {
      // For unknown tools, show first string-valued key
      for (const val of Object.values(input)) {
        if (typeof val === "string" && val.length > 0) {
          return truncate(val, 80);
        }
      }
      return null;
    }
  }
}

export function truncate(
  s: string | undefined | null,
  max: number,
): string | null {
  if (!s) return null;
  // Collapse to single line
  const oneLine = s.replace(/\n/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}
