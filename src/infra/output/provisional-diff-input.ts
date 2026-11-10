import { structuredPatch } from "diff";
import { createStreamingSanitizer, sanitizeExternalText, type StreamingSanitizer } from "../control-characters.js";
import { MUTATION_DIFF_RENDERED_LINE_LIMIT } from "../mutation-diff.js";
import type {
  ProvisionalDiff,
  ProvisionalDiffHunk,
  ProvisionalDiffLine,
  ProvisionalDiffUnavailableReason,
} from "../output-blocks.js";
import { editInputEntries } from "../file-edit/edit-input.js";
import { MAX_STREAMING_TOOL_INPUT_BYTES } from "./partial-json.js";
import { ProvisionalPatchParser } from "./provisional-patch.js";

export type ProvisionalDiffInputKind = "create" | "replace" | "patch";

interface StreamingFieldAdditions {
  readonly [field: string]: string;
}

interface AuthoritativeToolInput {
  readonly [field: string]: unknown;
}

export interface ProvisionalDiffInput {
  append(additions: StreamingFieldAdditions, completedFields: readonly string[]): void;
  complete(authoritativeInput: AuthoritativeToolInput): void;
  markUnavailable(reason: ProvisionalDiffUnavailableReason): void;
  snapshot(): ProvisionalDiff;
}

interface ProvisionalDiffInputOptions {
  /** Test seam for proving settled replacement alignment frequency. */
  readonly onAlign?: () => void;
}

interface FieldState {
  text: string;
  bytes: number;
  lines: ProvisionalDiffLine[];
  lineCount: number;
  complete: boolean;
}

type ReplacementSide = "old_string" | "new_string";

/** One streamed text field: its state and the sanitizer that feeds it. */
interface StreamedField {
  state: FieldState;
  sanitizer: StreamingSanitizer;
}

/** One replacement entry of an edit: both sides, and its hunks once both sides complete. */
interface Replacement {
  readonly old_string: StreamedField;
  readonly new_string: StreamedField;
  aligned?: ProvisionalDiffHunk[];
}

function emptyField(): FieldState {
  return { text: "", bytes: 0, lines: [], lineCount: 0, complete: false };
}

/** The replacement entry and side that a streamed field name addresses: `edits.<index>.old_string`
 *  and `edits.<index>.new_string`, or `old_string` and `new_string` of the single-edit shape that
 *  `editInputEntries` reads as entry 0. */
function replacementField(name: string): { readonly entry: number; readonly side: ReplacementSide } | undefined {
  if (name === "old_string" || name === "new_string") return { entry: 0, side: name };
  const match = /^edits\.(\d+)\.(old_string|new_string)$/.exec(name);
  return match?.[1] === undefined ? undefined : { entry: Number(match[1]), side: match[2] === "old_string" ? "old_string" : "new_string" };
}

function accumulate(field: FieldState, lineId: (index: number) => string, kind: ProvisionalDiffLine["kind"], text: string): void {
  let partial = field.text.length > 0 && !field.text.endsWith("\n");
  field.text += text;
  const pieces = text.split("\n");
  for (const [index, piece] of pieces.entries()) {
    const sealed = index < pieces.length - 1;
    if (partial || piece.length > 0 || sealed) {
      if (partial) {
        const tail = field.lines[field.lineCount - 1];
        if (tail) field.lines[field.lineCount - 1] = { ...tail, text: tail.text + piece, partial: !sealed };
      } else {
        const lineIndex = field.lineCount++;
        if (lineIndex < MUTATION_DIFF_RENDERED_LINE_LIMIT) field.lines.push({ id: lineId(lineIndex), kind, text: piece, partial: !sealed });
      }
      partial = !sealed;
    }
  }
}

function stringField(input: AuthoritativeToolInput, name: string): string {
  const value = input[name];
  return typeof value === "string" ? value : "";
}

