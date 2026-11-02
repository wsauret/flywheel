import { createBoundedWorkerSpawner } from "../../infra/bounded-worker-spawner.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { terminateWorker } from "../../infra/worker-termination.js"

const log = Log.create({ service: "project-state-standby" })

/** The one project-state Worker that a starting account service runs ahead of
 *  its first project open, so the state role's code loads while the service
 *  loads its own. The Worker only imports that code: it reads and changes no
 *  durable state until the open that takes it sends its init, and project
 *  opens wait for the confirmed service start as before (ARCH-RUNTIME-015). */
export interface ProjectStateStandby {
  /** Hands the Worker to the first caller while it is alive. The caller owns
   *  it from then on, its error and close events included. Answers undefined
   *  once it was taken, failed, or disposed, and the caller spawns its own. */
  take(): Worker | undefined
  /** Terminates and joins a Worker that nobody took. */
  dispose(): Promise<void>
}

/** Starts the standby on the service's own Worker budget of one generation.
 *  A Worker that cannot start, or fails before an open takes it, costs the
 *  first open only the time the standby would have saved. */
export function startProjectStateStandby(workerUrl: string | URL): ProjectStateStandby {
  const spawn = createBoundedWorkerSpawner("project-state-standby")
  let standby: Worker | undefined
  // The join of a standby that failed before anyone took it; dispose awaits
  // it so the service never exits ahead of that thread.
  let discarded: Promise<void> | undefined
  const listening = new AbortController()
  const discard = (cause: string) => {
    const worker = standby
    if (worker === undefined) return
    standby = undefined
    listening.abort()
    log.warn("the pre-started project state Worker ended before a project open took it; the first open starts its own", { cause })
    discarded = terminateWorker(worker)
  }
  try {
    standby = spawn(workerUrl, { type: "module" })
  } catch (error) {
    log.warn("the project state Worker could not be pre-started; the first open starts its own", { error: errorMessage(error) })
    return { take: () => undefined, dispose: async () => {} }
  }
  standby.addEventListener("error", (event) => discard(event.error === undefined ? event.message || "worker error" : errorMessage(event.error)), { signal: listening.signal })
  standby.addEventListener("close", () => discard("worker closed"), { signal: listening.signal })
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- boundary: Bun Worker.postMessage has no target origin
  standby.postMessage({ flywheel: "state.preload" })
  return {
    take() {
      const worker = standby
      if (worker === undefined) return undefined
      standby = undefined
      listening.abort()
      log.info("a project open took the pre-started project state Worker")
      return worker
    },
    async dispose() {
      const worker = standby
      if (worker === undefined) return await discarded
      standby = undefined
      listening.abort()
      await terminateWorker(worker)
    },
  }
}
