import { createBoundedWorkerSpawner, WorkerRoleAlreadyLive } from "../../infra/bounded-worker-spawner.js"
import type { StoredFact } from "../../infra/event-store-types.js"
import { terminateWorker } from "../../infra/worker-termination.js"
import type { ProjectDirectories } from "../../infra/directory-authorities.js"
import type { StartupReached } from "../../protocol/startup-steps.js"
import type { SessionMetadataChange } from "../session/manager.js"
import { createProjectStateClient, ProjectStateUnavailableError, type ProjectStateClient } from "./project-state-client.js"
import {
  decodeProjectStateClosed,
  decodeProjectStateMessage,
  decodeProjectStateStartupStep,
  type ProjectStateResponseFrame,
  type ProjectStateWorkerInit,
} from "./project-state-protocol.js"
import type { ProjectStateStandby } from "./project-state-standby.js"

/** One acquisition owns this budget. Close and join its client before acquiring a replacement.
 *  An acquisition first takes the account service's pre-started Worker, which
 *  spends none of this budget because the standby's own budget counted it. */
export interface ProjectStateWorkerSpawner {
  acquire(): ProjectStateClient
}

export function spawnProjectStateWorker(directories: ProjectDirectories, executionCwd: string, workerUrl: string | URL, onStartupStep?: (reached: StartupReached) => void, standby?: Pick<ProjectStateStandby, "take">, predecessorPids?: readonly number[]): ProjectStateWorkerSpawner {
  const spawn = createBoundedWorkerSpawner("project-state")
  let active = false
  const acquire = (): ProjectStateClient => {
    if (active) throw new WorkerRoleAlreadyLive("project-state")
    const worker = standby?.take() ?? spawn(workerUrl, { type: "module" })
    active = true
    const control = new MessageChannel()
    const execution = new MessageChannel()
    const listeners = new Set<(frame: ProjectStateResponseFrame) => boolean>()
    const closeListeners = new Set<(reason: string, cause?: Error) => void>()
    const sessionListeners = new Set<(change: SessionMetadataChange) => void>()
    const storedListeners = new Set<(events: readonly StoredFact[]) => void>()
    const shutdown = Promise.withResolvers<Error | null>()
    let lost = false
    let closeRequested = false
    const listen = (event: MessageEvent) => {
      const reached = decodeProjectStateStartupStep(event.data)
      if (reached) {
        onStartupStep?.(reached)
        return
      }
      const message = decodeProjectStateMessage(event.data)
      if (message?.kind === "response") {
        for (const listener of listeners) if (!listener(message.frame)) notifyClose("invalid worker response")
      } else if (message?.kind === "stored") for (const listener of storedListeners) listener(message.events)
      else if (message?.kind === "session-change") for (const listener of sessionListeners) listener(message.change)
      else notifyClose("invalid worker response")
    }
    control.port1.addEventListener("message", listen)
    execution.port1.addEventListener("message", listen)
    control.port1.start()
    execution.port1.start()
    worker.addEventListener("error", (event) => notifyClose(event.message ? `worker error: ${event.message}` : "worker error"), { once: true })
    worker.addEventListener("close", () => notifyClose("worker closed"), { once: true })
    worker.addEventListener("message", (event) => {
      const closed = decodeProjectStateClosed(event.data)
      if (!closed) notifyClose("invalid worker shutdown response")
      else if (closeRequested) shutdown.resolve(closed.error)
      // A close nobody asked for is a start that failed, in its own words.
      else if (closed.error === null) notifyClose("worker closed")
      else notifyClose(closed.error.message, closed.error)
    })
    function notifyClose(reason: string, cause?: Error): void {
      lost = true
      shutdown.resolve(new ProjectStateUnavailableError(reason, cause))
      for (const listener of closeListeners) listener(reason, cause)
      closeListeners.clear()
    }
    const init: ProjectStateWorkerInit = {
      flywheel: "state.init",
      directories,
      executionCwd,
      predecessorPids,
      controlPort: control.port2,
      executionPort: execution.port2,
    }
    worker.postMessage(init, [control.port2, execution.port2])
    return createProjectStateClient({
      send(request, encoded) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- boundary: MessagePort.postMessage has no target origin
        (request.lane === "control" ? control.port1 : execution.port1).postMessage(encoded, [encoded.buffer])
      },
      onResponse(listener) {
        listeners.add(listener)
      },
      onClose(listener) {
        closeListeners.add(listener)
      },
      onSessionChange(listener) {
        sessionListeners.add(listener)
        return () => sessionListeners.delete(listener)
      },
      onStored(listener) {
        storedListeners.add(listener)
        return () => { storedListeners.delete(listener) }
      },
      async close() {
        try {
          if (!lost) {
            closeRequested = true
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- boundary: Bun Worker.postMessage has no target origin
            worker.postMessage({ flywheel: "state.close" })
            const failure = await shutdown.promise
            if (failure) throw failure
          }
        } finally {
          control.port1.close()
          execution.port1.close()
          sessionListeners.clear()
          storedListeners.clear()
          await terminateWorker(worker)
          active = false
        }
      },
    })
  }
  return { acquire }
}
