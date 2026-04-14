import * as fs from "node:fs";
import * as path from "node:path";
import { createPatch } from "diff";

/** Adding a new tool just means adding an entry to this map. */
type ToolDetailHandler = (input: Record<string, unknown>, cwd: string) => string | null;

function shellDetail(input: Record<string, unknown>, cwd: string): string | null {
  const cmd = input.command as string | undefined;
  if (!cmd) return null;
  const shortened = cwd ? cmd.replaceAll(cwd + "/", "").replaceAll(cwd, ".") : cmd;
  return truncateLine(shortened, 100);
}

function agentDetail(input: Record<string, unknown>, _cwd: string): string | null {
  const desc = (input.description as string | undefined) ?? (input.prompt as string | undefined);
  const agentType = input.subagent_type as string | undefined;
  return truncateLine(agentType ? `[${agentType}] ${desc ?? ""}` : desc, 100);
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
  ["Glob", (input, cwd) => {
    const pat = input.pattern as string | undefined;
    const dir = input.path as string | undefined;
    const displayDir = dir ? formatDisplayPath(dir, cwd) : null;
    const quoted = pat ? `"${pat}"` : null;
    return truncateLine(displayDir ? `${quoted} in ${displayDir}` : quoted, 80);
  }],
  ["Grep", (input, cwd) => {
    const pat = input.pattern as string | undefined;
    const dir = input.path as string | undefined;
    const fileFilter = (input.glob as string | undefined) ?? (input.type as string | undefined);
    const displayDir = dir ? formatDisplayPath(dir, cwd) : null;
    const quoted = pat ? `"${pat}"` : null;
    const parts = [quoted, displayDir && `in ${displayDir}`, fileFilter && `[${fileFilter}]`].filter(Boolean).join(" ");
    return truncateLine(parts || null, 80);
  }],
  ["Agent", agentDetail],
  ["Task", agentDetail],
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

function formatDisplayPath(filePath: string | undefined | null, cwd?: string): string | null {
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
  const oneLine = s.replace(/\n/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

const CONTEXT_LINES = 3;

/**
 * Generate a unified diff from Edit tool's old_string → new_string.
 * Reads the file to produce context lines around the change.
 * Falls back to a minimal no-context diff if the file can't be read.
 *
 * Note: uses fs.readFileSync — a pragmatic boundary deviation. The diff
 * needs file content for context lines; threading a readFile callback
 * through 3 layers would be worse than the I/O here.
 */
function createEditDiff(filePath: string, oldStr: string, newStr: string, cwd: string = process.cwd()): string {
  try {
    const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const fileContent = fs.readFileSync(resolved, "utf-8");

    let oldContent: string;
    let newContent: string;
    if (fileContent.includes(newStr)) {
      // File already modified — reverse to reconstruct old.
      // Checked first: oldStr is often a substring of newStr (e.g. adding a
      // comment above a line), so includes(oldStr) would match even after
      // the edit has been applied, producing a double-insertion in the diff.
      newContent = fileContent;
      oldContent = fileContent.replace(newStr, oldStr);
    } else if (fileContent.includes(oldStr)) {
      oldContent = fileContent;
      newContent = fileContent.replace(oldStr, newStr);
    } else {
      // Neither found — fall back to minimal diff
      return createMinimalDiff(filePath, oldStr, newStr);
    }

    return createPatch(filePath, oldContent, newContent, "", "", { context: CONTEXT_LINES });
  } catch {
    return createMinimalDiff(filePath, oldStr, newStr);
  }
}

function createMinimalDiff(filePath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  let result = `--- a/${filePath}\n+++ b/${filePath}\n`;
  result += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;
  for (const line of oldLines) result += `-${line}\n`;
  for (const line of newLines) result += `+${line}\n`;
  return result;
}

/** Max lines for capturing Write diffs (full-file content can be huge). */
const MAX_WRITE_DIFF_LINES = 200;

/** Result of extracting display info from a tool_use input block. */
type ToolDiffInfo = {
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

function getFiletype(filePath: string): string | undefined {
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
