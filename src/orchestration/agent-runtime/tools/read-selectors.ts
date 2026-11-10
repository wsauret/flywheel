/**
 * Path selector parsing for the read tool.
 *
 * Splits "path:selector" suffixes and parses line ranges (`:5-16`),
 * multi-ranges (`:5-16,960-973`), compound selectors (`:5-16:raw`),
 * and the `:raw` mode flag.
 */

export type LineRange = { startLine: number; endLine: number | undefined };
export interface PathSelectorSplit { readonly path: string; readonly sel: string | undefined }

type ParsedSelector =
  | { kind: "none" }
  | { kind: "raw" }
  | { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean };

const LINE_RANGE_RE = /^L?(\d+)(?:([-+])L?(\d+)?)?$/i;

function parseLineRangeChunk(sel: string): LineRange | null {
  const m = LINE_RANGE_RE.exec(sel);
  if (!m?.[1]) return null;
  const rawStart = Number(m[1]);
  if (rawStart < 1) return null;
  const sep = m[2];
  const rhs = m[3] ? Number(m[3]) : undefined;
  let rawEnd: number | undefined;
  if (sep === "+") {
    if (rhs === undefined || rhs < 1) return null;
    rawEnd = rawStart + rhs - 1;
  } else if (sep === "-" && rhs !== undefined) {
    if (rhs < rawStart) return null;
    rawEnd = rhs;
  }
  return { startLine: rawStart, endLine: rawEnd };
}

function parseLineRanges(sel: string): [LineRange, ...LineRange[]] | null {
  const chunks = sel.split(",");
  const parsed: LineRange[] = [];
  for (const chunk of chunks) {
    const range = parseLineRangeChunk(chunk);
    if (!range) return null;
    parsed.push(range);
  }
  // Overlapping and adjacent ranges merge in line order; each merged range keeps the place of its earliest member,
  // so the result reads in the caller's order.
  const merged: { range: LineRange; order: number }[] = [];
  const byLine = parsed.map((range, order) => ({ range, order })).sort((a, b) => a.range.startLine - b.range.startLine);
  for (const current of byLine) {
    const last = merged.at(-1);
    // last.range.endLine === undefined means "to EOF": later ranges are subsumed, not lost.
    if (last && (last.range.endLine === undefined || current.range.startLine <= last.range.endLine + 1)) {
      const endLine = last.range.endLine === undefined || current.range.endLine === undefined ? undefined : Math.max(last.range.endLine, current.range.endLine);
      merged[merged.length - 1] = { range: { startLine: last.range.startLine, endLine }, order: Math.min(last.order, current.order) };
      continue;
    }
    merged.push(current);
  }
  const [first, ...rest] = merged.sort((a, b) => a.order - b.order).map(({ range }) => range);
  return first ? [first, ...rest] : null;
}

export function splitPathAndSel(rawPath: string): PathSelectorSplit {
  // A Windows path opens with a drive letter and a colon that is not a selector,
  // so the search starts past it. Stopping at that colon instead would hand the
  // whole "C:\dir\file.ts:1-100" string back as a path and lose every
  // selector an absolute Windows path carries.
  const driveQualified = /^[a-zA-Z]:/.test(rawPath);
  const colonIdx = rawPath.indexOf(":", driveQualified ? 2 : 0);
  if (colonIdx === -1) return { path: rawPath, sel: undefined };
  return { path: rawPath.slice(0, colonIdx), sel: rawPath.slice(colonIdx + 1) };
}

function parseCompoundSel(sel: string): ParsedSelector {
  const [a, b, ...rest] = sel.split(":");
  if (a === undefined || b === undefined || rest.length > 0) return { kind: "none" };
  const aIsRaw = a.toLowerCase() === "raw";
  const bIsRaw = b.toLowerCase() === "raw";
  const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
  if (rangeChunk === null || (!aIsRaw && !bIsRaw)) return { kind: "none" };
  const ranges = parseLineRanges(rangeChunk);
  return ranges ? { kind: "lines", ranges, raw: true } : { kind: "none" };
}

export function parseSel(sel: string | undefined): ParsedSelector {
  if (!sel || sel.length === 0) return { kind: "none" };
  if (sel.includes(":")) return parseCompoundSel(sel);
  if (sel.toLowerCase() === "raw") return { kind: "raw" };
  const ranges = parseLineRanges(sel);
  return ranges ? { kind: "lines", ranges } : { kind: "none" };
}

export function isRawSelector(parsed: ParsedSelector): boolean {
  return parsed.kind === "raw" || (parsed.kind === "lines" && parsed.raw === true);
}
