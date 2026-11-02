import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, extname, join } from "node:path"
import { isRecord } from "../../src/infra/record.js"

/** Babel compiles the Solid JSX of every test process, and it is the slowest
 *  step before the first test: loading Babel costs about half a second, and
 *  each file costs tens of milliseconds more. Every process of every checkout
 *  and worktree compiles the same sources the same way, so the output is
 *  shared on disk, keyed by content. A process that finds each file it loads
 *  here never loads Babel.
 *
 *  The cache lives beside the test duration record, outside the temporary
 *  directory whose leftovers the test runner reports. The path is fixed when
 *  the preload first loads this module, so a test that points HOME at a fake
 *  home does not move it. */
const cacheDirectory = join(homedir(), ".cache", "flywheel", "solid-transform")

/** A hit never touches its entry, so an entry ages from the moment a compile
 *  wrote it. An entry older than this is removed, and the next process that
 *  needs it compiles it again. This bounds the cache to the sources of the
 *  last month. */
const ENTRY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

let pruned = false

/** One installed package of a compiler: its version, and the directory that
 *  the packages it loads resolve from. */
export interface InstalledPackage {
  readonly label: string
  readonly directory: string
}

/** The package `name` as Node resolution finds it from `fromDirectory`. Pass
 *  the directory of the package that loads it, because a nested copy can
 *  differ from the one at the root. */
export function installedPackage(name: string, fromDirectory: string): InstalledPackage {
  const manifestPath = Bun.resolveSync(`${name}/package.json`, fromDirectory)
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (!isRecord(manifest) || typeof manifest.version !== "string") throw new Error(`${manifestPath} states no version`)
  return { label: `${name}@${manifest.version}`, directory: dirname(manifestPath) }
}

/** The repository lockfile, hashed. It pins every transitive package of a
 *  compiler, such as a Babel helper that a caret range lets move, which a
 *  list of the main packages does not name. */
const LOCKFILE_HASH = createHash("sha256").update(readFileSync(join(import.meta.dir, "..", "..", "bun.lock"))).digest("hex")

/** The identity of a compiler for the cache key: the installed version of
 *  each package that decides its output, and the lockfile that pins the rest.
 *  Another version of any of them can compile the same source to other
 *  output. */
export function compilerIdentity(packages: readonly InstalledPackage[]): string {
  return [...packages.map(({ label }) => label), `bun.lock#${LOCKFILE_HASH}`].join(" ")
}

/** Return the output that `compile` produces for `source`, from the cache when
 *  a previous process stored it.
 *
 *  `compiler` names everything except the source that decides the output: the
 *  compiler versions and every option. The file path is not part of the key,
 *  only its extension, because the Solid and TypeScript output never names the
 *  file. So the main checkout and its worktrees share entries. */
export async function cachedSolidTransform(input: {
  readonly compiler: string
  readonly path: string
  readonly source: string
  readonly compile: () => Promise<string>
}): Promise<string> {
  const key = createHash("sha256").update(JSON.stringify([input.compiler, extname(input.path), input.source])).digest("hex")
  const entry = join(cacheDirectory, `${key}.js`)
  try {
    return readFileSync(entry, "utf8")
  } catch {
    // Absent, or removed by the prune of a concurrent process: compile it.
  }
  const output = await input.compile()
  store(entry, output)
  return output
}

function store(entry: string, output: string): void {
  try {
    mkdirSync(cacheDirectory, { recursive: true })
    if (!pruned) {
      pruned = true
      prune()
    }
    // A concurrent reader sees the whole entry or no entry, never part of one.
    const staging = `${entry}.${process.pid}.tmp`
    writeFileSync(staging, output)
    renameSync(staging, entry)
  } catch {
    // The cache only saves time. A home that cannot take the entry leaves the
    // next process to compile the file again, and the test still runs.
  }
}

function prune(): void {
  const oldest = Date.now() - ENTRY_LIFETIME_MS
  for (const name of readdirSync(cacheDirectory)) {
    const path = join(cacheDirectory, name)
    try {
      if (statSync(path).mtimeMs < oldest) rmSync(path, { force: true })
    } catch {
      // Removed by the prune of a concurrent process.
    }
  }
}
