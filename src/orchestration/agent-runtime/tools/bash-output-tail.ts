/**
 * Output kernel shared by the bash tool's foreground stdout stream and
 * background log tailer: display-tail slicing, byte/line bounding for the
 * durable execution-output tail, background log reading, and the result of a
 * command that settled in its tool call.
 */

import { open } from "node:fs/promises";

import { createStreamingSanitizer } from "../../../infra/control-characters.js";
import { formatDuration } from "../../../protocol/client/format.js";
import type { BackgroundOutputRequest } from "../background-work-processes.js";
import { renderShellLines, type ShellGap, type ShellLines } from "./bash-compressor.js";
import { silentFailureStderr } from "./shell-stderr.js";
import type { RetainedFullContent, ToolResult } from "./types.js";

export const EXECUTION_OUTPUT_TAIL_CHARS = 50 * 1024;
const EXECUTION_OUTPUT_TAIL_LINES = 1000;
const EXECUTION_OUTPUT_TAIL_MAX_BYTES = 256 * 1024;
const BG_LOG_TAIL_CHARS = 4 * 1024;
const SPOOL_READ_CHUNK_BYTES = 64 * 1024;
const SPOOL_SCAN_LINE_CHARS = 64 * 1024;
const SPOOL_QUERY_MATCH_CAP = 200;
const FOREGROUND_FULL_TEXT_MAX_CHARS = 1024 * 1024;
const LINE_TRUNCATION_MARKER = "...[line truncated]";
const FOREGROUND_HEAD_CHARS = 128 * 1024;
const FOREGROUND_TAIL_CHARS = 128 * 1024;
const DURATION_SUFFIX_THRESHOLD_MS = 2_000;

