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

import * as fs from "node:fs";
import * as path from "node:path";
import { createPatch } from "diff";

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
function formatToolUse(block: Record<string, unknown>): string {
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
      return truncate(formatDisplayPath(input.file_path as string), 80);
    case "Write":
      return truncate(formatDisplayPath(input.file_path as string), 80);
    case "Edit": {
      const fp = input.file_path as string | undefined;
      return fp ? truncate(formatDisplayPath(fp), 80) : null;
    }
    case "Bash":
    case "PowerShell":
    case "REPL": {
      const cmd = input.command as string | undefined;
      if (!cmd) return null;
      // Replace absolute paths in the command with relative paths
      const cwd = process.cwd();
      const shortened = cwd ? cmd.replaceAll(cwd + "/", "").replaceAll(cwd, ".") : cmd;
      return truncate(shortened, 100);
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
    case "WebSearch":
      return truncate(input.query as string ?? input.search_query as string, 100);
    case "LSP": {
      const method = input.method as string | undefined;
      const fp = input.file_path as string | undefined;
      return truncate(method ? `${method}${fp ? ` ${formatDisplayPath(fp)}` : ""}` : (fp ? formatDisplayPath(fp) : null), 100);
    }
    case "NotebookEdit": {
      const fp = input.notebook_path as string ?? input.file_path as string | undefined;
      return fp ? truncate(formatDisplayPath(fp), 80) : null;
    }
    case "PowerShell":
    case "REPL": {
      const cmd = input.command as string | undefined;
      return cmd ? truncate(cmd, 100) : null;
    }
    case "Skill": {
      const skill = input.skill as string ?? input.name as string | undefined;
      return skill ? truncate(skill, 80) : null;
    }
    case "SendMessage": {
      const to = input.to as string | undefined;
      return to ? truncate(`to ${to}`, 80) : null;
    }
    case "AskUserQuestion": {
      const q = input.question as string | undefined;
      return q ? truncate(q, 100) : null;
    }
    case "ToolSearch": {
      const query = input.query as string | undefined;
      return query ? truncate(query, 80) : null;
    }
    case "TodoWrite":
    case "EnterPlanMode":
    case "ExitPlanMode":
    case "EnterWorktree":
    case "ExitWorktree":
      return null;
    default: {
      // MCP tools: show first string-valued key
      // Task tools: show subject or description
      const subject = input.subject as string | undefined;
      if (subject) return truncate(subject, 80);
      const desc = input.description as string | undefined;
      if (desc) return truncate(desc, 80);
      // Fallback: first string value
      for (const val of Object.values(input)) {
        if (typeof val === "string" && val.length > 0) {
          return truncate(val, 80);
        }
      }
      return null;
    }
  }
}

export function formatDisplayPath(filePath: string | undefined | null): string | null {
  if (!filePath) return null;

  let relative: string;
  if (path.isAbsolute(filePath)) {
    relative = path.relative(process.cwd(), filePath);
    if (relative.length === 0) return "./";
  } else {
    relative = filePath;
  }

  // Shorten internal .flywheel/sessions/<uuid>/handoffs/<file> paths
  const sessionHandoffMatch = relative.match(/\.flywheel\/sessions\/[^/]+\/handoffs\/(.+)$/);
  if (sessionHandoffMatch) {
    return `[handoff] ${sessionHandoffMatch[1]}`;
  }

  // Always use ./ prefix for files that aren't parent-relative
  if (!relative.startsWith("./") && !relative.startsWith("../")) {
    return `./${relative}`;
  }
  return relative;
}

function truncate(
  s: string | undefined | null,
  max: number,
): string | null {
  if (!s) return null;
  // Collapse to single line
  const oneLine = s.replace(/\n/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

// ── Diff generation ──

const CONTEXT_LINES = 3;

/**
 * Generate a unified diff from Edit tool's old_string → new_string.
 * Reads the file to produce context lines around the change.
 * Falls back to a minimal no-context diff if the file can't be read.
 */
export function createEditDiff(filePath: string, oldStr: string, newStr: string): string {
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
    const fileContent = fs.readFileSync(resolved, "utf-8");

    let oldContent: string;
    let newContent: string;
    if (fileContent.includes(oldStr)) {
      // File not yet modified — apply replacement
      oldContent = fileContent;
      newContent = fileContent.replace(oldStr, newStr);
    } else if (fileContent.includes(newStr)) {
      // File already modified — reverse to reconstruct old
      newContent = fileContent;
      oldContent = fileContent.replace(newStr, oldStr);
    } else {
      // Neither found — fall back to minimal diff
      return createMinimalDiff(filePath, oldStr, newStr);
    }

    return createPatch(filePath, oldContent, newContent, "", "", { context: CONTEXT_LINES });
  } catch {
    return createMinimalDiff(filePath, oldStr, newStr);
  }
}

/** Minimal diff without context (fallback when file can't be read). */
function createMinimalDiff(filePath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  let result = `--- a/${filePath}\n+++ b/${filePath}\n`;
  result += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  for (const line of oldLines) result += `-${line}\n`;
  for (const line of newLines) result += `+${line}\n`;
  return result;
}

/** Generate a unified diff for Write tool (all content as additions). */
export function createWriteDiff(filePath: string, content: string): string {
  const lines = content.split("\n");
  let result = `--- /dev/null\n+++ b/${filePath}\n`;
  result += `@@ -0,0 +1,${lines.length} @@\n`;
  for (const line of lines) result += `+${line}\n`;
  return result;
}

/** Max lines for capturing Write diffs (full-file content can be huge). */
const MAX_WRITE_DIFF_LINES = 200;

/**
 * Extract diff info from a tool_use input block.
 * Returns unified diff string + filetype for Edit, Write, and ApplyPatch tools.
 */
export function extractToolDiff(
  name: string,
  input: Record<string, unknown>,
): { diff: string; filetype: string | undefined } | undefined {
  const fp = (input.file_path as string) ?? "";
  const ft = getFiletype(fp);

  if (name === "Edit") {
    const oldStr = input.old_string as string | undefined;
    const newStr = input.new_string as string | undefined;
    if (oldStr != null && newStr != null) {
      return { diff: createEditDiff(fp, oldStr, newStr), filetype: ft };
    }
  }

  if (name === "Write") {
    const content = input.content as string | undefined;
    if (content) {
      const lineCount = content.split("\n").length;
      if (lineCount <= MAX_WRITE_DIFF_LINES) {
        return { diff: createWriteDiff(fp, content), filetype: ft };
      }
    }
  }

  if (name === "ApplyPatch") {
    const patch = input.patch as string | undefined;
    if (patch) {
      return { diff: patch, filetype: ft };
    }
  }

  return undefined;
}

/** Derive filetype from file extension for syntax highlighting. */
export function getFiletype(filePath: string): string | undefined {
  if (!filePath) return undefined;
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rs: "rust", go: "go", rb: "ruby",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", css: "css", scss: "scss", html: "html",
    sql: "sql", sh: "bash", bash: "bash", zsh: "zsh",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    java: "java", kt: "kotlin", swift: "swift",
    lua: "lua", vim: "vim", xml: "xml", graphql: "graphql",
  };
  return map[ext] ?? ext;
}
