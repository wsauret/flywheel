/** @jsxImportSource @opentui/solid */
import { createEffect, createRoot, on, onCleanup } from "solid-js"
import type { ModalHandle } from "../../components/modal-stack.js"
import type { TuiControllerHost } from "../../tui-module.js"
import { createSideQuestionModel } from "./model.js"
import { SideQuestionModal } from "./modal.js"

/** A cached opener creates an independent owner for each modal opening. */
export function createSideQuestionSurface(host: TuiControllerHost): () => void {
  let handle: ModalHandle | undefined
  createEffect(on(host.foregroundId, () => handle?.close(), { defer: true }))
  onCleanup(() => handle?.close())
  return () => {
    const id = host.foregroundId()
    if (!id) return
    handle?.close()
    createRoot((dispose) => {
      const model = createSideQuestionModel(host, id, () => opening.close())
      const opening = host.modal.replace(() => <SideQuestionModal model={model} />, {
        onKey: model.key,
        onPaste: model.paste,
        onClose: dispose,
      })
      handle = opening
    })
  }
}