interface SpoolSlice {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface RandomAccessSpool {
  readonly size: number;
  slice(start: number, end: number): SpoolSlice | Uint8Array | Promise<SpoolSlice | Uint8Array>;
}

export interface ForegroundSpool {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** Open the exclusive 0600 spool file that captures foreground stdout bytes.
 *  Writes loop until every byte lands, and close releases the one handle. */
export async function openForegroundSpool(path: string): Promise<ForegroundSpool> {
  const handle = await open(path, "wx+", 0o600);
  return {
    async write(bytes) {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.write(bytes, offset, bytes.byteLength - offset);
        if (result.bytesWritten === 0) throw new Error(`Could not write foreground Bash output spool: ${path}`);
        offset += result.bytesWritten;
      }
    },
    close: () => handle.close(),
  };
}

type OpenSpool = (path: string) => RandomAccessSpool;

function openBunSpool(path: string): RandomAccessSpool {
  const file = Bun.file(path);
  return { size: file.size, slice: (start, end) => file.slice(start, end) };
}

async function sliceBytes(file: RandomAccessSpool, start: number, end: number): Promise<Uint8Array> {
  const slice = await file.slice(start, end);
  return slice instanceof Uint8Array ? slice : new Uint8Array(await slice.arrayBuffer());
}

function queryPrefixTable(query: string): number[] {
  const prefix = Array.from({ length: query.length }, () => 0);
  for (let index = 1, matched = 0; index < query.length;) {
    if (query[index] === query[matched]) prefix[index++] = ++matched;
    else if (matched > 0) matched = prefix[matched - 1] ?? 0;
    else index++;
  }
  return prefix;
}

function isMissingSpool(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function formatScannedOutput(retained: readonly string[], totalLines: number, offset: number | undefined, limit: number, query: string | undefined, truncatedLines: number): string {
  const truncation = truncatedLines > 0 ? `\n(${truncatedLines} oversized line(s) truncated)` : "";
  if (query) {
    if (retained.length === 0) return `No lines contain '${query}' (searched ${totalLines} lines).${truncation}`;
    const cap = Math.min(limit, SPOOL_QUERY_MATCH_CAP);
    const capped = retained.length === cap ? `\n(first ${retained.length} matches shown)` : "";
    return `${retained.length} matching line(s):\n${retained.join("\n")}${capped}${truncation}`;
  }
  const start = offset ?? Math.max(0, totalLines - retained.length);
  if (retained.length === 0) return `Output has ${totalLines} lines; offset ${start} is past the end.${truncation}`;
  const more = start + retained.length < totalLines ? `\n(${totalLines - start - retained.length} more lines; continue with offset ${start + retained.length})` : "";
  return `Lines ${start + 1}-${start + retained.length} of ${totalLines}:\n${retained.join("\n")}${more}${truncation}`;
}

async function scanSpoolForward(file: RandomAccessSpool, request: BackgroundOutputRequest): Promise<string> {
  const size = file.size;
  const retained: string[] = [];
  const query = request.query;
  const prefix = query ? queryPrefixTable(query) : [];
  const matchCap = Math.min(request.limit, SPOOL_QUERY_MATCH_CAP);
  let queryMatched = 0;
  let lineMatches = false;
  let linePreview = "";
  let lineTruncated = false;
  let truncatedLines = 0;
  let totalLines = 0;
  let endedWithNewline = false;

  const keepLine = (): void => {
    const bounded = lineTruncated ? `${linePreview}${LINE_TRUNCATION_MARKER}` : linePreview;
    if (lineTruncated) truncatedLines++;
    if (query) {
      if (lineMatches && retained.length < matchCap) retained.push(`${totalLines + 1}: ${bounded}`);
    } else if (request.offset !== undefined && totalLines >= request.offset && retained.length < request.limit) {
      retained.push(bounded);
    }
    totalLines++;
    linePreview = "";
    lineTruncated = false;
    queryMatched = 0;
    lineMatches = false;
  };

  const accept = (text: string): void => {
    for (const char of text) {
      if (char === "\n") {
        keepLine();
        endedWithNewline = true;
        continue;
      }
      endedWithNewline = false;
      if (linePreview.length < SPOOL_SCAN_LINE_CHARS) linePreview += char;
      else lineTruncated = true;
      if (!query || lineMatches) continue;
      for (let index = 0; index < char.length; index++) {
        const unit = char[index];
        while (queryMatched > 0 && unit !== query[queryMatched]) queryMatched = prefix[queryMatched - 1] ?? 0;
        if (unit === query[queryMatched]) queryMatched++;
        if (queryMatched === query.length) {
          lineMatches = true;
          break;
        }
      }
    }
  };

  const sanitizer = createStreamingSanitizer(accept);
  const decoder = new TextDecoder();
  let readOffset = 0;
  while (readOffset < size) {
    const end = Math.min(size, readOffset + SPOOL_READ_CHUNK_BYTES);
    const bytes = await sliceBytes(file, readOffset, end);
    if (bytes.byteLength === 0) break;
    readOffset += bytes.byteLength;
    sanitizer.push(decoder.decode(bytes, { stream: true }));
  }
  sanitizer.push(decoder.decode());
  sanitizer.finish();
  if (!endedWithNewline || totalLines === 0) keepLine();
  return formatScannedOutput(retained, totalLines, request.offset, request.limit, query, truncatedLines);
}

export interface BoundedSpoolTail {
  lines: string[];
  reachedStart: boolean;
  totalLines?: number;
  truncatedLines: number;
}

async function scanSanitizedSpool(file: RandomAccessSpool, accept: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const sanitizer = createStreamingSanitizer(accept);
  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + SPOOL_READ_CHUNK_BYTES);
    const bytes = await sliceBytes(file, offset, end);
    if (bytes.byteLength === 0) break;
    offset += bytes.byteLength;
    sanitizer.push(decoder.decode(bytes, { stream: true }));
  }
  sanitizer.push(decoder.decode());
  sanitizer.finish();
}

/** Scans normalized sanitized output forward and retains only the requested line ring and bounded current-line preview. */
export async function readBoundedSpoolTail(file: RandomAccessSpool, limit: number): Promise<BoundedSpoolTail> {
  const lines: string[] = [];
  let current = "";
  let currentTruncated = false;
  let truncatedLines = 0;
  let totalLines = 0;
  let endedWithNewline = false;

  const keepLine = (): void => {
    const line = currentTruncated ? `${current}${LINE_TRUNCATION_MARKER}` : current;
    if (currentTruncated) truncatedLines++;
    totalLines++;
    if (limit > 0) {
      lines.push(line);
      if (lines.length > limit) lines.shift();
    }
    current = "";
    currentTruncated = false;
  };

  await scanSanitizedSpool(file, (text) => {
    for (const char of text) {
      if (char === "\n") {
        keepLine();
        endedWithNewline = true;
      } else {
        endedWithNewline = false;
        if (current.length < SPOOL_SCAN_LINE_CHARS) current += char;
        else currentTruncated = true;
      }
    }
  });
  if (!endedWithNewline && (current.length > 0 || currentTruncated)) keepLine();

  return { lines, reachedStart: true, totalLines, truncatedLines };
}

