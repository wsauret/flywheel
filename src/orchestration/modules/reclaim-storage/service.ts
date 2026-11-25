import { moduleServiceHandle } from "../../../infra/module-service.js"
import { describeReclaimOutcome, storageCursor, type RuntimeStorageView, type StorageReclaimResult } from "../../../protocol/modules/reclaim-storage.js"
import type { StorageReclaimOutcome, StorageReclaimPreview } from "../../../protocol/store-reclaim.js"
import type { ControlModuleServices, ModuleServiceInstance } from "../../app-service/executor/execution/module-service-host.js"

/** The module's one process-scoped service: the storage view, which follows
 *  the kernel's live store usage and publishes each new value whole, and the
 *  command, which the kernel's storage port runs. */
export interface StorageService extends ModuleServiceInstance {
  view(): RuntimeStorageView
  preview(): StorageReclaimPreview
  reclaim(): StorageReclaimResult
}

export const storageService = moduleServiceHandle<StorageService>("reclaim-storage")

function outcomeTitle(outcome: StorageReclaimOutcome): string {
  switch (outcome.kind) {
    case "reclaimed": return "Storage reclaimed"
    case "refused": return "Reclaim storage refused"
    case "failed": return "Reclaim storage failed"
  }
}

const NO_ACCOUNT = "Reclaim storage runs only in the Flywheel service. Open this project in the terminal or a web client."

export function createStorageService(services: ControlModuleServices): StorageService {
  const storage = services.storage
  const view = (): RuntimeStorageView => {
    const usage = storage?.usage()
    const last = storage?.last()
    return {
      usage: usage === undefined ? null : { storeBytes: usage.storeBytes, reclaimableBytes: usage.reclaimableBytes },
      lastReclaim: last === undefined ? null : { outcome: last.outcome, at: last.at },
    }
  }
  const stop = storage?.onUsage(() => {
    services.publish({ cursor: storageCursor(), payload: { kind: "reclaim_storage.changed", storage: view() } })
  })
  return {
    view,
    // The run closed the project, so no client heard its end: the reopened
    // project states the outcome once, after every module service exists.
    start() {
      const ended = storage?.takeAnnouncement()
      if (ended === undefined) return
      void services.notify({ type: "raise", occurrence: {
        sourceId: `reclaim-storage.run.${ended.at}`,
        title: outcomeTitle(ended.outcome),
        message: describeReclaimOutcome(ended.outcome),
        severity: ended.outcome.kind === "reclaimed" ? "warning" : "alert",
      } })
    },
    preview: () => storage?.preview() ?? null,
    reclaim() {
      if (!storage) return { ok: false, error: NO_ACCOUNT }
      const answer = storage.reclaim()
      return answer.kind === "started" ? { ok: true } : { ok: false, error: answer.message }
    },
    dispose() { stop?.() },
  }
}
