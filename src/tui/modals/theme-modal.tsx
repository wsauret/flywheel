/** @jsxImportSource @opentui/solid */

import { useTheme } from "@tui/context/theme"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import { ModalSelect } from "../components/modal-select.js"
import type { FilteredResult } from "../components/modal-select-types.js"
import { ModalFrame } from "../components/modal-frame.js"
import { MODAL_CONTROL_COPY, MODAL_FRAME_WIDTHS } from "../components/modal-copy.js"
import { settingCatalogRow } from "../../protocol/setting-catalog.js"

interface ThemeModalProps {
  result: FilteredResult<string>
  cursor: number
  current: string
  saving: boolean
  onClose: () => void
  onRowClick: (rowIndex: number) => void
}

export function ThemeModal(props: ThemeModalProps) {
  const { theme } = useTheme()
  const { modalWidth, listMaxHeight } = useModalDimensions(MODAL_FRAME_WIDTHS.theme)

  return (
    <ModalFrame title={settingCatalogRow("theme").label} width={modalWidth()} onClose={() => props.onClose()}>
      <box height={1} />
      <ModalSelect
        result={props.result}
        cursor={props.cursor}
        current={props.current}
        theme={theme}
        listMaxHeight={listMaxHeight()}
        onRowClick={props.onRowClick}
        footerRows={[`${props.saving ? "Saving... · " : ""}${MODAL_CONTROL_COPY.theme[0]}`]}
      />
    </ModalFrame>
  )
}
