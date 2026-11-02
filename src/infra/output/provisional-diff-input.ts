import { structuredPatch } from "diff";
import { createStreamingSanitizer, sanitizeExternalText } from "../control-characters.js";
import { MUTATION_DIFF_RENDERED_LINE_LIMIT } from "../mutation-diff.js";
import type {
  ProvisionalDiff,
  ProvisionalDiffHunk,
  ProvisionalDiffLine,
  ProvisionalDiffUnavailableReason,
} from "../output-blocks.js";
import { MAX_STREAMING_TOOL_INPUT_BYTES } from "./partial-json.js";
import { ProvisionalPatchParser } from "./provisional-patch.js";

export type ProvisionalDiffInputKind = "create" | "replace" | "patch";

interface StreamingFieldAdditions {
  readonly [field: string]: string;
}

interface AuthoritativeToolInput {
  readonly [field: string]: unknown;
}

interface DiffFieldStates {
  old_string: FieldState;
  new_string: FieldState;
  content: FieldState;
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

function emptyField(): FieldState {
  return { text: "", bytes: 0, lines: [], lineCount: 0, complete: false };
}

function accumulate(field: FieldState, name: keyof DiffFieldStates, text: string): void {
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
        if (lineIndex < MUTATION_DIFF_RENDERED_LINE_LIMIT) field.lines.push({
          id: `file-0:${name}:line-${lineIndex}`,
          kind: name === "old_string" ? "remove" : "add",
          text: piece,
          partial: !sealed,
        });
      }
      partial = !sealed;
    }
  }
}

/** Creates one filesystem-free normalizer for a file tool invocation. */
export function createProvisionalDiffInput(kind: ProvisionalDiffInputKind, options: ProvisionalDiffInputOptions = {}): ProvisionalDiffInput {
  let path: string | undefined;
  let unavailable: ProvisionalDiffUnavailableReason | undefined;
  let patch = new ProvisionalPatchParser();
  let aligned: ProvisionalDiffHunk[] | undefined;
  const fields: DiffFieldStates = {
    old_string: emptyField(),
    new_string: emptyField(),
    content: emptyField(),
  };

  const appendSanitized = (name: keyof typeof fields, addition: string): void => {
    const bounded = appendBounded(fields[name].bytes, addition);
    fields[name].bytes += bounded.bytes;
    accumulate(fields[name], name, bounded.text);
    if (bounded.overBound) unavailable = "over-bound";
  };
  const sanitizers = {
    old_string: createStreamingSanitizer((text) => { appendSanitized("old_string", text); }),
    new_string: createStreamingSanitizer((text) => { appendSanitized("new_string", text); }),
    content: createStreamingSanitizer((text) => { appendSanitized("content", text); }),
  };
  const patchSanitizer = createStreamingSanitizer((text) => { patch.append(text); });

  const appendField = (name: keyof typeof fields, addition: string): void => {
    if (addition.length > 0) sanitizers[name].push(addition);
  };

  const alignIfReady = (): void => {
    if (kind !== "replace" || aligned || !fields.old_string.complete || !fields.new_string.complete) return;
    options.onAlign?.();
    aligned = alignedReplacement(fields.old_string.text, fields.new_string.text);
  };

  const rebuild = (input: AuthoritativeToolInput): void => {
    path = typeof input.path === "string" ? sanitizeExternalText(input.path) : undefined;
    unavailable = undefined;
    aligned = undefined;
    if (kind === "patch") {
      patch = new ProvisionalPatchParser();
      if (typeof input.input === "string") {
        patch.append(boundedText(sanitizeExternalText(input.input), (reason) => { unavailable = reason; }));
        patch.finish();
      }
      return;
    }
    const names = kind === "create" ? ["content"] as const : ["old_string", "new_string"] as const;
    for (const name of names) {
      const value = typeof input[name] === "string" ? sanitizeExternalText(input[name]) : "";
      const bounded = appendBounded(0, value);
      fields[name] = emptyField();
      fields[name].bytes = bounded.bytes;
      fields[name].complete = true;
      accumulate(fields[name], name, bounded.text);
      if (bounded.overBound) unavailable = "over-bound";
    }
    alignIfReady();
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
      if (kind === "create") appendField("content", additions.content ?? "");
      else {
        appendField("old_string", additions.old_string ?? "");
        appendField("new_string", additions.new_string ?? "");
      }
      for (const name of completedFields) {
        if (name !== "old_string" && name !== "new_string" && name !== "content") continue;
        sanitizers[name].finish();
        fields[name].complete = true;
      }
      alignIfReady();
    },
    complete: (input) => {
      const current = currentInput(kind, path, fields, patch);
      if (!sameAuthoritativeInput(kind, current, input) || unavailable) rebuild(input);
      else {
        if (kind === "create") fields.content.complete = true;
        else if (kind === "replace") {
          fields.old_string.complete = true;
          fields.new_string.complete = true;
        }
        alignIfReady();
      }
    },
    markUnavailable: (reason) => { unavailable = reason; },
    snapshot: () => {
      if (kind === "patch") {
        const snapshot = patch.snapshot();
        return unavailable && !snapshot.unavailable ? { ...snapshot, unavailable } : snapshot;
      }
      const hunks = aligned ?? unalignedHunks(kind, fields);
      return {
        files: [{
          id: "file-0",
          ...(path === undefined ? {} : { path }),
          action: kind === "create" ? "add" : "update",
          hunks,
        }],
        ...(unavailable === undefined ? {} : { unavailable }),
      };
    },
  };
}

