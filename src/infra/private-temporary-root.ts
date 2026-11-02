import { lstatSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/**
 * Every private temporary root that Flywheel keeps. Each stays in the
 * temporary directory for good, and only its contents come and go: spools of
 * persistent processes, the lease records of process guardians, the socket
 * directories of open projects, the native assets that a source run stages, and the temporary directory of the
 * Claude engines that Flywheel runs.
 *
 * @public
 * `scripts/test-temp-guard.ts` reads this list to look inside the roots
 * instead of reporting them as leaks. Knip does not trace scripts into the
 * production project, so this export is not dead.
 */
export const PRIVATE_TEMPORARY_ROOT_STEMS = ["flywheel-spools", "flywheel-leases", "fw-ipc", "flywheel-native", "fw-claude"] as const
export type PrivateTemporaryRootStem = (typeof PRIVATE_TEMPORARY_ROOT_STEMS)[number]

/** The name of the root for `stem`: `<stem>-<uid>`, or `<stem>` where the
 *  platform has no uid. */
export function privateTemporaryRootName(stem: PrivateTemporaryRootStem): string {
  const uid = process.getuid?.()
  return uid === undefined ? stem : `${stem}-${uid}`
}

/** One directory of this user in the temporary directory, named `<stem>-<uid>`
 *  (`<stem>` on Windows, which has no uid and whose temporary directory belongs
 *  to one user).
 *
 *  An owner that must find its entries again after a crash keeps them here, so
 *  a sweep reads only this directory and never the whole temporary directory,
 *  which can hold hundreds of thousands of entries. A shared temporary
 *  directory, such as /tmp on Linux, lets another user create the name first.
 *  An existing root is therefore used only when it is a real directory that
 *  this user owns and that nobody else can enter, as tmux checks its own socket
 *  directory. Throws when the name exists in any other form. */
export function privateTemporaryRoot(temporary: string, stem: PrivateTemporaryRootStem): string {
  const uid = process.getuid?.()
  const root = join(temporary, privateTemporaryRootName(stem))
  try {
    mkdirSync(root, { mode: 0o700 })
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error
  }
  const stats = lstatSync(root)
  if (!stats.isDirectory() || (uid !== undefined && (stats.uid !== uid || (stats.mode & 0o077) !== 0))) {
    throw new Error(`${root} is not a private directory of this user`)
  }
  return root
}
