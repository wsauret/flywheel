/** The file as lines, with a final empty element so an appended assignment
 * keeps the file newline-terminated. Nothing else is normalized: `\r` stays on
 * each line and trailing blank lines stay, so every byte this writer does not
 * mean to change survives the rejoin. */
export function configLines(source: string): string[] {
  if (source.length === 0) return [""];
  return (source.endsWith("\n") ? source : `${source}\n`).split("\n");
}

/** Replace the stated value at `index` with `nextLine`, and report how many
 * lines the file lost.
 *
 * Only the value span changes: the indentation before the key and whatever
 * follows the value on its last line - a trailing comment, the `\r` of a CRLF
 * file - are carried onto the rewritten line. */
export function replaceAssignment(lines: string[], index: number, replacement: string): number {
  const span = assignmentSpan(lines, index);
  const indent = /^\s*/.exec(lines[index] ?? "")?.[0] ?? "";
  const tail = (lines[index + span.lines - 1] ?? "").slice(span.end);
  lines.splice(index, span.lines, `${indent}${replacement}${tail}`);
  return span.lines - 1;
}

/** Remove the complete assignment at `index`, and report how many lines the
 * file lost. */
export function removeAssignment(lines: string[], index: number): number {
  const span = assignmentSpan(lines, index);
  lines.splice(index, span.lines);
  return span.lines;
}

/** Where the assignment starting at `index` ends.
 *
 * A stated value may span lines: an array or an inline table written over
 * several of them, or a multiline string. Replacing or removing the key line
 * alone would leave the rest of the old value behind, which is why every
 * writer here addresses the complete span instead. */
interface AssignmentSpan {
  /** How many lines the assignment occupies, counted from its key line. */
  readonly lines: number;
  /** Offset in the last of those lines just after the stated value. */
  readonly end: number;
}

function assignmentSpan(lines: readonly string[], index: number): AssignmentSpan {
  let depth = 0;
  let fence: string | undefined;
  let assigned = false;
  for (let i = index; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let at = 0;
    let end = 0;
    while (at < line.length) {
      if (fence !== undefined) {
        const close = multilineQuoteRunEnd(line, at, fence);
        if (close === undefined) { at += 1; continue; }
        at = close;
        fence = undefined;
        end = at;
        continue;
      }
      const char = line[at] ?? "";
      if (char === '"' || char === "'") {
        const triple = char.repeat(3);
        if (line.startsWith(triple, at)) { fence = triple; at += triple.length; continue; }
        at = endOfQuoted(line, at);
        end = at;
        continue;
      }
      if (char === "#") break;
      at += 1;
      if (char.trim().length > 0) end = at;
      if (!assigned) {
        assigned = char === "=";
        continue;
      }
      if (char === "[" || char === "{") depth += 1;
      else if (char === "]" || char === "}") depth -= 1;
    }
    if (fence === undefined && assigned && depth <= 0) return { lines: i - index + 1, end };
  }
  return { lines: lines.length - index, end: (lines[lines.length - 1] ?? "").length };
}

function multilineQuoteRunEnd(line: string, at: number, fence: string): number | undefined {
  const quote = fence[0] ?? "";
  if (line[at] !== quote) return undefined;
  let end = at;
  while (line[end] === quote) end += 1;
  if (end - at < fence.length) return undefined;
  if (quote === '"') {
    let backslashes = 0;
    for (let before = at - 1; before >= 0 && line[before] === "\\"; before--) backslashes += 1;
    if (backslashes % 2 === 1) return undefined;
  }
  return end;
}

/** The index after the closing quote of the string starting at `at`, or the end
 * of the line when the file leaves it open. */
function endOfQuoted(line: string, at: number): number {
  const quote = line[at];
  for (let i = at + 1; i < line.length; i++) {
    if (quote === '"' && line[i] === "\\") { i += 1; continue; }
    if (line[i] === quote) return i + 1;
  }
  return line.length;
}

/** The index of the first section header, bounding the root table's assignments. */
export function rootEndIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) if (/^\s*\[.+\]\s*$/.test(lines[i] ?? "")) return i;
  return lines.length - 1;
}

