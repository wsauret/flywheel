import * as fs from "node:fs";
import * as path from "node:path";

type ModuleName = "cli" | "workflows" | "orchestration" | "tui" | "infra";

interface ImportRef {
  sourcePath: string;
  targetPath: string;
  specifier: string;
  line: number;
  isTypeOnly: boolean;
}

interface BoundaryRule {
  id: string;
  description: string;
  matches(importRef: ImportRef): boolean;
}

const repoRoot = path.resolve(import.meta.dir, "..");
const srcRoot = path.join(repoRoot, "src");
const temporaryAllowlist = new Set<string>([
  // (empty — no exceptions)
]);

const rules: BoundaryRule[] = [
  {
    id: "cli-is-top",
    description: "No module may import from cli/ — it is the composition root.",
    matches(importRef): boolean {
      if (isUnder(importRef.sourcePath, "src/cli/")) return false;
      return isModulePath(importRef.targetPath, "cli");
    },
  },
  {
    id: "infra-purity",
    description: "infra/ imports nothing from other modules (type-only imports are allowed).",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/infra/")) return false;
      if (importRef.isTypeOnly) return false;
      return ["workflows", "orchestration", "tui"].some((moduleName) =>
        isModulePath(importRef.targetPath, moduleName as ModuleName),
      );
    },
  },
  {
    id: "workflows-imports-infra-only",
    description: "workflows/ may only import from infra/ (not orchestration/ or tui/).",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/workflows/")) return false;
      if (!isModulePath(importRef.targetPath, "orchestration") &&
          !isModulePath(importRef.targetPath, "tui")) return false;
      return !isTemporarilyAllowed(importRef);
    },
  },
  {
    id: "orchestration-imports-workflows-infra",
    description: "orchestration/ may import from workflows/ and infra/, not tui/.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/orchestration/")) return false;
      if (!isModulePath(importRef.targetPath, "tui")) return false;
      return !isTemporarilyAllowed(importRef);
    },
  },
  {
    id: "orchestration-no-solid-web-or-jsx",
    description: "orchestration/ may use solid-js and solid-js/store, but NOT solid-js/web. No .tsx files in orchestration.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/orchestration/")) return false;
      // Block solid-js/web imports
      if (importRef.specifier === "solid-js/web" || importRef.specifier.startsWith("solid-js/web/")) return true;
      // Block .tsx source files in orchestration (any import from a .tsx file triggers)
      if (importRef.sourcePath.endsWith(".tsx")) return true;
      return false;
    },
  },
  {
    id: "tui-imports-orchestration-or-infra",
    description: "tui/ may import from orchestration/ and infra/, not workflows/ directly.",
    matches(importRef): boolean {
      if (!isUnder(importRef.sourcePath, "src/tui/")) return false;
      return isModulePath(importRef.targetPath, "workflows");
    },
  },
];

function isModulePath(relPath: string, moduleName: ModuleName): boolean {
  switch (moduleName) {
    case "cli":
      return isUnder(relPath, "src/cli/");
    case "workflows":
      return isUnder(relPath, "src/workflows/");
    case "orchestration":
      return isUnder(relPath, "src/orchestration/");
    case "tui":
      return isUnder(relPath, "src/tui/");
    case "infra":
      return isUnder(relPath, "src/infra/");
  }
}

function isUnder(relPath: string, prefix: string): boolean {
  return relPath === prefix.slice(0, -1) || relPath.startsWith(prefix);
}

function normalizeRel(absPath: string): string {
  return path.relative(repoRoot, absPath).split(path.sep).join("/");
}

function listSourceFiles(dirPath: string): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const absPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listSourceFiles(absPath));
      continue;
    }

    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    results.push(absPath);
  }

  return results;
}

