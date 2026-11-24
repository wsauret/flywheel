import type { ProjectServiceState } from "../../src/orchestration/app-service/account/projects/project-control-client.js"
import type { RuntimeRestartReadiness, RuntimeServiceState } from "../../src/protocol/app-service-types.js"

/** What the account service reports about itself, as a project reaches it,
 *  serving and never moving: for a project composition whose case is not
 *  about the service. */
export function servingAccountService(): ProjectServiceState {
  return recordingAccountService().port
}

/** What the account service reports about itself, as a project reaches it:
 *  a state a test reports, the listeners it holds, and the restarts a client
 *  asked of it, which it accepts while `readiness` is `ready`. */
export function recordingAccountService() {
  let state: RuntimeServiceState = { kind: "serving" }
  let readiness: RuntimeRestartReadiness = { kind: "ready", serviceStart: "start-1" }
  let restarts = 0
  const listeners = new Set<(state: RuntimeServiceState) => void>()
  const port: ProjectServiceState = {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    restartReadiness: () => readiness,
    async restart() {
      if (readiness.kind === "unavailable") return { ok: false, error: readiness.reason }
      restarts += 1
      return { ok: true }
    },
  }
  return {
    port, listeners,
    get restarts() { return restarts },
    report(next: RuntimeServiceState) {
      state = next
      for (const listener of listeners) listener(next)
    },
    setReadiness(next: RuntimeRestartReadiness) {
      readiness = next
    },
  }
}
