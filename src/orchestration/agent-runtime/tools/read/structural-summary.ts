import type { Node } from "web-tree-sitter";

import { type TreeSitterSource, withTreeSitterTree } from "./tree-sitter-code.js";

const MIN_TOTAL_LINES = 100;
const MIN_BODY_LINES = 4;
const MIN_COMMENT_LINES = 6;
const UNFOLD_UNTIL_LINES = 50;
const UNFOLD_LIMIT_LINES = 100;

interface LineSpan { start: number; end: number }
interface SpanNode { span: LineSpan; children: number[] }
interface ElidableForest { nodes: SpanNode[]; roots: number[] }

type SummarySegment =
  | { kind: "kept"; startLine: number; endLine: number; text: string }
  | { kind: "elided"; startLine: number; endLine: number };

export interface StructuralSummary {
  totalLines: number;
  segments: SummarySegment[];
}

export interface RenderedStructuralSummary {
  text: string;
  displayText: string;
  retainedRows: Array<readonly [number, string]>;
}

function childrenOf(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function spanLines(span: LineSpan): number {
  return span.end - span.start + 1;
}

function nodeStartLine(node: Node): number { return node.startPosition.row + 1; }
function nodeEndLine(node: Node): number { return node.endPosition.row + 1; }
function nodeLineCount(node: Node): number { return nodeEndLine(node) - nodeStartLine(node) + 1; }
function nodeContentEndLine(node: Node): number {
  const position = node.endPosition;
  return position.column === 0 && position.row > 0 ? position.row : position.row + 1;
}

function pushSpan(forest: ElidableForest, parent: number | undefined, span: LineSpan): number {
  const index = forest.nodes.length;
  forest.nodes.push({ span, children: [] });
  if (parent === undefined) forest.roots.push(index);
  else forest.nodes[parent]?.children.push(index);
  return index;
}

const ELIDABLE_KINDS = new Set([
  "statement_block", "block", "function_body", "object", "array", "template_string", "class_body",
  "interface_body", "enum_body", "object_type", "switch_body", "jsx_element", "jsx_self_closing_element",
]);
const GROUPABLE_KINDS = new Set(["import_statement", "import_from_statement"]);

function flushGroup(first: Node | undefined, last: Node | undefined, count: number, forest: ElidableForest, parent: number | undefined): void {
  if (!first || !last || count < 2) return;
  const spanSize = nodeEndLine(last) - nodeStartLine(first) + 1;
  if (spanSize < MIN_BODY_LINES) return;
  const start = Math.min(nodeContentEndLine(first), nodeStartLine(last) - 1) + 1;
  const end = nodeStartLine(last) - 1;
  if (start <= end) pushSpan(forest, parent, { start, end });
}

function collectElidableTree(node: Node, parent: number | undefined, forest: ElidableForest): void {
  const totalLines = nodeLineCount(node);
  if (node.type === "comment") {
    if (totalLines >= MIN_COMMENT_LINES) {
      const start = nodeStartLine(node) + 1;
      const end = nodeEndLine(node) - 1;
      if (start <= end) pushSpan(forest, parent, { start, end });
    }
    return;
  }

  let currentParent = parent;
  if (ELIDABLE_KINDS.has(node.type) && totalLines >= MIN_BODY_LINES) {
    const start = nodeStartLine(node) + 1;
    const end = nodeEndLine(node) - 1;
    if (start <= end) currentParent = pushSpan(forest, parent, { start, end });
  }

  const children = childrenOf(node);
  let first: Node | undefined;
  let last: Node | undefined;
  let count = 0;
  for (const child of children) {
    if (GROUPABLE_KINDS.has(child.type)) {
      first ??= child;
      last = child;
      count++;
    } else {
      flushGroup(first, last, count, forest, currentParent);
      first = undefined;
      last = undefined;
      count = 0;
    }
  }
  flushGroup(first, last, count, forest, currentParent);
  for (const child of children) collectElidableTree(child, currentParent, forest);
}

function selectFoldedSpans(forest: ElidableForest, totalLines: number): LineSpan[] {
  const folded = new Set(forest.roots);
  let visible = totalLines - Array.from(folded).reduce((sum, index) => sum + spanLines(forest.nodes[index]?.span ?? { start: 1, end: 0 }), 0);
  const queue = [...forest.roots];
  while (queue.length > 0 && visible < UNFOLD_UNTIL_LINES) {
    const index = queue.shift();
    if (index === undefined || !folded.has(index)) continue;
    const node = forest.nodes[index];
    if (!node) continue;
    const childLines = node.children.reduce((sum, child) => sum + spanLines(forest.nodes[child]?.span ?? { start: 1, end: 0 }), 0);
    const nextVisible = visible + spanLines(node.span) - childLines;
    if (nextVisible > UNFOLD_LIMIT_LINES) continue;
    folded.delete(index);
    for (const child of node.children) {
      folded.add(child);
      queue.push(child);
    }
    visible = nextVisible;
  }
  return Array.from(folded, (index) => forest.nodes[index]?.span).filter((span): span is LineSpan => span !== undefined);
}

function normalizeSpans(spans: LineSpan[], totalLines: number): LineSpan[] {
  const sorted = spans
    .map((span) => ({ start: Math.max(1, span.start), end: Math.min(totalLines, span.end) }))
    .filter((span) => span.start <= span.end)
    .sort((left, right) => left.start - right.start || right.end - left.end);
  const normalized: LineSpan[] = [];
  for (const span of sorted) {
    const previous = normalized.at(-1);
    if (previous && span.start <= previous.end) continue;
    normalized.push(span);
  }
  return normalized;
}

function buildSegments(lines: string[], spans: LineSpan[]): SummarySegment[] {
  const segments: SummarySegment[] = [];
  let line = 1;
  for (const span of spans) {
    if (line < span.start) segments.push({ kind: "kept", startLine: line, endLine: span.start - 1, text: lines.slice(line - 1, span.start - 1).join("\n") });
    segments.push({ kind: "elided", startLine: span.start, endLine: span.end });
    line = span.end + 1;
  }
  if (line <= lines.length) segments.push({ kind: "kept", startLine: line, endLine: lines.length, text: lines.slice(line - 1).join("\n") });
  return segments;
}

export async function summarizeStructure(source: TreeSitterSource): Promise<StructuralSummary | null> {
  const lines = source.text.split("\n");
  if (lines.length < MIN_TOTAL_LINES) return null;
  return withTreeSitterTree(source, (root) => {
    const forest: ElidableForest = { nodes: [], roots: [] };
    collectElidableTree(root, undefined, forest);
    const spans = normalizeSpans(selectFoldedSpans(forest, lines.length), lines.length);
    return spans.length > 0 ? { totalLines: lines.length, segments: buildSegments(lines, spans) } : null;
  });
}

function recoveryFooter(path: string, ranges: LineSpan[], elidedLines: number): string {
  const selector = ranges.slice(0, 2).map((range) => `${range.start}-${range.end}`).join(",");
  const tail = ranges.length > 2 ? `, e.g. ${path}:${selector}` : ` with ${path}:${selector}`;
  return `[…${elidedLines}ln elided; re-read needed ranges${tail}]`;
}

export function renderStructuralSummary(summary: StructuralSummary, path: string): RenderedStructuralSummary {
  const model: string[] = [];
  const display: string[] = [];
  const retainedRows: Array<readonly [number, string]> = [];
  const ranges: LineSpan[] = [];
  let elidedLines = 0;
  const mergedTailLines = new Set<number>();

  for (let index = 0; index < summary.segments.length; index++) {
    const segment = summary.segments[index];
    if (!segment) continue;
    if (segment.kind === "elided") {
      const previous = summary.segments[index - 1];
      const next = summary.segments[index + 1];
      const head = previous?.kind === "kept" ? previous.text.split("\n").at(-1) : undefined;
      const tail = next?.kind === "kept" ? next.text.split("\n")[0] : undefined;
      if (head?.trimEnd().endsWith("{") && tail && /^\s*}[;)]?\s*$/.test(tail)) {
        model.pop();
        display.pop();
        const start = segment.startLine - 1;
        const end = segment.endLine + 1;
        model.push(`${start}-${end}|${head.trimEnd()} … ${tail.trimStart()}`);
        display.push(`${head.trimEnd()} … ${tail.trimStart()}`);
        mergedTailLines.add(end);
      } else {
        model.push("…");
        display.push("…");
      }
      ranges.push({ start: segment.startLine - 1, end: segment.endLine + 1 });
      elidedLines += segment.endLine - segment.startLine + 1;
      continue;
    }
    for (const [offset, text] of segment.text.split("\n").entries()) {
      const line = segment.startLine + offset;
      retainedRows.push([line, text]);
      if (mergedTailLines.has(line)) continue;
      model.push(`${line}|${text}`);
      display.push(text);
    }
  }
  model.push(recoveryFooter(path, ranges, elidedLines));
  return { text: model.join("\n"), displayText: display.join("\n"), retainedRows };
}
