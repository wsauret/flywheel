import * as fs from "node:fs";
import * as path from "node:path";

// Documentation is a living present-tense authority, so a stale
// `src/...` citation is a build failure, not an audit finding. Every
// backticked path that starts with `src/` in a living document must resolve
// against the repo root.
//
// Dated evidence records are point-in-time captures and are exempt: research
// audits, QA runs, solved-problem writeups, audit reports, and kept experiment
// charters describe the tree as it was, not as it is. Plans are exempt because they cite files the
// plan will create.
//
// The scan covers docs/, the benchmark findings in bench/findings/, and, where
// the maintainer's private companion checkout exists, private/, whose release
// playbooks are living documents too.
const EXEMPT_DIRS = new Set(["research", "qa", "solutions", "audits", "plans", "experiments"]);

// Citations that intentionally do not resolve: placeholders and named
// anti-pattern locations whose absence is the point.
const ALLOWED_UNRESOLVED = new Set([
  "src/...", // literal placeholder for "any source path"
  "src/effect/", // ARCH-STRUCTURE-005 anti-pattern: the directory must not exist
  "src/workflows/steps/example.md", // playbook illustration, not a real step
]);

interface Violation {
  file: string;
  line: number;
  cited: string;
}

const BACKTICKED_SRC_PATH = /`(src\/[^`]+)`/g;

function listMarkdownFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXEMPT_DIRS.has(entry.name)) listMarkdownFiles(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
}

// A citation may carry `:line`, `:line-line`, or `:line,line` suffixes, and
// may use `*` globs or `<placeholder>` segments for families of files.
function resolves(repoRoot: string, cited: string): boolean {
  const bare = cited.replace(/:[\d,:+-]+$/, "");
  if (ALLOWED_UNRESOLVED.has(bare)) return true;
  const pattern = bare.replace(/<[^>]+>/g, "*");
  if (pattern.includes("*")) {
    const glob = new Bun.Glob(pattern);
    for (const _match of glob.scanSync({ cwd: repoRoot })) return true;
    // A glob over directories (e.g. `src/foo/*/`) is not matched by file
    // scanning; accept it when its static prefix exists.
    const staticPrefix = pattern.slice(0, pattern.indexOf("*"));
    return staticPrefix.length > "src/".length && fs.existsSync(path.join(repoRoot, staticPrefix));
  }
  return fs.existsSync(path.join(repoRoot, bare));
}

export function findUnresolvedDocPaths(repoRoot: string, docsDir: string): Violation[] {
  const files: string[] = [];
  listMarkdownFiles(docsDir, files);
  const out: Violation[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    for (const [index, text] of lines.entries()) {
      for (const match of text.matchAll(BACKTICKED_SRC_PATH)) {
        // SAFETY: the regex has one capture group, present on every match.
        const cited = match[1]!;
        if (!resolves(repoRoot, cited)) out.push({ file, line: index + 1, cited });
      }
    }
  }
  return out;
}

const isCli = import.meta.main;
if (isCli) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const privateDocs = path.join(repoRoot, "private");
  const violations = [
    ...findUnresolvedDocPaths(repoRoot, path.join(repoRoot, "docs")),
    ...findUnresolvedDocPaths(repoRoot, path.join(repoRoot, "bench", "findings")),
    ...(fs.existsSync(privateDocs) ? findUnresolvedDocPaths(repoRoot, privateDocs) : []),
  ];
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(`doc-src-path: ${path.relative(repoRoot, v.file)}:${v.line} cites \`${v.cited}\`, which does not resolve\n`);
    }
    process.exit(1);
  }
}
