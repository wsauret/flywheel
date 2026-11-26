/** Parser for the Codex V4A patch envelope.
 *
 *  Derived from OpenAI Codex apply-patch `parser.rs` (Apache-2.0), through the
 *  OpenClaw TypeScript port (MIT). Flywheel bounds the input, accepts the
 *  heredoc wrapper and whitespace-padded markers models emit, and produces a
 *  prepared patch whose paths are known before any filesystem admission. */

import { FILE_EDIT_LIMITS, type FileEditLimits, FileEditPlanError, limitExceeded } from "./contract.js";
import {
  ADD_FILE_MARKER,
  BEGIN_PATCH_MARKER,
  CHANGE_CONTEXT_MARKER,
  DELETE_FILE_MARKER,
  EMPTY_CHANGE_CONTEXT_MARKER,
  END_PATCH_MARKER,
  ENVIRONMENT_ID_MARKER,
  EOF_MARKER,
  HEREDOC_OPENERS,
  isPatchHeader,
  MOVE_TO_MARKER,
  UPDATE_FILE_MARKER,
} from "./patch-syntax.js";

/** One `@@` section of an update. `contextLineIndices` pairs each context line's position in
 *  `oldLines` with its position in `newLines`; the two drift apart across deleted and inserted lines. */
export interface PreparedChunk {
  readonly changeContext?: string;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  readonly contextLineIndices: readonly (readonly [oldIndex: number, newIndex: number])[];
  readonly isEndOfFile: boolean;
}

export type PreparedOperation =
  | { readonly kind: "add"; readonly path: string; readonly contents: string }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "update"; readonly path: string; readonly movePath?: string; readonly chunks: readonly PreparedChunk[] };

export interface PreparedPatch {
  readonly operations: readonly PreparedOperation[];
  /** Every executable source and move destination, sorted and unique. */
  readonly paths: readonly string[];
  readonly environmentId?: string;
  readonly ignoredEmptyUpdates?: readonly string[];
  readonly ignoredEmptyHunks?: number;
}

interface MutableChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  contextLineIndices: (readonly [number, number])[];
  isEndOfFile: boolean;
}

function newChunk(changeContext?: string): MutableChunk {
  return { ...(changeContext === undefined ? {} : { changeContext }), oldLines: [], newLines: [], contextLineIndices: [], isEndOfFile: false };
}

function pushContextLine(chunk: MutableChunk, line: string): void {
  chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
  chunk.oldLines.push(line);
  chunk.newLines.push(line);
}

function isEmptyChunk(chunk: MutableChunk | undefined): boolean {
  return chunk !== undefined && chunk.oldLines.length === 0 && chunk.newLines.length === 0;
}

function invalidPatch(message: string): FileEditPlanError {
  return new FileEditPlanError(`invalid patch: ${message}`);
}

function invalidHunk(message: string, lineNumber: number): FileEditPlanError {
  return new FileEditPlanError(`invalid hunk at line ${lineNumber}, ${message}`);
}

function invalidHeader(line: string, lineNumber: number): FileEditPlanError {
  return invalidHunk(`'${line.trim()}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`, lineNumber);
}

function isHeader(line: string): boolean {
  return isPatchHeader(line);
}

function parsePath(path: string, limits: FileEditLimits, lineNumber: number): string {
  if (path.length === 0) throw invalidHunk("path cannot be empty", lineNumber);
  if (Buffer.byteLength(path, "utf8") > limits.maxPathBytes) throw limitExceeded("path bytes");
  return path;
}

/** Strips the shell heredoc wrapper a model sometimes includes around the envelope. */
function unwrapHeredoc(lines: readonly string[]): readonly string[] {
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first !== undefined && last !== undefined && lines.length >= 4 && HEREDOC_OPENERS.has(first) && last.endsWith("EOF")) return lines.slice(1, -1);
  return lines;
}

type PendingOperation =
  | { readonly kind: "add"; readonly path: string; contents: string }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "update"; readonly path: string; movePath?: string; readonly chunks: MutableChunk[] };

/** Incrementally parses executable operation lines. A completed operation is emitted only when a
 * following operation header or the caller's completed envelope establishes its boundary. */
export class PatchOperationParser {
  private readonly limits: FileEditLimits;
  private pending?: PendingOperation;
  private readonly paths = new Set<string>();
  private environmentId?: string;
  private operationCount = 0;
  private readonly ignoredEmptyUpdates: string[] = [];
  private ignoredEmptyHunks = 0;

  constructor(limits: FileEditLimits = FILE_EDIT_LIMITS) {
    this.limits = limits;
  }

  append(line: string, lineNumber: number): PreparedOperation[] {
    const trimmed = line.trim();
    if (isHeader(line)) {
      const completed = this.flush(lineNumber);
      if (trimmed === END_PATCH_MARKER) return completed;
      this.start(trimmed, lineNumber);
      return completed;
    }
    if (trimmed.startsWith(ENVIRONMENT_ID_MARKER) && (this.pending === undefined || this.pending.kind === "delete")) {
      const completed = this.flush(lineNumber);
      if (this.environmentId !== undefined) throw invalidPatch("apply_patch environment_id cannot be specified more than once");
      const value = trimmed.slice(ENVIRONMENT_ID_MARKER.length).trim();
      if (value.length === 0) throw invalidPatch("apply_patch environment_id cannot be empty");
      this.environmentId = value;
      return completed;
    }
    if (this.pending === undefined) {
      throw invalidHeader(trimmed, lineNumber);
    }
    this.appendOperationLine(line, lineNumber);
    return [];
  }

