import { useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createMemo } from "solid-js"
import { computeModalListHeight, computeModalWidth } from "../components/modal-layout.js"

interface ModalDimensions {
  modalWidth: Accessor<number>
  listMaxHeight: Accessor<number>
  termWidth: Accessor<number>
  termHeight: Accessor<number>
}

export function useModalDimensions(maxWidth: number, reservedRows = 10, maxHeight = 18): ModalDimensions {
  const dimensions = useTerminalDimensions()
  const termWidth = createMemo(() => dimensions()?.width ?? 80)
  const termHeight = createMemo(() => dimensions()?.height ?? 24)
  const modalWidth = createMemo(() => computeModalWidth(termWidth(), maxWidth))
  const listMaxHeight = createMemo(() => computeModalListHeight(termHeight(), reservedRows, maxHeight))
  return { modalWidth, listMaxHeight, termWidth, termHeight }
}
