import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { Glob } from "bun";
import { BINARY_ENTRIES } from "../../../scripts/binary-entries.js";

// No kernel file imports a module registry, so a process that reads the module
// catalog must load the registries first (src/cli/module-registries.ts). The
// test preload installs the catalog for every test, so no other unit test
// sees a process path that forgot the load; this walk does. It follows every
// import from each shipped entry and fails a path that reaches the catalog
// before a dynamic import through `importComposing` loaded the registries.
// The walk does not enter the terminal client (src/tui/): the client reads the
// runtime through the protocol and composes nothing, so the config schema
// files it shows settings from never read the catalog in its process.

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CATALOG_READERS = new Set(["src/orchestration/module-catalog.ts", "src/orchestration/module-composition.ts"].map((path) => resolve(REPO_ROOT, path)));
// The shipped catalog of tests and scripts loads both registries, so it counts as one.
const REGISTRIES = new Set(["src/orchestration/modules.ts", "src/orchestration/credential-provider-modules.ts", "scripts/shipped-modules.ts"].map((path) => resolve(REPO_ROOT, path)));
const LOADER = resolve(REPO_ROOT, "src/cli/composition/module-registries.ts");
const TERMINAL_CLIENT = resolve(REPO_ROOT, "src/tui") + sep;
const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };

interface Edge {
  readonly target: string;
  /** The import evaluates the target only after the registries loaded, or is the load. */
  readonly loads: boolean;
}

function resolveSource(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier.replace(/\.js$/u, ""));
  return [`${base}.ts`, `${base}.tsx`].find((candidate) => existsSync(candidate));
}

const edgeCache = new Map<string, readonly Edge[]>();
function edges(file: string): readonly Edge[] {
  const cached = edgeCache.get(file);
  if (cached) return cached;
  const source = readFileSync(file, "utf8").replace(/^#![^\n]*\n/u, "");
  const wrapped = new Map<string, number>();
  for (const match of source.matchAll(/importComposing\(\s*\(\)\s*=>\s*import\(\s*"([^"]+)"\s*\)\s*\)/gu)) {
    const specifier = match[1]!;
    wrapped.set(specifier, (wrapped.get(specifier) ?? 0) + 1);
  }
  const found: Edge[] = [];
  for (const { path, kind } of (file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts).scanImports(source)) {
    const target = resolveSource(file, path);
    if (target === undefined) continue;
    const remaining = kind === "dynamic-import" ? wrapped.get(path) ?? 0 : 0;
    if (remaining > 0) wrapped.set(path, remaining - 1);
    // Importing a registry is the load itself.
    found.push({ target, loads: remaining > 0 || REGISTRIES.has(target) });
  }
  edgeCache.set(file, found);
  return found;
}

/** The first import chain from `entry` that reaches a catalog reader before the registries loaded. */
function unloadedCatalogChain(entry: string): readonly string[] | undefined {
  const parents = new Map<string, string>();
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const edge of edges(file)) {
      if (edge.loads || seen.has(edge.target)) continue;
      seen.add(edge.target);
      parents.set(edge.target, file);
      if (CATALOG_READERS.has(edge.target)) {
        const chain = [edge.target];
        for (let current: string | undefined = file; current !== undefined; current = parents.get(current)) chain.unshift(current);
        return chain.map((path) => relative(REPO_ROOT, path));
      }
      if (!edge.target.startsWith(TERMINAL_CLIENT)) queue.push(edge.target);
    }
  }
  return undefined;
}

/** Whether loading `entry` evaluates a catalog reader, through static or dynamic imports. */
function reachesCatalog(entry: string): boolean {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (CATALOG_READERS.has(file)) return true;
    for (const edge of edges(file)) {
      if (seen.has(edge.target) || REGISTRIES.has(edge.target)) continue;
      seen.add(edge.target);
      queue.push(edge.target);
    }
  }
  return false;
}

describe("module registry loading", () => {
  for (const entry of BINARY_ENTRIES) {
    test(`${entry} loads the module registries before it reads the module catalog`, () => {
      expect(unloadedCatalogChain(resolve(REPO_ROOT, entry))).toBeUndefined();
    });
  }

  test("every import through importComposing loads code that reads the module catalog", () => {
    // A load that no catalog read follows only slows the process down.
    const needless: string[] = [];
    for (const path of new Glob("src/**/*.{ts,tsx}").scanSync(REPO_ROOT)) {
      const file = resolve(REPO_ROOT, path);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/importComposing\(\s*\(\)\s*=>\s*import\(\s*"([^"]+)"\s*\)\s*\)/gu)) {
        const target = resolveSource(file, match[1]!);
        if (target === undefined || !reachesCatalog(target)) needless.push(`${path} -> ${match[1]}`);
      }
    }
    expect(needless).toEqual([]);
  });

  test("only the process entry loader imports a module registry", () => {
    const importers: string[] = [];
    for (const path of new Glob("src/**/*.{ts,tsx}").scanSync(REPO_ROOT)) {
      const file = resolve(REPO_ROOT, path);
      if (file === LOADER || REGISTRIES.has(file)) continue;
      if (edges(file).some((edge) => REGISTRIES.has(edge.target))) importers.push(path);
    }
    expect(importers).toEqual([]);
  });
});
