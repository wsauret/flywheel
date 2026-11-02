/** Plans one string replacement against caller-owned text through an ordered
 *  ladder of recovery tiers. The first tier that finds anything decides: unique
 *  mode needs exactly one match there, and `replaceAll` takes every match there.
 *  Every tier reports spans on the source bytes, so normalization never leaks
 *  into the published file; the replacement text takes the source's own line
 *  endings and, after an indentation tier, the source's indentation shift.
 *
 *  The display-prefix and uniform-indent tiers follow techniques from OMP / pi
 *  (MIT). The escape-normalized tier is ported from Hermes
 *  `fuzzy_match.py` (MIT, Copyright (c) 2025 Nous Research). */

import { type ByteSpan, FILE_EDIT_LIMITS, type FileEditLimits, FileEditPlanError, limitExceeded } from "./contract.js";
import { applyIndentDelta, foldTypography, type IndentDelta, indentDelta, NO_INDENT_DELTA, sameIndentDelta } from "./seek-sequence.js";
import { isBlank, LineEndingRestorer, scanSourceLines, splitIndent, type TextSpan, trimTrailingWhitespace, trimWhitespace, utf8ByteOffsets, whitespaceWords } from "./text-file.js";

const STRING_MATCH_KINDS = [
  "exact",
  "line-ending",
  "display-prefix",
  "trailing-whitespace",
  "unicode-typography",
  "uniform-indent",
  "unicode-escape",
  "escape-normalized",
] as const;
type StringMatchKind = (typeof STRING_MATCH_KINDS)[number];

export interface StringEdit {
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll?: boolean;
}

export interface StringEditPlan {
  readonly content: string;
  readonly spans: readonly ByteSpan[];
  readonly matchKind: StringMatchKind;
}

/** Spans one tier found, with the replacement text each span takes. */
interface TierMatches {
  readonly spans: readonly TextSpan[];
  readonly replacementFor: (newString: string, index: number) => string;
}

export interface StringEditMatch extends TierMatches {
  readonly matchKind: StringMatchKind;
  readonly oldString: string;
}

export interface StringEditReplacement {
  readonly newString: string;
  readonly replaceAll?: boolean;
}

interface LogicalLine {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface NormalizedOffset {
  readonly normalized: number;
  readonly source: number;
}

/** Normalized text with the offset map that lands a normalized match back on source units. */
interface Normalized {
  readonly text: string;
  readonly offsets: readonly NormalizedOffset[];
}

const CANDIDATE_LIMIT = 3;
const CANDIDATE_CHARACTERS = 80;
const ESCAPE_SEQUENCES: readonly (readonly [literal: string, control: string])[] = [["\\n", "\n"], ["\\t", "\t"], ["\\r", "\r"]];

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

function codePointLengthAt(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1;
}

function findMatchSpans(source: string, needle: string): TextSpan[] {
  const spans: TextSpan[] = [];
  if (needle.length === 0) return spans;
  for (let start = source.indexOf(needle); start !== -1; start = source.indexOf(needle, start + codePointLengthAt(source, start))) {
    spans.push({ start, end: start + needle.length });
  }
  return spans;
}

/** Normalizes line endings to LF, drops trailing spaces and tabs, and folds typography, as asked,
 *  recording where the normalized text and the source drift apart. */
function normalize(text: string, endings: boolean, trailing: boolean, typography: boolean): Normalized {
  let output = "";
  const offsets: NormalizedOffset[] = [{ normalized: 0, source: 0 }];
  const push = (value: string, sourceEnd: number) => {
    output += value;
    // SAFETY: the map starts with one entry and only grows.
    const previous = offsets[offsets.length - 1]!;
    if (sourceEnd - output.length !== previous.source - previous.normalized) offsets.push({ normalized: output.length, source: sourceEnd });
  };
  let pendingSpaces: number | undefined;
  let index = 0;
  while (index < text.length) {
    // SAFETY: index is below text.length.
    const character = text[index]!;
    const isNewline = character === "\n" || character === "\r";
    if (trailing && (character === " " || character === "\t")) {
      pendingSpaces ??= index;
      index += 1;
      continue;
    }
    if (pendingSpaces !== undefined) {
      // Spaces before a newline (or the end of text) are trailing and vanish; any other run is kept.
      if (!isNewline) for (let space = pendingSpaces; space < index; space += 1) push(text[space] ?? "", space + 1);
      pendingSpaces = undefined;
    }
    if (isNewline && endings) {
      const sourceEnd = character === "\r" && text[index + 1] === "\n" ? index + 2 : index + 1;
      push("\n", sourceEnd);
      index = sourceEnd;
      continue;
    }
    push((typography ? foldTypography(character) : undefined) ?? character, index + 1);
    index += 1;
  }
  return { text: output, offsets };
}

function sourceOffset(normalized: Normalized, offset: number): number {
  let low = 0;
  let high = normalized.offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((normalized.offsets[middle]?.normalized ?? Infinity) <= offset) low = middle;
    else high = middle - 1;
  }
  // SAFETY: the map always holds its zero entry, so the search lands on one.
  const entry = normalized.offsets[low]!;
  return entry.source + offset - entry.normalized;
}

