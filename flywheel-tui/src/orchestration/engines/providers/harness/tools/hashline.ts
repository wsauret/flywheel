/**
 * Hashline format: display, parsing, validation, and transactional editing.
 *
 * Each line is prefixed with `LINENUM#HASH:` where HASH is a 2-character
 * code derived from xxHash32 of the trimmed line text. This format gives
 * the model line-addressable references for editing.
 */

const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";

const DICT = Array.from({ length: 256 }, (_, i) => {
  const h = i >>> 4;
  const l = i & 0x0f;
  return `${NIBBLE_STR[h]!}${NIBBLE_STR[l]!}`;
});

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

export function computeLineHash(idx: number, line: string): string {
  const trimmed = line.replace(/\r/g, "").trimEnd();
  const seed = RE_SIGNIFICANT.test(trimmed) ? 0 : idx;
  return DICT[Bun.hash.xxHash32(trimmed, seed) & 0xff]!;
}

export function formatLineTag(lineNumber: number, lineText: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, lineText)}`;
}

export function formatHashLines(content: string): string {
  const lines = content.split("\n");
  return lines
    .map((line, i) => {
      const num = i + 1;
      return `${formatLineTag(num, line)}:${line}`;
    })
    .join("\n");
}

// ── Tag Parsing ───────────────────────────────────────────────────

export interface LineRef {
  line: number;
  hash: string;
}

export function parseTag(tag: string): LineRef | null {
  const match = tag.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/);
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

export interface HashMismatch {
  line: number;
  expected: string;
  actual: string;
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
      lines.push(mismatchSet.has(lineNum) ? `>>> ${prefix}:${text}` : `    ${prefix}:${text}`);
    }
    return lines.join("\n");
  }
}

// ── Prefix Stripping ──────────────────────────────────────────────

const HASHLINE_PREFIX_RE = /^\s*(?:>>>|>>)?\s*(?:\+?\s*(?:\d+\s*#\s*|#\s*)|\+)\s*[ZPMQVRWSNKTXJBYH]{2}:/;

export function stripHashlinePrefixes(content: string): string {
  const lines = content.split("\n");
  let hashPrefixCount = 0;
  let nonEmpty = 0;
  for (const l of lines) {
    if (l.length === 0) continue;
    nonEmpty++;
    if (HASHLINE_PREFIX_RE.test(l)) hashPrefixCount++;
  }
  if (nonEmpty === 0 || hashPrefixCount !== nonEmpty) return content;
  return lines.map((l) => l.replace(HASHLINE_PREFIX_RE, "")).join("\n");
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
): Promise<void> {
  if (edits.length === 0) return;

  const hasCreate = edits.some((e) => e.op === "create");
  if (hasCreate) {
    if (edits.length !== 1) throw new Error("A 'create' edit must be the only edit in the batch");
    const createEdit = edits[0]!;
    if (createEdit.op !== "create") throw new Error("Expected create edit");
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir) await ops.mkdir(dir);
    await ops.writeFile(filePath, createEdit.lines.join("\n"));
    return;
  }

  const hasReplaceAll = edits.some((e) => e.op === "replace_all");
  if (hasReplaceAll) {
    if (edits.length !== 1) throw new Error("A 'replace_all' edit must be the only edit");
    const edit = edits[0]!;
    if (edit.op !== "replace_all") throw new Error("Expected replace_all edit");
    await ops.writeFile(filePath, edit.lines.join("\n"));
    return;
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

  if (!changed) return;
  await ops.writeFile(filePath, fileLines.join("\n"));
}