function collectSpecifiers(fileText: string): Array<{ specifier: string; line: number; isTypeOnly: boolean }> {
  const matches: Array<{ specifier: string; line: number; isTypeOnly: boolean }> = [];

  // Static imports: import [type] ... from "..."
  const staticPattern = /(?:^|\n)\s*import\s+(type\s+)?[\s\S]*?\sfrom\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = staticPattern.exec(fileText)) !== null) {
    const specifier = match[2];
    if (!specifier) continue;
    matches.push({
      specifier,
      isTypeOnly: !!match[1],
      line: 1 + countNewlines(fileText, match.index),
    });
  }

  // Side-effect imports: import "..."
  const sideEffectPattern = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((match = sideEffectPattern.exec(fileText)) !== null) {
    const specifier = match[1];
    if (!specifier) continue;
    matches.push({
      specifier,
      isTypeOnly: false,
      line: 1 + countNewlines(fileText, match.index),
    });
  }

  // Dynamic imports: import("...")
  const dynamicPattern = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = dynamicPattern.exec(fileText)) !== null) {
    const specifier = match[1];
    if (!specifier) continue;
    matches.push({
      specifier,
      isTypeOnly: false,
      line: 1 + countNewlines(fileText, match.index),
    });
  }

  return matches;
}

function countNewlines(text: string, endIndex: number): number {
  let count = 0;
  for (let i = 0; i < endIndex; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

function resolveImport(sourceFileAbs: string, specifier: string): string | null {
  if (specifier.startsWith("@tui/")) {
    const subPath = specifier.slice("@tui/".length);
    return resolveFromBase(path.join(srcRoot, "tui", subPath));
  }

  if (specifier.startsWith("@infra/")) {
    const subPath = specifier.slice("@infra/".length);
    return resolveFromBase(path.join(srcRoot, "infra", subPath));
  }

  if (!specifier.startsWith(".")) return null;

  const sourceDir = path.dirname(sourceFileAbs);
  return resolveFromBase(path.resolve(sourceDir, specifier));
}

function resolveFromBase(basePath: string): string | null {
  const candidates = new Set<string>([
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
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) continue;
    return normalizeRel(candidate);
  }

  return null;
}

function makeImportKey(importRef: ImportRef): string {
  return `${importRef.sourcePath} -> ${importRef.targetPath}`;
}

function isTemporarilyAllowed(importRef: ImportRef): boolean {
  return temporaryAllowlist.has(makeImportKey(importRef));
}

function main(): void {
  const files = listSourceFiles(srcRoot);
  const imports: ImportRef[] = [];

  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const sourcePath = normalizeRel(file);
    const specifiers = collectSpecifiers(text);

    for (const { specifier, line, isTypeOnly } of specifiers) {
      const targetPath = resolveImport(file, specifier);
      // Include bare package imports (targetPath null) so rules can check specifiers directly
      imports.push({ sourcePath, targetPath: targetPath ?? "", specifier, line, isTypeOnly });
    }
  }

  const violations: string[] = [];
  const seenTemporaryAllowances = new Set<string>();

  for (const importRef of imports) {
    if (isTemporarilyAllowed(importRef)) {
      seenTemporaryAllowances.add(makeImportKey(importRef));
    }

    for (const rule of rules) {
      if (!rule.matches(importRef)) continue;
      violations.push(
        [
          `${importRef.sourcePath}:${importRef.line}`,
          `  rule: ${rule.id}`,
          `  why: ${rule.description}`,
          `  import: ${importRef.specifier}`,
          `  resolved: ${importRef.targetPath}`,
        ].join("\n"),
      );
    }
  }

  const unusedAllowances = [...temporaryAllowlist].filter((key) => !seenTemporaryAllowances.has(key));

  if (violations.length > 0) {
    console.error("Boundary check failed.\n");
    for (const violation of violations) {
      console.error(violation);
      console.error("");
    }
    process.exit(1);
  }

  console.log(`Boundary check passed. Scanned ${files.length} files.`);

  if (seenTemporaryAllowances.size > 0) {
    console.log("\nTemporary exceptions still in use:");
    for (const key of [...seenTemporaryAllowances].sort()) {
      console.log(`- ${key}`);
    }
  }

  if (unusedAllowances.length > 0) {
    console.log("\nTemporary exceptions no longer in use:");
    for (const key of unusedAllowances.sort()) {
      console.log(`- ${key}`);
    }
  }
}

main();
