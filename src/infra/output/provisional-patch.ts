import { MUTATION_DIFF_RENDERED_LINE_LIMIT } from "../mutation-diff.js";
import type {
  ProvisionalDiff,
  ProvisionalDiffFile,
  ProvisionalDiffLine,
  ProvisionalDiffUnavailableReason,
} from "../output-blocks.js";
import {
  BEGIN_PATCH_MARKER,
  CHANGE_CONTEXT_MARKER,
  EMPTY_CHANGE_CONTEXT_MARKER,
  END_PATCH_MARKER,
  ENVIRONMENT_ID_MARKER,
  EOF_MARKER,
  HEREDOC_OPENERS,
  MOVE_TO_MARKER,
  patchOperationHeader,
} from "../file-edit/patch-syntax.js";

interface MutableFile {
  id: string;
  path?: string;
  action: "add" | "delete" | "update";
  movePath?: string;
  hunks: MutableHunk[];
  lineCount: number;
}

interface MutableHunk {
  id: string;
  lines: ProvisionalDiffLine[];
  omittedAfter: number;
}

/**
 * Interprets the display-safe subset of an append-only V4A patch stream.
 *
 * It never validates an executable patch and never reads target files.
 */
export class ProvisionalPatchParser {
  private readonly files: MutableFile[] = [];
  private currentFile: MutableFile | undefined;
  private currentHunk: MutableHunk | undefined;
  private currentLine = "";
  private activeLine: ProvisionalDiffLine | undefined;
  private unavailable: ProvisionalDiffUnavailableReason | undefined;
  private inEnvelope = false;
  private heredoc = false;
  private characterCount = 0;

  get acceptedCharacters(): number {
    return this.characterCount;
  }

  append(text: string): void {
    if (this.unavailable) return;
    for (const char of text) {
      this.characterCount += 1;
      if (this.unavailable) continue;
      if (char === "\n") {
        this.finishLine();
        continue;
      }
      if (char === "\r") continue;
      this.currentLine += char;
      this.beginOrExtendCodeLine();
    }
  }

  /** Reconciles a completed input without treating an unterminated code row as complete. */
  finish(): void {
    if (!this.activeLine && this.currentLine.length > 0) this.finishLine();
  }

  snapshot(): ProvisionalDiff {
    return {
      files: this.files.map((file): ProvisionalDiffFile => ({
        id: file.id,
        ...(file.path === undefined ? {} : { path: file.path }),
        action: file.action,
        ...(file.movePath === undefined ? {} : { movePath: file.movePath }),
        hunks: file.hunks.flatMap((hunk) => hunk.lines.length === 0 && hunk.omittedAfter === 0 ? [] : [{
          id: hunk.id,
          lines: [...hunk.lines],
          omittedBefore: 0,
          omittedAfter: hunk.omittedAfter,
        }]),
      })),
      ...(this.unavailable === undefined ? {} : { unavailable: this.unavailable }),
    };
  }

  private beginOrExtendCodeLine(): void {
    if (!this.inEnvelope || !this.currentFile || this.activeLine) {
      if (this.activeLine) {
        const retained = this.currentHunk?.lines.at(-1) === this.activeLine;
        this.activeLine = { ...this.activeLine, text: this.currentLine.slice(1) };
        if (retained) this.currentHunk?.lines.splice(-1, 1, this.activeLine);
      }
      return;
    }
    const prefix = this.currentLine[0];
    if (prefix === " " && isAmbiguousWhitespaceHeader(this.currentLine)) return;
    const kind = prefix === "+" ? "add" : prefix === "-" ? "remove" : prefix === " " ? "context" : undefined;
    if (kind === undefined) return;
    const allowed = this.currentFile.action === "add" ? kind === "add" : this.currentFile.action === "update";
    if (!allowed) return;
    const hunk = this.ensureHunk();
    const line: ProvisionalDiffLine = {
      id: `${this.currentFile.id}:line-${this.currentFile.lineCount++}`,
      kind,
      text: this.currentLine.slice(1),
      partial: true,
    };
    hunk.lines.push(line);
    this.activeLine = line;
    this.enforceLineLimit();
  }

