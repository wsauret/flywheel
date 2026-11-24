/** Records the project files a shell command showed the model, so a later edit of them counts as read and a later
 *  write can replace a file whose whole current text the model saw.
 *
 *  Models often read a file with `cat`, `head`, `tail`, `nl`, or `sed -n` instead of the read tool, often several
 *  files in one loop, and an edit that follows would then warn that the file was not read, while a write would
 *  refuse to replace it.
 *
 *  Two records come from one command. `recordShellFileReads` infers the printed lines from the command syntax: it
 *  counts a command only when every simple command in it is one such read of one plain file argument, or an
 *  `echo`, `printf`, `true`, or `:`, joined by `&&`, `||`, or `;`. A pipe, a redirect, a substitution, an
 *  expansion, a glob, or any other shell syntax makes the whole command count for nothing. Each file is read again
 *  after the command exits, and the ledger receives the lines the command printed, with the hash of the file as it
 *  is now. A slice that output compression would shorten records nothing, since the model did not see it whole.
 *  This inference informs edit warnings only.
 *
 *  `recordShownFileVersions` proves a version from the output itself: a file that the command names, whose exact
 *  current text the output that the model received holds whole, plain or numbered as `cat -n` prints it, is a
 *  verified version in the ledger, as if the read tool had shown it. The shell form does not matter. */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalMutationPath } from "../../../../infra/file-mutation-queue.js";
import type { ResolvedShellCommands } from "./policy/bash-command-policy.js";
import { shownUncompressed } from "./execution/bash-compressor.js";
import type { LineRange } from "../files/file-read-ledger.js";
import type { ToolContext } from "../types.js";

/** The lines one command printed: all of them, the first or last `count`, or one-based inclusive `start`-`end`. */
type PrintedLines =
  | { readonly kind: "all" }
  | { readonly kind: "head"; readonly count: number }
  | { readonly kind: "tail"; readonly count: number }
  | { readonly kind: "range"; readonly start: number; readonly end: number };

interface ShellFileRead {
  readonly path: string;
  readonly lines: PrintedLines;
}

// Larger output exceeds the foreground output tail, so the model saw only part of it.
const MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_HEAD_TAIL_LINES = 10;
// `cat -n` and `nl` print a number of up to this many ASCII bytes before each line.
const LINE_NUMBER_BYTES = 8;
const NO_OP_COMMANDS = new Set(["echo", "printf", "true", ":"]);
const CAT_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["cat", new Set(["-n", "--number"])],
  ["nl", new Set<string>()],
  ["bat", new Set(["-n", "--number", "-p", "--plain"])],
  ["batcat", new Set(["-n", "--number", "-p", "--plain"])],
]);
const SED_RANGE = /^(\d+)(?:,(\d+))?p$/;

/** Records in `context.readLedger` each file that a command printed whole, when the command exited 0. `resolved` is
 *  the command policy's parse of the command; without one, nothing is recorded. */
export async function recordShellFileReads(resolved: ResolvedShellCommands | undefined, exitCode: number | undefined, context: ToolContext): Promise<void> {
  const ledger = context.readLedger;
  if (!ledger || !resolved || exitCode !== 0) return;
  const reads = shellFileReads(resolved);
  if (reads.length === 0) return;
  const position = await context.projectionReader?.capturePosition() ?? 0;
  const projectRoot = canonicalMutationPath(context.projectRoot);
  for (const read of reads) {
    const path = projectFile(resolve(context.executionCwd, read.path), projectRoot);
    if (path === undefined) continue;
    const bytes = await fileBytes(path);
    if (bytes === undefined) continue;
    const coverage = printedCoverage(read.lines, bytes);
    if (coverage === undefined) continue;
    ledger.recordInferredRead(path, createHash("sha256").update(bytes).digest("hex"), coverage, position);
  }
}

/** Marks in `context.readLedger` the current version of each project file that `command` names, by a path, or by a
 *  glob that matches it from the working directory or a directory that the command enters with `cd`, when `shown`,
 *  the output that the model received, holds the file's whole text. Empty files and text that is not UTF-8 prove
 *  nothing. */
