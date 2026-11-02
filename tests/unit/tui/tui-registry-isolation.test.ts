import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** The TUI realm must never load the definition registry: `workflows/register`
 *  builds the skill registry at module initialization, so any runtime import
 *  chain from a TUI module creates a second live registry beside the runtime's.
 *  Every definition-derived value reaches the client as published catalog
 *  metadata instead.
 *
 *  The TUI must also never import the module registry statically.
 *  `orchestration/modules` loads every module descriptor with its runtime:
 *  each provider SDK, the MCP client, the workflow engine. The client imports
 *  its interface before its first frame, and a static chain to the registry
 *  once put about a thousand files in front of that frame. The account
 *  actions, which still read the registry, load on first use. */

const SRC = resolve(import.meta.dir, "../../../src");
const DEFINITION_REGISTRY = join(SRC, "workflows/register.ts");
const MODULE_REGISTRY = join(SRC, "orchestration/modules.ts");

const STATIC_IMPORT_SOURCE = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;'"]*from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
const IMPORT_SOURCE = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;'"]*from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Resolve a specifier the way Bun does for this tree: relative paths and the
 *  `@tui`/`@infra` aliases, with the `.js` extension mapped back to source.
 *  Anything else (a package) cannot reach `src/`. */
function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  const base = specifier.startsWith("@tui/")
    ? join(SRC, "tui", specifier.slice("@tui/".length))
    : specifier.startsWith("@infra/")
      ? join(SRC, "infra", specifier.slice("@infra/".length))
      : specifier.startsWith(".")
        ? resolve(dirname(fromFile), specifier)
        : undefined;
  if (!base) return undefined;
  const stem = base.replace(/\.js$/, "");
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, base, join(stem, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this candidate; try the next extension.
    }
  }
  return undefined;
}

function importChainTo(registry: string, imports: RegExp): string[] | null {
  const entries = sourceFiles(join(SRC, "tui"));
  const cameFrom = new Map<string, string>(entries.map((file) => [file, ""]));
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined) break
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(imports)) {
      const target = resolveSpecifier(file, match[1] ?? match[2] ?? match[3] ?? "");
      if (!target || cameFrom.has(target)) continue;
      cameFrom.set(target, file);
      if (target === registry) {
        const chain: string[] = [];
        for (let step: string | undefined = target; step; step = cameFrom.get(step) || undefined) chain.unshift(relative(SRC, step));
        return chain;
      }
      queue.push(target);
    }
  }
  return null;
}

describe("TUI realm isolation", () => {
  it("has no runtime import chain from src/tui to the definition registry", () => {
    expect(importChainTo(DEFINITION_REGISTRY, IMPORT_SOURCE)).toBeNull();
  });

  it("has no static import chain from src/tui to the module registry", () => {
    expect(importChainTo(MODULE_REGISTRY, STATIC_IMPORT_SOURCE)).toBeNull();
  });
});
