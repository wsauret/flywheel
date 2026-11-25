import * as path from "node:path";
import { deslugify } from "../../../providers/canonical-name.js";
import { ShellScanner, type ShellCommand, type ShellScanStep } from "./shell-words.js";

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

/** What one step of a `ShellDetailStream` adds. */
export interface ShellDetailStep {
  /** The command text this step adds, with the execution directory shortened. */
  readonly text: string;
  /** Offsets in the shortened command where a script starts that the row
   *  shows through `bash`: each one gets `bash ` inserted before it. */
  readonly scripts: readonly number[];
  /** The commands this step completed, each script among them run through
   *  `bash` as the row shows it. */
  readonly complete: readonly ShellCommand[];
  /** The commands whose words ended and which wait for a heredoc body, shown
   *  the same way. */
  readonly waiting: readonly ShellCommand[];
  /** The offset that `slice` reads from until the next step; see `ShellScanStep.floor`. */
  readonly floor: number;
}

/** The row detail of a shell command that arrives in pieces: the command
 *  with the execution directory shortened, and each script that it runs
 *  directly shown as `bash <script>`, so the row names the program that runs
 *  it. The commands come from the display word model, so a heredoc body is
 *  never read as a command. Each step reads only the text appended to it. */
export class ShellDetailStream {
  private readonly scanner = new ShellScanner();
  /** Paths under the execution directory show relative to it, and the
   *  directory itself shows as `.`. */
  private readonly shortenPaths: StreamingReplacement;
  private readonly shortenDirectory: StreamingReplacement;

  constructor(executionCwd: string) {
    this.shortenPaths = new StreamingReplacement(executionCwd ? `${executionCwd}/` : "", "");
    this.shortenDirectory = new StreamingReplacement(executionCwd, ".");
  }

  advance(text: string): ShellDetailStep {
    const shortened = this.shortenDirectory.push(this.shortenPaths.push(text, false), false);
    return this.step(shortened, this.scanner.advance(shortened));
  }

  finish(): ShellDetailStep {
    const shortened = this.shortenDirectory.push(this.shortenPaths.push("", true), true);
    const scanned = this.scanner.advance(shortened);
    const finished = this.scanner.finish();
    return this.step(shortened, { ...finished, parsed: [...scanned.parsed, ...finished.parsed], complete: [...scanned.complete, ...finished.complete] });
  }

  /** Shortened command text between two offsets at or after the floor of the last step. */
  slice(from: number, to: number): string {
    return this.scanner.slice(from, to);
  }

  /** The length of the shortened command so far. */
  get end(): number {
    return this.scanner.end;
  }

  private step(text: string, scanned: ShellScanStep): ShellDetailStep {
    return {
      text,
      scripts: scanned.parsed.flatMap((command) => command.start !== undefined && isScript(command) ? [command.start] : []),
      complete: scanned.complete.map(shownCommand),
      waiting: scanned.waiting.map(shownCommand),
      floor: scanned.floor,
    };
  }
}

/** A command as the row shows it: a script runs through `bash`. */
function shownCommand(command: ShellCommand): ShellCommand {
  return isScript(command) ? { ...command, words: ["bash", ...command.words], shown: ["bash", ...command.shown] } : command;
}

/** `replaceAll` for text that arrives in pieces: a tail that can still grow
 *  into the pattern waits for the next piece unless the text ended. */
class StreamingReplacement {
  private held = "";

  constructor(private readonly pattern: string, private readonly replacement: string) {}

  push(piece: string, ended: boolean): string {
    const text = this.held + piece;
    this.held = "";
    const pattern = this.pattern;
    if (!pattern) return text;
    let out = "";
    let copied = 0;
    for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, copied)) {
      out += text.slice(copied, at) + this.replacement;
      copied = at + pattern.length;
    }
    if (!ended) {
      const first = pattern.charAt(0);
      for (let at = text.indexOf(first, Math.max(copied, text.length - pattern.length + 1)); at >= 0; at = text.indexOf(first, at + 1)) {
        if (pattern.startsWith(text.slice(at))) {
          this.held = text.slice(at);
          return out + text.slice(copied, at);
        }
      }
    }
    return out + text.slice(copied);
  }
}

function isScript(command: ShellCommand): boolean {
  return command.shown[0]?.endsWith(".sh") === true;
}

/** A whole shell command as its row shows it, and its commands as the row's
 *  sentence reads them. */
interface ShellCommandDisplay {
  readonly detail: string;
  readonly commands: readonly ShellCommand[];
}

export function shellCommandDisplay(command: string, executionCwd: string): ShellCommandDisplay {
  const stream = new ShellDetailStream(executionCwd);
  const steps = [stream.advance(command), stream.finish()];
  const shortened = steps.map((step) => step.text).join("");
  const scripts = steps.flatMap((step) => step.scripts).sort((left, right) => left - right);
  let detail = "";
  let copied = 0;
  for (const start of scripts) {
    detail += `${shortened.slice(copied, start)}bash `;
    copied = start;
  }
  return { detail: (detail + shortened.slice(copied)).trim(), commands: steps.flatMap((step) => step.complete) };
}

export function shellDetail(input: ToolInput, executionCwd: string): string | null {
  const cmd = strField(input, "command");
  // Multiline commands (heredoc scripts, inline python) keep their linebreaks;
  // the row renderer hard-breaks on them with a hanging indent.
  return cmd ? shellCommandDisplay(cmd, executionCwd).detail || null : null;
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
