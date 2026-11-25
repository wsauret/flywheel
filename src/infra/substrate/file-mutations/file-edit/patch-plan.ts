/** Plans a prepared patch against caller-owned file snapshots.
 *
 *  Derived from OpenAI Codex apply-patch `file_update.rs` (Apache-2.0). Each
 *  update chunk seeks forward from the previous chunk's match, context lines
 *  keep their exact source bytes, and only the changed segments are replaced.
 *  A move publishes its destination and deletes its source. The planner reads
 *  no path and writes nothing: it reports old and new content, the UTF-8 byte
 *  spans an update replaced, and the loosest tier that had to match. */

import { type ByteSpan, FILE_EDIT_LIMITS, type FileEditLimits, FileEditPlanError, limitExceeded } from "./contract.js";
import type { PreparedChunk, PreparedOperation, PreparedPatch } from "./patch-parser.js";
import { applyIndentDelta, SEEK_MATCH_KINDS, type SeekMatchKind, seekSequence } from "./seek-sequence.js";
import { type LineReplacement, SourceFile } from "./text-file.js";
import { nearestSourceLines } from "./string-edit.js";

export interface FileSnapshot {
  readonly path: string;
  /** Absent when the path does not exist. */
  readonly content?: string;
}

export type PatchPlan =
  | { readonly kind: "add"; readonly path: string; readonly newContent: string; readonly overwrittenContent?: string }
  | { readonly kind: "delete"; readonly path: string; readonly oldContent: string }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly movePath?: string;
      readonly oldContent: string;
      readonly newContent: string;
      /** Content the move destination held before the move overwrote it. */
      readonly overwrittenContent?: string;
      readonly spans: readonly ByteSpan[];
      readonly matchKind: SeekMatchKind;
    };

interface AppliedUpdate {
  readonly content: string;
  readonly spans: readonly ByteSpan[];
  readonly matchKind: SeekMatchKind;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function loosest(left: SeekMatchKind, right: SeekMatchKind): SeekMatchKind {
  return SEEK_MATCH_KINDS.indexOf(right) > SEEK_MATCH_KINDS.indexOf(left) ? right : left;
}

function missingFile(path: string): FileEditPlanError {
  return new FileEditPlanError(`file does not exist: ${path}`);
}

/** Stateful forward matcher for update chunks. Each append starts after the previous match. */
class UpdatePlanningCursor {
  private readonly path: string;
  private readonly file: SourceFile;
  private readonly originalLines: readonly string[];
  private readonly replacements: LineReplacement[] = [];
  private readonly spans: ByteSpan[] = [];
  private lineIndex = 0;
  private matchKind: SeekMatchKind = "exact";

  constructor(path: string, source: string) {
    this.path = path;
    this.file = SourceFile.parse(source);
    this.originalLines = this.file.lineTexts();
  }

  append(chunk: PreparedChunk): void {
    const replace = (start: number, oldLength: number, lines: readonly string[]) => {
      this.replacements.push({ start, oldLength, lines });
      this.spans.push(this.file.byteSpan(start, oldLength));
    };
    if (chunk.changeContext !== undefined) {
      const context = seekSequence(this.originalLines, [chunk.changeContext], this.lineIndex, false);
      if (!context) throw new FileEditPlanError(`Failed to find context '${chunk.changeContext}' in ${this.path}`);
      this.lineIndex = context.index + 1;
      this.matchKind = loosest(this.matchKind, context.kind);
    }
    if (chunk.oldLines.length === 0) {
      replace(this.originalLines.length, 0, chunk.newLines);
      return;
    }
    let pattern = chunk.oldLines;
    let replacement = chunk.newLines;
    let found = seekSequence(this.originalLines, pattern, this.lineIndex, chunk.isEndOfFile);
    if (!found && pattern[pattern.length - 1] === "") {
      // A hunk may end with an empty line that stands for the file's final newline, which the line
      // model keeps on the preceding line. Retry without that sentinel.
      pattern = pattern.slice(0, -1);
      if (replacement[replacement.length - 1] === "") replacement = replacement.slice(0, -1);
      found = seekSequence(this.originalLines, pattern, this.lineIndex, chunk.isEndOfFile);
    }
    // Context drift stays a refusal for now, but it is the largest remaining tool-call retry cost: from
    // 2026-08-06 to 2026-10-24 it caused 759 failed calls and $74 of priced retries. Usually one line of
    // the hunk differs from the file, such as `export interface` for `interface`. A tier that applied
    // the hunk anyway would accept a line that the model misremembered, and the new text, which the
    // model wrote from that memory, can then be wrong, for example by adding an `export` that should
    // not be there. Revisit when a recovery can show that the replacement is still what the model meant.
    if (!found) {
      const nearest = nearestSourceLines(this.originalLines.slice(this.lineIndex).join("\n"), chunk.oldLines.join("\n"))[0];
      const start = this.lineIndex + (nearest?.lineNumber ?? 1) - 1;
      const actual = this.originalLines.slice(start, start + Math.min(chunk.oldLines.length + 4, 20))
        .map((line, index) => `${start + index + 1}|${line}`).join("\n");
      throw new FileEditPlanError(`Failed to find expected lines in ${this.path}:\n${chunk.oldLines.join("\n")}\nActual file lines near the expected location:\n${actual}`);
    }
    this.matchKind = loosest(this.matchKind, found.kind);
    replacement = applyIndentDelta(replacement, found.indentDelta);
    // Context lines stay in place with their exact bytes and endings; only the segments between
    // them are replaced, so a file with mixed endings keeps every untouched boundary.
    let oldStart = 0;
    let newStart = 0;
    for (const [oldContext, newContext] of chunk.contextLineIndices) {
      if (oldContext >= pattern.length || newContext >= replacement.length) break;
      if (oldStart !== oldContext || newStart !== newContext) replace(found.index + oldStart, oldContext - oldStart, replacement.slice(newStart, newContext));
      oldStart = oldContext + 1;
      newStart = newContext + 1;
    }
    if (oldStart !== pattern.length || newStart !== replacement.length) replace(found.index + oldStart, pattern.length - oldStart, replacement.slice(newStart));
    this.lineIndex = found.index + pattern.length;
  }

