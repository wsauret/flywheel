/** The one contract for "what did this durable mutation change": a collection
 * of unified patches captured at the write boundary from the same endpoints the
 * write itself published.
 *
 * It is one strict, versioned schema, so the same diff crosses every durable
 * boundary that carries a mutation without a second private shape.
 *
 * A diff is evidence for a reader, never an input to a decision. Patches whose
 * retained hunk content contains a recognized credential are omitted whole.
 * Every other changed target retains up to 1,000 rendered patch lines,
 * regardless of source-file or collection size, and states the exact remainder
 * so a large source can never hide a small change. */

import { createPatch } from "diff";
import { Schema } from "effect";
import { redactSecrets } from "./redact-secrets.js";

export const MUTATION_DIFF_VERSION = 1;

/** Maximum rendered hunk lines retained for one file's expanded disclosure. */
export const MUTATION_DIFF_RENDERED_LINE_LIMIT = 1_000;

/** Lines of unchanged context each patch hunk keeps. */
const PATCH_CONTEXT_LINES = 3;

const MutationFileChangeSchema = Schema.Literals(["added", "modified", "removed"]);
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Why a target's bytes are absent. Size reasons and `private_reach` are legacy
 * read-only variants; current writers omit only recognized sensitive values. */
const MutationDiffOmissionReasonSchema = Schema.Literals(["sensitive", "target_over_bound", "collection_over_budget", "private_reach"]);

export const MutationDiffSchema = Schema.Struct({
  version: Schema.Literal(MUTATION_DIFF_VERSION),
  files: Schema.Array(Schema.Struct({
    path: Schema.String,
    change: MutationFileChangeSchema,
    unifiedDiff: Schema.String,
    omittedLines: Schema.optionalKey(NonNegativeInteger),
  })),
  omissions: Schema.Array(Schema.Struct({
    path: Schema.String,
    reason: MutationDiffOmissionReasonSchema,
  })),
});

export type MutationDiff = typeof MutationDiffSchema.Type;
type MutationFileChange = typeof MutationFileChangeSchema.Type;
type MutationDiffOmissionReason = typeof MutationDiffOmissionReasonSchema.Type;

/** One side of one target. `absent` is not empty text: a file that did not
 *  exist and a file that held nothing are different changes. */
export type MutationDiffEndpoint =
  | { readonly kind: "absent" }
  | { readonly kind: "text"; readonly text: string };

/** One artifact the mutation moves from `before` to `after`. The path is what a
 *  reader is shown, and it is the patch's own file name. */
export interface MutationDiffTarget {
  readonly path: string;
  readonly before: MutationDiffEndpoint;
  readonly after: MutationDiffEndpoint;
}

interface MutationFileDiff {
  readonly path: string;
  readonly change: MutationFileChange;
  readonly unifiedDiff: string;
  readonly omittedLines?: number;
}

interface MutationDiffOmission {
  readonly path: string;
  readonly reason: MutationDiffOmissionReason;
}

/** Capture what these targets changed. Unchanged targets carry nothing. */
export function buildMutationDiff(targets: readonly MutationDiffTarget[]): MutationDiff {
  const files: MutationFileDiff[] = [];
  const omissions: MutationDiffOmission[] = [];
  for (const target of targets) {
    const change = changeOf(target);
    if (!change) continue;
    const patch = createPatch(target.path, textOf(target.before), textOf(target.after), "", "", { context: PATCH_CONTEXT_LINES });
    const retained = truncateUnifiedDiff(patch, MUTATION_DIFF_RENDERED_LINE_LIMIT);
    if (containsSensitiveHunkContent(retained.text)) {
      omissions.push({ path: target.path, reason: "sensitive" });
      continue;
    }
    files.push({
      path: target.path,
      change,
      unifiedDiff: retained.text,
      ...(retained.omitted > 0 ? { omittedLines: retained.omitted } : {}),
    });
  }
  return { version: MUTATION_DIFF_VERSION, files, omissions };
}