function normalizedMatches(contents: string, needle: string, endings: boolean, trailing: boolean, typography: boolean): TextSpan[] {
  const source = normalize(contents, endings, trailing, typography);
  const target = normalize(needle, endings, trailing, typography);
  return findMatchSpans(source.text, target.text).map((span) => ({ start: sourceOffset(source, span.start), end: sourceOffset(source, span.end) }));
}

/** Strips `N|` read prefixes or `*N|` / ` N|` search prefixes when every line proves one active,
 *  monotonic numbering; returns undefined when the text is not a numbered listing. */
function stripProvenDisplayPrefixes(text: string): string | undefined {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let listing: "read" | "search" | undefined;
  let previous: number | undefined;
  const stripped: string[] = [];
  for (const line of lines) {
    const first = line[0];
    let kind: "read" | "search";
    let digitStart: number;
    if (isDigit(first)) [kind, digitStart] = ["read", 0];
    else if (first === "*" || first === " ") [kind, digitStart] = ["search", 1];
    else return undefined;
    listing ??= kind;
    if (listing !== kind) return undefined;
    let digits = 0;
    while (isDigit(line[digitStart + digits])) digits += 1;
    if (digits === 0 || line[digitStart + digits] !== "|") return undefined;
    const lineNumber = Number(line.slice(digitStart, digitStart + digits));
    if (lineNumber === 0 || (previous !== undefined && (lineNumber <= previous || (kind === "read" && lineNumber !== previous + 1)))) return undefined;
    previous = lineNumber;
    stripped.push(line.slice(digitStart + digits + 1));
  }
  return stripped.length === 0 ? undefined : stripped.join("\n");
}

/** Lines with their unit offsets; a text that ends with an ending also has a final empty line. */
function logicalLines(text: string): LogicalLine[] {
  const scanned = scanSourceLines(text);
  const lines: LogicalLine[] = [];
  let offset = 0;
  for (const line of scanned) {
    lines.push({ start: offset, end: offset + line.text.length, text: line.text });
    offset += line.text.length + (line.ending?.length ?? 0);
  }
  if (scanned.length === 0 || scanned[scanned.length - 1]?.ending !== undefined) lines.push({ start: text.length, end: text.length, text: "" });
  return lines;
}

function formatCandidate(lineNumber: number, line: string): string {
  const characters = [...trimWhitespace(line)];
  return `line ${lineNumber}: ${characters.slice(0, CANDIDATE_CHARACTERS).join("")}${characters.length > CANDIDATE_CHARACTERS ? "…" : ""}`;
}

function joinCandidates(candidates: readonly string[]): string {
  return candidates.length === 0 ? "none" : candidates.join("; ");
}

function matchedCandidates(contents: string, spans: readonly TextSpan[]): string {
  const lines = logicalLines(contents);
  const candidates: string[] = [];
  for (const span of spans.slice(0, CANDIDATE_LIMIT)) {
    const index = lines.findIndex((line) => span.start >= line.start && span.start <= line.end);
    const line = lines[index];
    if (line) candidates.push(formatCandidate(index + 1, line.text));
  }
  return joinCandidates(candidates);
}

