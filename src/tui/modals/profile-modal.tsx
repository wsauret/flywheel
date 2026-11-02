/** @jsxImportSource @opentui/solid */

import { useTheme } from "@tui/context/theme"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import { ModalSelect } from "../components/modal-select.js"
import type { FilteredResult } from "../components/modal-select-types.js"
import { ModalFrame } from "../components/modal-frame.js"
import { MODAL_CONTROL_COPY, MODAL_FRAME_WIDTHS } from "../components/modal-copy.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"

interface ProfileModalProps {
  result: FilteredResult<string>
  cursor: number
  current: string | undefined
  onClose: () => void
  onRowClick: (rowIndex: number) => void
}

export function ProfileModal(props: ProfileModalProps) {
  const { theme } = useTheme()
  const { modalWidth, listMaxHeight } = useModalDimensions(MODAL_FRAME_WIDTHS.profile)

  return (
    <ModalFrame title={KERNEL_COMMAND_NAMES.profile} width={modalWidth()} onClose={() => props.onClose()}>
      <box height={1} />
      <ModalSelect
        result={props.result}
        cursor={props.cursor}
        current={props.current}
        theme={theme}
        listMaxHeight={listMaxHeight()}
        onRowClick={props.onRowClick}
        footerRows={MODAL_CONTROL_COPY.profile}
      />
    </ModalFrame>
  )
}
