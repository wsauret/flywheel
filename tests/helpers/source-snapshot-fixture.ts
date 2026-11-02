import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const REPOSITORY = resolve(fileURLToPath(new URL("../..", import.meta.url)))

/** Source inputs for a minimal checkout that can enter a source snapshot. */
export const SNAPSHOT_SOURCE_FILES = new Map([
  ["package.json", "{\"name\":\"flywheel-tui\"}\n"],
  ["tsconfig.json", "{}\n"],
  ["bun.lock", "{}\n"],
  ["crates/tokenizer/tokenizer-prebuilt.json", "{}\n"],
  ["crates/tokenizer/flywheel-tokenizer.wasm.zst", "zst"],
  ["src/cli/index.ts", "export {}\n"],
  ["src/infra/cli-subprocess.ts", "export {}\n"],
  ["scripts/dev.ts", "export {}\n"],
  ["webview/build.ts", "export {}\n"],
  ["webview/package.json", "{}\n"],
  ["webview/src/client.ts", "export const generation = 'first'\n"],
  ["webview/local/index.html", "<html></html>\n"],
  ["webview/editor/main.tsx", "export {}\n"],
  ["webview/phone/main.tsx", "export {}\n"],
])

/** A fixture checkout with a snapshot that holds copies of real modules. */
export interface SnapshotFixture {
  /** The checkout, as the real path that a module in its snapshot names. */
  readonly checkout: string
  /** The snapshot's root, inside the checkout's build cache. */
  readonly snapshot: string
  /** Imports a copied module, by its path relative to the repository, from
   *  inside the snapshot, as a dev service loads it. */
  importFromSnapshot<Module>(path: string): Promise<Module>
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The file a relative specifier names, the way Bun resolves a `.js`
 *  specifier to the TypeScript source beside it. */
function resolveModule(specifier: string, from: string): string {
  const base = resolve(dirname(from), specifier)
  const stem = extname(base) === ".js" ? base.slice(0, -".js".length) : base
  const found = [`${stem}.ts`, `${stem}.tsx`, base, join(base, "index.ts")].find(isFile)
  if (found === undefined) throw new Error(`${specifier} from ${from} names no file`)
  return found
}

/** The package a bare specifier names, or undefined for a runtime builtin. */
function packageName(specifier: string): string | undefined {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return undefined
  const segments = specifier.split("/")
  const name = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]
  return name !== undefined && existsSync(join(REPOSITORY, "node_modules", name)) ? name : undefined
}

/** Copies `entries`, by path relative to the repository, and every module
 *  they import, into a snapshot of a fixture checkout under `root`, so a test
 *  loads real Flywheel modules the way a dev service does: from
 *  `<checkout>/node_modules/.cache/flywheel/source/<digest>/`. A module that
 *  is imported lazily is copied only with `lazyImports`, which a bundle of
 *  the entries needs; a test that loads one names it as an entry. Each
 *  package the modules import resolves through a link in the checkout's own
 *  `node_modules`, one link for each package, as the packages of a real
 *  checkout resolve. The checkout holds nothing else; a test writes what the
 *  modules read there. The snapshot is `digest`, which a test names when the
 *  checkout under `root` already holds a snapshot of its own source that the
 *  modules must run from. */
export function snapshotFixture(root: string, entries: readonly string[], options: { readonly lazyImports?: boolean; readonly digest?: string } = {}): SnapshotFixture {
  mkdirSync(join(root, "checkout", "node_modules"), { recursive: true })
  const checkout = realpathSync(join(root, "checkout"))
  const snapshot = join(checkout, "node_modules", ".cache", "flywheel", "source", options.digest ?? "0123456789abcdef")
  const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) }
  const copied = new Set<string>()
  const packages = new Set<string>()
  const pending = entries.map((entry) => join(REPOSITORY, entry))
  while (pending.length > 0) {
    const file = pending.pop()
    if (file === undefined || copied.has(file)) continue
    copied.add(file)
    const target = join(snapshot, relative(REPOSITORY, file))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(file, target)
    const transpiler = file.endsWith(".ts") ? transpilers.ts : file.endsWith(".tsx") ? transpilers.tsx : undefined
    if (transpiler === undefined) continue
    // The scanner reads no shebang line, which an entry script starts with.
    for (const { path, kind } of transpiler.scanImports(readFileSync(file, "utf8").replace(/^#!.*/, ""))) {
      if (kind === "dynamic-import" && options.lazyImports !== true) continue
      if (path.startsWith(".")) pending.push(resolveModule(path, file))
      else {
        const name = packageName(path)
        if (name !== undefined) packages.add(name)
      }
    }
  }
  for (const name of packages) {
    const link = join(checkout, "node_modules", name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(realpathSync(join(REPOSITORY, "node_modules", name)), link, "junction")
  }
  return {
    checkout,
    snapshot,
    importFromSnapshot: async <Module>(path: string): Promise<Module> => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a dynamic import names its module by a path the compiler cannot follow
      return await import(pathToFileURL(join(snapshot, path)).href) as Module
    },
  }
}