/** The line that assigns `field`, whose text is a key pattern: a bare name, or
 *  the alternation `keyPattern` builds for a key the file may also quote. */
export function findFieldIndex(lines: string[], start: number, end: number, field: string): number {
  const pattern = new RegExp(`^\\s*${field}\\s*=`);
  for (let i = start; i < end;) {
    const line = lines[i] ?? "";
    if (pattern.test(line)) return i;
    i += /^\s*[^#\s[][^=]*=/.test(line) ? Math.max(1, assignmentSpan(lines, i).lines) : 1;
  }
  return -1;
}

/** One TOML key as the file may write it: bare, or quoted either way. */
export function keyPattern(name: string): string {
  return `(?:${name}|"${name}"|'${name}')`;
}

export function findSectionEnd(lines: string[], sectionStart: number): number {
  for (let i = sectionStart + 1; i < lines.length; i++) if (/^\s*\[.+\]\s*$/.test(lines[i] ?? "")) return i;
  return lines.length - 1;
}

export function removeSection(lines: string[], sectionStart: number, sectionEnd: number): void {
  lines.splice(sectionStart, Math.max(1, sectionEnd - sectionStart));
}

/** Whether this range still assigns anything, so an emptied section can go. */
export function sectionHasKeyLines(lines: readonly string[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (/^\s*[^#\s[][^=]*=/.test(lines[i] ?? "")) return true;
  return false;
}

interface SemanticSpan {
  readonly start: number;
  readonly end: number;
}

interface ParsedKey {
  readonly path: readonly string[];
  readonly segments: readonly SemanticSpan[];
  readonly end: number;
}

export interface SemanticKeyRewrite {
  readonly path: readonly string[];
  /** The replacement TOML key token. Omit it to remove the assignment. */
  readonly replacement?: string;
}

interface SemanticAssignment {
  readonly path: readonly string[];
  readonly key: SemanticSpan;
  readonly removal: SemanticSpan;
  readonly value: SemanticSpan;
}

interface SemanticTable {
  readonly path: readonly string[] | undefined;
  readonly start: number;
  end: number;
}

/** Upsert a TOML value at a nonempty semantic path. `literal` must be a valid TOML value.
 * Replace authored values or subtrees; insert through the deepest inline or explicit table ancestor.
 * Bytes outside the edited spans and the document's line endings remain unchanged. */
export function upsertSemanticAssignment(source: string, path: readonly string[], literal: string): string {
  const replacement = patchSemanticAssignment(source, path, literal);
  if (replacement !== undefined) return replacement;
  const next = removeSemanticSubtree(source, path);
  const tables: SemanticTable[] = [];
  const assignments = semanticAssignments(next, tables);
  const inline = assignments.filter((assignment) => isPathPrefix(assignment.path, path) && next[assignment.value.start] === "{")
    .toSorted((left, right) => right.path.length - left.path.length)[0];
  const key = (parts: readonly string[]) => parts.map(quoteTomlKey).join(".");
  if (inline !== undefined) {
    const at = inline.value.end - 1;
    const nonempty = next.slice(inline.value.start + 1, at).trim().length > 0;
    return `${next.slice(0, at)}${nonempty ? ", " : ""}${key(path.slice(inline.path.length))} = ${literal}${next.slice(at)}`;
  }
  const table = tables.filter((candidate) => candidate.path !== undefined && isPathPrefix(candidate.path, path))
    .toSorted((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))[0];
  const at = table?.end ?? tables[0]?.start ?? next.length;
  const newline = next.includes("\r\n") ? "\r\n" : "\n";
  const prefix = at > 0 && next[at - 1] !== "\n" ? newline : "";
  return `${next.slice(0, at)}${prefix}${key(path.slice(table?.path?.length ?? 0))} = ${literal}${newline}${next.slice(at)}`;
}

/** Replace one authored TOML value by semantic path while preserving every byte outside its value span.
 * Returns `undefined` when the path is absent and throws when more than one authored form controls it. */
export function patchSemanticAssignment(source: string, path: readonly string[], literal: string): string | undefined {
  const spans: SemanticSpan[] = [];
  let table: readonly string[] = [];
  let at = 0;
  while (at < source.length) {
    at = skipLayout(source, at, true);
    if (at >= source.length) break;
    if (source[at] === "[") {
      table = [];
      const arrayTable = source[at + 1] === "[";
      const close = findClosingBracket(source, at);
      if (!arrayTable) {
        const header = parseKey(source, at + 1, close);
        if (header !== undefined) table = header.path;
      }
      at = close + 1;
      continue;
    }
    const key = parseKey(source, at, source.length);
    if (key === undefined) { at = nextLine(source, at); continue; }
    const equals = skipHorizontal(source, key.end);
    if (source[equals] !== "=") { at = nextLine(source, at); continue; }
    const valueStart = skipHorizontal(source, equals + 1);
    const value = valueSpan(source, valueStart, false);
    locateSemanticSpan(source, [...table, ...key.path], valueStart, value.end, path, spans);
    at = value.next;
  }
  if (spans.length === 0) return undefined;
  if (spans.length > 1) throw new Error(`TOML path ${path.join(".")} has multiple authorities`);
  const span = spans[0];
  if (span === undefined) return undefined;
  return `${source.slice(0, span.start)}${literal}${source.slice(span.end)}`;
}

/** Renames or removes assignments by semantic TOML path in one indexed edit pass.
 * Key replacements preserve the winning value and its trailing comment. */
export function rewriteSemanticAssignmentKeys(source: string, rewrites: readonly SemanticKeyRewrite[]): string {
  if (rewrites.length === 0) return source;
  const requested = new Map(rewrites.map((rewrite) => [JSON.stringify(rewrite.path), rewrite]));
  const located = new Map<string, SemanticAssignment[]>();
  for (const assignment of semanticAssignments(source)) {
    const key = JSON.stringify(assignment.path);
    if (!requested.has(key)) continue;
    const matches = located.get(key) ?? [];
    matches.push(assignment);
    located.set(key, matches);
  }
  const edits: Array<SemanticSpan & { readonly text: string }> = [];
  for (const [key, rewrite] of requested) {
    const matches = located.get(key) ?? [];
    if (matches.length > 1) throw new Error(`TOML path ${rewrite.path.join(".")} has multiple authorities`);
    const assignment = matches[0];
    if (assignment === undefined) continue;
    const span = rewrite.replacement === undefined ? assignment.removal : assignment.key;
    edits.push({ ...span, text: rewrite.replacement ?? "" });
  }
  const coalesced: Array<SemanticSpan & { readonly text: string }> = [];
  for (const edit of edits.toSorted((left, right) => left.start - right.start)) {
    const previous = coalesced[coalesced.length - 1];
    if (previous === undefined || edit.start >= previous.end) {
      coalesced.push(edit);
      continue;
    }
    if (previous.text.length > 0 || edit.text.length > 0) throw new Error("semantic TOML key rewrites overlap");
    if (edit.end <= previous.end) continue;
    const mergedEnd = Math.max(previous.end, edit.end);
    const next = skipLayout(source, mergedEnd, false);
    coalesced[coalesced.length - 1] = {
      start: previous.start,
      end: source[next] === "," ? next + 1 : mergedEnd,
      text: "",
    };
  }
  const chunks: string[] = [];
  let end = source.length;
  for (const edit of coalesced.toReversed()) {
    if (edit.end > end) throw new Error("semantic TOML key rewrites overlap");
    chunks.push(source.slice(edit.end, end), edit.text);
    end = edit.start;
  }
  chunks.push(source.slice(0, end));
  return chunks.toReversed().join("");
}

/** Remove one complete table, including inline and dotted assignments, without rewriting other TOML. */
export function removeSemanticSubtree(source: string, path: readonly string[]): string {
  const next = rewriteSemanticAssignmentKeys(source, semanticAssignments(source)
    .filter((assignment) => pathsEqual(path, assignment.path) || isPathPrefix(path, assignment.path))
    .map((assignment) => ({ path: assignment.path })));
  const spans: SemanticSpan[] = [];
  let at = 0;
  while (at < next.length) {
    at = skipLayout(next, at, true);
    if (next[at] === "[") {
      const close = findClosingBracket(next, at);
      const header = parseKey(next, at + 1, close)?.path;
      if (header !== undefined && (pathsEqual(path, header) || isPathPrefix(path, header))) spans.push({ start: lineStart(next, at), end: nextLine(next, close) });
      at = nextLine(next, close);
      continue;
    }
    const key = parseKey(next, at, next.length);
    const equals = key === undefined ? at : skipHorizontal(next, key.end);
    at = next[equals] === "=" ? valueSpan(next, skipHorizontal(next, equals + 1), false).next : nextLine(next, at);
  }
  return spans.toReversed().reduce((text, span) => text.slice(0, span.start) + text.slice(span.end), next);
}

/** One TOML key token for `value`: bare when TOML allows it, else quoted. */
export function quoteTomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

/** The body of a basic TOML string that holds `value`. */
export function escapeTomlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Rename one table wherever the document names it: in a table header, in a
 * dotted key, or in an inline table. `path` names the table, and
 * `replacement` is its new last key, as a valid TOML key token. Every byte
 * outside the renamed key tokens stays unchanged. */
export function renameSemanticTable(source: string, path: readonly string[], replacement: string): string {
  const spans: SemanticSpan[] = [];
  const visit = (key: ParsedKey, parent: readonly string[]): void => {
    const span = key.segments[path.length - 1 - parent.length];
    const named = [...parent, ...key.path];
    if (span !== undefined && path.every((part, index) => part === named[index])) spans.push(span);
  };
  let table: readonly string[] = [];
  let at = 0;
  while (at < source.length) {
    at = skipLayout(source, at, true);
    if (at >= source.length) break;
    if (source[at] === "[") {
      const close = findClosingBracket(source, at);
      const header = source[at + 1] === "[" ? undefined : parseKey(source, at + 1, close);
      table = header?.path ?? [];
      if (header !== undefined) visit(header, []);
      at = close + 1;
      continue;
    }
    const key = parseKey(source, at, source.length);
    if (key === undefined) { at = nextLine(source, at); continue; }
    const equals = skipHorizontal(source, key.end);
    if (source[equals] !== "=") { at = nextLine(source, at); continue; }
    visit(key, table);
    const valueStart = skipHorizontal(source, equals + 1);
    const value = valueSpan(source, valueStart, false);
    if (source[valueStart] === "{") visitInlineKeys(source, valueStart + 1, value.end - 1, [...table, ...key.path], visit);
    at = value.next;
  }
  return spans.toSorted((left, right) => right.start - left.start)
    .reduce((text, span) => `${text.slice(0, span.start)}${replacement}${text.slice(span.end)}`, source);
}

function visitInlineKeys(source: string, initial: number, limit: number, parent: readonly string[], visit: (key: ParsedKey, parent: readonly string[]) => void): void {
  let at = initial;
  while (at < limit) {
    at = skipLayout(source, at, false);
    if (at >= limit || source[at] === "}") return;
    const key = parseKey(source, at, limit);
    if (key === undefined) return;
    const equals = skipHorizontal(source, key.end);
    if (source[equals] !== "=") return;
    visit(key, parent);
    const start = skipLayout(source, equals + 1, false);
    const value = valueSpan(source, start, true);
    if (source[start] === "{") visitInlineKeys(source, start + 1, value.end - 1, [...parent, ...key.path], visit);
    at = value.next;
    if (source[at] === ",") at += 1;
  }
}

function semanticAssignments(source: string, tables?: SemanticTable[]): readonly SemanticAssignment[] {
  const assignments: SemanticAssignment[] = [];
  let table: readonly string[] = [];
  let at = 0;
  while (at < source.length) {
    at = skipLayout(source, at, true);
    if (at >= source.length) break;
    if (source[at] === "[") {
      table = [];
      const arrayTable = source[at + 1] === "[";
      const close = findClosingBracket(source, at);
      if (!arrayTable) table = parseKey(source, at + 1, close)?.path ?? [];
      const preceding = tables?.at(-1);
      if (preceding !== undefined) preceding.end = lineStart(source, at);
      tables?.push({ path: arrayTable ? undefined : table, start: lineStart(source, at), end: source.length });
      at = close + 1;
      continue;
    }
    const keyStart = at;
    const key = parseKey(source, keyStart, source.length);
    if (key === undefined) { at = nextLine(source, at); continue; }
    const equals = skipHorizontal(source, key.end);
    if (source[equals] !== "=") { at = nextLine(source, at); continue; }
    const valueStart = skipHorizontal(source, equals + 1);
    const value = valueSpan(source, valueStart, false);
    const path = [...table, ...key.path];
    const keySpan = key.segments.at(-1);
    if (keySpan === undefined) { at = value.next; continue; }
    assignments.push({
      path,
      key: keySpan,
      removal: { start: lineStart(source, keyStart), end: value.next },
      value,
    });
    if (source[valueStart] === "{") collectInlineAssignments(source, valueStart + 1, value.end - 1, path, assignments);
    at = value.next;
  }
  return assignments;
}

function collectInlineAssignments(
  source: string,
  initial: number,
  limit: number,
  parent: readonly string[],
  assignments: SemanticAssignment[],
): void {
  let at = initial;
  let precedingComma: number | undefined;
  while (at < limit) {
    const layoutStart = at;
    at = skipLayout(source, at, false);
    if (at >= limit || source[at] === "}") return;
    const key = parseKey(source, at, limit);
    if (key === undefined) return;
    const equals = skipHorizontal(source, key.end);
    if (source[equals] !== "=") return;
    const valueStart = skipLayout(source, equals + 1, false);
    const value = valueSpan(source, valueStart, true);
    const comma = source[value.next] === "," ? value.next : undefined;
    const path = [...parent, ...key.path];
    const keySpan = key.segments.at(-1);
    if (keySpan === undefined) return;
    assignments.push({
      path,
      key: keySpan,
      removal: precedingComma !== undefined
        ? { start: precedingComma, end: value.end }
        : { start: layoutStart, end: comma === undefined ? value.end : comma + 1 },
      value,
    });
    if (source[valueStart] === "{") collectInlineAssignments(source, valueStart + 1, value.end - 1, path, assignments);
    if (comma === undefined) return;
    precedingComma = comma;
    at = comma + 1;
  }
}

function lineStart(source: string, at: number): number {
  const newline = source.lastIndexOf("\n", at - 1);
  return newline < 0 ? 0 : newline + 1;
}

function locateSemanticSpan(source: string, assignedPath: readonly string[], start: number, end: number, target: readonly string[], spans: SemanticSpan[]): void {
  if (pathsEqual(assignedPath, target)) {
    spans.push({ start, end });
    return;
  }
  if (!isPathPrefix(assignedPath, target) || source[start] !== "{") return;
  locateInlineMember(source, start + 1, end - 1, assignedPath, target, spans);
}

function locateInlineMember(source: string, initial: number, limit: number, parent: readonly string[], target: readonly string[], spans: SemanticSpan[]): void {
  let at = initial;
  while (at < limit) {
    at = skipLayout(source, at, false);
    if (at >= limit || source[at] === "}") return;
    const key = parseKey(source, at, limit);
    if (key === undefined) return;
    const equals = skipHorizontal(source, key.end);
    if (source[equals] !== "=") return;
    const start = skipLayout(source, equals + 1, false);
    const value = valueSpan(source, start, true);
    locateSemanticSpan(source, [...parent, ...key.path], start, value.end, target, spans);
    at = value.next;
    if (source[at] === ",") at += 1;
  }
}

function parseKey(source: string, initial: number, limit: number): ParsedKey | undefined {
  const path: string[] = [];
  const segments: SemanticSpan[] = [];
  let at = skipHorizontal(source, initial);
  while (at < limit) {
    const start = at;
    const quote = source[at];
    if (quote === '"' || quote === "'") {
      const end = quotedEnd(source, at, quote);
      const token = source.slice(at, end);
      path.push(quote === '"' ? decodeBasicKey(token) : token.slice(1, -1));
      at = end;
    } else {
      while (at < limit && isBareKeyCharacter(source[at] ?? "")) at += 1;
      if (at === start) return path.length > 0 ? { path, segments, end: at } : undefined;
      path.push(source.slice(start, at));
    }
    segments.push({ start, end: at });
    at = skipHorizontal(source, at);
    if (source[at] !== ".") return { path, segments, end: at };
    at = skipHorizontal(source, at + 1);
  }
  return path.length > 0 ? { path, segments, end: at } : undefined;
}

function isBareKeyCharacter(char: string): boolean {
  return (char >= "A" && char <= "Z")
    || (char >= "a" && char <= "z")
    || (char >= "0" && char <= "9")
    || char === "_"
    || char === "-";
}

function decodeBasicKey(token: string): string {
  const parsed: unknown = Bun.TOML.parse(`${token} = 0`);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid TOML basic key");
  const key = Object.keys(parsed)[0];
  if (key === undefined) throw new Error("invalid TOML basic key");
  return key;
}

function quotedEnd(source: string, initial: number, quote: string): number {
  for (let at = initial + 1; at < source.length; at++) {
    if (quote === '"' && source[at] === "\\") { at += 1; continue; }
    if (source[at] === quote) return at + 1;
  }
  return source.length;
}

function valueSpan(source: string, initial: number, inline: boolean): SemanticSpan & { readonly next: number } {
  let square = 0;
  let curly = 0;
  let at = initial;
  let end = initial;
  while (at < source.length) {
    const char = source[at] ?? "";
    if (char === '"' || char === "'") {
      const triple = char.repeat(3);
      at = source.startsWith(triple, at) ? multilineQuotedEnd(source, at, triple) : quotedEnd(source, at, char);
      end = at;
      continue;
    }
    if (char === "#") {
      at = nextLine(source, at);
      if (!inline && square === 0 && curly === 0) return { start: initial, end, next: at };
      continue;
    }
    if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "{") curly += 1;
    else if (char === "}") {
      if (inline && curly === 0 && square === 0) return { start: initial, end, next: at };
      curly -= 1;
    } else if (char === "," && inline && square === 0 && curly === 0) return { start: initial, end, next: at };
    else if ((char === "\n" || char === "\r") && !inline && square === 0 && curly === 0) return { start: initial, end, next: nextLine(source, at) };
    at += 1;
    if (char.trim().length > 0) end = at;
  }
  return { start: initial, end, next: at };
}

function multilineQuotedEnd(source: string, initial: number, fence: string): number {
  const quote = fence[0] ?? "";
  const basic = quote === '"';
  let at = initial + fence.length;
  while (at < source.length) {
    if (source[at] !== quote) { at += 1; continue; }
    const runStart = at;
    while (source[at] === quote) at += 1;
    if (at - runStart < fence.length) continue;
    if (basic) {
      let backslashes = 0;
      for (let before = runStart - 1; before >= initial && source[before] === "\\"; before--) backslashes += 1;
      if (backslashes % 2 === 1) continue;
    }
    return at;
  }
  return source.length;
}

function skipHorizontal(source: string, initial: number): number {
  let at = initial;
  while (source[at] === " " || source[at] === "\t") at += 1;
  return at;
}

function skipLayout(source: string, initial: number, stopAfterComment: boolean): number {
  let at = initial;
  while (at < source.length) {
    if (/\s/.test(source[at] ?? "")) { at += 1; continue; }
    if (source[at] !== "#") return at;
    at = nextLine(source, at);
    if (stopAfterComment) continue;
  }
  return at;
}

function nextLine(source: string, initial: number): number {
  const newline = source.indexOf("\n", initial);
  return newline < 0 ? source.length : newline + 1;
}

function findClosingBracket(source: string, initial: number): number {
  let quote: string | undefined;
  for (let at = initial + 1; at < source.length; at++) {
    const char = source[at] ?? "";
    if (quote !== undefined) {
      if (quote === '"' && char === "\\") at += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "]") return at;
  }
  return source.length;
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function isPathPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length < path.length && prefix.every((part, index) => part === path[index]);
}