function formatSpoolTail(tail: BoundedSpoolTail, limit: number): string {
  if (tail.lines.length === 0) return "Lines 1-1 of 1:\n";
  const truncation = tail.truncatedLines > 0 ? `\n(${tail.truncatedLines} oversized line(s) truncated)` : "";
  if (!tail.reachedStart) return `Last ${tail.lines.length} lines:\n${tail.lines.join("\n")}${truncation}`;
  return formatScannedOutput(tail.lines, tail.totalLines ?? tail.lines.length, undefined, limit, undefined, tail.truncatedLines);
}

async function scanSpoolTail(file: RandomAccessSpool, limit: number): Promise<string> {
  return formatSpoolTail(await readBoundedSpoolTail(file, limit), limit);
}

/** Reads and formats one bounded process-output request without materializing the Bash spool. */
export async function readBackgroundProcessOutput(logPath: string, request: BackgroundOutputRequest, openSpool: OpenSpool = openBunSpool): Promise<string> {
  try {
    const file = openSpool(logPath);
    return request.offset === undefined && request.query === undefined
      ? await scanSpoolTail(file, request.limit)
      : await scanSpoolForward(file, request);
  } catch (error) {
    if (isMissingSpool(error)) return "Lines 1-1 of 1:\n";
    throw error;
  }
}


/** Bounds sanitized settled display text by the existing line and UTF-8 byte limits. */
export function boundedExecutionOutputTail(sanitized: string): string {
  const lines = sanitized.split("\n");
  const lineBounded = lines.length > EXECUTION_OUTPUT_TAIL_LINES
    ? lines.slice(sanitized.endsWith("\n") ? -(EXECUTION_OUTPUT_TAIL_LINES + 1) : -EXECUTION_OUTPUT_TAIL_LINES).join("\n")
    : sanitized;
  const encoder = new TextEncoder();
  if (encoder.encode(lineBounded).byteLength <= EXECUTION_OUTPUT_TAIL_MAX_BYTES) return lineBounded;
  let low = 0;
  let high = lineBounded.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (encoder.encode(lineBounded.slice(middle)).byteLength <= EXECUTION_OUTPUT_TAIL_MAX_BYTES) high = middle;
    else low = middle + 1;
  }
  let start = low;
  if (start > 0 && /[\uDC00-\uDFFF]/.test(lineBounded[start] ?? "")) start++;
  return lineBounded.slice(start);
}

/** A command's settled foreground output. A `complete` view holds all of
 *  its sanitized text. A `bounded` view keeps a head and a tail around an
 *  exactly counted gap, and names the retained file that holds every byte. */
export type ForegroundView =
  | { readonly kind: "complete"; readonly text: string }
  | { readonly kind: "bounded"; readonly head: string; readonly tail: string; readonly gap: ShellGap; readonly file: RetainedFullContent };

export interface SettledShellOutput {
  readonly foreground: ForegroundView;
  readonly notificationTail: string;
  readonly executionOutputTail: string;
}
interface ShellOutputAccumulator {
  push(text: string): void;
  /** Counts and hashes raw output bytes as they reach the retained file. */
  addBytes(bytes: Uint8Array): void;
  reset(): void;
  displayTail(): string;
  finalize(logPath: string): SettledShellOutput;
}

interface BoundedTextChunks {
  append(text: string): void;
  clear(): void;
  text(): string;
}

function boundedTextChunks(limit: number): BoundedTextChunks {
  let chunks: string[] = [];
  let first = 0;
  let length = 0;
  return {
    append(text) {
      if (!text) return;
      chunks.push(text);
      length += text.length;
      let excess = length - limit;
      while (excess > 0 && first < chunks.length) {
        const chunk = chunks[first] ?? "";
        if (chunk.length <= excess) {
          excess -= chunk.length;
          length -= chunk.length;
          first++;
        } else {
          chunks[first] = chunk.slice(excess);
          length -= excess;
          excess = 0;
        }
      }
      if (first > 1024 && first * 2 > chunks.length) {
        chunks = chunks.slice(first);
        first = 0;
      }
    },
    clear() {
      chunks = [];
      first = 0;
      length = 0;
    },
    text: () => chunks.slice(first).join(""),
  };
}

