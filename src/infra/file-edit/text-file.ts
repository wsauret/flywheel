/** Line and line-ending model shared by the patch and string planners.
 *
 *  One scanner splits text into lines that keep their own CR, LF, or CRLF
 *  ending, and one rule picks the file style. Replacements restore endings so
 *  a replaced line keeps its own ending, an inserted line takes the nearest
 *  local ending, and only a file with no local evidence falls back to the file
 *  style. A missing final newline stays missing, and a BOM stays in the first
 *  line's text. Offsets inside this module are UTF-16 code units; callers that
 *  report UTF-8 byte spans convert through `utf8ByteOffsets`. */

import { type ByteSpan, FileEditPlanError, limitExceeded } from "./contract.js";

export type LineEnding = "\n" | "\r\n" | "\r";

export interface SourceLine {
  readonly text: string;
  readonly ending: LineEnding | undefined;
}

/** A half-open range of UTF-16 code units. */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/** `(start, oldLength, lines)`: replace `oldLength` source lines from `start` with `lines`. */
export interface LineReplacement {
  readonly start: number;
  readonly oldLength: number;
  readonly lines: readonly string[];
}

// Rust's `char::is_whitespace` (the Unicode White_Space property). JavaScript's
// `trim` also removes U+FEFF, which would let a trim-tier match swallow a BOM.
const WHITESPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING_WHITESPACE = new RegExp(`^[${WHITESPACE}]+`, "u");
const TRAILING_WHITESPACE = new RegExp(`[${WHITESPACE}]+$`, "u");
const WHITESPACE_RUN = new RegExp(`[${WHITESPACE}]+`, "gu");

export function trimTrailingWhitespace(value: string): string {
  return value.replace(TRAILING_WHITESPACE, "");
}

export function trimWhitespace(value: string): string {
  return trimTrailingWhitespace(value.replace(LEADING_WHITESPACE, ""));
}

export function isBlank(value: string): boolean {
  return trimWhitespace(value).length === 0;
}

export function whitespaceWords(value: string): string[] {
  return value.split(WHITESPACE_RUN).filter((word) => word.length > 0);
}

/** Splits a line into its leading whitespace and the rest. */
export function splitIndent(value: string): readonly [indent: string, body: string] {
  const body = value.replace(LEADING_WHITESPACE, "");
  return [value.slice(0, value.length - body.length), body];
}

/** The one CR/LF scanner: every line keeps the ending that terminated it; an unterminated tail has none. */
export function scanSourceLines(contents: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let lineStart = 0;
  let cursor = 0;
  while (cursor < contents.length) {
    const code = contents.charCodeAt(cursor);
    let ending: LineEnding;
    if (code === 0x0d) ending = contents.charCodeAt(cursor + 1) === 0x0a ? "\r\n" : "\r";
    else if (code === 0x0a) ending = "\n";
    else {
      cursor += 1;
      continue;
    }
    lines.push({ text: contents.slice(lineStart, cursor), ending });
    cursor += ending.length;
    lineStart = cursor;
  }
  if (lineStart < contents.length) lines.push({ text: contents.slice(lineStart), ending: undefined });
  return lines;
}

/** The one file-style rule: the most frequent ending; a tie goes to the ending seen first; no endings means LF. */
export function preferredLineEnding(lines: readonly SourceLine[]): LineEnding {
  const counts = new Map<LineEnding, { count: number; firstSeen: number }>();
  for (const [index, line] of lines.entries()) {
    if (line.ending === undefined) continue;
    const entry = counts.get(line.ending);
    if (entry) entry.count += 1;
    else counts.set(line.ending, { count: 1, firstSeen: index });
  }
  let preferred: LineEnding = "\n";
  let best: { count: number; firstSeen: number } | undefined;
  for (const [ending, entry] of counts) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.firstSeen < best.firstSeen)) {
      best = entry;
      preferred = ending;
    }
  }
  return preferred;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Converts ascending UTF-16 offsets of `text` to UTF-8 byte offsets in one pass. */
