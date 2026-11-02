import * as fs from "node:fs";
import * as path from "node:path";

// The file size rule of docs/architecture.md: no `.ts` or `.tsx` file in
// src/ or tests/ has more than 600 lines of code, and blank and comment lines
// do not count. Markdown in docs/ is exempt.
//
// Counting CODE lines rather than physical lines keeps the gate from taxing
// the why-comment discipline that AGENTS.md section 6 requires: a raw-line cap made
// comment-heavy files trim documentation (or split into single-consumer
// helper fragments) to dodge the gate.

export const SRC_MAX_LINES = 600;
export const TEST_MAX_LINES = 600;

// Exact donor files stay intact for future upstream diffs. New vendored files use the normal limit by default.
const VENDORED_FILE_SIZE_EXEMPTIONS = new Set([
  "src/infra/code-mode/interpreter/runtime.ts",
  "src/infra/code-mode/interpreter/methods.ts",
  "tests/unit/infra/code-mode/promise-test262.test.ts",
  "tests/unit/infra/code-mode/promise.test.ts",
  "tests/unit/infra/code-mode/generator-test262.test.ts",
  "tests/unit/infra/code-mode/codemode.test.ts",
  "tests/unit/infra/code-mode/stdlib.test.ts",
  "tests/unit/infra/code-mode/parity.test.ts",
  "tests/unit/infra/code-mode/string-search-test262.test.ts",
  "tests/unit/infra/code-mode/string-regexp-test262.test.ts",
]);

interface Violation {
  file: string;
  lines: number;
  max: number;
}

function listCodeFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listCodeFiles(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
}

// A line-prefix heuristic, not a parser: skips blank lines, `//` lines, and
// block-comment lines by their conventional prefixes (`/*`, `*`). A code line
// that genuinely starts with `*` (a generator method in a class body) reads
// as comment -- accepted slack in a size gate, and it errs lenient.
const NON_CODE_LINE = /^\s*($|\/\/|\/\*|\*)/;

function codeLineCount(source: string): number {
  let count = 0;
  for (const line of source.split("\n")) {
    if (!NON_CODE_LINE.test(line)) count++;
  }
  return count;
}

function lineCount(filePath: string): number {
  return codeLineCount(fs.readFileSync(filePath, "utf-8"));
}

export function findOversizedFiles(rootDir: string, max: number): Violation[] {
  const files: string[] = [];
  listCodeFiles(rootDir, files);
  const out: Violation[] = [];
  const repoRoot = path.resolve(import.meta.dir, "..");
  for (const file of files) {
    const relative = path.relative(repoRoot, file).split(path.sep).join("/");
    if (VENDORED_FILE_SIZE_EXEMPTIONS.has(relative)) continue;
    const lines = lineCount(file);
    if (lines > max) out.push({ file, lines, max });
  }
  out.sort((a, b) => b.lines - a.lines);
  return out;
}

const isCli = import.meta.main;
if (isCli) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const violations = [
    ...findOversizedFiles(path.join(repoRoot, "src"), SRC_MAX_LINES),
    ...findOversizedFiles(path.join(repoRoot, "tests"), TEST_MAX_LINES),
  ];
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(`file-size: ${path.relative(repoRoot, v.file)} has ${v.lines} lines of code (max ${v.max}; blank/comment lines don't count)\n`);
    }
    process.exit(1);
  }
}