function changeOf(target: MutationDiffTarget): MutationFileChange | undefined {
  if (target.before.kind === "absent") return target.after.kind === "absent" ? undefined : "added";
  if (target.after.kind === "absent") return "removed";
  return target.before.text === target.after.text ? undefined : "modified";
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/** Count retained renderer rows and +/- lines with the same grammar as truncation.
 * Headers and no-newline markers do not count as rendered rows. */
export function mutationDiffLineCounts(diff: string) {
  let inHunk = false;
  let rendered = 0;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (HUNK_HEADER_RE.test(line)) { inHunk = true; continue; }
    if (!inHunk || !/^[+\- ]/.test(line)) continue;
    rendered += 1;
    if (line.startsWith("+")) added += 1;
    if (line.startsWith("-")) removed += 1;
  }
  return { rendered, added, removed };
}

function containsSensitiveHunkContent(diff: string): boolean {
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (HUNK_HEADER_RE.test(line)) {
      inHunk = true;
      continue;
    }
    if (!inHunk || !/^[+\- ]/.test(line)) continue;
    const content = line.slice(1);
    if (redactSecrets(content) !== content) return true;
  }
  return false;
}

interface TruncatedUnifiedDiff {
  readonly text: string;
  readonly omitted: number;
  readonly rendered: number;
}

/** Retain at most `lineLimit` rendered hunk lines and count the exact remainder.
 * Structural patch headers do not spend the limit because the TUI does not
 * render them as rows. */
export function truncateUnifiedDiff(diff: string, lineLimit: number): TruncatedUnifiedDiff {
  if (!Number.isInteger(lineLimit) || lineLimit < 0) throw new Error("Unified diff line limit must be a non-negative integer");
  const lines = diff.split("\n");
  let inHunk = false;
  let rendered = 0;
  let cut = lines.length;
  for (const [index, line] of lines.entries()) {
    if (HUNK_HEADER_RE.test(line)) {
      if (rendered === lineLimit && cut === lines.length) cut = index;
      inHunk = true;
      continue;
    }
    if (!inHunk || !/^[+\- ]/.test(line)) continue;
    if (rendered === lineLimit && cut === lines.length) cut = index;
    rendered += 1;
  }
  if (rendered <= lineLimit) return { text: diff, omitted: 0, rendered };
  return { text: lines.slice(0, cut).join("\n"), omitted: rendered - lineLimit, rendered };
}

/** The collapsed preview of one patch from its leading bytes: the patch from its first hunk,
 * cut to `lines` rendered lines and to `encodedBytes` of JSON-encoded text. `complete` states
 * whether the prefix is the whole patch. A line that a byte cut ends early is dropped, so the
 * preview never shows part of a line as if it were whole, unless no whole changed line precedes
 * it; such a line alone fills more rows than a collapsed preview shows. */
export function unifiedDiffPreview(prefix: string, complete: boolean, bound: { readonly lines: number; readonly encodedBytes: number }): string {
  const start = prefix.search(/^@@/m);
  if (start < 0) return "";
  const retained = truncateUnifiedDiff(prefix.slice(start), bound.lines);
  let preview = retained.text;
  let cut = !complete && retained.omitted === 0;
  if (encodedBytes(preview) > bound.encodedBytes) {
    cut = true;
    // Escapes grow the encoded size faster than the text, so the longest fitting prefix is bisected.
    let fits = 0;
    let fails = preview.length;
    while (fails - fits > 1) {
      const middle = Math.floor((fits + fails) / 2);
      if (encodedBytes(preview.slice(0, middle)) <= bound.encodedBytes) fits = middle;
      else fails = middle;
    }
    // A cut never keeps half of a surrogate pair.
    preview = preview.slice(0, /[\uD800-\uDBFF]/.test(preview[fits - 1] ?? "") ? fits - 1 : fits);
  }
  if (!cut) return preview;
  const whole = preview.slice(0, preview.lastIndexOf("\n") + 1);
  return /\n[+\- ]/.test(whole) ? whole : preview;
}

function encodedBytes(text: string): number {
  return new TextEncoder().encode(JSON.stringify(text)).byteLength;
}

function textOf(endpoint: MutationDiffEndpoint): string {
  return endpoint.kind === "text" ? endpoint.text : "";
}
