import * as fs from "node:fs";
import * as path from "node:path";
import type { Node } from "web-tree-sitter";
import { loadTreeSitterParser } from "../src/infra/tree-sitter-parser.js";

// The vendored code-mode interpreter retains donor casts and non-null assertions for direct upstream comparison.
const SAFETY_EXEMPT_DIRECTORIES = ["src/infra/code-mode/"];

// `docs/elegance.md` "TypeScript Discipline": no `as Type` (other than `as const`) and no
// non-null `!` without a `// SAFETY:` comment naming the invariant that makes it
// sound. This gate makes that rule compiler-enforced instead of a convention a
// grep can only partially audit. It walks the AST (not a regex) so it cannot
// confuse a non-null assertion with `!=`/prefix-`!`, a real cast with `as const`
// or `satisfies`, or a cast in a string/comment with a real one. A flagged node
// is satisfied when a `// SAFETY:` comment leads or trails the node OR its
// enclosing statement -- matching how the existing comments are placed.

interface Violation {
  file: string;
  line: number;
  col: number;
  kind: string;
  snippet: string;
}

function childrenOf(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function listFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(full, out);
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) out.push(full);
  }
}

// These tree-sitter container kinds map 1:1 to the TS compiler kinds this gate
// used before: statement_block = Block/ModuleBlock, program = SourceFile,
// switch_case / switch_default = CaseClause/DefaultClause.
const STATEMENT_CONTAINERS = new Set(["program", "statement_block", "switch_case", "switch_default"]);

// Climb to the node whose parent is a statement container -- that node is the
// statement the SAFETY comment would sit above or beside.
function enclosingStatement(node: Node): Node {
  let current = node;
  let parent = current.parent;
  while (parent && !STATEMENT_CONTAINERS.has(parent.type)) {
    current = parent;
    parent = current.parent;
  }
  return current;
}

// `x as const` is the one assertion the SAFETY rule allows; tree-sitter emits a
// literal `const` child for it where a real cast carries a type node.
function isAsConst(node: Node): boolean {
  return node.children.some((child) => child?.type === "const");
}

// Coverage is decided by line, not by sibling links: a nested cast's comment
// attaches to an ancestor in the tree, so a sibling walk misses it. This mirrors
// the TS scanner instead -- a full-line comment above the statement (blank lines
// allowed, stopping at the first code line) leads it, and a comment after code on
// the end line trails it.
interface CommentIndex {
  fullLineSafety: Set<number>;
  trailingSafety: Set<number>;
  commentOnly: Set<number>;
}

function buildCommentIndex(comments: Node[], lines: string[]): CommentIndex {
  const fullLineSafety = new Set<number>();
  const trailingSafety = new Set<number>();
  const commentOnly = new Set<number>();
  for (const comment of comments) {
    const startLine = comment.startPosition.row + 1;
    const endLine = comment.endPosition.row + 1;
    const hasSafety = comment.text.includes("SAFETY:");
    const beforeStart = lines[comment.startPosition.row]?.slice(0, comment.startPosition.column) ?? "";
    const startsLine = beforeStart.trim() === "";
    // A full-line comment carries no code on any of its lines; a trailing comment
    // only frees its continuation lines. The leading scan skips comment-only lines.
    for (let line = startsLine ? startLine : startLine + 1; line <= endLine; line += 1) commentOnly.add(line);
    if (startsLine && hasSafety) {
      for (let line = startLine; line <= endLine; line += 1) fullLineSafety.add(line);
    } else if (hasSafety) {
      trailingSafety.add(endLine);
    }
  }
  return { fullLineSafety, trailingSafety, commentOnly };
}

// Scan upward from the line above `startLine`, skipping blank and comment-only
// lines; a full-line SAFETY comment in that run covers the statement, the first
// code line ends it. Only meaningful when the node begins its line: a comment on
// the previous line is leading trivia only if no token sits before the node, the
// same boundary the TS scanner draws at the previous token.
function leadingCovered(node: Node, lines: string[], index: CommentIndex): boolean {
  const { row, column } = node.startPosition;
  if ((lines[row]?.slice(0, column) ?? "").trim() !== "") return false;
  for (let scan = row; scan >= 1; scan -= 1) {
    if (index.fullLineSafety.has(scan)) return true;
    if ((lines[scan - 1] ?? "").trim() === "" || index.commentOnly.has(scan)) continue;
    return false;
  }
  return false;
}

function isCovered(node: Node, lines: string[], index: CommentIndex): boolean {
  const stmt = enclosingStatement(node);
  return (
    index.trailingSafety.has(node.endPosition.row + 1) ||
    index.trailingSafety.has(stmt.endPosition.row + 1) ||
    leadingCovered(node, lines, index) ||
    leadingCovered(stmt, lines, index)
  );
}

export async function findUnsafeCasts(filePath: string): Promise<Violation[]> {
  const text = fs.readFileSync(filePath, "utf-8");
  const parser = await loadTreeSitterParser(filePath.endsWith(".tsx") ? "tsx" : "typescript");
  const tree = parser.parse(text);
  if (!tree) throw new Error(`Failed to parse ${filePath}`);
  const lines = text.split("\n");

  const comments: Node[] = [];
  const casts: { node: Node; kind: string }[] = [];
  const collect = (node: Node): void => {
    const kind = node.type;
    if (kind === "comment") comments.push(node);
    else if (kind === "as_expression") {
      if (!isAsConst(node)) casts.push({ node, kind: "as" });
    } else if (kind === "non_null_expression") {
      casts.push({ node, kind: "non-null" });
    } else if (kind === "type_assertion") {
      casts.push({ node, kind: "angle-cast" });
    }
    for (const child of childrenOf(node)) collect(child);
  };
  try {
    collect(tree.rootNode);

    const index = buildCommentIndex(comments, lines);
    const out: Violation[] = [];
    for (const { node, kind } of casts) {
      if (isCovered(node, lines, index)) continue;
      const { row, column } = node.startPosition;
      const snippet = node.text.replace(/\s+/g, " ").slice(0, 80);
      out.push({ file: filePath, line: row + 1, col: column + 1, kind, snippet });
    }
    return out;
  } finally {
    tree.delete();
  }
}

const isCli = import.meta.main;
if (isCli) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const files: string[] = [];
  listFiles(path.join(repoRoot, "src"), files);
  const checkedFiles = files.filter((file) => {
    const relative = path.relative(repoRoot, file).split(path.sep).join("/");
    return !SAFETY_EXEMPT_DIRECTORIES.some((directory) => relative.startsWith(directory));
  });
  const violations: Violation[] = [];
  for (const file of checkedFiles) violations.push(...await findUnsafeCasts(file));
  violations.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(`safety: ${path.relative(repoRoot, v.file)}:${v.line}:${v.col} [${v.kind}] ${v.snippet}\n`);
    }
    process.stderr.write(`\nsafety: ${violations.length} cast/non-null site(s) without a // SAFETY: comment (or restructure to remove the cast)\n`);
    process.exit(1);
  }
}
