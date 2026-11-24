/** What a snapshot of the dev entry holds (ARCH-DISTRIBUTION-030): the file
 *  set it copies from its checkout, the walk and stat signature of that
 *  checkout, the digest of its bytes, and the engines it pins beside them.
 *  `source-snapshot.ts` decides when a snapshot is made, reused, held, and
 *  swept; this module only reads a checkout and writes one copy. */

import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { dirname, join } from "node:path"

import { holdsPinnedAntigravityBytes, pinnedAntigravityBytes, QUALIFIED_ANTIGRAVITY_VERSION, type AntigravityPinnedBytes } from "./antigravity-engine-pin.js"
import { SOURCE_DIGEST_HEX_LENGTH } from "../cli-subprocess.js"
import { errnoCode, errorMessage } from "../error-message.js"
import { Log } from "../diagnostics/log.js"
import { buildPlatformArch, checkoutAntigravityEngine, checkoutClaudeEngine } from "../native-assets.js"

const log = Log.create({ service: "source-snapshot" })

/** What a snapshot copies, as paths relative to the checkout. The tokenizer
 *  files are the ones a module imports or reads relative to itself. A path a
 *  module takes relative to its own URL must stay inside this set, or go
 *  through `sourceCheckout()` or `flywheelCacheDirectory()`. */
export const SOURCE_FILE_SET = [
  "src",
  "scripts",
  "package.json",
  "tsconfig.json",
  "bun.lock",
  "webview/build.ts",
  "webview/package.json",
  "webview/tsconfig.json",
  "webview/src",
  "webview/local",
  "webview/editor",
  "webview/phone",
  "LICENSE",
  "THIRD-PARTY-NOTICES.md",
  "THIRD-PARTY-LICENSES.txt",
  "crates/tokenizer/tokenizer-prebuilt.json",
  "crates/tokenizer/flywheel-tokenizer.wasm.zst",
] as const

/** The runtime writes lock files into `.locks` directories under `src`,
 *  and editors write swap and backup files beside the files they edit.
 *  Neither is source, so the walk, the copy, and the digest all skip them. */
function skipped(name: string): boolean {
  return name.startsWith(".") || name.endsWith("~")
}

interface SourceFile {
  /** The path relative to the checkout, with POSIX separators. */
  readonly path: string
  readonly stats: fs.BigIntStats
}

async function statOrUndefined(path: string): Promise<fs.BigIntStats | undefined> {
  try {
    return await fs.promises.stat(path, { bigint: true })
  } catch {
    return undefined
  }
}

/** Every file of the file set in `checkout`, sorted by path. Copied from
 *  OpenClaw's `findLatestMtime` (scripts/run-node.mts) and edited: it keeps
 *  each file's stats, where OpenClaw keeps the latest mtime, which misses a
 *  deletion and a copy that keeps its mtime. It starts from each member of
 *  the file set and skips what `skipped` names. It reads every directory
 *  and every file's stats at once, off the thread: a checkout of about 2000
 *  files takes 5 to 10 ms, where one synchronous read at a time takes 15 to
 *  60 ms, and a service that walks its checkout keeps answering its clients
 *  while the reads wait. */
async function listSourceFiles(checkout: string): Promise<SourceFile[]> {
  const files: SourceFile[] = []
  const visitFile = async (path: string, known?: fs.BigIntStats): Promise<void> => {
    const stats = known ?? await statOrUndefined(join(checkout, path))
    if (stats !== undefined) files.push({ path, stats })
  }
  const visitDirectory = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await fs.promises.readdir(join(checkout, current), { withFileTypes: true })
    } catch {
      return
    }
    await Promise.all(entries.map(async (entry) => {
      if (skipped(entry.name)) return
      const path = `${current}/${entry.name}`
      if (entry.isDirectory()) await visitDirectory(path)
      else if (entry.isFile()) await visitFile(path)
    }))
  }
  await Promise.all(SOURCE_FILE_SET.map(async (member) => {
    const stats = await statOrUndefined(join(checkout, member))
    if (stats?.isDirectory()) await visitDirectory(member)
    else if (stats?.isFile()) await visitFile(member, stats)
  }))
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** The checkout's `agy`, by its path relative to the checkout: the copy of
 *  the pinned version that the prepare step placed. */
