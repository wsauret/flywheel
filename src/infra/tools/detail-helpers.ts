import * as path from "node:path";
import { deslugify } from "../canonical-name.js";

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

function readShellWord(command: string, start: number) {
  let i = start;
  let quote: string | null = null;
  while (i < command.length) {
    // SAFETY: i < command.length is the loop guard, so this index is in bounds.
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (/\s/.test(ch) || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") break;
    i++;
  }
  return { raw: command.slice(start, i), end: i };
}

function unquoteShellWord(word: string): string {
  if (word.length >= 2 && ((word.startsWith("'") && word.endsWith("'")) || (word.startsWith('"') && word.endsWith('"')))) {
    return word.slice(1, -1);
  }
  return word;
}

function isEnvAssignment(word: string): boolean {
  return /^[A-Za-z_]\w*=/.test(word);
}

function isBashScriptPath(word: string): boolean {
  return unquoteShellWord(word).endsWith(".sh");
}

/** Consume leading whitespace from `start` and return it with the first non-whitespace index. */
function readWhitespace(command: string, start: number) {
  let i = start;
  let text = "";
  while (i < command.length) {
    // SAFETY: i < command.length is the loop guard, so this index is in bounds.
    const ch = command[i]!;
    if (!/\s/.test(ch)) break;
    text += ch;
    i++;
  }
  return { text, end: i };
}

function normalizeBashScriptCommands(command: string): string {
  let out = "";
  let i = 0;
  let atCommandStart = true;
  while (i < command.length) {
    if (!atCommandStart) {
      // SAFETY: i < command.length is the enclosing while guard; index in bounds.
      const ch = command[i]!;
      out += ch;
      atCommandStart = ch === ";" || ch === "|" || ch === "&" || ch === "(";
      i++;
      continue;
    }

    const whitespace = readWhitespace(command, i);
    out += whitespace.text;
    i = whitespace.end;

    while (i < command.length) {
      const word = readShellWord(command, i);
      if (!word.raw || !isEnvAssignment(word.raw)) break;
      out += word.raw;
      const envWhitespace = readWhitespace(command, word.end);
      out += envWhitespace.text;
      i = envWhitespace.end;
    }

    const word = readShellWord(command, i);
    if (word.raw && isBashScriptPath(word.raw)) out += "bash ";
    if (word.raw) {
      out += word.raw;
      i = word.end;
    }
    atCommandStart = false;
  }
  return out;
}

export function shellDetail(input: ToolInput, executionCwd: string): string | null {
  const cmd = strField(input, "command");
  if (!cmd) return null;
  const shortened = executionCwd ? cmd.replaceAll(`${executionCwd}/`, "").replaceAll(executionCwd, ".") : cmd;
  // Multiline commands (heredoc scripts, inline python) keep their linebreaks;
  // the row renderer hard-breaks on them with a hanging indent.
  return normalizeBashScriptCommands(shortened).trim() || null;
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
