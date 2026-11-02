import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Log } from "./log.js"
import { isProcessAlive } from "./process-liveness.js"
import { privateTemporaryRoot, type PrivateTemporaryRootStem } from "./private-temporary-root.js"

/** Temporary directories that live as long as the process that made them.
 *
 *  A process makes each one as `<pid>-XXXXXX` in one private root of this
 *  user, such as `fw-ipc-<uid>`, and removes it with everything in it when it
 *  is done. A process that is killed removes nothing, so each new directory
 *  first sweeps its root and removes every directory whose pid holds no
 *  process. A pid that the system gave to a new process reads as alive, so a
 *  sweep can keep an abandoned directory longer than it must, but it never
 *  removes the directory of a process that runs. The sweep reads only the one
 *  root, never the whole temporary directory. */

const log = Log.create({ service: "process-temporary-directory" })

const OWNED_NAME = /^(\d+)-/

/** Makes a new directory that this process owns in the root named by `stem`,
 *  after it removes the directories of processes that no longer run. A failed
 *  sweep is logged and never fails the call. */
export async function createProcessTemporaryDirectory(stem: PrivateTemporaryRootStem, temporary: string = tmpdir()): Promise<string> {
  const root = privateTemporaryRoot(temporary, stem)
  await sweepAbandonedDirectories(root)
  return await mkdtemp(join(root, `${process.pid}-`))
}

/** Removes a process temporary directory with everything still in it. */
export async function removeProcessTemporaryDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
}

async function sweepAbandonedDirectories(root: string): Promise<void> {
  let names: readonly string[]
  try {
    names = await readdir(root)
  } catch (error) {
    log.debug("a process temporary root could not be swept", { root, error: String(error) })
    return
  }
  for (const name of names) {
    const owner = OWNED_NAME.exec(name)
    if (owner === null || isProcessAlive(Number(owner[1]))) continue
    await rm(join(root, name), { recursive: true, force: true }).catch((error: unknown) => {
      log.debug("an abandoned process temporary directory could not be removed; a later sweep tries again", { root, name, error: String(error) })
    })
  }
}