  finish(): AppliedUpdate {
    this.replacements.sort((left, right) => left.start - right.start);
    this.file.applyReplacements(this.replacements);
    return { content: this.file.contents(), spans: this.spans, matchKind: this.matchKind };
  }
}

/** Applies the update chunks to `source` and reports the new text with the byte spans it replaced. */
function deriveNewContents(path: string, source: string, chunks: readonly PreparedChunk[]): AppliedUpdate {
  const cursor = new UpdatePlanningCursor(path, source);
  for (const chunk of chunks) cursor.append(chunk);
  return cursor.finish();
}

function retainedBytes(plan: PatchPlan): number {
  switch (plan.kind) {
    case "add":
      return utf8Length(plan.newContent) + utf8Length(plan.overwrittenContent ?? "");
    case "delete":
      return utf8Length(plan.oldContent);
    case "update":
      return utf8Length(plan.oldContent) + utf8Length(plan.newContent) + utf8Length(plan.overwrittenContent ?? "");
  }
}

/** Plans every operation in order over the snapshots. One path may be touched several times; each
 *  later operation sees the content the earlier one produced. Any failure yields no plan at all. */
export class PatchPlanningCursor {
  private readonly limits: FileEditLimits;
  private readonly files = new Map<string, string>();
  private readonly admittedPaths = new Set<string>();
  private readonly modifiedPaths = new Set<string>();
  private readonly planned: PatchPlan[] = [];
  private retained = 0;
  private snapshotBytes = 0;
  private operationCount = 0;

  constructor(snapshots: readonly FileSnapshot[], limits: FileEditLimits = FILE_EDIT_LIMITS) {
    this.limits = limits;
    for (const snapshot of snapshots) this.admitSnapshot(snapshot);
  }

  /** Admits one initial filesystem view. Later admission never replaces a path changed by this cursor. */
  admitSnapshot(snapshot: FileSnapshot): void {
    if (this.admittedPaths.has(snapshot.path) || this.modifiedPaths.has(snapshot.path)) return;
    this.admittedPaths.add(snapshot.path);
    if (snapshot.content === undefined) return;
    this.snapshotBytes += utf8Length(snapshot.content);
    if (this.snapshotBytes > this.limits.maxOutputBytes) throw new FileEditPlanError("snapshots exceed output bytes limit");
    this.files.set(snapshot.path, snapshot.content);
  }

  append(operation: PreparedOperation): PatchPlan {
    this.operationCount += 1;
    if (this.operationCount > this.limits.maxHunks) throw limitExceeded("hunks");
    if (utf8Length(operation.path) > this.limits.maxPathBytes) throw limitExceeded("path bytes");
    let plan: PatchPlan;
    if (operation.kind === "add") {
      if (utf8Length(operation.contents) > this.limits.maxOutputBytes) throw limitExceeded("output bytes");
      const overwrittenContent = this.files.get(operation.path);
      this.files.set(operation.path, operation.contents);
      plan = { kind: "add", path: operation.path, newContent: operation.contents, ...(overwrittenContent === undefined ? {} : { overwrittenContent }) };
      const recorded = this.record(plan);
      this.modifiedPaths.add(operation.path);
      return recorded;
    }
    const oldContent = this.files.get(operation.path);
    if (oldContent === undefined) throw missingFile(operation.path);
    if (operation.kind === "delete") {
      this.files.delete(operation.path);
      const recorded = this.record({ kind: "delete", path: operation.path, oldContent });
      this.modifiedPaths.add(operation.path);
      return recorded;
    }
    const update = deriveNewContents(operation.path, oldContent, operation.chunks);
    if (utf8Length(update.content) > this.limits.maxOutputBytes) throw limitExceeded("output bytes");
    const destination = operation.movePath ?? operation.path;
    let overwrittenContent: string | undefined;
    if (destination !== operation.path) {
      overwrittenContent = this.files.get(destination);
      this.files.set(destination, update.content);
      this.files.delete(operation.path);
    } else this.files.set(operation.path, update.content);
    plan = {
      kind: "update",
      path: operation.path,
      ...(operation.movePath === undefined ? {} : { movePath: operation.movePath }),
      oldContent,
      newContent: update.content,
      ...(overwrittenContent === undefined ? {} : { overwrittenContent }),
      spans: update.spans,
      matchKind: update.matchKind,
    };
    const recorded = this.record(plan);
    this.modifiedPaths.add(operation.path);
    this.modifiedPaths.add(destination);
    return recorded;
  }

  plans(): readonly PatchPlan[] {
    return this.planned;
  }

  private record(plan: PatchPlan): PatchPlan {
    this.retained += retainedBytes(plan);
    if (this.retained > this.limits.maxOutputBytes * 2) throw limitExceeded("retained plan bytes");
    this.planned.push(plan);
    return plan;
  }
}

export function planPreparedPatch(prepared: PreparedPatch, snapshots: readonly FileSnapshot[], limits: FileEditLimits = FILE_EDIT_LIMITS): PatchPlan[] {
  const cursor = new PatchPlanningCursor(snapshots, limits);
  for (const operation of prepared.operations) cursor.append(operation);
  return [...cursor.plans()];
}