function sharedPrefixLength(left: string, right: string): number {
  let count = 0;
  const rightCharacters = [...right];
  for (const character of left) {
    if (rightCharacters[count] !== character) break;
    count += 1;
  }
  return count;
}

/** Up to three source lines closest to the first non-blank line of `old`, for diagnostics only. Similarity never authorizes an edit. */
export function nearestSourceLines(contents: string, old: string): readonly { readonly lineNumber: number; readonly text: string }[] {
  const oldLines = old.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const needle = trimWhitespace(oldLines.find((line) => !isBlank(line)) ?? old);
  const needleWords = whitespaceWords(needle);
  const ranked: { score: number; lineNumber: number; text: string }[] = [];
  for (const [index, line] of logicalLines(contents).entries()) {
    const candidate = trimWhitespace(line.text);
    if (candidate.length === 0) continue;
    const candidateWords = whitespaceWords(candidate);
    const sharedWords = needleWords.filter((word) => candidateWords.includes(word)).length;
    const score = sharedWords * 1_000 + sharedPrefixLength(needle, candidate);
    if (score === 0) continue;
    const lineNumber = index + 1;
    const position = ranked.findIndex((current) => score > current.score || (score === current.score && lineNumber < current.lineNumber));
    ranked.splice(position === -1 ? ranked.length : position, 0, { score, lineNumber, text: line.text });
    if (ranked.length > CANDIDATE_LIMIT) ranked.length = CANDIDATE_LIMIT;
  }
  return ranked;
}

function nearestCandidates(contents: string, old: string): string {
  return joinCandidates(nearestSourceLines(contents, old).map(entry => formatCandidate(entry.lineNumber, entry.text)));
}

function uniformIndentMatches(contents: string, old: string): { readonly span: TextSpan; readonly delta: IndentDelta }[] {
  const oldLines = old.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (oldLines.every(isBlank)) return [];
  const source = logicalLines(contents);
  const matches: { span: TextSpan; delta: IndentDelta }[] = [];
  for (let start = 0; start + oldLines.length <= source.length; start += 1) {
    let delta: IndentDelta | undefined;
    const window = source.slice(start, start + oldLines.length);
    const valid = window.every((line, offset) => {
      const expected = oldLines[offset] ?? "";
      if (isBlank(line.text) && isBlank(expected)) return true;
      const [actualIndent, actualBody] = splitIndent(line.text);
      const [expectedIndent, expectedBody] = splitIndent(expected);
      if (trimTrailingWhitespace(actualBody) !== trimTrailingWhitespace(expectedBody)) return false;
      const lineDelta = indentDelta(actualIndent, expectedIndent);
      if (lineDelta === undefined) return false;
      if (delta === undefined) {
        delta = lineDelta;
        return true;
      }
      return sameIndentDelta(delta, lineDelta);
    });
    const first = window[0];
    const last = window[window.length - 1];
    if (valid && delta !== undefined && first && last) matches.push({ span: { start: first.start, end: last.end }, delta });
  }
  return matches;
}

/** Decodes the literal `\n`, `\t`, and `\r` sequences a serialized tool call carried instead of the control characters. */
function decodeEscapes(text: string, sequences: readonly (readonly [string, string])[]): string {
  let decoded = text;
  for (const [literal, control] of sequences) decoded = decoded.replaceAll(literal, control);
  return decoded;
}

function escapeNormalizedMatches(contents: string, oldString: string): TierMatches | undefined {
  const present = ESCAPE_SEQUENCES.filter(([literal]) => oldString.includes(literal));
  if (present.length === 0) return undefined;
  const spans = findMatchSpans(contents, decodeEscapes(oldString, present));
  return { spans, replacementFor: (newString) => decodeEscapes(newString, present) };
}

/** The curly forms of each straight quote, as [opening, closing]. */
const CURLY_FORMS: ReadonlyMap<string, readonly [opening: string, closing: string]> = new Map([
  ["\"", ["\u201c", "\u201d"]],
  ["'", ["\u2018", "\u2019"]],
]);
/** A quote after one of these characters, or at the start of the text, opens a quotation. */
const OPENS_QUOTATION_AFTER = " \t\n\r([{\u2014\u2013";

type QuoteStyle = "curly" | "straight";

