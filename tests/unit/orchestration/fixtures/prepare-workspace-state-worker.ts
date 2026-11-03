import { parentPort, workerData } from "node:worker_threads"
import type { ProjectDirectories } from "../../../../src/infra/directory-authorities.js"
import { LockRefusal } from "../../../../src/infra/ownership-file-lock.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"

/** A second thread that prepares the same workspace, so a test can race two
 *  starts against one event store. It reports readiness once its imports are
 *  resolved and prepares on the next message, which keeps the two starts inside
 *  the same few milliseconds instead of separated by module loading. It reports
 *  whether its start was admitted, refused by a gate that clears itself, or
 *  failed. */
const data: unknown = workerData
if (typeof data !== "object" || data === null || !("directories" in data)) throw new Error("worker data has no directories")
const directories = data.directories
if (typeof directories !== "object" || directories === null) throw new Error("worker directories are invalid")
const projectDirectories: ProjectDirectories = {
  projectRoot: String("projectRoot" in directories ? directories.projectRoot : ""),
  accountHome: String("accountHome" in directories ? directories.accountHome : ""),
  userDataRoot: String("userDataRoot" in directories ? directories.userDataRoot : ""),
}

parentPort?.on("message", () => {
  try {
    // Released as soon as this start settles: a shared-holder entry is stamped
    // with the owning pid, so one left behind would read as a live owner for
    // the rest of this process's life.
    prepareWorkspaceState(projectDirectories).generation.release()
    parentPort?.postMessage({ outcome: "admitted" }, [])
  } catch (err) {
    if (err instanceof LockRefusal && err.clearsItself) parentPort?.postMessage({ outcome: "refused" }, [])
    else parentPort?.postMessage({ outcome: "failed", error: err instanceof Error ? err.message : String(err) }, [])
  }
})

parentPort?.postMessage({ ready: true }, [])