/** Creates one filesystem-free normalizer for a file tool invocation. */
export function createProvisionalDiffInput(kind: ProvisionalDiffInputKind, options: ProvisionalDiffInputOptions = {}): ProvisionalDiffInput {
  let path: string | undefined;
  let unavailable: ProvisionalDiffUnavailableReason | undefined;
  let patch = new ProvisionalPatchParser();
  const patchSanitizer = createStreamingSanitizer((text) => { patch.append(text); });

  const streamedField = (lineId: (index: number) => string, lineKind: ProvisionalDiffLine["kind"]): StreamedField => {
    const field: StreamedField = { state: emptyField(), sanitizer: createStreamingSanitizer((text) => {
      const bounded = appendBounded(field.state.bytes, text);
      field.state.bytes += bounded.bytes;
      accumulate(field.state, lineId, lineKind, bounded.text);
      if (bounded.overBound) unavailable = "over-bound";
    }) };
    return field;
  };
  let content = streamedField((index) => `file-0:content:line-${index}`, "add");
  let replacements: Replacement[] = [];
  const replacementAt = (entry: number): Replacement => {
    while (replacements.length <= entry) {
      const prefix = `file-0:edit-${replacements.length}`;
      replacements.push({
        old_string: streamedField((index) => `${prefix}:old:line-${index}`, "remove"),
        new_string: streamedField((index) => `${prefix}:new:line-${index}`, "add"),
      });
    }
    // SAFETY: the loop above extended the list past `entry`.
    return replacements[entry]!;
  };

  const alignIfReady = (): void => {
    for (const [entry, replacement] of replacements.entries()) {
      if (replacement.aligned || !replacement.old_string.state.complete || !replacement.new_string.state.complete) continue;
      options.onAlign?.();
      replacement.aligned = alignedReplacement(`file-0:edit-${entry}`, replacement.old_string.state.text, replacement.new_string.state.text);
    }
  };

  const settle = (field: StreamedField, text: string): void => {
    field.sanitizer.push(text);
    field.sanitizer.finish();
    field.state.complete = true;
  };

  const rebuild = (input: AuthoritativeToolInput): void => {
    path = typeof input.path === "string" ? sanitizeExternalText(input.path) : undefined;
    unavailable = undefined;
    if (kind === "patch") {
      patch = new ProvisionalPatchParser();
      if (typeof input.input === "string") {
        patch.append(boundedText(sanitizeExternalText(input.input), (reason) => { unavailable = reason; }));
        patch.finish();
      }
      return;
    }
    if (kind === "create") {
      content = streamedField((index) => `file-0:content:line-${index}`, "add");
      settle(content, stringField(input, "content"));
      return;
    }
    replacements = [];
    for (const [entry, fields] of editInputEntries(input).entries()) {
      const replacement = replacementAt(entry);
      settle(replacement.old_string, stringField(fields, "old_string"));
      settle(replacement.new_string, stringField(fields, "new_string"));
    }
    alignIfReady();
  };

  const sameAuthoritativeInput = (input: AuthoritativeToolInput): boolean => {
    const same = (field: StreamedField | undefined, fields: AuthoritativeToolInput, name: string) => field?.state.text === sanitizeExternalText(stringField(fields, name));
    if (kind === "patch" || (path ?? "") !== sanitizeExternalText(stringField(input, "path"))) return false;
    if (kind === "create") return same(content, input, "content");
    const entries = editInputEntries(input);
    return entries.length === replacements.length && entries.every((fields, entry) =>
      same(replacements[entry]?.old_string, fields, "old_string") && same(replacements[entry]?.new_string, fields, "new_string"));
  };

  return {
    append: (additions, completedFields) => {
      if (typeof additions.path === "string") path = `${path ?? ""}${sanitizeExternalText(additions.path)}`;
      if (kind === "patch") {
        if (typeof additions.input === "string") patchSanitizer.push(additions.input);
        if (completedFields.includes("input")) {
          patchSanitizer.finish();
          patch.finish();
        }
        return;
      }
      if (kind === "create") {
        if (additions.content) content.sanitizer.push(additions.content);
        if (completedFields.includes("content")) {
          content.sanitizer.finish();
          content.state.complete = true;
        }
        return;
      }
      for (const [name, text] of Object.entries(additions)) {
        const field = replacementField(name);
        if (field && text.length > 0) replacementAt(field.entry)[field.side].sanitizer.push(text);
      }
      for (const name of completedFields) {
        const field = replacementField(name);
        if (!field) continue;
        const streamed = replacementAt(field.entry)[field.side];
        streamed.sanitizer.finish();
        streamed.state.complete = true;
      }
      alignIfReady();
    },
    complete: (input) => {
      if (!sameAuthoritativeInput(input) || unavailable) {
        rebuild(input);
        return;
      }
      if (kind === "create") content.state.complete = true;
      for (const replacement of replacements) {
        replacement.old_string.state.complete = true;
        replacement.new_string.state.complete = true;
      }
      alignIfReady();
    },
    markUnavailable: (reason) => { unavailable = reason; },
    snapshot: () => {
      if (kind === "patch") {
        const snapshot = patch.snapshot();
        return unavailable && !snapshot.unavailable ? { ...snapshot, unavailable } : snapshot;
      }
      const hunks = kind === "create"
        ? unalignedHunks("file-0", [content.state])
        : replacements.flatMap((replacement, entry) => replacement.aligned ?? unalignedHunks(`file-0:edit-${entry}`, [replacement.old_string.state, replacement.new_string.state]));
      return {
        files: [{
          id: "file-0",
          ...(path === undefined ? {} : { path }),
          action: kind === "create" ? "add" : "update",
          hunks: withinRowBudget(hunks),
        }],
        ...(unavailable === undefined ? {} : { unavailable }),
      };
    },
  };
}

