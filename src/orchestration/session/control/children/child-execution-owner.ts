import { openExistingContainedDirectory } from "../../../../infra/descriptor-directory.js"
import { ensureSessionDir, sessionRelativeDir } from "../../../../infra/paths.js"
import { directoryComponents, removeTreeUnder } from "../../../../infra/write-file-under.js"
import { writeOwnerPid } from "../../pid-lock.js"

/** Prepares the filesystem owner before guarded publication. Rollback removes
 * only a directory this call created for an exclusively held, unreserved id. */
export function prepareChildExecutionOwner(sessionId: string, projectRoot: string, reserved: boolean) {
  const relativeDir = sessionRelativeDir(sessionId)
  const existing = openExistingContainedDirectory(projectRoot, directoryComponents(relativeDir))
  const created = existing === undefined
  existing?.close()
  const rollback = () => {
    if (created && !reserved) removeTreeUnder(projectRoot, relativeDir)
  }
  try {
    ensureSessionDir(sessionId, projectRoot)
    writeOwnerPid(sessionId, projectRoot)
  } catch (error) {
    rollback()
    throw error
  }
  return { rollback }
}