function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
  return count;
}

/** Cuts the head after its last newline and the tail after its first, so
 *  the gap holds whole lines and its count is exact from the running
 *  newline total. A window without a newline stays a fragment of one long
 *  line, and the gap then counts characters. */
function boundedView(headWindow: string, tailWindow: string, totalChars: number, totalNewlines: number, file: RetainedFullContent): ForegroundView {
  const headEnd = headWindow.lastIndexOf("\n");
  const tailStart = tailWindow.indexOf("\n");
  const head = headEnd === -1 ? headWindow : headWindow.slice(0, headEnd + 1);
  const tail = tailStart === -1 ? tailWindow : tailWindow.slice(tailStart + 1);
  const gap: ShellGap = headEnd === -1 || tailStart === -1
    ? { unit: "characters", count: totalChars - head.length - tail.length }
    : { unit: "lines", count: totalNewlines - countNewlines(head) - countNewlines(tail) };
  return { kind: "bounded", head, tail, gap, file };
}

/** Accumulates one bounded, sanitized view while output is consumed and settles it once. */
export function createShellOutputAccumulator(): ShellOutputAccumulator {
  let head = "";
  const tail = boundedTextChunks(FOREGROUND_FULL_TEXT_MAX_CHARS);
  let totalChars = 0;
  let totalNewlines = 0;
  let retainedBytes = 0;
  let hasher = new Bun.CryptoHasher("sha256");
  let settled: SettledShellOutput | undefined;

  return {
    push(text) {
      if (settled) throw new Error("Shell output arrived after settlement");
      if (head.length < FOREGROUND_HEAD_CHARS) head += text.slice(0, FOREGROUND_HEAD_CHARS - head.length);
      tail.append(text);
      totalChars += text.length;
      totalNewlines += countNewlines(text);
    },
    addBytes(bytes) {
      if (settled) throw new Error("Shell output arrived after settlement");
      retainedBytes += bytes.byteLength;
      hasher.update(bytes);
    },
    reset() {
      if (settled) throw new Error("Shell output reset after settlement");
      head = "";
      tail.clear();
      totalChars = 0;
      totalNewlines = 0;
      retainedBytes = 0;
      hasher = new Bun.CryptoHasher("sha256");
    },
    displayTail: () => tail.text().slice(-EXECUTION_OUTPUT_TAIL_CHARS),
    finalize(logPath) {
      if (settled) return settled;
      const retainedTail = tail.text();
      // Bounded once the retained text lost characters; sanitized text can be
      // far shorter than its bytes, and then every character is still here.
      const foreground: ForegroundView = totalChars > FOREGROUND_FULL_TEXT_MAX_CHARS
        ? boundedView(head, retainedTail.slice(-FOREGROUND_TAIL_CHARS), totalChars, totalNewlines, { path: logPath, bytes: retainedBytes, sha256: hasher.digest("hex") })
        : { kind: "complete", text: retainedTail };
      settled = {
        foreground,
        notificationTail: retainedTail.slice(-BG_LOG_TAIL_CHARS).trim(),
        executionOutputTail: boundedExecutionOutputTail(retainedTail),
      };
      return settled;
    },
  };
}

/** The real lines of one captured segment. A terminating newline ends the
 *  last line and does not start another, so blank lines are kept and none
 *  is added. */
function segmentLines(segment: string): string[] {
  if (segment === "") return [];
  return (segment.endsWith("\n") ? segment.slice(0, -1) : segment).split("\n");
}

function foregroundLines(foreground: ForegroundView): ShellLines {
  if (foreground.kind === "complete") return { head: segmentLines(foreground.text), tail: [] };
  return { head: segmentLines(foreground.head), gap: foreground.gap, tail: segmentLines(foreground.tail) };
}

/** The model-facing text of one settled foreground command, with the
 *  recovery source the tool-output boundary needs when lines were dropped:
 *  the complete text when a rule dropped lines, or the retained file of a
 *  bounded capture. */
interface ShellObservation extends Pick<ToolResult, "fullContent" | "retainedFullContent"> {
  readonly text: string;
}

/** Shapes one settled foreground command for the model. `raw` keeps every
 *  captured line. Whitespace-only output is no output; other output keeps
 *  its blank lines. */
