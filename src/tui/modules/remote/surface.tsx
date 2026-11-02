/** @jsxImportSource @opentui/solid */
import { remoteDomain } from "../../../protocol/modules/remote.js"
import type { TuiControllerHost } from "../../tui-module.js"
import { RemoteModal } from "./modal.js"
import { useRemoteModal } from "./use-remote-modal.js"

export function createRemoteSurface(host: TuiControllerHost): () => void {
  const view = () => host.read(remoteDomain)
  const controller = useRemoteModal({
    modal: host.modal, view, currentProjectRoot: host.projectRoot, appService: host.client, showToast: host.showToast,
    renderModal: () => <RemoteModal view={view()} cursor={controller.cursor()} now={controller.now()} currentProjectRoot={host.projectRoot()} rename={controller.rename()} renameSaving={controller.renameSaving} processInitiationPending={controller.processInitiationPending()} onClose={controller.closeRemoteModal} onSelect={controller.select} onRenameBlur={controller.finishRename} />,
  })
  return controller.openRemoteModal
}
