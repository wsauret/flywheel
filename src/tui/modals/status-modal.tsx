/** @jsxImportSource @opentui/solid */

import type { TextRenderable } from "@opentui/core"
import { StyledText, bold as stBold, fg as stFg } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import { ModalFrame } from "@tui/components/modal-frame"
import { MODAL_CONTROL_COPY, MODAL_FRAME_WIDTHS } from "@tui/components/modal-copy"
import { ModalFooter } from "@tui/components/modal-footer"
import { createEffect, For } from "solid-js"
import type { StatusRow } from "../hooks/use-status-modal.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"

interface StatusModalProps {
  rows: readonly StatusRow[]
  cursor: number
  onClose: () => void
  onRowClick: (rowIndex: number) => void
}


export function StatusModal(props: StatusModalProps) {
  const { theme } = useTheme()
  const { modalWidth } = useModalDimensions(MODAL_FRAME_WIDTHS.status)
  // Module rows bring labels of any length, so the label column follows the longest one with one cell of gap.
  const labelColumn = (): number => Math.max(12, ...props.rows.map((row) => row.label.length + 1))

  return (
    <ModalFrame title={KERNEL_COMMAND_NAMES.status} width={modalWidth()} onClose={() => props.onClose()} gap={1}>
      <box flexDirection="column">
        <For each={props.rows}>
          {(row, index) => (
            <box
              backgroundColor={props.cursor === index() ? theme.backgroundElement : undefined}
              onMouseDown={() => props.onRowClick(index())}
            >
              <text ref={(el: TextRenderable) => {
                createEffect(() => {
                  el.content = new StyledText([
                    stBold(stFg(row.tone === "warning" ? theme.warning : theme.text)(row.label.padEnd(labelColumn()))),
                    stFg(theme.textMuted)(row.value),
                    ...(row.action?.kind === "command" ? [stFg(theme.primary)(`  /${row.action.id}`)] : []),
                    // One line per row: a multi-line hint reads as one sentence here and whole in the web sheet.
                    ...(row.hint === undefined ? [] : [stFg(theme.textMuted)(`  ${row.hint.replace(/\n/g, " · ")}`)]),
                  ])
                })
              }} overflow="hidden" wrapMode="none" />
            </box>
          )}
        </For>
      </box>
      <ModalFooter rows={MODAL_CONTROL_COPY.status} align="left" />
    </ModalFrame>
  )
}