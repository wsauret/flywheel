/** @jsxImportSource @opentui/solid */

import { StyledText, type ScrollBoxRenderable, type TextRenderable } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import { createEffect, createMemo, Index, onCleanup, Show } from "solid-js"
import { experimentViewDomain } from "../../../protocol/modules/experiments.js"
import { modalCopyLimit } from "../../components/modal-copy.js"
import { ModalFooter } from "../../components/modal-footer.js"
import { ModalFrame } from "../../components/modal-frame.js"
import type { TuiSurfaceProps } from "../../tui-module.js"
import { renderDashboardLines } from "./dashboard-lines.js"

export function ExperimentDashboardModal(props: TuiSurfaceProps) {
  const { theme } = useTheme()
  // oxlint-disable-next-line solid/reactivity -- the surface's declared frame width is fixed for the modal's lifetime
  const { modalWidth, listMaxHeight } = useModalDimensions(props.width, 9, 30)
  const contentWidth = createMemo(() => Math.max(20, modalCopyLimit(modalWidth())))
  const view = () => props.read(experimentViewDomain)
  const lines = createMemo(() => {
    const current = view()
    return current ? renderDashboardLines(current, contentWidth(), theme, 0) : []
  })
  const title = () => {
    const name = view()?.name
    return name ? `Experiment · ${name}` : "Experiment"
  }

  return (
    <ModalFrame title={title()} width={modalWidth()} onClose={() => props.onClose()} gap={1}>
      <Show when={view()} fallback={<text fg={theme.textMuted}>This session has no experiment.</text>}>
        <scrollbox
          ref={(el: ScrollBoxRenderable) => {
            props.scroll.attach(el)
            onCleanup(() => props.scroll.detach())
          }}
          maxHeight={listMaxHeight()}
          viewportOptions={{ paddingRight: 1 }}
          verticalScrollbarOptions={{ paddingLeft: 1, trackOptions: { foregroundColor: theme.border, backgroundColor: theme.backgroundElement } }}
        >
          <box flexDirection="column" flexShrink={0}>
            <Index each={lines()}>
              {(line) => <text ref={(el: TextRenderable) => { createEffect(() => { el.content = new StyledText([...line()]) }) }} overflow="hidden" wrapMode="none" height={1} />}
            </Index>
          </box>
        </scrollbox>
      </Show>
      <ModalFooter rows={props.controls} align="left" />
    </ModalFrame>
  )
}
