/** Records the project files a successful shell command printed whole, so a later edit of them counts as read.
 *
 *  Models often read a file with `cat`, `head`, `tail`, `nl`, or `sed -n` instead of the read tool, and an edit
 *  that follows would then warn that the file was not read.
 *
 *  A command counts only when every simple command in it is one such read of one plain file argument, or an `echo`,
 *  `printf`, `true`, or `:`, joined by `&&`, `||`, or `;`. A pipe, a redirect, a substitution, an expansion, a glob,
 *  or any other shell syntax makes the whole command count for nothing. Each file is read again after the command
 *  exits, and the ledger receives the lines the command printed, with the hash of the file as it is now. A slice
 *  that output compression would shorten records nothing, since the model did not see it whole. */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Node } from "web-tree-sitter";

import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import { shownUncompressed } from "./bash-compressor.js";
import { bashCommandNodes, loadBashParser } from "./bash-parser.js";
import type { LineRange } from "./file-read-ledger.js";
import type { ToolContext } from "./types.js";

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
const CANDIDATE = /\b(?:cat|nl|bat|batcat|head|tail|sed)\b/;
const NO_OP_COMMANDS = new Set(["echo", "printf", "true", ":"]);
const CAT_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["cat", new Set(["-n", "--number"])],
  ["nl", new Set<string>()],
  ["bat", new Set(["-n", "--number", "-p", "--plain"])],
  ["batcat", new Set(["-n", "--number", "-p", "--plain"])],
]);
const SED_RANGE = /^(\d+)(?:,(\d+))?p$/;
const GLOB = /[*?[]/;

/** Records each file `command` printed whole in `context.readLedger`, when the command exited 0. */
export async function recordShellFileReads(command: string, exitCode: number | undefined, context: ToolContext): Promise<void> {
  const ledger = context.readLedger;
  if (!ledger || exitCode !== 0 || !CANDIDATE.test(command)) return;
  const reads = await shellFileReads(command);
  if (reads.length === 0) return;
  const projectRoot = canonicalMutationPath(context.projectRoot);
  const position = await context.projectionReader?.capturePosition() ?? 0;
  for (const read of reads) {
    const path = canonicalMutationPath(isAbsolute(read.path) ? read.path : resolve(context.executionCwd, read.path));
    const fromRoot = relative(projectRoot, path);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) continue;
    const bytes = await fileBytes(path);
    if (bytes === undefined) continue;
    const coverage = printedCoverage(read.lines, bytes);
    if (coverage === undefined) continue;
    ledger.recordRead(path, createHash("sha256").update(bytes).digest("hex"), coverage, position);
  }
}

async function fileBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
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

/** The file reads that make up all of `command`, or none when any part of it is something else. */
async function shellFileReads(command: string): Promise<ShellFileRead[]> {
  const parser = await loadBashParser().catch(() => undefined);
  const tree = parser?.parse(command);
  if (!tree) return [];
  try {
    if (tree.rootNode.hasError) return [];
    const reads: ShellFileRead[] = [];
    for (const node of bashCommandNodes(tree.rootNode)) {
      if (node.parent?.type !== "program" && node.parent?.type !== "list") return [];
      const words = commandWords(node);
      if (words === undefined) return [];
      const [name = "", ...args] = words;
      if (NO_OP_COMMANDS.has(name)) continue;
      const read = fileRead(name, args);
      if (read === undefined) return [];
      reads.push(read);
    }
    return reads;
  } finally {
    tree.delete();
  }
}

/** The literal words of a simple command, or undefined when any word needs the shell to expand it. */
function commandWords(node: Node): string[] | undefined {
  const words: string[] = [];
  for (const child of node.children) {
    if (!child) return undefined;
    const part = child.type === "command_name" ? child.firstChild : child;
    if (!part) return undefined;
    if (part.type === "raw_string") words.push(part.text.slice(1, -1));
    else if (part.type === "string" && part.namedChildCount === 0) words.push(part.text.slice(1, -1).replace(/\\(["\\$`])/g, "$1"));
    else if ((part.type === "word" || part.type === "number") && !GLOB.test(part.text) && !part.text.startsWith("~")) words.push(part.text.replace(/\\(.)/g, "$1"));
    else return undefined;
  }
  return words;
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
