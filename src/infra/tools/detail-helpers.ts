import * as path from "node:path";
import { deslugify } from "../canonical-name.js";
import { parseShell } from "./shell-words.js";

export interface ToolInput {
  [key: string]: unknown;
}

/** Narrow a tool-input field to a string, dropping any non-string value. Tool
 *  inputs arrive as `ToolInput` from the LLM boundary; the schema
 *  exists per tool but detail formatting reads opportunistically across tools. */
export function strField(input: ToolInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

/** Narrow a tool-input field to a number, dropping any non-number value. */
export function numField(input: ToolInput, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

export function singleLine(s: string | undefined | null): string | null {
  if (!s) return null;
  return s.replace(/\n/g, " ").trim();
}

/** File subjects keep their line selector but omit parent directories. */
export function fileSubject(filePath: string): string {
  return filePath.replaceAll("\\", "/").split("/").at(-1) ?? "";
}

/** One path as tool output shows it: relative to the execution directory, and
 *  always in POSIX separators. The text a model reads must not change with the
 *  host, and a path it echoes back has to resolve on either platform. */
export function displayRelativePath(filePath: string, executionCwd: string): string {
  const relative = path.relative(executionCwd, filePath);
  return (relative === "" ? "." : relative).replaceAll(path.sep, "/");
}

export function formatRelativePath(filePath: string | undefined | null, executionCwd: string): string | null {
  if (!filePath) return null;

  let relative: string;
  if (path.isAbsolute(filePath)) {
    relative = path.relative(executionCwd, filePath);
    if (relative.length === 0) return ".";
  } else {
    relative = filePath;
  }

  // A displayed path is read by a model and compared across platforms, so it is
  // published in POSIX form whatever the host separator is.
  relative = relative.replaceAll(path.sep, "/");

  if (relative.startsWith("./")) {
    return relative.slice(2);
  }
  return relative;
}

export function formatDisplayPath(filePath: string | undefined | null, executionCwd: string): string | null {
  const relative = formatRelativePath(filePath, executionCwd);
  if (relative === null) return null;
  const sessionHandoffMatch = relative.match(/\.flywheel\/sessions\/[^/]+\/([^/]+\.json)$/);
  return sessionHandoffMatch ? `[handoff] ${sessionHandoffMatch[1]}` : relative;
}

/** Show each script that a command runs directly as `bash <script>`, so the
 *  row names the program that runs it. The commands and their first words come
 *  from the display word model, so a heredoc body is never read as a command. */
function showScriptsThroughBash(command: string): string {
  const starts = parseShell(command)
    .flatMap((parsed) => (parsed.start !== undefined && parsed.shown[0]?.endsWith(".sh") ? [parsed.start] : []))
    .sort((left, right) => left - right);
  let out = "";
  let copied = 0;
  for (const start of starts) {
    out += `${command.slice(copied, start)}bash `;
    copied = start;
  }
  return out + command.slice(copied);
}

export function shellDetail(input: ToolInput, executionCwd: string): string | null {
  const cmd = strField(input, "command");
  if (!cmd) return null;
  const shortened = executionCwd ? cmd.replaceAll(`${executionCwd}/`, "").replaceAll(executionCwd, ".") : cmd;
  // Multiline commands (heredoc scripts, inline python) keep their linebreaks;
  // the row renderer hard-breaks on them with a hanging indent.
  return showScriptsThroughBash(shortened).trim() || null;
}

/** Display label for a subagent tool call. The general agent renders as
 *  "General" or "Fork" depending on its fork setting; forked personas get a
 *  "(fork)" suffix so the user can see which mode is running. */
export function subagentDisplayLabel(input: ToolInput): string | null {
  const agentType = strField(input, "persona");
  if (!agentType) return null;
  if (agentType === "general") return input.fork === true ? "Fork" : "General";
  const label = deslugify(agentType);
  return input.fork === true ? `${label} (fork)` : label;
}

export function agentDetail(input: ToolInput, _executionCwd: string): string | null {
  const desc = strField(input, "description") ?? strField(input, "prompt");
  const label = subagentDisplayLabel(input);
  return singleLine(label ? `[${label}] ${desc ?? ""}` : desc);
}

export function workflowDetail(input: ToolInput, _executionCwd: string): string | null {
  const summary = strField(input, "summary") ?? strField(input, "task_summary");
  return summary ? singleLine(summary) : null;
}

/** Bash-idiom pipe stage for search reach: `| count` (grep -c), `| tail -N`
 *  (grep | tail -N), or `| head -N` (grep -m N / an explicit limit). Rendered
 *  with a literal pipe so the row reads like the bash chain it replaces. */
function searchModeToken(input: ToolInput): string | null {
  if (strField(input, "output_mode") === "count") return "count";
  const limit = numField(input, "limit");
  if (input.tail === true) return limit !== undefined ? `tail -${limit}` : "tail";
  if (limit !== undefined) return `head -${limit}`;
  return null;
}

export function searchDetail(input: ToolInput, executionCwd: string, ...filterKeys: string[]): string | null {
  const pat = strField(input, "pattern");
  const dir = strField(input, "path");
  let extra: string | undefined;
  for (const key of filterKeys) {
    extra = strField(input, key);
    if (extra) break;
  }
  const displayDir = dir ? formatDisplayPath(dir, executionCwd) : null;
  const quoted = pat ? `"${pat}"` : null;
  const mode = searchModeToken(input);
  const parts = [quoted, displayDir && `in ${displayDir}`, extra && `[${extra}]`, mode && `| ${mode}`].filter(Boolean).join(" ");
  return singleLine(parts || null);
}

export function listDetail(input: ToolInput, executionCwd: string): string | null {
  const pat = strField(input, "pattern");
  const dir = strField(input, "path");
  const include = strField(input, "include");
  const displayDir = dir ? formatDisplayPath(dir, executionCwd) : null;
  const quoted = pat ? `"${pat}"` : null;
  const scope = quoted ? displayDir && `in ${displayDir}` : displayDir;
  // Bash-idiom pipe stage: sort "mtime" is the `ls -t` shape, with limit the
  // `ls -t | head -N` shape.
  const limit = numField(input, "limit");
  const newest = strField(input, "sort") === "mtime" ? (limit !== undefined ? `newest ${limit}` : "newest first") : null;
  const parts = [quoted, scope, include && include !== "all" && `[${include}]`, newest && `| ${newest}`].filter(Boolean).join(" ");
  return singleLine(parts || null);
}
