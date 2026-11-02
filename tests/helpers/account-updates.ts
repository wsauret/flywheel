import type { ProjectUpdates } from "../../src/orchestration/app-service/project-control-client.js"
import type { UpdateStatusView } from "../../src/protocol/update-protocol-types.js"

const AUTO_INSTALL_ON = { persisted: true, forcedOff: false, effective: true }

/** The account's update coordinator as a project reaches it, idle and never
 *  moving: for a project composition whose case is not about updates. */
export function idleAccountUpdates(): ProjectUpdates {
  return recordingAccountUpdates().port
}

/** The account's update coordinator as a project reaches it: a view a test
 *  moves, the auto-install writes it was asked for, and the listeners it
 *  holds. */
export function recordingAccountUpdates() {
  let view: UpdateStatusView = { revision: 0, autoInstall: AUTO_INSTALL_ON, status: { kind: "idle" } }
  const listeners = new Set<(view: UpdateStatusView) => void>()
  const writes: boolean[] = []
  const port: ProjectUpdates = {
    status: () => view,
    setAutoInstall: async (_expected, value) => { writes.push(value); return { ok: true } },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    port, writes, listeners,
    publish(next: UpdateStatusView) {
      view = next
      for (const listener of listeners) listener(next)
    },
  }
}
