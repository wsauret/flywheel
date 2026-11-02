/** @jsxImportSource @opentui/solid */
import { createRoot, onCleanup } from "solid-js"
import type { ModalHandle } from "../../components/modal-stack.js"
import type { TuiControllerHost } from "../../tui-module.js"
import { createMcpList, createMcpOperations } from "./list.js"
import { McpModal } from "./modal.js"

/** The cached opener gives each modal a fresh owner and releases it on close. */
export function createMcpSurface(host: TuiControllerHost): () => void {
  let handle: ModalHandle | undefined
  const operations = createMcpOperations(host)
  onCleanup(() => handle?.close())
  return () => {
    handle?.close()
    createRoot((dispose) => {
      const list = createMcpList({ ...host, close: () => opening.close() }, operations)
      const opening = host.modal.replace(() => <McpModal list={list} />, { onKey: list.key, onClose: dispose })
      handle = opening
    })
  }
}
