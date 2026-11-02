import * as fs from "node:fs";
import * as path from "node:path";

export interface SourceImport {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly specifier: string;
  readonly line: number;
  readonly isTypeOnly: boolean;
  readonly dynamic: boolean;
}

export interface SourceImportScan {
  readonly files: readonly string[];
  readonly imports: readonly SourceImport[];
}

const NON_SOURCE_DIRS = new Set(["node_modules", "out", "dist"]);

function listSourceFiles(dirPath: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!NON_SOURCE_DIRS.has(entry.name)) results.push(...listSourceFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) results.push(absolutePath);
  }
  return results;
}

function countNewlines(text: string, endIndex: number): number {
  let count = 0;
  for (let index = 0; index < endIndex; index++) if (text.charCodeAt(index) === 10) count++;
  return count;
}

function importLine(source: string, matchIndex: number): number {
  return 1 + countNewlines(source, matchIndex + (source.charCodeAt(matchIndex) === 10 ? 1 : 0));
}

export function collectImportSpecifiers(source: string): Array<{ readonly specifier: string; readonly line: number; readonly isTypeOnly: boolean; readonly dynamic: boolean }> {
  const matches: Array<{ specifier: string; line: number; isTypeOnly: boolean; dynamic: boolean }> = [];
  const staticPattern = /(?:^|\n)\s*import\s+(type\s+)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = staticPattern.exec(source)) !== null) {
    const specifier = match[2];
    if (specifier) matches.push({ specifier, isTypeOnly: match[1] !== undefined, line: importLine(source, match.index), dynamic: false });
  }

  const sideEffectPattern = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((match = sideEffectPattern.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier) matches.push({ specifier, isTypeOnly: false, line: importLine(source, match.index), dynamic: false });
  }

  const dynamicPattern = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamicPattern.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier) matches.push({ specifier, isTypeOnly: false, line: 1 + countNewlines(source, match.index), dynamic: true });
  }
  return matches;
}

function normalizeRelative(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function resolveFromBase(repoRoot: string, basePath: string): string | null {
  const candidates = new Set([
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ]);
  if (basePath.endsWith(".js") || basePath.endsWith(".jsx")) {
    candidates.add(basePath.replace(/\.jsx?$/, ".ts"));
    candidates.add(basePath.replace(/\.jsx?$/, ".tsx"));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return normalizeRelative(repoRoot, candidate);
  }
  return null;
}

function resolveImport(repoRoot: string, sourceFile: string, specifier: string): string | null {
  if (specifier.startsWith("@tui/")) return resolveFromBase(repoRoot, path.join(repoRoot, "src/tui", specifier.slice("@tui/".length)));
  if (specifier.startsWith("@infra/")) return resolveFromBase(repoRoot, path.join(repoRoot, "src/infra", specifier.slice("@infra/".length)));
  if (!specifier.startsWith(".")) return null;
  return resolveFromBase(repoRoot, path.resolve(path.dirname(sourceFile), specifier));
}

export function scanSourceImports(repoRoot: string, roots: readonly string[]): SourceImportScan {
  const files = roots.flatMap((root) => {
    const absoluteRoot = path.join(repoRoot, root);
    return fs.existsSync(absoluteRoot) ? listSourceFiles(absoluteRoot) : [];
  });
  const imports = files.flatMap((file) => {
    const sourcePath = normalizeRelative(repoRoot, file);
    const source = fs.readFileSync(file, "utf8");
    return collectImportSpecifiers(source).map(({ specifier, line, isTypeOnly, dynamic }): SourceImport => ({
      sourcePath,
      targetPath: resolveImport(repoRoot, file, specifier) ?? "",
      specifier,
      line,
      isTypeOnly,
      dynamic,
    }));
  });
  return { files, imports };
}