/** The replacement in the quote style of the source text it replaces. The typography fold matches a straight
 *  quote to a curly one, so for each quote kind where the matched text and the old string differ in style,
 *  the replacement takes the style of the matched text. A kind where both agree stays as the call wrote it. */
function withQuoteStyle(newString: string, oldString: string, matched: string): string {
  const styles = new Map<string, QuoteStyle>();
  for (const [straight, forms] of CURLY_FORMS) {
    const fileCurly = forms.some((form) => matched.includes(form));
    if (fileCurly !== forms.some((form) => oldString.includes(form))) styles.set(straight, fileCurly ? "curly" : "straight");
  }
  if (styles.size === 0) return newString;
  const characters = [...newString];
  return characters.map((character, index) => {
    const straight = straightForm(character);
    const style = straight === undefined ? undefined : styles.get(straight);
    if (straight === undefined || style === undefined) return character;
    if (style === "straight") return straight;
    if (character !== straight) return character;
    return curlyForm(straight, characters[index - 1], characters[index + 1]);
  }).join("");
}

/** The straight quote that `character` is a form of, or undefined when it is not a quote. */
function straightForm(character: string): string | undefined {
  for (const [straight, forms] of CURLY_FORMS) if (character === straight || forms.includes(character)) return straight;
  return undefined;
}

/** The curly form of a straight quote between `before` and `after`. A single quote between two letters is an
 *  apostrophe, which is the closing form. */
function curlyForm(straight: string, before: string | undefined, after: string | undefined): string {
  // SAFETY: callers pass only keys of CURLY_FORMS.
  const [opening, closing] = CURLY_FORMS.get(straight)!;
  if (straight === "'" && isLetter(before) && isLetter(after)) return closing;
  return before === undefined || OPENS_QUOTATION_AFTER.includes(before) ? opening : closing;
}

function isLetter(character: string | undefined): boolean {
  return character !== undefined && /^\p{L}$/u.test(character);
}

/** The value of the four hex digits after `text[at]` and `text[at + 1]` when they spell `\u`, or undefined. */
function escapeAt(text: string, at: number): number | undefined {
  if (text.charCodeAt(at) !== 0x5c || text.charCodeAt(at + 1) !== 0x75) return undefined;
  const digits = text.slice(at + 2, at + 6);
  return /^[0-9a-fA-F]{4}$/.test(digits) ? Number.parseInt(digits, 16) : undefined;
}

/** Decodes each `\uXXXX` escape whose backslash is not itself escaped. */
function decodeUnicodeEscapes(text: string): string {
  let decoded = "";
  let index = 0;
  while (index < text.length) {
    const character = text.charAt(index);
    if (character === "\\" && text.charAt(index + 1) === "\\") {
      decoded += "\\\\";
      index += 2;
      continue;
    }
    const unit = escapeAt(text, index);
    decoded += unit === undefined ? character : String.fromCharCode(unit);
    index += unit === undefined ? 1 : 6;
  }
  return decoded;
}

function isAscii(unit: number): boolean {
  return unit < 0x80;
}

function oddBackslashesBefore(text: string, index: number): boolean {
  let count = 0;
  while (text.charCodeAt(index - 1 - count) === 0x5c) count += 1;
  return count % 2 === 1;
}

/** One place where the file writes `oldString` with each non-ASCII code unit as a `\uXXXX` escape, the hex
 *  digits the file used for each code unit there, and whether its escapes used more uppercase hex letters. */
interface EscapedSpan {
  readonly span: TextSpan;
  readonly hexByUnit: ReadonlyMap<number, string>;
  readonly upperHex: boolean;
}

/** Reads `oldString` at `start` in `contents`, where an ASCII unit stands for itself and a non-ASCII unit is an
 *  escape with hex digits of either case. An escape after an odd run of backslashes is literal text, and so is a
 *  leading backslash of the old string. */