export async function recordShownFileVersions(command: string, shown: string, context: ToolContext): Promise<void> {
  const ledger = context.readLedger;
  if (!ledger || shown === "") return;
  const shownBytes = Buffer.byteLength(shown);
  const verified: { path: string; sha256: string }[] = [];
  for (const path of await namedProjectFiles(command, context)) {
    const bytes = await fileBytes(path, shownBytes);
    if (bytes === undefined || bytes.length === 0) continue;
    let text: string;
    try {
      text = UTF8.decode(bytes);
    } catch {
      continue;
    }
    if (!shown.includes(text) && !shown.includes(catNumbered(text))) continue;
    verified.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (verified.length === 0) return;
  const position = await context.projectionReader?.capturePosition() ?? 0;
  for (const { path, sha256 } of verified) ledger.recordRead(path, sha256, "full", position);
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// Bounds the files one command can name, so a broad glob costs a bounded number of reads.
const MAX_NAMED_FILES = 64;
const WORD_SEPARATORS = /[\s;&|()<>'"`{}]+/;
const GLOB = /[*?[]/;

/** `text` as `cat -n` prints it: each line after its number, right-aligned in six columns, and a tab. */
function catNumbered(text: string): string {
  const ending = text.endsWith("\n") ? "\n" : "";
  const lines = (ending ? text.slice(0, -1) : text).split("\n");
  return lines.map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join("\n") + ending;
}

/** The project files that the words of `command` name. Words are split without shell parsing, since the output, not
 *  the syntax, proves what the model saw; a word that needs expansion other than a glob names nothing. */
async function namedProjectFiles(command: string, context: ToolContext): Promise<string[]> {
  const words = command.split(WORD_SEPARATORS).filter((word) => word !== "" && !word.startsWith("-") && !word.startsWith("~") && !word.includes("$"));
  const bases = [context.executionCwd, ...words.flatMap((word, index) => words[index - 1] === "cd" ? [resolve(context.executionCwd, word)] : [])];
  const projectRoot = canonicalMutationPath(context.projectRoot);
  const files = new Set<string>();
  const add = (path: string): boolean => {
    const file = projectFile(path, projectRoot);
    if (file !== undefined) files.add(file);
    return files.size < MAX_NAMED_FILES;
  };
  for (const word of words) {
    if (!GLOB.test(word)) {
      for (const base of isAbsolute(word) ? [word] : bases) if (!add(resolve(base, word))) return [...files];
      continue;
    }
    // A recursive glob can walk the whole project for every command that spells one, such as a search filter.
    if (word.includes("**")) continue;
    const prefix = word.slice(0, word.search(GLOB));
    const roots = isAbsolute(word) ? [/[\\/]$/.test(prefix) ? prefix : dirname(prefix)] : bases;
    for (const root of roots) {
      try {
        for await (const match of new Bun.Glob(isAbsolute(word) ? relative(root, word) : word).scan({ cwd: root, onlyFiles: true, absolute: true })) {
          if (!add(match)) return [...files];
        }
      } catch {
        // A directory that does not exist matches nothing.
      }
    }
  }
  return [...files];
}

/** The canonical form of `path` when it lies inside the canonical `projectRoot`, or undefined. */
function projectFile(path: string, projectRoot: string): string | undefined {
  const canonical = canonicalMutationPath(path);
  const fromRoot = relative(projectRoot, canonical);
  return fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot) ? undefined : canonical;
}

/** The bytes of a regular file of at most `maxBytes`, or undefined. */
async function fileBytes(path: string, maxBytes = MAX_FILE_BYTES): Promise<Uint8Array | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return await readFile(path);
  } catch {
    return undefined;
  }
}

function lineCount(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? count + 1 : count;
}

/** The bytes of one-based inclusive lines `start`-`end` of `bytes`, newlines included. */
function rangeBytes(bytes: Uint8Array, start: number, end: number): number {
  let line = 1;
  let from = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0x0a) continue;
    line += 1;
    if (line === start) from = index + 1;
    if (line > end) return index + 1 - from;
  }
  return bytes.length - from;
}

