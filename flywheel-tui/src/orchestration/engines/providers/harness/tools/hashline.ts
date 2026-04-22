/**
 * Hashline format: display, parsing, validation, and transactional editing.
 *
 * Each line is prefixed with `LINENUM#HASH:` where HASH is a 3-character
 * lowercase hex code derived from xxHash32 of the normalized line text.
 * This format gives the model line-addressable references for editing.
 */

const DICT = Array.from({ length: 4096 }, (_, i) => i.toString(16).padStart(3, "0"));

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

const CONFUSABLE_HYPHENS = /[\u2010\u2011\u2012\u2013\u2014\u2212\ufe63\uff0d]/g;
const CONFUSABLE_QUOTES = /[\u2018\u2019\u201c\u201d`\u00b4]/g;
const CONFUSABLE_SPACES = /[\u00a0\u2000-\u200b\u2028\u2029\u3000\ufeff]/g;

function normalizeConfusables(text: string): string {
  return text
    .replace(CONFUSABLE_HYPHENS, "-")
    .replace(CONFUSABLE_QUOTES, "'")
    .replace(CONFUSABLE_SPACES, " ");
}

const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

export function escapeControlChars(text: string): string {
  return text.replace(CONTROL_CHAR_RE, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function computeLineHash(idx: number, line: string): string {
  const normalized = normalizeConfusables(line.replace(/\r/g, "")).trimEnd();
  const seed = RE_SIGNIFICANT.test(normalized) ? 0 : idx;
  return DICT[Bun.hash.xxHash32(normalized, seed) % 4096]!;
}

export function formatLineTag(lineNumber: number, lineText: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, lineText)}`;
}

export function formatHashLines(content: string): string {
  const lines = content.split("\n");
  return lines
    .map((line, i) => {
      const num = i + 1;
      return `${formatLineTag(num, line)}:${escapeControlChars(line)}`;
    })
    .join("\n");
}

// ── Tag Parsing ───────────────────────────────────────────────────

interface LineRef {
  line: number;
  hash: string;
}

function parseTag(tag: string): LineRef | null {
  const match = tag.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([0-9a-f]{3})/);
  if (match) {
    const line = parseInt(match[1]!, 10);
    if (line < 1) return null;
    return { line, hash: match[2]! };
  }
  const bareMatch = tag.match(/^\s*(\d+)\s*$/);
  if (bareMatch) {
    const line = parseInt(bareMatch[1]!, 10);
    if (line < 1) return null;
    return { line, hash: "" };
  }
  return null;
}

// ── Hash Mismatch ─────────────────────────────────────────────────

interface HashMismatch {
  line: number;
  expected: string;
  actual: string;
}

function tokenSimilarity(a: string, b: string): number {
  const tokA = new Set(a.trim().split(/\s+/));
  const tokB = new Set(b.trim().split(/\s+/));
  if (tokA.size === 0 && tokB.size === 0) return 1;
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokA) if (tokB.has(t)) overlap++;
  return overlap / Math.max(tokA.size, tokB.size);
}

function findSimilarLines(
  originalLine: string,
  fileLines: string[],
  hintLine: number,
  window = 50,
  maxSuggestions = 3,
): Array<{ line: number; hash: string; content: string }> {
  const MIN_SIMILARITY = 0.3;
  const start = Math.max(0, hintLine - 1 - window);
  const end = Math.min(fileLines.length, hintLine - 1 + window + 1);
  const candidates: Array<{ line: number; score: number; content: string }> = [];
  for (let i = start; i < end; i++) {
    if (!fileLines[i]!.trim()) continue;
    const score = tokenSimilarity(originalLine, fileLines[i]!);
    if (score >= MIN_SIMILARITY) candidates.push({ line: i + 1, score, content: fileLines[i]! });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, maxSuggestions).map((c) => ({
    line: c.line,
    hash: computeLineHash(c.line, c.content),
    content: c.content,
  }));
}

const MISMATCH_CONTEXT = 2;

export class HashlineMismatchError extends Error {
  constructor(
    public readonly mismatches: HashMismatch[],
    public readonly fileLines: string[],
  ) {
    super(HashlineMismatchError.formatMessage(mismatches, fileLines));
    this.name = "HashlineMismatchError";
  }