function antigravityCache(): string {
  return checkoutAntigravityEngine(QUALIFIED_ANTIGRAVITY_VERSION, buildPlatformArch())
}

/** A walk of the checkout: the files of the set, and the stats of the
 *  checkout's `agy`, which a snapshot pins beside its source. */
interface SourceListing {
  readonly files: readonly SourceFile[]
  readonly antigravity: fs.BigIntStats | undefined
  /** What an entry compares before it reads any file. Any write, rename, or
   *  removal of a file of the set or of the `agy` changes it. */
  readonly signature: string
}

export async function listSource(checkout: string): Promise<SourceListing> {
  const [files, antigravity] = await Promise.all([listSourceFiles(checkout), statOrUndefined(join(checkout, antigravityCache()))])
  const hash = createHash("sha256")
  for (const { path, stats } of files) hash.update(`${path}\0${stats.size}\0${stats.mtimeNs}\0${stats.ctimeNs}\0${stats.ino}\n`)
  // Not the `agy`'s ctime: the snapshot's own hard link to it changes that.
  // A prepare renames a new file onto it, which changes its inode.
  if (antigravity !== undefined) hash.update(`${antigravityCache()}\0${antigravity.size}\0${antigravity.mtimeNs}\0${antigravity.ino}\n`)
  return { files, antigravity, signature: hash.digest("hex") }
}

/** The SHA-256 of the pinned `agy` when the file at `path` holds exactly its
 *  bytes, and nothing otherwise. `pin` is the bytes a test supplies in place
 *  of the pin's. */
async function verifiedAntigravity(path: string, pin: AntigravityPinnedBytes | undefined): Promise<string | undefined> {
  const pinned = pin ?? pinnedAntigravityBytes()
  return pinned !== undefined && await holdsPinnedAntigravityBytes(path, pinned) ? pinned.sha256 : undefined
}

/** A listed file's bytes, or undefined when the file has left the checkout
 *  since the walk that listed it: the checkout changed, and it is walked
 *  again. */
async function readListedFile(checkout: string, path: string): Promise<Buffer | undefined> {
  try {
    return await fs.promises.readFile(join(checkout, path))
  } catch (error) {
    const code = errnoCode(error)
    if (code === "ENOENT" || code === "ENOTDIR") return undefined
    throw error
  }
}

/** The digest of the source `files` name, from the bytes `contents` holds
 *  for each of them in the same order, and of the verified `agy` whose
 *  SHA-256 is `antigravity`, when there is one. A copy and the checkout it
 *  copies fold the same way, so one source has one digest wherever it is
 *  read, and a snapshot that pins an `agy` is never the snapshot of the same
 *  source that pins none. */
function digestOf(files: readonly SourceFile[], contents: readonly Uint8Array[], antigravity: string | undefined): string {
  const hash = createHash("sha256")
  for (const [index, { path }] of files.entries()) {
    const content = contents[index] ?? new Uint8Array()
    hash.update(`${path}\0${content.length}\0`).update(content)
  }
  if (antigravity !== undefined) hash.update(`${antigravityCache()}\0${antigravity}\0`)
  return hash.digest("hex").slice(0, SOURCE_DIGEST_HEX_LENGTH)
}

/** A finished copy of the file set: the digest of its bytes, and how many
 *  there are. */
interface SnapshotCopy {
  readonly digest: string
  readonly bytes: number
}

/** Copies `files` from `checkout` into `target`, and answers the digest of
 *  the bytes it wrote, or undefined when a listed file left the checkout
 *  during the copy. It makes each directory once and then copies every file
 *  at once, each file's write right after its own read, so the reads and the
 *  writes run off the thread together and only the hash runs on it. An
 *  entry that copies a checkout of about 2000 files and 22 MB takes 240 to
 *  280 ms this way, and took 500 to 1200 ms with one synchronous copy at a
 *  time. Every copy settles before it answers, so the caller can remove
 *  `target` whatever the answer. */
