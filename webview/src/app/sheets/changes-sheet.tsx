import { Show } from "solid-js"
import { useClient } from "../client-context.js"
import { ChangesContent } from "../changes-content.js"
import { SheetEmpty } from "./sheet.js"
import { WorkspaceSurface } from "../workspace-surface.js"
import { KERNEL_COMMAND_NAMES } from "../../../../src/protocol/command-names.js"

export function ChangesSheet(props: { readonly docked?: boolean; readonly onClose?: () => void } = {}) {
  const client = useClient()
  const openEditor = () => {
    const controller = client.changes()
    if (!controller) return
    void client.host.capabilities.openChanges?.({ sessionId: controller.sessionId })
      .catch(cause => client.report("warning", `Could not open Changes: ${String(cause)}`))
  }
  return <WorkspaceSurface title={KERNEL_COMMAND_NAMES.changes} wide docked={props.docked} onClose={props.onClose ?? client.closeSheet} tools={
    <Show when={client.host.capabilities.openChanges && client.changes()}>
      <button class="ghost-text" onClick={openEditor}>Open in editor</button>
    </Show>
  }>
    <Show when={client.changes()} keyed fallback={<SheetEmpty>Select a session to review changes.</SheetEmpty>}>
      {controller => <ChangesContent controller={controller} onOpenFile={client.actions.canOpenFiles ? path => client.actions.openFile(path) : undefined} />}
    </Show>
  </WorkspaceSurface>
}
