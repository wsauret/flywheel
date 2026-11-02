/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable, TextRenderable } from "@opentui/core"
import { StyledText, bold as stBold, fg as stFg } from "@opentui/core"
import { useKeymap } from "@tui/context/keymap"
import { useTheme } from "@tui/context/theme"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import { BOLD } from "@tui/utils/text-attributes"
import { createEffect, For, onCleanup } from "solid-js"
import { ModalFrame } from "./modal-frame.js"
import { MODAL_CONTROL_COPY, MODAL_FRAME_WIDTHS } from "./modal-copy.js"
import { ModalFooter } from "./modal-footer.js"
import type { ModalScrollController } from "./modal-scroll-controller.js"
import { HELP_SHORTCUT_SECTIONS, helpShortcuts } from "./modal-help-shortcuts.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"

interface ModalHelpProps {
  onClose: () => void
  scroll: ModalScrollController
}

export function ModalHelp(props: ModalHelpProps) {
  const { theme } = useTheme()
  const { keymap } = useKeymap()
  const shortcuts = helpShortcuts(keymap.chordFor)
  const { modalWidth, listMaxHeight } = useModalDimensions(MODAL_FRAME_WIDTHS.help, 9, 24)

  return (
    <ModalFrame title={KERNEL_COMMAND_NAMES.shortcuts} width={modalWidth()} onClose={() => props.onClose()} gap={1}>
      <text fg={theme.textMuted}>Prompt editing and application controls</text>
      <scrollbox
        ref={(el: ScrollBoxRenderable) => {
          props.scroll.attach(el)
          onCleanup(() => props.scroll.detach())
        }}
        maxHeight={listMaxHeight()}
        viewportOptions={{ paddingRight: 1 }}
        verticalScrollbarOptions={{ paddingLeft: 1, trackOptions: { foregroundColor: theme.border, backgroundColor: theme.backgroundElement } }}
      >
        <For each={HELP_SHORTCUT_SECTIONS}>
          {(section, sectionIndex) => (
            <box flexDirection="column" paddingTop={sectionIndex() === 0 ? 0 : 1}>
              <text fg={theme.primary} attributes={BOLD}>{section}</text>
              <For each={shortcuts.filter((shortcut) => shortcut[2] === section)}>
                {([key, label]) => (
                  <text ref={(el: TextRenderable) => {
                    createEffect(() => {
                      el.content = new StyledText([
                        stBold(stFg(theme.text)(key.padEnd(28))),
                        stFg(theme.textMuted)(" - "),
                        stFg(theme.text)(label),
                      ])
                    })
                  }} />
                )}
              </For>
            </box>
          )}
        </For>
      </scrollbox>
      <ModalFooter rows={MODAL_CONTROL_COPY.help} align="left" />
    </ModalFrame>
  )
}