function boundedText(text: string, onUnavailable: (reason: ProvisionalDiffUnavailableReason) => void): string {
  const bounded = appendBounded(0, text);
  if (bounded.overBound) onUnavailable("over-bound");
  return bounded.text;
}

function appendBounded(acceptedBytes: number, addition: string) {
  const remaining = MAX_STREAMING_TOOL_INPUT_BYTES - acceptedBytes;
  const additionBytes = Buffer.byteLength(addition);
  if (additionBytes <= remaining) return { text: addition, bytes: additionBytes, overBound: false };
  let retained = "";
  let bytes = 0;
  for (const char of addition) {
    const next = Buffer.byteLength(char);
    if (bytes + next > Math.max(remaining, 0)) break;
    retained += char;
    bytes += next;
  }
  return { text: retained, bytes, overBound: true };
}

function unalignedHunks(id: string, sides: readonly FieldState[]): ProvisionalDiffHunk[] {
  const total = sides.reduce((count, field) => count + field.lineCount, 0);
  if (total === 0) return [];
  const lines = sides.flatMap((field) => field.lines).slice(0, MUTATION_DIFF_RENDERED_LINE_LIMIT);
  return [{ id: `${id}:hunk-0`, lines, omittedBefore: 0, omittedAfter: total - lines.length }];
}

function alignedReplacement(id: string, oldText: string, newText: string): ProvisionalDiffHunk[] {
  const patch = structuredPatch("", "", oldText, newText, "", "", { context: 3 });
  let lineIndex = 0;
  return patch.hunks.map((hunk, hunkIndex) => ({
    id: `${id}:hunk-${hunkIndex}`,
    lines: hunk.lines.flatMap((line): ProvisionalDiffLine[] => {
      const prefix = line[0];
      if (prefix !== "+" && prefix !== "-" && prefix !== " ") return [];
      return [{
        id: `${id}:line-${lineIndex++}`,
        kind: prefix === "+" ? "add" : prefix === "-" ? "remove" : "context",
        text: line.slice(1),
        partial: false,
      }];
    }),
    omittedBefore: 0,
    omittedAfter: 0,
  }));
}

/** Keeps the first rendered rows of all hunks together within the shared row limit. */
function withinRowBudget(hunks: readonly ProvisionalDiffHunk[]): ProvisionalDiffHunk[] {
  let remaining = MUTATION_DIFF_RENDERED_LINE_LIMIT;
  return hunks.map((hunk) => {
    const retained = Math.min(remaining, hunk.lines.length);
    remaining -= retained;
    return retained === hunk.lines.length ? hunk : { ...hunk, lines: hunk.lines.slice(0, retained), omittedAfter: hunk.omittedAfter + hunk.lines.length - retained };
  });
}