function escapedSpanAt(contents: string, oldString: string, start: number): EscapedSpan | undefined {
  if (contents.charCodeAt(start) === 0x5c && oddBackslashesBefore(contents, start)) return undefined;
  const hexByUnit = new Map<number, string>();
  let letterBalance = 0;
  let cursor = start;
  for (let index = 0; index < oldString.length; index += 1) {
    const unit = oldString.charCodeAt(index);
    if (isAscii(unit)) {
      if (contents.charCodeAt(cursor) !== unit) return undefined;
      cursor += 1;
      continue;
    }
    if (escapeAt(contents, cursor) !== unit || oddBackslashesBefore(contents, cursor)) return undefined;
    const hex = contents.slice(cursor + 2, cursor + 6);
    hexByUnit.set(unit, hex);
    for (const digit of hex) letterBalance += digit >= "A" && digit <= "F" ? 1 : digit >= "a" && digit <= "f" ? -1 : 0;
    cursor += 6;
  }
  return { span: { start, end: cursor }, hexByUnit, upperHex: letterBalance > 0 };
}

/** Every place, left to right and without overlap, where the file writes `oldString` with its non-ASCII code
 *  units escaped. */
function escapedSpans(contents: string, oldString: string): EscapedSpan[] {
  const found: EscapedSpan[] = [];
  const firstUnit = oldString.charCodeAt(0);
  const anchor = isAscii(firstUnit) ? oldString.charAt(0) : "\\u";
  for (let start = contents.indexOf(anchor); start !== -1; start = contents.indexOf(anchor, start)) {
    const escaped = escapedSpanAt(contents, oldString, start);
    if (escaped === undefined) {
      start += 1;
      continue;
    }
    found.push(escaped);
    start = escaped.span.end;
  }
  return found;
}

/** Writes each non-ASCII code unit of `text` as an escape in the file's spelling: the hex digits the matched span
 *  used for the same unit, otherwise the hex letter case that the span used most, with lowercase on a tie. */
function escapeLike(text: string, matched: EscapedSpan | undefined): string {
  const hexByUnit = matched?.hexByUnit ?? new Map<number, string>();
  let escaped = "";
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (isAscii(unit)) {
      escaped += text.charAt(index);
      continue;
    }
    const hex = unit.toString(16).padStart(4, "0");
    escaped += `\\u${hexByUnit.get(unit) ?? (matched?.upperHex === true ? hex.toUpperCase() : hex)}`;
  }
  return escaped;
}

/** Bridges `\uXXXX` escapes in either direction. When the call escaped characters, the file writes them as
 *  literal characters. When the call wrote non-ASCII characters, the file escapes them, and the replacement is
 *  escaped the same way. */
function unicodeEscapeMatches(contents: string, oldString: string): TierMatches | undefined {
  const decoded = decodeUnicodeEscapes(oldString);
  if (decoded !== oldString) return { spans: findMatchSpans(contents, decoded), replacementFor: decodeUnicodeEscapes };
  if (![...oldString].some((character) => !isAscii(character.charCodeAt(0))) || !contents.includes("\\u")) return undefined;
  const matches = escapedSpans(contents, oldString);
  return { spans: matches.map((match) => match.span), replacementFor: (newString, index) => escapeLike(newString, matches[index]) };
}

type Tier = (contents: string, oldString: string) => TierMatches | undefined;

const TIERS = {
  exact: (contents: string, oldString: string) => ({ spans: findMatchSpans(contents, oldString), replacementFor: (newString) => newString }),
  "line-ending": (contents: string, oldString: string) => ({ spans: normalizedMatches(contents, oldString, true, false, false), replacementFor: (newString) => newString }),
  "display-prefix": (contents: string, oldString: string) => {
    const stripped = stripProvenDisplayPrefixes(oldString);
    return stripped === undefined ? undefined : { spans: normalizedMatches(contents, stripped, true, false, false), replacementFor: (newString) => newString };
  },
  "trailing-whitespace": (contents: string, oldString: string) => ({ spans: normalizedMatches(contents, oldString, true, true, false), replacementFor: (newString) => newString }),
  "unicode-typography": (contents: string, oldString: string) => {
    const spans = normalizedMatches(contents, oldString, true, true, true);
    return { spans, replacementFor: (newString, index) => withQuoteStyle(newString, oldString, contents.slice(spans[index]?.start, spans[index]?.end)) };
  },
  "uniform-indent": (contents: string, oldString: string) => {
    const matches = uniformIndentMatches(contents, oldString);
    return { spans: matches.map((match) => match.span), replacementFor: (newString, index) => applyIndentDelta(newString.split("\n"), matches[index]?.delta ?? NO_INDENT_DELTA).join("\n") };
  },
  "unicode-escape": unicodeEscapeMatches,
  "escape-normalized": escapeNormalizedMatches,
} satisfies { readonly [K in StringMatchKind]: Tier };