  private finishLine(): void {
    if (this.activeLine) {
      const completed = { ...this.activeLine, partial: false };
      if (this.currentHunk?.lines.at(-1) === this.activeLine) this.currentHunk.lines.splice(-1, 1, completed);
      this.activeLine = undefined;
      this.currentLine = "";
      return;
    }
    const line = this.currentLine;
    this.currentLine = "";
    const trimmed = line.trim();
    if (!this.inEnvelope) {
      if (HEREDOC_OPENERS.has(line)) {
        this.heredoc = true;
        return;
      }
      if (trimmed === BEGIN_PATCH_MARKER) {
        this.inEnvelope = true;
        return;
      }
      this.fail();
      return;
    }
    if (trimmed === END_PATCH_MARKER) {
      this.inEnvelope = false;
      return;
    }
    if (this.heredoc && line === "EOF") return;
    if (trimmed.startsWith(ENVIRONMENT_ID_MARKER)) return;
    const header = patchOperationHeader(trimmed);
    if (header) {
      if (header.path.length === 0) {
        this.fail();
        return;
      }
      this.currentFile = { id: `file-${this.files.length}`, path: header.path, action: header.action, hunks: [], lineCount: 0 };
      this.currentHunk = undefined;
      this.files.push(this.currentFile);
      return;
    }
    if (trimmed.startsWith(MOVE_TO_MARKER) && this.currentFile?.action === "update") {
      const movePath = line.trimEnd().slice(MOVE_TO_MARKER.length);
      if (movePath.length === 0) this.fail();
      else this.currentFile.movePath = movePath;
      return;
    }
    if (trimmed === EMPTY_CHANGE_CONTEXT_MARKER || trimmed.startsWith(CHANGE_CONTEXT_MARKER)) {
      if (this.currentFile?.action === "update") this.currentHunk = this.newHunk(this.currentFile);
      return;
    }
    if (trimmed === EOF_MARKER) return;
    if (line.length === 0 && this.currentFile?.action === "update") {
      this.addCompletedCodeLine("context", "");
      return;
    }
    this.fail();
  }

  private addCompletedCodeLine(kind: ProvisionalDiffLine["kind"], text: string): void {
    const file = this.currentFile;
    if (!file) return;
    this.ensureHunk().lines.push({ id: `${file.id}:line-${file.lineCount++}`, kind, text, partial: false });
    this.enforceLineLimit();
  }

  private ensureHunk(): MutableHunk {
    if (this.currentHunk) return this.currentHunk;
    if (!this.currentFile) throw new Error("A provisional patch hunk requires a file");
    this.currentHunk = this.newHunk(this.currentFile);
    return this.currentHunk;
  }

  private newHunk(file: MutableFile): MutableHunk {
    const hunk = { id: `${file.id}:hunk-${file.hunks.length}`, lines: [], omittedAfter: 0 };
    file.hunks.push(hunk);
    return hunk;
  }

  private enforceLineLimit(): void {
    const file = this.currentFile;
    const hunk = this.currentHunk;
    if (file && hunk && file.lineCount > MUTATION_DIFF_RENDERED_LINE_LIMIT) {
      hunk.lines.pop();
      hunk.omittedAfter += 1;
    }
  }

  private fail(): void {
    this.unavailable = "malformed";
    this.activeLine = undefined;
  }
}

const STRUCTURAL_PREFIXES = [
  BEGIN_PATCH_MARKER,
  END_PATCH_MARKER,
  "*** Add File: ",
  "*** Delete File: ",
  "*** Update File: ",
  MOVE_TO_MARKER,
  EMPTY_CHANGE_CONTEXT_MARKER,
  EOF_MARKER,
  ENVIRONMENT_ID_MARKER,
];

function isAmbiguousWhitespaceHeader(line: string): boolean {
  const candidate = line.trimStart();
  return STRUCTURAL_PREFIXES.some((marker) =>
    marker.startsWith(candidate)
    || candidate.startsWith(marker) && candidate.slice(marker.length).trim().length === 0
  );
}
