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
// The standalone entries outside the binary (repository scripts, benchmark
// launchers and workers, and the release harness) start without the test
// preload too, so each one that reaches the catalog must publish both halves
// of it: load both registries, call importComposing, or install its own
// catalog. They start no measured startup path, so they may load the
// registries with a static import.

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CATALOG_READERS = new Set(["src/orchestration/module-contract/module-catalog.ts", "src/orchestration/module-contract/module-composition.ts"].map((path) => resolve(REPO_ROOT, path)));
// The shipped catalog of tests and scripts loads both registries, so it counts as one.
const CREDENTIAL_REGISTRY = resolve(REPO_ROOT, "src/orchestration/credential-provider-modules.ts");
const OTHER_REGISTRY = resolve(REPO_ROOT, "src/orchestration/modules.ts");
const SHIPPED_CATALOG = resolve(REPO_ROOT, "scripts/shipped-modules.ts");
const REGISTRIES = new Set([CREDENTIAL_REGISTRY, OTHER_REGISTRY, SHIPPED_CATALOG]);
const LOADER = resolve(REPO_ROOT, "src/cli/composition/module-registries.ts");
const TERMINAL_CLIENT = resolve(REPO_ROOT, "src/tui") + sep;
const STANDALONE_ROOTS = ["scripts", "bench", "tests/release"];
// Benchmark task files and review fixtures are inputs that a benchmark copies, never entries of this repository.
const BENCHMARK_INPUTS = ["bench/tasks", "bench/chat-ab/tasks", "bench/ab-persona/fixtures"].map((path) => resolve(REPO_ROOT, path) + sep);
// The files that can import a standalone file: a file that nothing imports is an entry.
const IMPORTER_ROOTS = ["scripts", "bench", "tests"];
/** Sources that a test plants at a path in the repository, without writing a file. */
const planted = new Map<string, string>();
const sourceOf = (file: string): string => planted.get(file) ?? readFileSync(file, "utf8");
const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };

interface Edge {
  readonly target: string;
  /** The import evaluates the target only after the registries loaded, or is the load. */
  readonly loads: boolean;
}

function resolveSource(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier.replace(/\.(?:js|ts|tsx)$/u, ""));
  return [`${base}.ts`, `${base}.tsx`].find((candidate) => planted.has(candidate) || existsSync(candidate));
}