function currentInput(
  kind: ProvisionalDiffInputKind,
  path: string | undefined,
  fields: DiffFieldStates,
  patch: ProvisionalPatchParser,
): AuthoritativeToolInput {
  if (kind === "patch") return { input: patch.acceptedCharacters };
  if (kind === "create") return { path, content: fields.content.text };
  return { path, old_string: fields.old_string.text, new_string: fields.new_string.text };
}

function sameAuthoritativeInput(kind: ProvisionalDiffInputKind, current: AuthoritativeToolInput, input: AuthoritativeToolInput): boolean {
  if (kind === "patch") return false;
  const names = kind === "create" ? ["path", "content"] as const : ["path", "old_string", "new_string"] as const;
  return names.every((name) => (current[name] ?? "") === (typeof input[name] === "string" ? sanitizeExternalText(input[name]) : ""));
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

function unalignedHunks(
  kind: Exclude<ProvisionalDiffInputKind, "patch">,
  fields: DiffFieldStates,
): ProvisionalDiffHunk[] {
  const sides = kind === "create" ? [fields.content] : [fields.old_string, fields.new_string];
  const total = sides.reduce((count, field) => count + field.lineCount, 0);
  if (total === 0) return [];
  const lines = sides.flatMap((field) => field.lines).slice(0, MUTATION_DIFF_RENDERED_LINE_LIMIT);
  return [{
    id: "file-0:hunk-0", lines, omittedBefore: 0, omittedAfter: total - lines.length,
  }];
}

function alignedReplacement(oldText: string, newText: string): ProvisionalDiffHunk[] {
  const patch = structuredPatch("", "", oldText, newText, "", "", { context: 3 });
  let lineIndex = 0;
  const hunks = patch.hunks.map((hunk, hunkIndex) => {
    const lines = hunk.lines.flatMap((line): ProvisionalDiffLine[] => {
      const prefix = line[0];
      if (prefix !== "+" && prefix !== "-" && prefix !== " ") return [];
      return [{
        id: `file-0:line-${lineIndex++}`,
        kind: prefix === "+" ? "add" : prefix === "-" ? "remove" : "context",
        text: line.slice(1),
        partial: false,
      }];
    });
    return {
      id: `file-0:hunk-${hunkIndex}`,
      lines,
      omittedBefore: 0,
      omittedAfter: 0,
    };
  });
  let remaining = MUTATION_DIFF_RENDERED_LINE_LIMIT;
  for (const hunk of hunks) {
    const retained = Math.min(remaining, hunk.lines.length);
    hunk.omittedAfter = hunk.lines.length - retained;
    hunk.lines = hunk.lines.slice(0, retained);
    remaining -= retained;
  }
  return hunks;
}
