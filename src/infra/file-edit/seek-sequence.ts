/** Locates a run of expected lines inside a file, in decreasing strictness.
 *
 *  Derived from OpenAI Codex apply-patch `seek_sequence.rs` (Apache-2.0): exact
 *  lines first, then trailing whitespace ignored, then both margins ignored,
 *  then Unicode punctuation and spaces folded to ASCII. Flywheel adds a final
 *  unique substring tier for incomplete model-authored lines. Chunks apply in order,
 *  each seeking forward from the previous match. Full-line tiers take their first
 *  match, while the substring tier requires one unique match. At end of file every
 *  tier runs at the final position. Flywheel also reports one uniform indentation
 *  shift from a margin-tier match so replacement lines can be re-indented. */

import { splitIndent, trimTrailingWhitespace, trimWhitespace, isBlank } from "./text-file.js";

const FULL_LINE_MATCH_KINDS = ["exact", "rstrip", "trim", "unicode"] as const;
export const SEEK_MATCH_KINDS = [...FULL_LINE_MATCH_KINDS, "substring"] as const;
export type SeekMatchKind = (typeof SEEK_MATCH_KINDS)[number];

export type IndentDelta =
  | { readonly kind: "none" }
  | { readonly kind: "add"; readonly prefix: string }
  | { readonly kind: "remove"; readonly prefix: string };

export const NO_INDENT_DELTA: IndentDelta = { kind: "none" };

export interface SequenceMatch {
  readonly index: number;
  readonly kind: SeekMatchKind;
  readonly indentDelta: IndentDelta;
}

/** ASCII fold for one typographic character, or undefined when the character is not folded. */
export function foldTypography(character: string): string | undefined {
  const code = character.codePointAt(0);
  if (code === undefined) return undefined;
  if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212) return "-";
  if (code >= 0x2018 && code <= 0x201b) return "'";
  if (code >= 0x201c && code <= 0x201f) return "\"";
  if (code === 0x00a0 || (code >= 0x2002 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000) return " ";
  return undefined;
}

function normalizePunctuation(value: string): string {
  let output = "";
  for (const character of value) output += foldTypography(character) ?? character;
  return output;
}

const NORMALIZERS = {
  exact: (value: string) => value,
  rstrip: trimTrailingWhitespace,
  trim: trimWhitespace,
  unicode: (value: string) => normalizePunctuation(trimWhitespace(value)),
} satisfies { readonly [K in Exclude<SeekMatchKind, "substring">]: (value: string) => string };

function linesMatch(lines: readonly string[], pattern: readonly string[], start: number, normalize: (value: string) => string): boolean {
  for (const [offset, expected] of pattern.entries()) {
    const actual = lines[start + offset];
    if (actual === undefined || normalize(actual) !== normalize(expected)) return false;
  }
  return true;
}

function partialLinesMatch(lines: readonly string[], pattern: readonly string[], start: number): boolean {
  for (const [offset, expected] of pattern.entries()) {
    const actual = lines[start + offset];
    if (actual === undefined) return false;
    if (actual.startsWith("\uFEFF") && !expected.startsWith("\uFEFF")) return false;
    const normalizedExpected = NORMALIZERS.unicode(expected);
    const normalizedActual = NORMALIZERS.unicode(actual);
    if (normalizedExpected.length === 0 ? normalizedActual.length !== 0 : !normalizedActual.includes(normalizedExpected)) return false;
  }
  return true;
}

/** Seeks `pattern` in `lines` at or after `start`. With `eof`, the search starts at the last position
 *  the pattern fits, so a chunk marked `*** End of File` lands on the file's tail. */
export function seekSequence(lines: readonly string[], pattern: readonly string[], start: number, eof: boolean): SequenceMatch | undefined {
  if (pattern.length === 0) return { index: Math.min(start, lines.length), kind: "exact", indentDelta: NO_INDENT_DELTA };
  if (pattern.length > lines.length || start > lines.length) return undefined;
  const eofStart = lines.length - pattern.length;
  const searchStart = eof ? Math.max(eofStart, start) : start;
  for (const kind of FULL_LINE_MATCH_KINDS) {
    const normalize = NORMALIZERS[kind];
    for (let index = searchStart; index <= eofStart; index += 1) {
      if (!linesMatch(lines, pattern, index, normalize)) continue;
      const delta = kind === "trim" || kind === "unicode" ? uniformIndentDelta(lines.slice(index, index + pattern.length), pattern) : NO_INDENT_DELTA;
      return { index, kind, indentDelta: delta };
    }
  }
  let partialIndex: number | undefined;
  for (let index = searchStart; index <= eofStart; index += 1) {
    if (!partialLinesMatch(lines, pattern, index)) continue;
    if (partialIndex !== undefined) return undefined;
    partialIndex = index;
  }
  if (partialIndex === undefined) return undefined;
  return {
    index: partialIndex,
    kind: "substring",
    indentDelta: uniformIndentDelta(lines.slice(partialIndex, partialIndex + pattern.length), pattern),
  };
}

/** The one indentation shift every non-blank line pair shares, or none when the lines disagree. */
export function uniformIndentDelta(actual: readonly string[], expected: readonly string[]): IndentDelta {
  let shared: IndentDelta | undefined;
  for (const [offset, expectedLine] of expected.entries()) {
    const actualLine = actual[offset] ?? "";
    if (isBlank(actualLine) && isBlank(expectedLine)) continue;
    const delta = indentDelta(splitIndent(actualLine)[0], splitIndent(expectedLine)[0]);
    if (delta === undefined) return NO_INDENT_DELTA;
    if (shared === undefined) shared = delta;
    else if (!sameIndentDelta(shared, delta)) return NO_INDENT_DELTA;
  }
  return shared ?? NO_INDENT_DELTA;
}

export function sameIndentDelta(left: IndentDelta, right: IndentDelta): boolean {
  return left.kind === right.kind && (left.kind === "none" || right.kind === "none" || left.prefix === right.prefix);
}

/** The shift from the expected indent to the actual one when one is a suffix of the other. */
export function indentDelta(actual: string, expected: string): IndentDelta | undefined {
  if (actual === expected) return NO_INDENT_DELTA;
  if (actual.endsWith(expected)) return { kind: "add", prefix: actual.slice(0, actual.length - expected.length) };
  if (expected.endsWith(actual)) return { kind: "remove", prefix: expected.slice(0, expected.length - actual.length) };
  return undefined;
}

/** Re-indents non-blank lines by the shift a margin tier observed. */
export function applyIndentDelta(lines: readonly string[], delta: IndentDelta): string[] {
  return lines.map((line) => {
    if (delta.kind === "none" || isBlank(line)) return line;
    if (delta.kind === "add") return `${delta.prefix}${line}`;
    return line.startsWith(delta.prefix) ? line.slice(delta.prefix.length) : line;
  });
}