const edgeCache = new Map<string, readonly Edge[]>();
function edges(file: string): readonly Edge[] {
  const cached = edgeCache.get(file);
  if (cached) return cached;
  const source = sourceOf(file).replace(/^#![^\n]*\n/u, "");
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

/** Every standalone entry: a file under a standalone root that no file of
 *  the repository imports, such as a worker that a launcher starts by path,
 *  or one that a package script runs, that checks `import.meta.main`, or that
 *  starts with a shebang. The import scan reads specifiers as text, which is
 *  enough to tell a library from an entry. */
let inventory: readonly string[] | undefined;
function standaloneEntries(): readonly string[] {
  if (inventory !== undefined) return inventory;
  const scripts: { readonly [name: string]: string } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")).scripts;
  const run = new Set(Object.values(scripts).flatMap((command) =>
    [...command.matchAll(/\bbun(?: run)?(?: --\S+)* ((?:scripts|bench|tests\/release)\/\S+\.tsx?)/gu)].map((match) => resolve(REPO_ROOT, match[1]!))));
  const candidates = new Set(STANDALONE_ROOTS.flatMap((root) => [...new Glob(`${root}/**/*.{ts,tsx}`).scanSync(REPO_ROOT)])
    .map((path) => resolve(REPO_ROOT, path))
    .filter((file) => !BENCHMARK_INPUTS.some((inputs) => file.startsWith(inputs))));
  const imported = new Set<string>();
  for (const path of IMPORTER_ROOTS.flatMap((root) => [...new Glob(`${root}/**/*.{ts,tsx}`).scanSync(REPO_ROOT)])) {
    const file = resolve(REPO_ROOT, path);
    for (const match of readFileSync(file, "utf8").matchAll(/(?:\bfrom|\bimport\(?)\s*["'](\.[^"']+)["']/gu)) {
      const base = resolve(dirname(file), match[1]!.replace(/\.(?:js|ts|tsx)$/u, ""));
      for (const target of [`${base}.ts`, `${base}.tsx`]) if (candidates.has(target)) imported.add(target);
    }
  }
  inventory = [...candidates].filter((file) => {
    if (!imported.has(file) || run.has(file)) return true;
    const source = readFileSync(file, "utf8");
    return source.startsWith("#!") || source.includes("import.meta.main");
  }).toSorted();
  return inventory;
}

type CatalogHalf = "credential providers" | "other modules";
const BOTH_HALVES: readonly CatalogHalf[] = ["credential providers", "other modules"];
const HALVES_OF = new Map<string, readonly CatalogHalf[]>([[CREDENTIAL_REGISTRY, ["credential providers"]], [OTHER_REGISTRY, ["other modules"]], [SHIPPED_CATALOG, BOTH_HALVES]]);

/** Whether `file` calls `installModuleCatalog` in its code, not only in a comment. */
const installCache = new Map<string, boolean>();
function installsCatalog(file: string): boolean {
  const cached = installCache.get(file);
  if (cached !== undefined) return cached;
  const source = sourceOf(file);
  const installs = !CATALOG_READERS.has(file) && source.includes("installModuleCatalog(")
    && (file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts).transformSync(source.replace(/^#![^\n]*\n/u, "")).includes("installModuleCatalog(");
  if (!planted.has(file)) installCache.set(file, installs);
  return installs;
}

/** The halves of the module catalog that loading `entry` publishes: a
 *  registry it imports, a load through `importComposing`, or a catalog that
 *  it installs. A reference to the loader that never calls it publishes
 *  nothing, so the walk does not enter the loader. */
function publishedHalves(entry: string): ReadonlySet<CatalogHalf> {
  const halves = new Set<CatalogHalf>();
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (installsCatalog(file)) return new Set(BOTH_HALVES);
    for (const edge of edges(file)) {
      for (const half of HALVES_OF.get(edge.target) ?? (edge.loads ? BOTH_HALVES : [])) halves.add(half);
      if (seen.has(edge.target) || REGISTRIES.has(edge.target) || edge.target === LOADER) continue;
      seen.add(edge.target);
      queue.push(edge.target);
    }
  }
  return halves;
}

/** A repository path with forward slashes on every platform. */
const repoPath = (file: string): string => relative(REPO_ROOT, file).split(sep).join("/");

/** Why a standalone entry fails to publish the catalog it reaches, or undefined. */
function standaloneFault(entry: string): string | undefined {
  if (!reachesCatalog(entry)) return undefined;
  const halves = publishedHalves(entry);
  const missing = BOTH_HALVES.filter((half) => !halves.has(half));
  return missing.length === 0 ? undefined : `${repoPath(entry)} reaches the catalog without publishing ${missing.join(" and ")}`;
}

/** Runs `check` on an entry planted at `path` with `source`, whose relative
 *  imports resolve against the repository. */
function withPlanted<Result>(path: string, source: string, check: (entry: string) => Result): Result {
  const entry = resolve(REPO_ROOT, path);
  planted.set(entry, source);
  try {
    return check(entry);
  } finally {
    planted.delete(entry);
    edgeCache.delete(entry);
  }
}

describe("module registry loading", () => {
  for (const entry of BINARY_ENTRIES) {
    test(`${entry} loads the module registries before it reads the module catalog`, () => {
      expect(unloadedCatalogChain(resolve(REPO_ROOT, entry))).toBeUndefined();
    });
  }

  test("every standalone entry that reaches the module catalog publishes both of its halves", () => {
    expect(standaloneEntries().flatMap((entry) => standaloneFault(entry) ?? [])).toEqual([]);
  });

  test("the standalone inventory holds entries that no script, shebang, or main check names", () => {
    // A launcher starts the persona worker by path, and a person runs the prompt dump by hand.
    const entries = standaloneEntries().map(repoPath);
    expect(entries).toEqual(expect.arrayContaining(["bench/shared/native-persona-worker.ts", "scripts/dump-prompt.ts"]));
  });

  test("a standalone entry fails when it publishes only part of the catalog it reaches", () => {
    const catalog = `import { installedModules } from "../src/orchestration/module-contract/module-catalog.js";\ninstalledModules();\n`;
    const fault = (source: string) => withPlanted("scripts/planted-entry.ts", source, standaloneFault);
    expect({
      credentialHalfOnly: fault(`import "../src/orchestration/credential-provider-modules.js";\n${catalog}`),
      explicitTsExtension: fault(`import { installedModules } from "../src/orchestration/module-contract/module-catalog.ts";\ninstalledModules();\n`),
      loaderNeverCalled: fault(`import { importComposing } from "../src/cli/composition/module-registries.js";\nvoid importComposing;\n${catalog}`),
      installInCommentOnly: fault(`// installModuleCatalog(...) is not called here.\n${catalog}`),
    }).toEqual({
      credentialHalfOnly: "scripts/planted-entry.ts reaches the catalog without publishing other modules",
      explicitTsExtension: "scripts/planted-entry.ts reaches the catalog without publishing credential providers and other modules",
      loaderNeverCalled: "scripts/planted-entry.ts reaches the catalog without publishing credential providers and other modules",
      installInCommentOnly: "scripts/planted-entry.ts reaches the catalog without publishing credential providers and other modules",
    });
    expect([
      fault(`import "./shipped-modules.js";\n${catalog}`),
      fault(`import { importComposing } from "../src/cli/composition/module-registries.js";\nawait importComposing(() => import("../src/orchestration/module-contract/module-catalog.js"));\n`),
    ]).toEqual([undefined, undefined]);
  });

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
