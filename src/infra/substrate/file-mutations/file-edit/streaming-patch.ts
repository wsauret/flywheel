import { FILE_EDIT_LIMITS, type FileEditLimits, FileEditPlanError } from "./contract.js";
import { PatchOperationParser, preparePatch, type PreparedOperation, type PreparedPatch } from "./patch-parser.js";
import { BEGIN_PATCH_MARKER, END_PATCH_MARKER, HEREDOC_OPENERS } from "./patch-syntax.js";

export interface StreamingPatchProgress {
  readonly status: "undecided";
  readonly operations: readonly PreparedOperation[];
}

/** Frames appended text into only the lines that the input itself terminates. */
class PatchLineFramer {
  private pending = "";

  append(text: string): string[] {
    this.pending += text;
    const lines: string[] = [];
    for (let newline = this.pending.indexOf("\n"); newline >= 0; newline = this.pending.indexOf("\n")) {
      const line = this.pending.slice(0, newline);
      lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
      this.pending = this.pending.slice(newline + 1);
    }
    return lines;
  }

  finish(): string[] {
    if (this.pending.length === 0) return [];
    const line = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
    this.pending = "";
    return [line];
  }
}

/** Incrementally exposes executable operations while deferring envelope acceptance until finish. */
export class StreamingPatch {
  private readonly limits: FileEditLimits;
  private readonly framer = new PatchLineFramer();
  private readonly operationParser: PatchOperationParser;
  private readonly lines: string[] = [];
  private parsed?: PreparedPatch;
  private frameState: "leading" | "operations" | "ended" = "leading";
  private heredocOpened = false;
  private bytes = 0;

  constructor(limits: FileEditLimits = FILE_EDIT_LIMITS) {
    this.limits = limits;
    this.operationParser = new PatchOperationParser(limits);
  }

  append(text: string): StreamingPatchProgress {
    if (this.parsed !== undefined) throw new FileEditPlanError("invalid patch: patch input is already complete");
    this.bytes += Buffer.byteLength(text, "utf8");
    if (this.bytes > this.limits.maxPatchBytes) throw new FileEditPlanError("patch exceeds patch bytes limit");
    const completeLines = this.framer.append(text);
    this.lines.push(...completeLines);
    if (this.lines.length > this.limits.maxLines) throw new FileEditPlanError("patch exceeds lines limit");
    const operations: PreparedOperation[] = [];
    const firstLineNumber = this.lines.length - completeLines.length + 1;
    for (const [index, line] of completeLines.entries()) {
      operations.push(...this.appendSealedLine(line, firstLineNumber + index));
    }
    return { status: "undecided", operations };
  }

  finish(): PreparedPatch {
    this.lines.push(...this.framer.finish());
    if (this.lines.length > this.limits.maxLines) throw new FileEditPlanError("patch exceeds lines limit");
    this.parsed = preparePatch(this.lines.join("\n"), this.limits);
    return this.parsed;
  }

  private appendSealedLine(line: string, lineNumber: number): PreparedOperation[] {
    const trimmed = line.trim();
    if (this.frameState === "ended") return [];
    if (this.frameState === "leading") {
      if (trimmed.length === 0) return [];
      if (!this.heredocOpened && HEREDOC_OPENERS.has(line)) {
        this.heredocOpened = true;
        return [];
      }
      if (trimmed === BEGIN_PATCH_MARKER) {
        this.frameState = "operations";
        return [];
      }
      throw new FileEditPlanError("invalid patch: The first line of the patch must be '*** Begin Patch'");
    }
    const completed = this.operationParser.append(line, lineNumber);
    if (trimmed === END_PATCH_MARKER) this.frameState = "ended";
    return completed;
  }
}
