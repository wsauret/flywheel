import * as fs from "node:fs";
import * as path from "node:path";

// agents.md §7 / biome's former useFilenamingConvention: source filenames under
// src/ are kebab-case. This is a directory-walk gate rather than a per-file lint
// rule because the constraint is about the path, not the AST -- oxlint has no
// built-in filename rule, and a walk mirrors scripts/check-file-sizes.ts exactly.

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface Violation {
  file: string;
  base: string;
}

// Strip the full extension, including compound ones like `.d.ts` and `.test.tsx`,
// so the kebab check runs on the meaningful stem (`vendor`, not `vendor.d`).
function stem(fileName: string): string {
  return fileName.replace(/\.(d\.ts|test\.tsx?|tsx?)$/, "");
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

export function findNonKebabFiles(rootDir: string): Violation[] {
  const files: string[] = [];
  listCodeFiles(rootDir, files);
  const out: Violation[] = [];
  for (const file of files) {
    const base = stem(path.basename(file));
    if (!KEBAB_CASE.test(base)) out.push({ file, base });
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

const isCli = import.meta.main;
if (isCli) {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const violations = findNonKebabFiles(path.join(repoRoot, "src"));
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(
        `filename: ${path.relative(repoRoot, v.file)} stem '${v.base}' is not kebab-case\n`,
      );
    }
    process.exit(1);
  }
}
