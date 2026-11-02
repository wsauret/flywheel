import { createSignal, onCleanup } from "solid-js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { updatesCursor, type UpdateStatusView } from "../../protocol/update-protocol-types.js"
import { createHeldView } from "../../protocol/client/held-view.js"

export interface UpdateStatusCache {
  /** The runtime's published update view: its state and the effective
   *  auto-install policy together. Undefined until the first snapshot arrives,
   *  because the client owns no default policy of its own. */
  view(): UpdateStatusView | undefined
}

/** Client intake for the workspace `updates` domain, held as one whole view:
 *  patches replace it, and each lane reads it again. */
export function createUpdateStatusCache(deps: { appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> }): UpdateStatusCache {
  const [view, setView] = createSignal<UpdateStatusView | undefined>()
  const held = createHeldView<UpdateStatusView>({
    client: deps.appService,
    cursor: updatesCursor(),
    read: async () => {
      const snapshot = await deps.appService.query({ type: "updateSnapshot" })
      return { view: snapshot.update, position: snapshot.snapshotPosition }
    },
    adopt: (payload) => (payload.kind === "update.changed" ? payload.update : undefined),
    changed: (next) => setView(next),
    label: "update status",
  })
  onCleanup(held.dispose)
  return { view }
}