/** The ledger coverage of the printed lines, or undefined when they are none or compression would shorten them.
 *  The size counts the widest line number `cat -n` or `nl` can print, so a slice near the threshold records nothing
 *  rather than too much. */
function printedCoverage(lines: PrintedLines, bytes: Uint8Array): "full" | readonly LineRange[] | undefined {
  const total = lineCount(bytes);
  let start = 1;
  let end = total;
  if (lines.kind === "head") end = Math.min(lines.count, total);
  if (lines.kind === "tail") start = Math.max(1, total - lines.count + 1);
  if (lines.kind === "range") [start, end] = [lines.start, Math.min(lines.end, total)];
  if (total === 0 || start > end || !shownUncompressed(rangeBytes(bytes, start, end) + LINE_NUMBER_BYTES * (end - start + 1))) return undefined;
  return start === 1 && end === total ? "full" : [{ start, end }];
}

/** The file reads that make up all of a command, or none when any part of it is something else. */
function shellFileReads({ hasError, commands }: ResolvedShellCommands): ShellFileRead[] {
  if (hasError) return [];
  const reads: ShellFileRead[] = [];
  for (const { literalWords } of commands) {
    if (literalWords === undefined) return [];
    const [name = "", ...args] = literalWords;
    if (NO_OP_COMMANDS.has(name)) continue;
    const read = fileRead(name, args);
    if (read === undefined) return [];
    reads.push(read);
  }
  return reads;
}

function fileRead(name: string, args: readonly string[]): ShellFileRead | undefined {
  const catFlags = CAT_FLAGS.get(name);
  if (catFlags !== undefined) {
    const operands = args.filter((arg) => !catFlags.has(arg));
    const [path] = operands;
    return operands.length === 1 && path !== undefined && !path.startsWith("-") ? { path, lines: { kind: "all" } } : undefined;
  }
  if (name === "head" || name === "tail") {
    const counted = countedFileArgument(args);
    return counted === undefined ? undefined : { path: counted.path, lines: { kind: name, count: counted.count } };
  }
  return name === "sed" ? sedRead(args) : undefined;
}

/** `head` and `tail` arguments: one file and an optional line count as `-n N`, `-nN`, `-N`, or `--lines=N`. */
function countedFileArgument(args: readonly string[]): { path: string; count: number } | undefined {
  let count = DEFAULT_HEAD_TAIL_LINES;
  let path: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-n" || arg === "--lines") {
      const value = args[++index];
      if (value === undefined || !/^\d+$/.test(value)) return undefined;
      count = Number(value);
      continue;
    }
    const inline = /^(?:-n|--lines=|-)(\d+)$/.exec(arg);
    if (inline) {
      count = Number(inline[1]);
      continue;
    }
    if (arg.startsWith("-") || path !== undefined) return undefined;
    path = arg;
  }
  return path === undefined || count === 0 ? undefined : { path, count };
}

/** `sed -n 'Np' file` or `sed -n 'M,Np' file`; an in-place edit or any other script is not a read. */
function sedRead(args: readonly string[]): ShellFileRead | undefined {
  let quiet = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === "--quiet" || arg === "--silent") quiet = true;
    else if (arg.startsWith("--") || arg === "-e" || (arg.startsWith("-") && arg.includes("i"))) return undefined;
    else if (arg.startsWith("-")) quiet ||= arg.includes("n");
    else operands.push(arg);
  }
  const [script, path] = operands;
  const range = script === undefined ? null : SED_RANGE.exec(script);
  if (!quiet || operands.length !== 2 || path === undefined || !range) return undefined;
  const start = Number(range[1]);
  const end = range[2] === undefined ? start : Number(range[2]);
  return start === 0 ? undefined : { path, lines: { kind: "range", start, end } };
}