export function finishStringEdit(contents: string, match: StringEditMatch, replacement: StringEditReplacement, limits: FileEditLimits = FILE_EDIT_LIMITS): StringEditPlan {
  if (utf8Length(match.oldString) + utf8Length(replacement.newString) > limits.maxOutputBytes) throw limitExceeded("string edit bytes");
  const spans = match.spans;
  if (replacement.replaceAll !== true && spans.length !== 1) {
    throw new FileEditPlanError(`string edit refused at ${match.matchKind} tier: ${spans.length} matches; nearest lines: ${matchedCandidates(contents, spans)}`);
  }
  for (let index = 1; index < spans.length; index += 1) {
    if ((spans[index]?.start ?? 0) < (spans[index - 1]?.end ?? 0)) throw new FileEditPlanError("replacement spans overlap");
  }
  const selected = replacement.replaceAll === true ? spans : spans.slice(0, 1);
  const endings = new LineEndingRestorer(contents);
  let output = "";
  let cursor = 0;
  for (const [index, span] of selected.entries()) {
    output += contents.slice(cursor, span.start) + endings.restore(match.replacementFor(replacement.newString, index), span);
    cursor = span.end;
  }
  output += contents.slice(cursor);
  if (output === contents) throw new FileEditPlanError("the replacement produced no change");
  if (utf8Length(output) > limits.maxOutputBytes) throw limitExceeded("output bytes");
  const byteOffsets = utf8ByteOffsets(contents, selected.flatMap((span) => [span.start, span.end]));
  const byteSpans = selected.map((_, index) => ({ start: byteOffsets[index * 2] ?? 0, end: byteOffsets[index * 2 + 1] ?? 0 }));
  return { content: output, spans: byteSpans, matchKind: match.matchKind };
}

function findStringEditMatch(contents: string, oldString: string): StringEditMatch {
  for (const matchKind of STRING_MATCH_KINDS) {
    const matches = TIERS[matchKind](contents, oldString);
    if (matches !== undefined && matches.spans.length > 0) return { ...matches, matchKind, oldString };
  }
  const lastTier = STRING_MATCH_KINDS[STRING_MATCH_KINDS.length - 1];
  throw new FileEditPlanError(`string edit refused: no match after ${lastTier} tier; nearest lines: ${nearestCandidates(contents, oldString)}`);
}

/** Selects the first matching tier using only the source and old string. */
export function matchStringEdit(contents: string, oldString: string, limits: FileEditLimits = FILE_EDIT_LIMITS): StringEditMatch {
  if (oldString.length === 0) throw new FileEditPlanError("old_string must not be empty");
  if (contents.includes("\0")) throw new FileEditPlanError("binary content cannot be edited");
  if (utf8Length(contents) > limits.maxOutputBytes) throw limitExceeded("input bytes");
  if (utf8Length(oldString) > limits.maxOutputBytes) throw limitExceeded("string edit bytes");
  return findStringEditMatch(contents, oldString);
}

/** Plans the replacement of `oldString` in `contents`. Unique mode refuses more than one match at
 *  the deciding tier and names up to three of them; no match at any tier names the nearest lines. */
export function planStringEdit(contents: string, edit: StringEdit, limits: FileEditLimits = FILE_EDIT_LIMITS): StringEditPlan {
  if (edit.oldString.length === 0) throw new FileEditPlanError("old_string must not be empty");
  if (contents.includes("\0")) throw new FileEditPlanError("binary content cannot be edited");
  if (utf8Length(contents) > limits.maxOutputBytes) throw limitExceeded("input bytes");
  if (utf8Length(edit.oldString) + utf8Length(edit.newString) > limits.maxOutputBytes) throw limitExceeded("string edit bytes");
  if (edit.oldString === edit.newString) return { content: contents, spans: [], matchKind: "exact" };
  return finishStringEdit(contents, findStringEditMatch(contents, edit.oldString), edit, limits);
}
