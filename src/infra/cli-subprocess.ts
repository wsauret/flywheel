import { existsSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function runsThroughBun(execPath: string): boolean {
  const executable = basename(execPath.replaceAll("\\", "/")).toLowerCase()
  return executable === "bun" || executable === "bun.exe"
}

/** The serving lane a process belongs to. A source checkout serves beside the
 *  installed account service, never through it: its own rendezvous, hub port,
 *  and remote identity, so `bun run dev` neither dials, starts, nor retires
 *  the service the installed binary owns. The lane is a property of the build
 *  lineage, derived once from the executable and fixed for the process. */
export type ServeLane = "installed" | "dev"

/** Names, in every command an agent runs, the session that runs it. A
 *  Flywheel client started from such a command never asks the account
 *  service to make way, so no session's command can restart the service
 *  that every other session runs on (UPD-010). */
export const AGENT_SESSION_ENV = "FLYWHEEL_AGENT_SESSION_ID"

export function serveLaneFor(execPath: string): ServeLane {
  return runsThroughBun(execPath) ? "dev" : "installed"
}

/** A snapshot of a checkout's source, from which a dev service and the
 *  processes it starts run (ARCH-DISTRIBUTION-030). The checkout is a real path, because
 *  Bun names every module by its real path. */
export interface SourceSnapshotLocation {
  readonly checkout: string
  readonly digest: string
}

/** How many hex characters of a sha256 name a snapshot. Sixteen keep the
 *  deepest path in a snapshot under Windows' 260 characters for a checkout
 *  path of about 45 characters. */
export const SOURCE_DIGEST_HEX_LENGTH = 16

/** Whether `name` is the name of a snapshot directory: a digest. */
export function isSourceSnapshotDigest(name: string): boolean {
  return name.length === SOURCE_DIGEST_HEX_LENGTH && /^[0-9a-f]+$/.test(name)
}

/** The directory that holds the snapshots of `checkout`'s source: one
 *  directory per snapshot, named by its digest. It sits in the checkout's
 *  build cache, so every bare import from a snapshot resolves up to the
 *  checkout's own `node_modules`. */
export function sourceSnapshotHome(checkout: string): string {
  return join(checkoutCacheDirectory(checkout), "source")
}

function checkoutCacheDirectory(checkout: string): string {
  return join(checkout, "node_modules", ".cache", "flywheel")
}

/** The root of the source tree that holds `moduleUrl`, a module of
 *  `src/infra` such as this one. */
function sourceTreeRoot(moduleUrl: string): string {
  return resolve(fileURLToPath(new URL("../..", moduleUrl)))
}

/** The snapshot this module runs from, or undefined when it runs from a live
 *  checkout or from a packaged build. A snapshot copies its checkout's
 *  layout, so the answer for this module is the answer for every module of
 *  its tree, in every process. `moduleUrl` is this module's own place; a
 *  test names a module of `src/infra` in another tree. */
export function runningSourceSnapshot(moduleUrl: string = import.meta.url): SourceSnapshotLocation | undefined {
  if (!runsThroughBun(process.execPath)) return undefined
  const root = sourceTreeRoot(moduleUrl)
  const digest = basename(root)
  const checkout = resolve(root, "..", "..", "..", "..", "..")
  return isSourceSnapshotDigest(digest) && sourceSnapshotHome(checkout) === dirname(root) ? { checkout, digest } : undefined
}

/** The checkout this source module belongs to: the checkout that holds its
 *  snapshot, or the tree it runs from. What a checkout holds beside its
 *  source, such as fonts and native addons, is read from
 *  here, never relative to a module, which a snapshot does not copy. */
export function sourceCheckout(moduleUrl: string = import.meta.url): string {
  return runningSourceSnapshot(moduleUrl)?.checkout ?? sourceTreeRoot(moduleUrl)
}

/** A program that the checkout's packages hold, which a source run starts as
 *  a process of its own, by its path relative to the checkout. A process
 *  that runs from a snapshot starts the copy that the snapshot pinned when
 *  it was made (`source-snapshot.ts`), so an install that replaces the
 *  package in the checkout never changes the program that a running service
 *  starts. A live checkout, and a snapshot whose checkout had no such
 *  program to pin, start the checkout's own. */
export function checkoutProgram(path: string, moduleUrl: string = import.meta.url): string {
  const snapshot = runningSourceSnapshot(moduleUrl)
  const pinned = snapshot === undefined ? undefined : join(sourceSnapshotHome(snapshot.checkout), snapshot.digest, path)
  return pinned !== undefined && existsSync(pinned) ? pinned : join(sourceCheckout(moduleUrl), path)
}

/** The build cache of the checkout this source module belongs to. What a
 *  run derives from the checkout lives here, outside every snapshot, so the
 *  runs of every snapshot of one checkout share it. */
export function flywheelCacheDirectory(moduleUrl: string = import.meta.url): string {
  return checkoutCacheDirectory(sourceCheckout(moduleUrl))
}

/** Specifier for an entry embedded beside this one in a standalone executable.
 *
 *  Bun mounts a compiled executable's modules on a virtual filesystem, rooted
 *  at `/$bunfs/root` on Unix and at the `B:/~BUN/root` drive on Windows. That
 *  mount answers only to its own forward-slash keys, which rules out every
 *  other way of naming a sibling: a bare relative specifier has no base to
 *  resolve against and reports `ModuleNotFound`, and a `file://` URL or a
 *  native Windows path converts to backslashes the mount does not carry and
 *  reports `ENOENT`. `import.meta.dir` names the mount directory in native
 *  separators, so normalizing them yields the one specifier Bun resolves on
 *  every platform.
 *
 *  `moduleDir` is the caller's own `import.meta.dir`; the caller must be an
 *  embedded module, which makes its directory the mount root. */
export function embeddedEntrySpecifier(moduleDir: string, entry: string): string {
  return `${moduleDir.replaceAll("\\", "/")}/${entry}`
}