export async function copyAndDigest(checkout: string, files: readonly SourceFile[], target: string, antigravity: string | undefined): Promise<SnapshotCopy | undefined> {
  const made = new Set<string>()
  for (const { path } of files) {
    const directory = dirname(join(target, path))
    if (made.has(directory)) continue
    fs.mkdirSync(directory, { recursive: true })
    made.add(directory)
  }
  const copies = await Promise.allSettled(files.map(async ({ path, stats }) => {
    const content = await readListedFile(checkout, path)
    if (content !== undefined) await fs.promises.writeFile(join(target, path), content, { mode: Number(stats.mode & 0o777n) })
    return content
  }))
  const contents: Buffer[] = []
  for (const copy of copies) {
    if (copy.status === "rejected") throw copy.reason
    if (copy.value === undefined) return undefined
    contents.push(copy.value)
  }
  return { digest: digestOf(files, contents, antigravity), bytes: contents.reduce((sum, content) => sum + content.length, 0) }
}

/** Pins the checkout's engine file `path` into `target`. A package import loads once, but an engine loads at each launch. An install or a prepare removes or replaces the checkout's engine, so a hard link keeps the original one. Where a link fails, a copy keeps it instead. */
async function pinEngine(checkout: string, target: string, path: string): Promise<void> {
  const pinned = join(target, path)
  fs.mkdirSync(dirname(pinned), { recursive: true })
  await fs.promises.link(join(checkout, path), pinned).catch(() => fs.promises.copyFile(join(checkout, path), pinned, fs.constants.COPYFILE_FICLONE))
}

/** Pins the checkout's Claude engine into `target`. If the checkout has no engine, the snapshot uses the checkout's engine at launch. The copied lockfile includes the engine version in the snapshot digest. */
export async function pinClaudeEngine(checkout: string, target: string): Promise<void> {
  const path = checkoutClaudeEngine(buildPlatformArch())
  if (await statOrUndefined(join(checkout, path)) !== undefined) await pinEngine(checkout, target, path)
}

/** Pins the checkout's `agy`, which `listing` found, into `target`, and answers its SHA-256 once the pinned file proves to hold the pin's bytes. A copy that does not, or that left the checkout, is not pinned, and the snapshot then runs no `agy` (`antigravityEnginePath`): it never runs the checkout's. The answer goes into the snapshot's digest, so an entry after a prepare that places the `agy` makes a snapshot of its own. The hash reads about 230 MB, about 100 ms, once for each snapshot made. */
export async function pinAntigravityEngine(checkout: string, target: string, listing: SourceListing, pin: AntigravityPinnedBytes | undefined): Promise<string | undefined> {
  if (listing.antigravity === undefined) return undefined
  const path = antigravityCache()
  const pinned = join(target, path)
  try {
    await pinEngine(checkout, target, path)
  } catch (error) {
    log.warn("the snapshot pins no Antigravity CLI, because the checkout's copy could not be pinned", { checkout, error: errorMessage(error) })
    return undefined
  }
  const verified = await verifiedAntigravity(pinned, pin)
  if (verified !== undefined) return verified
  await fs.promises.rm(pinned, { force: true })
  log.warn("the snapshot pins no Antigravity CLI, because the checkout's copy is not the pinned bytes; bun run engine:antigravity:prepare replaces it", { checkout, path, bytes: Number(listing.antigravity.size) })
  return undefined
}

/** Links the client's packages into `target`. The web client pins versions of its own, such as `marked`, in `webview/node_modules`, and a bare import from the copy's `webview/` resolves up past that folder to the checkout's root packages. Without the link, a dev service builds its client against the root versions. Like the root packages, the link follows a later install. A junction needs no Windows privilege, and other platforms ignore the type. */
export async function linkClientPackages(checkout: string, target: string): Promise<void> {
  const packages = join(checkout, "webview", "node_modules")
  if (await statOrUndefined(packages) === undefined) return
  await fs.promises.symlink(packages, join(target, "webview", "node_modules"), "junction")
}

/** The digest of the source `files` name, as `checkout` holds it now, or
 *  undefined when a listed file left the checkout during the read. It reads
 *  every file at once, off the thread, and only the hash runs on it. */
export async function checkoutDigest(checkout: string, listing: SourceListing, pin: AntigravityPinnedBytes | undefined): Promise<string | undefined> {
  const [contents, antigravity] = await Promise.all([
    Promise.all(listing.files.map(({ path }) => readListedFile(checkout, path))),
    listing.antigravity === undefined ? undefined : verifiedAntigravity(join(checkout, antigravityCache()), pin),
  ])
  const read = contents.filter((content) => content !== undefined)
  return read.length === listing.files.length ? digestOf(listing.files, read, antigravity) : undefined
}