export function shellObservation(command: string, foreground: ForegroundView, raw: boolean): ShellObservation {
  if (foreground.kind === "complete" && foreground.text.trim() === "") return { text: "" };
  const rendered = renderShellLines(command, foregroundLines(foreground), raw);
  if (foreground.kind === "bounded") return { text: rendered.output, retainedFullContent: foreground.file };
  return rendered.compressed ? { text: rendered.output, fullContent: foreground.text } : { text: rendered.output };
}

/** The tool result of a command that settled in its tool call, whichever
 *  path ran it: its output, a note when its deadline ended it, a stderr note
 *  when it failed with no output, and its exit code with the duration of a
 *  slow run. A deadline reports exit code 124, as `timeout` does. */
export function settledForegroundResult(input: {
  readonly command: string;
  readonly rawOutput: boolean;
  readonly settled: { readonly exit: { readonly code: number | null }; readonly output: SettledShellOutput; readonly durationMs: number };
  readonly stderrTail: string;
  /** The deadline in seconds, when it ended the command. */
  readonly expiredDeadlineSec: number | undefined;
}): ToolResult {
  const { command, rawOutput, settled: { exit, output, durationMs }, expiredDeadlineSec } = input;
  const timedOut = expiredDeadlineSec !== undefined;
  const { text, ...recovery } = shellObservation(command, output.foreground, rawOutput);
  const exitCode = timedOut ? 124 : (exit.code ?? 1);
  const parts: string[] = [];
  if (timedOut) parts.push(`[Command timed out after ${expiredDeadlineSec}s; killed] Inspect useful partial output or artifacts, and complete required work without blindly repeating the destructive deadline.`);
  if (text) parts.push(text);
  else if (!timedOut) parts.push("(no output)");
  const stderrNote = silentFailureStderr(exitCode, text, input.stderrTail);
  if (stderrNote) parts.push(stderrNote);
  parts.push(durationMs >= DURATION_SUFFIX_THRESHOLD_MS ? `[exit code: ${exitCode} in ${formatDuration(durationMs)}]` : `[exit code: ${exitCode}]`);
  return {
    content: parts.join("\n"),
    outcome: timedOut ? "error" : "ok",
    details: { background: false, exitCode, durationMs },
    ...recovery,
    ...(output.executionOutputTail ? { executionOutputTail: output.executionOutputTail } : {}),
  };
}

async function readSanitizedTail(file: RandomAccessSpool, tailChars: number): Promise<string> {
  let tail = "";
  await scanSanitizedSpool(file, (text) => {
    tail = (tail + text.slice(-tailChars)).slice(-tailChars);
  });
  return tail;
}

/** Reads one bounded growth interval while preserving decoder and sanitizer state between 64 KiB reads. */
export async function readSpoolGrowth(file: RandomAccessSpool, start: number, accept: (bytes: Uint8Array) => void): Promise<number> {
  const size = file.size;
  let offset = start;
  while (offset < size) {
    const end = Math.min(size, offset + SPOOL_READ_CHUNK_BYTES);
    const bytes = await sliceBytes(file, offset, end);
    if (bytes.byteLength === 0) break;
    offset += bytes.byteLength;
    accept(bytes);
  }
  return offset;
}

// The log belongs to a detached process; it may be missing or half-flushed
// when the exit races the last write, so absence reads as empty.
export async function readBackgroundLog(logPath: string, openSpool: OpenSpool = openBunSpool): Promise<{ notificationTail: string; executionOutputTail: string }> {
  try {
    const file = openSpool(logPath);
    const tail = await readSanitizedTail(file, EXECUTION_OUTPUT_TAIL_MAX_BYTES);
    return {
      notificationTail: tail.slice(-BG_LOG_TAIL_CHARS).trim(),
      executionOutputTail: boundedExecutionOutputTail(tail),
    };
  } catch (error) {
    if (isMissingSpool(error)) return { notificationTail: "", executionOutputTail: "" };
    throw error;
  }
}

/** Emits already-sanitized accumulated live output and suppresses unchanged payloads. */
export function createTailEmitter(emit: (text: string) => void): (buffer: string) => boolean {
  let last = "";
  return (buffer) => {
    if (buffer === last) return false;
    last = buffer;
    emit(buffer);
    return true;
  };
}
