import type { ProjectServiceState } from "../../src/orchestration/app-service/project-control-client.js"
import type { RuntimeServiceState } from "../../src/protocol/app-service-types.js"

/** What the account service reports about itself, as a project reaches it,
 *  serving and never moving: for a project composition whose case is not
 *  about the service. */
export function servingAccountService(): ProjectServiceState {
  return recordingAccountService().port
}

/** What the account service reports about itself, as a project reaches it:
 *  a state a test reports, and the listeners it holds. */
export function recordingAccountService() {
  let state: RuntimeServiceState = { kind: "serving" }
  const listeners = new Set<(state: RuntimeServiceState) => void>()
  const port: ProjectServiceState = {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    port, listeners,
    report(next: RuntimeServiceState) {
      state = next
      for (const listener of listeners) listener(next)
    },
  }
}
