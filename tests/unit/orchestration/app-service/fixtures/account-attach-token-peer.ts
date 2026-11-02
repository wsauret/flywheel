import { existsSync, readFileSync } from "node:fs"
import { parentPort, workerData } from "node:worker_threads"
import { Redacted } from "effect"

import { readOrCreateAccountAttachToken } from "../../../../../src/orchestration/app-service/account-attach-token.js"
import { accountServeTokenPath } from "../../../../../src/infra/paths.js"

/** One participant of a token race, on its own thread. It goes through the
 *  roots in order. A `create` peer reads or creates each token, as a client and
 *  the service do when they start together. An `observe` peer reads each token
 *  file as soon as the path exists, as a harness that waits for the file does.
 *  It posts what it saw at each root: the token, or the error it met.
 *
 *  The peers run free, with no barrier. The creator that reaches a root first
 *  publishes its token, which is the slowest step. The other creators only
 *  read, and the observer only polls, so they catch up and wait at the root
 *  that is being published. Thus each root is raced while the cost stays the
 *  work itself. A barrier at each root made the race wait until the scheduler
 *  ran every thread, so on a loaded machine the test took several seconds. */
const data: unknown = workerData
if (typeof data !== "object" || data === null || !("roots" in data) || !("role" in data)) {
  throw new Error("worker data needs roots and role")
}
const { roots, role } = data
if (!Array.isArray(roots) || (role !== "create" && role !== "observe")) {
  throw new Error("worker data has the wrong types")
}

const seen: string[] = []
for (const root of roots) {
  if (typeof root !== "string") throw new Error("a root is not a path")
  try {
    if (role === "create") {
      seen.push(Redacted.value(readOrCreateAccountAttachToken(root, "installed")))
    } else {
      const path = accountServeTokenPath(root, "installed")
      while (!existsSync(path)) {
        // The observer reads the moment a creator publishes the path.
      }
      seen.push(readFileSync(path, "utf8").trim())
    }
  } catch (error) {
    seen.push(`error: ${error instanceof Error ? error.message : String(error)}`)
  }
}
parentPort?.postMessage(seen, [])
