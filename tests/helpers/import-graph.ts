import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };

/** One module an import chain reaches: a repository source file by its absolute path, or a package by its name. */
export type ImportedModule = { readonly kind: "file"; readonly path: string } | { readonly kind: "package"; readonly name: string };

/** Which imports a walk follows. `bundled` follows static and dynamic imports alike, because Bun's bundler puts
 *  both into a build. `evaluated` follows static imports only: the modules that load and run before the entry's
 *  own code runs. Type-only imports are erased before either walk looks. */
export type ImportWalk = "bundled" | "evaluated";

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? specifier;
}

/** The first import chain from `entry` to a module that `reached` matches, from the entry to that module, or
 *  undefined when the walk reaches none. Source files are named by absolute path and a package by its name. The
 *  walk does not descend into packages. */
export function importChain(entry: string, walk: ImportWalk, reached: (module: ImportedModule) => boolean): readonly string[] | undefined {
  const parents = new Map<string, string>();
  const seen = new Set<string>();
  const queue = [entry];
  const chainTo = (last: string, parent: string): readonly string[] => {
    const chain = [last];
    for (let current: string | undefined = parent; current !== undefined; current = parents.get(current)) chain.unshift(current);
    return chain;
  };
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const transpiler = file.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
    for (const { path, kind } of transpiler.scanImports(readFileSync(file, "utf8").replace(/^#![^\n]*\n/u, ""))) {
      if (walk === "evaluated" && kind === "dynamic-import") continue;
      if (!path.startsWith(".")) {
        if (path.startsWith("node:") || path.startsWith("bun:") || path === "bun") continue;
        const name = packageName(path);
        if (reached({ kind: "package", name })) return chainTo(name, file);
        continue;
      }
      const base = resolve(dirname(file), path.replace(/\.js$/u, ""));
      const next = [`${base}.ts`, `${base}.tsx`].find((candidate) => existsSync(candidate));
      if (next === undefined || seen.has(next)) continue;
      parents.set(next, file);
      if (reached({ kind: "file", path: next })) return chainTo(next, file);
      queue.push(next);
    }
  }
  return undefined;
}
