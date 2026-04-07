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
 * Per-tool detail handlers.
 * Adding a new tool just means adding an entry to this map.
 */
type ToolDetailHandler = (input: Record<string, unknown>, cwd: string) => string | null;

function shellDetail(input: Record<string, unknown>, cwd: string): string | null {
  const cmd = input.command as string | undefined;
  if (!cmd) return null;
  const shortened = cwd ? cmd.replaceAll(cwd + "/", "").replaceAll(cwd, ".") : cmd;
  return truncateLine(shortened, 100);
}

const TOOL_DETAIL_HANDLERS = new Map<string, ToolDetailHandler>([
  ["Read", (input, cwd) => {
    const path = formatDisplayPath(input.file_path as string, cwd);
    const offset = input.offset as number | undefined;
    const limit = input.limit as number | undefined;
    if (offset != null || limit != null) {
      const start = (offset ?? 0) + 1;
      const end = limit != null ? start + limit - 1 : undefined;
      const range = end != null ? `:${start}-${end}` : `:${start}+`;
      return truncateLine(`${path}${range}`, 80);
    }
    return truncateLine(path, 80);
  }],
  ["Write", (input, cwd) => truncateLine(formatDisplayPath(input.file_path as string, cwd), 80)],
  ["Edit", (input, cwd) => { const fp = input.file_path as string | undefined; return fp ? truncateLine(formatDisplayPath(fp, cwd), 80) : null }],
  ["Bash", shellDetail],
  ["PowerShell", shellDetail],
  ["REPL", shellDetail],
  ["Glob", (input) => truncateLine(input.pattern as string, 80)],
  ["Grep", (input) => truncateLine(input.pattern as string, 80)],
  ["Agent", (input) => truncateLine((input.description as string | undefined) ?? (input.prompt as string | undefined), 100)],
  ["Task", (input) => truncateLine((input.description as string | undefined) ?? (input.prompt as string | undefined), 100)],
  ["WebFetch", (input) => truncateLine(input.url as string, 100)],
  ["WebSearch", (input) => truncateLine((input.query as string | undefined) ?? (input.search_query as string | undefined), 100)],
  ["LSP", (input, cwd) => {
    const method = input.method as string | undefined;
    const fp = input.file_path as string | undefined;
    return truncateLine(method ? `${method}${fp ? ` ${formatDisplayPath(fp, cwd)}` : ""}` : (fp ? formatDisplayPath(fp, cwd) : null), 100);
  }],
  ["NotebookEdit", (input, cwd) => {
    const fp = (input.notebook_path as string | undefined) ?? (input.file_path as string | undefined);
    return fp ? truncateLine(formatDisplayPath(fp, cwd), 80) : null;
  }],
  ["Skill", (input) => {
    const skill = (input.skill as string | undefined) ?? (input.name as string | undefined);
    return skill ? truncateLine(skill, 80) : null;
  }],
  ["SendMessage", (input) => { const to = input.to as string | undefined; return to ? truncateLine(`to ${to}`, 80) : null }],
  ["AskUserQuestion", (input) => { const q = input.question as string | undefined; return q ? truncateLine(q, 100) : null }],
  ["ToolSearch", (input) => { const query = input.query as string | undefined; return query ? truncateLine(query, 80) : null }],
  ["TodoWrite", () => null],
  ["EnterPlanMode", () => null],
  ["ExitPlanMode", () => null],
  ["EnterWorktree", () => null],
  ["ExitWorktree", () => null],
]);

/**
 * Extract a short, useful detail string from tool input.
 */
export function getToolDetail(
  name: string,
  input: Record<string, unknown>,
  cwd: string = process.cwd(),
): string | null {
  const handler = TOOL_DETAIL_HANDLERS.get(name);
  if (handler) return handler(input, cwd);

  // Fallback for unknown tools (MCP, etc.): subject, description, first string value
  const subject = input.subject as string | undefined;
  if (subject) return truncateLine(subject, 80);
  const desc = input.description as string | undefined;
  if (desc) return truncateLine(desc, 80);
  for (const val of Object.values(input)) {
    if (typeof val === "string" && val.length > 0) {
      return truncateLine(val, 80);
    }
  }
  return null;
}

export function formatDisplayPath(filePath: string | undefined | null, cwd?: string): string | null {
  if (!filePath) return null;

  const cwdPath = cwd ?? process.cwd();
  let relative: string;
  if (path.isAbsolute(filePath)) {
    relative = path.relative(cwdPath, filePath);
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

function truncateLine(
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
function createEditDiff(filePath: string, oldStr: string, newStr: string, cwd: string = process.cwd()): string {
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
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

/** Result of extracting display info from a tool_use input block. */
export type ToolDiffInfo = {
  diff?: string;
  content?: string;
  filetype: string | undefined;
};

/**
 * Extract diff/content info from a tool_use input block.
 *
 * - Edit → unified diff (red/green rendering)
 * - Write → raw content (plain text rendering)
 * - ApplyPatch → unified diff
 */
export function extractToolDiff(
  name: string,
  input: Record<string, unknown>,
): ToolDiffInfo | undefined {
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
    const rawContent = input.content as string | undefined;
    if (rawContent) {
      const lineCount = rawContent.split("\n").length;
      if (lineCount <= MAX_WRITE_DIFF_LINES) {
        return { content: rawContent, filetype: ft };
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
