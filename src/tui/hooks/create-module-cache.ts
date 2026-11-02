import { createSignal, onCleanup } from "solid-js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { capabilitiesCursor, type RuntimeModulesView } from "../../protocol/module-protocol-types.js"
import { createHeldView } from "../../protocol/client/held-view.js"

export interface ModuleCache {
  /** The runtime's published capability view: the selected set, derived
   *  Workflows mode, persistent-process policy, and any configuration error.
   *  Undefined until the first snapshot arrives, because the client owns no
   *  selection or policy of its own. */
  view(): RuntimeModulesView | undefined
}

/** Client intake for the workspace `modules` domain, held as one whole view:
 *  patches replace it, and each lane reads it again. */
export function createModuleCache(deps: {
  appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
}): ModuleCache {
  const [view, setView] = createSignal<RuntimeModulesView | undefined>()
  const held = createHeldView<RuntimeModulesView>({
    client: deps.appService,
    cursor: capabilitiesCursor(),
    read: async () => {
      const snapshot = await deps.appService.query({ type: "moduleSnapshot" })
      return { view: snapshot.capabilities, position: snapshot.snapshotPosition }
    },
    adopt: (payload) => (payload.kind === "modules.changed" ? payload.capabilities : undefined),
    changed: (next) => setView(next),
    label: "module",
  })
  onCleanup(held.dispose)
  return { view }
}