  static formatMessage(mismatches: HashMismatch[], fileLines: string[]): string {
    const mismatchSet = new Map<number, HashMismatch>();
    for (const m of mismatches) mismatchSet.set(m.line, m);

    const displayLines = new Set<number>();
    for (const m of mismatches) {
      const lo = Math.max(1, m.line - MISMATCH_CONTEXT);
      const hi = Math.min(fileLines.length, m.line + MISMATCH_CONTEXT);
      for (let i = lo; i <= hi; i++) displayLines.add(i);
    }

    const sorted = [...displayLines].sort((a, b) => a - b);
    const lines: string[] = [
      `${mismatches.length} line${mismatches.length > 1 ? "s have" : " has"} changed since last read. Use the updated LINE#ID references shown below (>>> marks changed lines).`,
      "",
    ];

    let prevLine = -1;
    for (const lineNum of sorted) {
      if (prevLine !== -1 && lineNum > prevLine + 1) lines.push("    ...");
      prevLine = lineNum;
      const text = fileLines[lineNum - 1]!;
      const hash = computeLineHash(lineNum, text);
      const prefix = `${lineNum}#${hash}`;
      const escaped = escapeControlChars(text);
      lines.push(mismatchSet.has(lineNum) ? `>>> ${prefix}:${escaped}` : `    ${prefix}:${escaped}`);
    }

    const suggestedLines: string[] = [];
    for (const m of mismatches) {
      const currentContent = fileLines[m.line - 1];
      if (!currentContent?.trim()) continue;
      const suggestions = findSimilarLines(currentContent, fileLines, m.line);
      const filtered = suggestions.filter((s) => s.line !== m.line);
      if (filtered.length > 0) {
        suggestedLines.push("");
        suggestedLines.push(`Did you mean one of these nearby lines?`);
        for (const s of filtered) {
          suggestedLines.push(`  ${s.line}#${s.hash}:${escapeControlChars(s.content)}`);
        }
      }
    }
    if (suggestedLines.length > 0) lines.push(...suggestedLines);

    return lines.join("\n");
  }
}

// ── Prefix Stripping ──────────────────────────────────────────────

