import { batch, createSignal, type Accessor } from "solid-js"
import type { ClientSheetId } from "../../../src/protocol/client/host-contract.js"

/** Owns page-local workspace and modal destinations, independent of session selection. */
export function createWorkspaceNavigation(canDock: Accessor<boolean>) {
  const [modal, setModal] = createSignal<ClientSheetId>()
  const [workspace, setWorkspace] = createSignal<"changes" | "background" | "status">()
  return {
    sheet: () => modal() ?? (canDock() ? undefined : workspace()),
    panel: () => canDock() ? workspace() : undefined,
    open: (id: ClientSheetId) => batch(() => {
      if (id === "changes" || id === "background" || id === "status") {
        setWorkspace(id)
        setModal(undefined)
      } else {
        // Without room to dock, the workspace destination is a sheet like any
        // other, so another sheet replaces it rather than stacking over it.
        if (!canDock()) setWorkspace(undefined)
        setModal(id)
      }
    }),
    // A docked panel is no sheet: closing sheets, as selecting a session does,
    // leaves it open (PI-INTERACTION-056). Only its own control closes it.
    closeSheet: () => { if (modal()) setModal(undefined); else if (!canDock()) setWorkspace(undefined) },
    clearModal: () => setModal(undefined),
    closePanel: () => setWorkspace(undefined),
  }
}