  finish(lineNumber: number): PreparedPatch {
    const operations = this.flush(lineNumber);
    return {
      operations, paths: [...this.paths].sort(),
      ...(this.environmentId === undefined ? {} : { environmentId: this.environmentId }),
      ...(this.ignoredEmptyUpdates.length === 0 ? {} : { ignoredEmptyUpdates: this.ignoredEmptyUpdates }),
      ...(this.ignoredEmptyHunks === 0 ? {} : { ignoredEmptyHunks: this.ignoredEmptyHunks }),
    };
  }

  private start(header: string, lineNumber: number): void {
    if (this.operationCount >= this.limits.maxHunks) throw new FileEditPlanError("patch exceeds hunks limit");
    this.operationCount += 1;
    if (header.startsWith(ADD_FILE_MARKER)) this.pending = { kind: "add", path: parsePath(header.slice(ADD_FILE_MARKER.length), this.limits, lineNumber), contents: "" };
    else if (header.startsWith(DELETE_FILE_MARKER)) {
      const path = parsePath(header.slice(DELETE_FILE_MARKER.length), this.limits, lineNumber);
      this.pending = { kind: "delete", path };
    } else if (header.startsWith(UPDATE_FILE_MARKER)) {
      this.pending = { kind: "update", path: parsePath(header.slice(UPDATE_FILE_MARKER.length), this.limits, lineNumber), chunks: [] };
    } else throw invalidHeader(header, lineNumber);
  }

  private appendOperationLine(line: string, lineNumber: number): void {
    const pending = this.pending;
    if (pending?.kind === "add") {
      if (!line.startsWith("+")) throw invalidHeader(line, lineNumber);
      pending.contents += `${line.slice(1)}\n`;
      if (Buffer.byteLength(pending.contents, "utf8") > this.limits.maxOutputBytes) throw limitExceeded("output bytes");
      return;
    }
    if (pending?.kind === "delete") throw invalidHeader(line, lineNumber);
    if (pending === undefined) throw invalidHeader(line, lineNumber);
    const updateLine = line.trimEnd();
    const last = pending.chunks[pending.chunks.length - 1];
    if (updateLine.startsWith(MOVE_TO_MARKER) && pending.chunks.length === 0 && pending.movePath === undefined) {
      pending.movePath = parsePath(updateLine.slice(MOVE_TO_MARKER.length), this.limits, lineNumber);
      return;
    }
    if (updateLine.length === 0 && last?.isEndOfFile) return;
    if (updateLine === EMPTY_CHANGE_CONTEXT_MARKER || updateLine.startsWith(CHANGE_CONTEXT_MARKER)) {
      pending.chunks.push(newChunk(updateLine.startsWith(CHANGE_CONTEXT_MARKER) ? updateLine.slice(CHANGE_CONTEXT_MARKER.length) : undefined));
      return;
    }
    if (pending.chunks.length === 0) pending.chunks.push(newChunk());
    // SAFETY: the preceding push guarantees that the update has a final chunk.
    const chunk = pending.chunks[pending.chunks.length - 1]!;
    if (updateLine === EOF_MARKER) {
      chunk.isEndOfFile = true;
    } else if (line.length === 0) pushContextLine(chunk, "");
    else if (line.startsWith(" ")) pushContextLine(chunk, line.slice(1));
    else if (line.startsWith("+")) chunk.newLines.push(line.slice(1));
    else if (line.startsWith("-")) chunk.oldLines.push(line.slice(1));
    else throw invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${line}'`, lineNumber);
  }

  private flush(lineNumber: number): PreparedOperation[] {
    const pending = this.pending;
    this.pending = undefined;
    if (pending === undefined) return [];
    let operation: PreparedOperation;
    if (pending.kind === "add") operation = { kind: "add", path: pending.path, contents: pending.contents };
    else if (pending.kind === "delete") operation = pending;
    else {
      const chunks = pending.chunks.filter(chunk => !isEmptyChunk(chunk));
      if (chunks.length === 0 && pending.movePath !== undefined) throw invalidHunk("A move must include a non-empty update hunk", lineNumber);
      this.ignoredEmptyHunks += pending.chunks.length - chunks.length;
      if (chunks.length === 0) {
        this.ignoredEmptyUpdates.push(pending.path);
        return [];
      }
      operation = { kind: "update", path: pending.path, ...(pending.movePath === undefined ? {} : { movePath: pending.movePath }), chunks };
    }
    this.recordPath(operation.path);
    if (operation.kind === "update" && operation.movePath !== undefined) this.recordPath(operation.movePath);
    return [operation];
  }

  private recordPath(path: string): void {
    this.paths.add(path);
  }
}

/** Parses one complete envelope. Refuses malformed input and input beyond the limits before any path is touched. */
export function preparePatch(patch: string, limits: FileEditLimits = FILE_EDIT_LIMITS): PreparedPatch {
  if (Buffer.byteLength(patch, "utf8") > limits.maxPatchBytes) throw new FileEditPlanError("patch exceeds patch bytes limit");
  let lines: readonly string[] = patch.trim().split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.length > limits.maxLines) throw new FileEditPlanError("patch exceeds lines limit");
  if (lines[0]?.trim() !== BEGIN_PATCH_MARKER) lines = unwrapHeredoc(lines);
  if (lines[0]?.trim() !== BEGIN_PATCH_MARKER) throw invalidPatch("The first line of the patch must be '*** Begin Patch'");
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === END_PATCH_MARKER);
  if (endIndex < 0) throw invalidPatch("The last line of the patch must be '*** End Patch'");

  const parser = new PatchOperationParser(limits);
  const operations: PreparedOperation[] = [];
  for (const [index, line] of lines.slice(1, endIndex).entries()) operations.push(...parser.append(line, index + 2));
  const completed = parser.finish(endIndex + 1);
  operations.push(...completed.operations);
  return { ...completed, operations };
}
