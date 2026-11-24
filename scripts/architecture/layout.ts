// The module hierarchy of the source roots, read from the file system alone:
// one module per directory and per file, `index.ts` standing for its
// directory, and `foo.ts` beside `foo/` being the same module as the
// directory.
import * as fs from "node:fs";
import * as path from "node:path";
import { Tree, type SourceFile, type SourceRoot } from "./model.ts";

const TEST_DIRS = new Set(["test", "tests", "__tests__"]);
const isTestFile = (file: string) =>
  /\.(test|spec)\.(ts|tsx)$/.test(file) || file.split("/").slice(0, -1).some((segment) => TEST_DIRS.has(segment));
const moduleName = (base: string) => base.replace(/\.d\.ts$/, "").replace(/\.(ts|tsx)$/, "");
const skipped = (name: string) => name.startsWith(".") || name === "node_modules" || name === "dist";

export interface Layout {
  tree: Tree;
  files: SourceFile[];
  texts: string[];
  fileIndex: Map<string, number>;
}

function listFiles(root: string, dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (skipped(entry.name)) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listFiles(root, rel, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
}

// Reads every TypeScript file of the source roots under `root` (paths
// relative to it, `/`-separated) into the module tree.
export function layOut(root: string, roots: SourceRoot[]): Layout {
  const tree = new Tree();
  const files: SourceFile[] = [];
  const texts: string[] = [];
  const fileIndex = new Map<string, number>();
  for (const sourceRoot of roots) {
    const pkg = tree.child(tree.root(), "package", sourceRoot.name);
    tree.node(pkg).dir = sourceRoot.dir;
    const found: string[] = [];
    listFiles(root, sourceRoot.dir, found);
    found.sort();
    for (const rel of found) {
      const inside = sourceRoot.dir ? rel.slice(sourceRoot.dir.length + 1) : rel;
      const parts = inside.split("/");
      const base = parts.pop() ?? "";
      let node = pkg;
      let dir = sourceRoot.dir;
      for (const part of parts) {
        node = tree.child(node, "module", part);
        dir = dir ? `${dir}/${part}` : part;
        tree.node(node).dir ??= dir;
        if (TEST_DIRS.has(part)) tree.node(node).test = true;
      }
      const name = moduleName(base);
      const index = name === "index";
      const module = index ? node : tree.child(node, "module", name);
      if (/\.(test|spec)$/.test(name)) tree.node(module).test = true;
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      fileIndex.set(path.resolve(root, rel), files.length);
      files.push({ path: rel, module, test: isTestFile(rel), lines, index });
      texts.push(text);
    }
  }
  return { tree, files, texts, fileIndex };
}

interface ScannedFile {
  path: string;
  test: boolean;
  text: string;
}

// Test-only code: a file that test files import and that no production file
// imports, directly or through other such files, is test code like *.test.ts.
// The import graph covers every TypeScript file under the root, not only the
// source roots, so a host shell or a root tests/ directory outside them counts
// as an importer (nested repositories, node_modules, dist, and dot directories
// are skipped). Tests reach a file through value imports (Bun's scanner drops
// `import type`), dynamic imports, requires, and module files named by
// `new URL("<path>", import.meta.url)` (how a test hands a fixture to a
// bundler), resolved by Bun's resolver (tsconfig paths included). A production
// file keeps a file production through those and through type-only imports
// too: the model judges the type links of production code. The greatest fixed
// point over the files that tests reach, so fixtures that import each other
// stay test code.
// An entry point is production even when only tests import it: a file that
// declares itself runnable (a `#!` line or `import.meta.main`), or that a JSON
// manifest outside test directories names by a path relative to the manifest
// (package.json scripts and main, a worker config's main). Marks the test-only
// files of the layout `test` and returns their paths.
export function markTestOnly(root: string, laid: Layout): string[] {
  const { files, texts, fileIndex } = laid;
  const all: ScannedFile[] = files.map((f, i) => ({ path: f.path, test: f.test, text: texts[i] ?? "" }));
  const index = new Map(fileIndex);
  const manifests: string[] = [];
  const walk = (dir: string, inherited: Ignore[]) => {
    const entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    if (dir && entries.some((e) => e.name === ".git")) return;
    const ignores = entries.some((e) => e.name === ".gitignore") ? [...inherited, ...readIgnore(root, dir)] : inherited;
    for (const e of entries) {
      if (skipped(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (ignores.some((ignore) => ignore.matches(rel, e.isDirectory()))) continue;
      if (e.isDirectory()) walk(rel, ignores);
      else if (/\.jsonc?$/.test(e.name) && !isTestFile(rel.replace(/\.jsonc?$/, ".ts"))) manifests.push(rel);
      else if (/\.(ts|tsx)$/.test(e.name) && !index.has(path.resolve(root, rel))) {
        index.set(path.resolve(root, rel), all.length);
        all.push({ path: rel, test: isTestFile(rel), text: fs.readFileSync(path.join(root, rel), "utf8") });
      }
    }
  };
  walk("", []);
  const { imports, typeImports } = importGraph(root, all, index);
  const importers: number[][] = all.map(() => []);
  for (const graph of [imports, typeImports]) for (const [i, targets] of graph.entries()) for (const j of targets) importers[j]?.push(i);
  const entries = entryPoints(root, all, index, manifests);
  const reached = new Set<number>();
  const stack = all.flatMap((f, i) => (f.test ? (imports[i] ?? []) : []));
  for (let j = stack.pop(); j !== undefined; j = stack.pop()) {
    if (all[j]?.test || entries.has(j) || reached.has(j)) continue;
    reached.add(j);
    stack.push(...(imports[j] ?? []));
  }
  const testOnly = new Set(reached);
  const isProduction = (i: number) => !all[i]?.test && !testOnly.has(i);
  for (let changed = true; changed; ) {
    changed = false;
    for (const j of testOnly) {
      if (!(importers[j] ?? []).some(isProduction)) continue;
      testOnly.delete(j);
      changed = true;
    }
  }
  const marked = [...testOnly].filter((j) => j < files.length);
  for (const j of marked) files[j]!.test = true;
  return marked.map((j) => files[j]!.path).sort();
}

// The static import and re-export statements that can be type-only:
// `import type`, `export type ... from`, and the brace forms that hold
// `type` specifiers, which Bun's scanner drops when every specifier is a type.
const TYPE_IMPORT = /^\s*(?:import|export)\s+(?:type\s+[^;'"]*?|\{[^}]*\}\s*)from\s*(["'])([^"']+)\1/gm;

// For each file, the files that it imports at run time, and the files that
// its static import statements name, type-only ones included.
function importGraph(root: string, all: ScannedFile[], index: Map<string, number>) {
  const scanners = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
  const imports: number[][] = [];
  const typeImports: number[][] = [];
  for (const [i, f] of all.entries()) {
    const dir = path.dirname(path.join(root, f.path));
    const resolve = (specs: Iterable<string>) => {
      const out: number[] = [];
      for (const spec of specs) {
        let resolved: string;
        try {
          resolved = Bun.resolveSync(spec, dir);
        } catch {
          // A package or a path that does not resolve is outside the graph.
          continue;
        }
        const j = index.get(resolved);
        if (j !== undefined && j !== i) out.push(j);
      }
      return out;
    };
    imports.push(resolve(f.path.endsWith(".d.ts") ? [] : valueSpecifiers(scanners[f.path.endsWith(".tsx") ? "tsx" : "ts"], f.text)));
    typeImports.push(resolve(Array.from(f.text.matchAll(TYPE_IMPORT), (m) => m[2] ?? "")));
  }
  return { imports, typeImports };
}

function valueSpecifiers(scanner: Bun.Transpiler, text: string): string[] {
  let specs: string[];
  try {
    specs = scanner.scanImports(text.replace(/^#!.*/, "")).map((x) => x.path);
  } catch {
    // A file that Bun cannot parse imports nothing that the check can see.
    return [];
  }
  for (const m of text.matchAll(/new URL\(\s*(["'`])([^"'`$]+)\1\s*,\s*import\.meta\.url\s*\)/g)) {
    const named = m[2] ?? "";
    specs.push(/^\.{0,2}\//.test(named) ? named : `./${named}`);
  }
  return specs;
}

function entryPoints(root: string, all: ScannedFile[], index: Map<string, number>, manifests: string[]): Set<number> {
  const entries = new Set<number>();
  for (const [i, f] of all.entries()) if (!f.test && (f.text.startsWith("#!") || f.text.includes("import.meta.main"))) entries.add(i);
  for (const manifest of manifests) {
    if (fs.statSync(path.join(root, manifest)).size > 1 << 16) continue;
    for (const [named] of fs.readFileSync(path.join(root, manifest), "utf8").matchAll(/[\w@./-]+\.tsx?(?![\w*])/g)) {
      const j = index.get(path.resolve(root, path.dirname(manifest), named));
      if (j !== undefined && !all[j]?.test) entries.add(j);
    }
  }
  return entries;
}

// The plain patterns of a .gitignore (negations are skipped, so a re-included
// file stays out): a pattern with an inner or leading slash is anchored at the
// .gitignore directory, any other matches at every depth below it; a trailing
// slash matches directories only.
interface Ignore {
  matches: (rel: string, isDir: boolean) => boolean;
}

function readIgnore(root: string, dir: string): Ignore[] {
  const base = dir ? `${dir}/` : "";
  const patterns = fs.readFileSync(path.join(root, dir, ".gitignore"), "utf8").split("\n").map((line) => line.trim());
  return patterns
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
    .map((line) => {
      const dirOnly = line.endsWith("/");
      const pattern = line.replace(/\/$/, "");
      const anchored = pattern.includes("/");
      const glob = new Bun.Glob(anchored ? pattern.replace(/^\//, "") : `**/${pattern}`);
      return {
        matches: (rel: string, isDir: boolean) => (!dirOnly || isDir) && rel.startsWith(base) && glob.match(rel.slice(base.length)),
      };
    });
}
