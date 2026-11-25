import type { WorkerSelf } from "../../infra/process/workers/bun-worker-rpc.js"
import { errorMessage } from "../../infra/error-message.js"
import { importComposing } from "./module-registries.js"

/** One Worker entry for source and compiled distributions. The first control
 *  frame selects the owning role; subsequent frames belong to that role's own
 *  protocol. A standalone Bun executable bundles one entry, so role selection
 *  must be data, not another executable path. The roles are the runtime's
 *  auxiliary Workers (ARCH-RUNTIME-011): the read-only background history reader,
 *  the one-shot startup maintenance owner, the per-project state owner, and
 *  the account service's one-job update installer. Each role reads the module
 *  catalog, so each loads the module registries first. */

declare const self: WorkerSelf

let roleStarted = false
let stateRole: Promise<typeof import("../../orchestration/app-service/project-state/worker/project-state-worker.js")> | undefined
const importStateRole = () => (stateRole ??= importComposing(() => import("../../orchestration/app-service/project-state/worker/project-state-worker.js")))
const importFailure = (error: unknown) => { throw new Error(`project state worker import failed: ${errorMessage(error)}`) }

self.addEventListener("message", (event: MessageEvent) => {
  const frame = controlFrame(event.data)
  if (!frame || roleStarted) return
  switch (frame) {
    // The account service's standby (project-state-standby.ts) loads the
    // state role's code before any project names it; `state.init` selects it.
    case "state.preload":
      void importStateRole().catch(importFailure)
      return
    case "background.init":
      roleStarted = true
      void importComposing(() => import("../../orchestration/app-service/background/runtime-background-worker.js")).then(({ runRuntimeBackgroundWorker }) => runRuntimeBackgroundWorker(self, event.data))
      return
    case "maintenance.init":
      roleStarted = true
      void importComposing(() => import("../../orchestration/app-service/background/runtime-maintenance-worker.js")).then(({ runRuntimeMaintenanceWorker }) => runRuntimeMaintenanceWorker(self, event.data))
      return
    case "update.init":
      roleStarted = true
      void importComposing(() => import("../../orchestration/update/update-worker.js")).then(({ runUpdateWorker }) => runUpdateWorker(self, event.data))
      return
    case "state.init":
      roleStarted = true
      void importStateRole()
        .then(({ runProjectStateWorker }) => runProjectStateWorker(self, event.data))
        .catch(importFailure)
      return
  }
})

function controlFrame(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("flywheel" in data)) return undefined
  return typeof data.flywheel === "string" ? data.flywheel : undefined
}