export function utf8ByteOffsets(text: string, offsets: readonly number[]): number[] {
  const result: number[] = [];
  let unit = 0;
  let bytes = 0;
  for (const offset of offsets) {
    if (offset < unit) throw new Error("utf8ByteOffsets requires ascending offsets");
    while (unit < offset) {
      const code = text.charCodeAt(unit);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && unit + 1 < text.length) {
        // A surrogate pair is one four-byte scalar; both units are consumed here.
        bytes += 4;
        unit += 2;
        continue;
      } else bytes += 3;
      unit += 1;
    }
    result.push(bytes);
  }
  return result;
}

interface NearestEnding {
  readonly index: number;
  readonly ending: LineEnding;
}

/** Answers "which ending does a replacement line take" from precomputed nearest-ending indexes, so
 *  every lookup is constant time and a replacement of many lines stays linear. */
class EndingResolver {
  readonly #lines: readonly SourceLine[];
  readonly #previous: (NearestEnding | undefined)[];
  readonly #next: (NearestEnding | undefined)[];
  readonly #preferred: LineEnding;

  constructor(lines: readonly SourceLine[], preferred: LineEnding) {
    this.#lines = lines;
    this.#preferred = preferred;
    this.#previous = [];
    let nearest: NearestEnding | undefined;
    for (const [index, line] of lines.entries()) {
      if (line.ending !== undefined) nearest = { index, ending: line.ending };
      this.#previous.push(nearest);
    }
    this.#next = Array.from({ length: lines.length }, (): NearestEnding | undefined => undefined);
    nearest = undefined;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const ending = this.#lines[index]?.ending;
      if (ending !== undefined) nearest = { index, ending };
      this.#next[index] = nearest;
    }
  }

  endingFor(start: number, oldLength: number, relative: number): LineEnding {
    if (relative < oldLength) {
      const own = this.#lines[start + relative]?.ending;
      if (own !== undefined) return own;
    }
    const target = start + relative;
    return (this.#nearest(target, start, start + oldLength) ?? this.#nearest(target, 0, this.#lines.length))?.ending ?? this.#preferred;
  }

  #nearest(target: number, rangeStart: number, rangeEnd: number): NearestEnding | undefined {
    if (rangeStart >= rangeEnd || this.#lines.length === 0) return undefined;
    const inRange = (candidate: NearestEnding | undefined) => candidate !== undefined && candidate.index >= rangeStart && candidate.index < rangeEnd ? candidate : undefined;
    const before = inRange(this.#previous[Math.min(target, rangeEnd - 1)]);
    const after = target < rangeEnd ? inRange(this.#next[Math.max(target, rangeStart)]) : undefined;
    if (before && after) return Math.abs(after.index - target) < Math.abs(before.index - target) ? after : before;
    return before ?? after;
  }
}

/** A text file as lines with their own endings, addressable by line index and by UTF-8 byte span. */
export class SourceFile {
  #lines: SourceLine[];
  readonly #byteOffsets: number[];
  readonly #preferred: LineEnding;

  private constructor(lines: SourceLine[]) {
    this.#lines = lines;
    this.#preferred = preferredLineEnding(lines);
    this.#byteOffsets = [0];
    for (const line of lines) {
      const previous = this.#byteOffsets[this.#byteOffsets.length - 1] ?? 0;
      this.#byteOffsets.push(previous + utf8Length(line.text) + (line.ending?.length ?? 0));
    }
  }

  static parse(contents: string): SourceFile {
    return new SourceFile(scanSourceLines(contents));
  }

  get lineCount(): number {
    return this.#lines.length;
  }

  lineTexts(): string[] {
    return this.#lines.map((line) => line.text);
  }

  /** The UTF-8 byte span `length` lines from `start` occupy, endings included. */
  byteSpan(start: number, length: number): ByteSpan {
    const end = start + length;
    const startByte = this.#byteOffsets[start];
    const endByte = this.#byteOffsets[end];
    if (startByte === undefined || endByte === undefined) throw limitExceeded("line span");
    return { start: startByte, end: endByte };
  }

  /** Applies start-sorted, non-overlapping replacements and restores every new line's ending. */
  applyReplacements(replacements: readonly LineReplacement[]): void {
    const endings = new EndingResolver(this.#lines, this.#preferred);
    const lastLineUnterminated = this.#lines.length > 0 && this.#lines[this.#lines.length - 1]?.ending === undefined;
    const prepared: { start: number; oldLength: number; lines: SourceLine[]; bridge: LineEnding | undefined }[] = [];
    let previousEnd = 0;
    for (const { start, oldLength, lines } of replacements) {
      if (start + oldLength > this.#lines.length) throw limitExceeded("replacement span");
      if (start < previousEnd) throw new FileEditPlanError("replacement spans overlap");
      // A replacement that reaches the end of an unterminated file keeps the file unterminated.
      const preservesMissingFinalEnding = lastLineUnterminated && start + oldLength === this.#lines.length;
      const inserted = lines.map((text, relative) => ({
        text,
        ending: preservesMissingFinalEnding && relative + 1 === lines.length ? undefined : endings.endingFor(start, oldLength, relative),
      }));
      // An insertion after an unterminated last line must terminate that line first.
      const bridge = oldLength === 0 && inserted.length > 0 ? endings.endingFor(start, 0, 0) : undefined;
      prepared.push({ start, oldLength, lines: inserted, bridge });
      previousEnd = start + oldLength;
    }
    const result: SourceLine[] = [];
    let sourceIndex = 0;
    for (const { start, oldLength, lines, bridge } of prepared) {
      result.push(...this.#lines.slice(sourceIndex, start));
      const last = result[result.length - 1];
      if (last && last.ending === undefined && bridge !== undefined) result[result.length - 1] = { text: last.text, ending: bridge };
      result.push(...lines);
      sourceIndex = start + oldLength;
    }
    result.push(...this.#lines.slice(sourceIndex));
    this.#lines = result;
  }

  contents(): string {
    let output = "";
    for (const line of this.#lines) output += line.text + (line.ending ?? "");
    return output;
  }
}

interface EndingBoundary {
  readonly offset: number;
  readonly ending: LineEnding;
}

/** Rewrites the line boundaries of replacement text to the endings of the source span it replaces.
 *  The i-th boundary in the replacement takes the i-th boundary inside the span; further boundaries
 *  take the span's first ending, else the nearest ending around the span, else the file style.
 *  Spans must arrive in ascending order so the boundary index is scanned once. */
export class LineEndingRestorer {
  readonly #boundaries: EndingBoundary[] = [];
  readonly #preferred: LineEnding;
  #cursor = 0;

  constructor(contents: string) {
    const lines = scanSourceLines(contents);
    let offset = 0;
    for (const line of lines) {
      if (line.ending !== undefined) this.#boundaries.push({ offset: offset + line.text.length, ending: line.ending });
      offset += line.text.length + (line.ending?.length ?? 0);
    }
    this.#preferred = preferredLineEnding(lines);
  }

  restore(replacement: string, span: TextSpan): string {
    while (this.#cursor < this.#boundaries.length && (this.#boundaries[this.#cursor]?.offset ?? Infinity) < span.start) this.#cursor += 1;
    const first = this.#cursor;
    let after = first;
    while (after < this.#boundaries.length && (this.#boundaries[after]?.offset ?? Infinity) <= span.end) after += 1;
    const replaced = this.#boundaries.slice(first, after);
    const fallback = replaced[0]?.ending ?? this.#nearestAround(first, span) ?? this.#preferred;
    // A boundary exactly at the span end also terminates the next adjacent span.
    this.#cursor = after > 0 && this.#boundaries[after - 1]?.offset === span.end ? after - 1 : after;
    return scanSourceLines(replacement)
      .map((line, index) => line.text + (line.ending === undefined ? "" : replaced[index]?.ending ?? fallback))
      .join("");
  }

  #nearestAround(first: number, span: TextSpan): LineEnding | undefined {
    const before = first > 0 ? this.#boundaries[first - 1] : undefined;
    const next = this.#boundaries[first];
    if (before && next) return Math.max(next.offset - span.end, 0) < span.start - before.offset ? next.ending : before.ending;
    return (before ?? next)?.ending;
  }
}
