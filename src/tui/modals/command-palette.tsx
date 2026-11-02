/** @jsxImportSource @opentui/solid */

import { useTheme } from "@tui/context/theme"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import { ModalFrame } from "@tui/components/modal-frame"
import { MODAL_CONTROL_COPY, MODAL_FRAME_WIDTHS } from "@tui/components/modal-copy"

import type { CommandPaletteState } from "./command-palette-types.js"
import { ModalSelect } from "../components/modal-select.js"
import { ControlledTextField } from "../components/controlled-text-field.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"

interface CommandPaletteProps {
  state: CommandPaletteState
  onClose: () => void
  onRowClick: (rowIndex: number) => void
}


export function CommandPalette(props: CommandPaletteProps) {
  const { theme } = useTheme()
  const { modalWidth, listMaxHeight } = useModalDimensions(MODAL_FRAME_WIDTHS.commands)

  return (
    <ModalFrame title={KERNEL_COMMAND_NAMES.help} width={modalWidth()} onClose={() => props.onClose()}>
      <box paddingTop={1} paddingLeft={2}>
        <ControlledTextField presentation={props.state.presentation} focused selectionForeground={theme.selectionForeground} selectionBackground={theme.selectionBackground} placeholder="Filter commands" width={Math.max(1, modalWidth() - 8)} textColor={theme.text} placeholderColor={theme.textMuted} />
      </box>
      <box height={1} />
      <ModalSelect
        result={props.state.result}
        cursor={props.state.cursor}
        theme={theme}
        listMaxHeight={listMaxHeight()}
        onRowClick={props.onRowClick}
        footerRows={[MODAL_CONTROL_COPY.commands[0]]}
        emptyFooterRows={[MODAL_CONTROL_COPY.commands[1]]}
      />
    </ModalFrame>
  )
}