const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*(?:\+?\s*(?:\d+\s*#\s*|#\s*)|\+)\s*[0-9a-f]{3}:/;

const DIFF_PLUS_RE = /^\+(?!\+)/;

export function stripHashlinePrefixes(content: string): string {
  const lines = content.split("\n");
  let hashPrefixCount = 0;
  let diffPlusCount = 0;
  let nonEmpty = 0;
  for (const l of lines) {
    if (l.length === 0) continue;
    nonEmpty++;
    if (HASHLINE_PREFIX_RE.test(l)) hashPrefixCount++;
    if (DIFF_PLUS_RE.test(l)) diffPlusCount++;
  }
  if (nonEmpty === 0) return content;
  if (hashPrefixCount === nonEmpty) {
    return lines.map((l) => l.replace(HASHLINE_PREFIX_RE, "")).join("\n");
  }
  if (diffPlusCount > 0 && diffPlusCount >= nonEmpty * 0.5) {
    return lines.map((l) => l.replace(DIFF_PLUS_RE, "")).join("\n");
  }
  return content;
}

// ── Edit Types ────────────────────────────────────────────────────

export type HashlineEdit =
  | { op: "insert_before"; target: string; lines: string[] }
  | { op: "insert_after"; target: string; lines: string[] }
  | { op: "replace"; start: string; end: string; lines: string[] }
  | { op: "delete"; start: string; end: string }
  | { op: "replace_all"; lines: string[] }
  | { op: "create"; lines: string[] };

type InternalEdit =
  | { op: "insert_before"; pos: LineRef; lines: string[] }
  | { op: "insert_after"; pos: LineRef; lines: string[] }
  | { op: "replace"; pos: LineRef; end: LineRef; lines: string[] }
  | { op: "delete"; pos: LineRef; end: LineRef }
  | { op: "replace_all"; lines: string[] }
  | { op: "create"; lines: string[] };

function resolveEdit(edit: HashlineEdit): InternalEdit {
  switch (edit.op) {
    case "insert_before": {
      const anchor = parseTag(edit.target);
      if (!anchor?.hash) throw new Error(`Invalid target reference: "${edit.target}"`);
      return { op: "insert_before", pos: anchor, lines: edit.lines };
    }
    case "insert_after": {
      const anchor = parseTag(edit.target);
      if (!anchor?.hash) throw new Error(`Invalid target reference: "${edit.target}"`);
      return { op: "insert_after", pos: anchor, lines: edit.lines };
    }
    case "replace": {
      const start = parseTag(edit.start);
      const end = parseTag(edit.end);
      if (!start?.hash) throw new Error(`Invalid start reference: "${edit.start}"`);
      if (!end?.hash) throw new Error(`Invalid end reference: "${edit.end}"`);
      if (start.line > end.line) throw new Error(`Range start ${start.line} > end ${end.line}`);
      return { op: "replace", pos: start, end, lines: edit.lines };
    }
    case "delete": {
      const start = parseTag(edit.start);
      const end = parseTag(edit.end);
      if (!start?.hash) throw new Error(`Invalid start reference: "${edit.start}"`);
      if (!end?.hash) throw new Error(`Invalid end reference: "${edit.end}"`);
      if (start.line > end.line) throw new Error(`Range start ${start.line} > end ${end.line}`);
      return { op: "delete", pos: start, end };
    }
    case "replace_all":
      return { op: "replace_all", lines: edit.lines };
    case "create":
      return { op: "create", lines: edit.lines };
  }
}

function collectMismatch(anchor: LineRef, fileLines: string[], mismatches: HashMismatch[]): void {
  if (anchor.line < 1 || anchor.line > fileLines.length) {
    throw new Error(`Line ${anchor.line} does not exist (file has ${fileLines.length} lines)`);
  }
  const actualHash = computeLineHash(anchor.line, fileLines[anchor.line - 1]!);
  if (actualHash !== anchor.hash) {
    mismatches.push({ line: anchor.line, expected: anchor.hash, actual: actualHash });
  }
}

// ── Edit Application ──────────────────────────────────────────────

export interface EditFileOperations {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export async function applyHashlineEdits(
  filePath: string,
  edits: HashlineEdit[],
  ops: EditFileOperations,
): Promise<{ changed: boolean }> {
  if (edits.length === 0) return { changed: false };

  const hasCreate = edits.some((e) => e.op === "create");
  if (hasCreate) {
    if (edits.length !== 1) throw new Error("A 'create' edit must be the only edit in the batch");
    const createEdit = edits[0]!;
    if (createEdit.op !== "create") throw new Error("Expected create edit");
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir) await ops.mkdir(dir);
    await ops.writeFile(filePath, createEdit.lines.join("\n"));
    return { changed: true };
  }

  const hasReplaceAll = edits.some((e) => e.op === "replace_all");
  if (hasReplaceAll) {
    if (edits.length !== 1) throw new Error("A 'replace_all' edit must be the only edit");
    const edit = edits[0]!;
    if (edit.op !== "replace_all") throw new Error("Expected replace_all edit");
    await ops.writeFile(filePath, edit.lines.join("\n"));
    return { changed: true };
  }

  const content = await ops.readFile(filePath);
  const fileLines = content.split("\n");
  const internalEdits = edits.map((e) => resolveEdit(e));

  // Phase 1: Validate ALL edits before mutation
  const mismatches: HashMismatch[] = [];
  for (const edit of internalEdits) {
    switch (edit.op) {
      case "insert_before":
      case "insert_after":
        collectMismatch(edit.pos, fileLines, mismatches);
        break;
      case "replace":
      case "delete":
        collectMismatch(edit.pos, fileLines, mismatches);
        collectMismatch(edit.end, fileLines, mismatches);
        break;
    }
  }
  if (mismatches.length > 0) throw new HashlineMismatchError(mismatches, fileLines);

  // Phase 2: Sort edits bottom-up
  const annotated = internalEdits.map((edit, idx) => {
    let sortLine: number;
    switch (edit.op) {
      case "insert_before": sortLine = edit.pos.line; break;
      case "insert_after": sortLine = edit.pos.line; break;
      case "replace": sortLine = edit.end.line; break;
      case "delete": sortLine = edit.end.line; break;
      default: sortLine = 0; break;
    }
    return { edit, idx, sortLine };
  });
  annotated.sort((a, b) => b.sortLine - a.sortLine || a.idx - b.idx);

  // Phase 3: Apply
  let changed = false;
  for (const { edit } of annotated) {
    switch (edit.op) {
      case "insert_before":
        fileLines.splice(edit.pos.line - 1, 0, ...edit.lines);
        if (edit.lines.length > 0) changed = true;
        break;
      case "insert_after":
        fileLines.splice(edit.pos.line, 0, ...edit.lines);
        if (edit.lines.length > 0) changed = true;
        break;
      case "replace": {
        const count = edit.end.line - edit.pos.line + 1;
        const old = fileLines.slice(edit.pos.line - 1, edit.pos.line - 1 + count);
        if (old.length !== edit.lines.length || old.some((l, i) => l !== edit.lines[i])) {
          fileLines.splice(edit.pos.line - 1, count, ...edit.lines);
          changed = true;
        }
        break;
      }
      case "delete": {
        const count = edit.end.line - edit.pos.line + 1;
        fileLines.splice(edit.pos.line - 1, count);
        changed = true;
        break;
      }
    }
  }

  if (!changed) return { changed: false };
  await ops.writeFile(filePath, fileLines.join("\n"));
  return { changed: true };
}
