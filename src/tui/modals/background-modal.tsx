/** @jsxImportSource @opentui/solid */

import { useTheme } from "@tui/context/theme"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { useListSelectionReveal } from "../hooks/use-list-selection-reveal.js"
import { canStopBackgroundRow, type BackgroundIndexEntry, type BackgroundIndexFilter } from "../../protocol/client/background-index.js"
import type { FilteredResult } from "../components/modal-select-types.js"
import { Button } from "../components/button.js"
import { ModalFrame } from "../components/modal-frame.js"
import { MODAL_CONTROL_COPY, MODAL_FRAME_WIDTHS } from "../components/modal-copy.js"
import { ModalFooter } from "../components/modal-footer.js"
import { useHoverHighlight } from "../hooks/use-hover-highlight.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"

interface BackgroundModalProps {
  result: FilteredResult<BackgroundIndexEntry>
  cursor: number
  navigationRevision: number
  filter: BackgroundIndexFilter
  /** What the list says when it shows no row. */
  empty: string
  tail: (rowId: string) => readonly string[] | undefined
  onClose: () => void
  onRowClick: (rowIndex: number) => void
  onStopClick: (rowIndex: number) => void
  onFilter: (filter: BackgroundIndexFilter) => void
}

function ProcessStopControl(props: { onPress: () => void }) {
  const { theme } = useTheme()
  const hover = useHoverHighlight()
  return (
    <box
      width={3}
      height={1}
      flexShrink={0}
      justifyContent="center"
      selectable={false}
      backgroundColor={hover.hovered() ? theme.backgroundElement : undefined}
      {...hover.handlers}
      onMouseDown={(event) => {
        event.stopPropagation()
        props.onPress()
      }}
    >
      <text selectable={false} fg={hover.hovered() ? theme.error : theme.textMuted}>x</text>
    </box>
  )
}

/** The Active or All choice: the shown one reads as the primary control. */
function FilterToggle(props: { filter: BackgroundIndexFilter; onFilter: (filter: BackgroundIndexFilter) => void }) {
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <Button label="Active" muted={props.filter !== "active"} onPress={() => props.onFilter("active")} />
      <Button label="All" hotkey="a" muted={props.filter !== "all"} onPress={() => props.onFilter("all")} />
    </box>
  )
}

export function BackgroundModal(props: BackgroundModalProps) {
  const { theme } = useTheme()
  const { modalWidth, listMaxHeight } = useModalDimensions(MODAL_FRAME_WIDTHS.background)
  const [viewport, setViewport] = createSignal<ScrollBoxRenderable>()
  useListSelectionReveal({
    viewport,
    revision: () => props.navigationRevision,
    layout: () => [props.result, props.result.rows.map((row) => row.kind === "option" ? props.tail(row.option.id) : undefined), modalWidth(), listMaxHeight()],
    elements: (scroll) => props.result.rows.flatMap((row) => { const element = scroll.content.findDescendantById(row.id); return element ? [element] : [] }),
    reveal: (scroll) => {
      const row = props.result.rows[props.cursor]
      if (row?.kind !== "option") return false
      scroll.scrollChildIntoView(`${row.option.id}:header`)
      return true
    },
  })

  return (
    <ModalFrame title={KERNEL_COMMAND_NAMES.bg} width={modalWidth()} onClose={() => props.onClose()}>
      <box height={1} />
      <FilterToggle filter={props.filter} onFilter={props.onFilter} />
      <box height={1} />
      <Show
        when={props.result.rows.length > 0}
        fallback={
          <box flexDirection="column">
            <box paddingLeft={2}>
              <text fg={theme.textMuted}>{props.empty}</text>
            </box>
            <box paddingTop={1}>
              <ModalFooter rows={[MODAL_CONTROL_COPY.background[1]]} />
            </box>
          </box>
        }
      >
        <scrollbox
          ref={setViewport}
          maxHeight={listMaxHeight()}
          scrollbarOptions={{ visible: false }}
        >
          <box flexDirection="column" flexShrink={0}>
            <Key each={props.result.rows.filter((row) => row.kind === "option")} by="id">
              {(row) => {
                const entry = () => row().option.value
                const tail = createMemo(() => props.tail(row().option.id))
                const expandable = () => entry().row.kind === "command" && entry().row.status === "running"
                return (
                  <box
                    id={row().option.id}
                    flexDirection="column"
                    flexShrink={0}
                    paddingBottom={1}
                  >
                    <box
                      id={`${row().option.id}:header`}
                      flexDirection="row"
                      flexShrink={0}
                      paddingLeft={1 + 2 * entry().depth}
                      paddingRight={1}
                      backgroundColor={props.cursor === row().rowIndex ? theme.backgroundElement : undefined}
                      onMouseDown={() => props.onRowClick(row().rowIndex)}
                    >
                      {/* Text is selectable by default, and OpenTUI starts a selection on press
                          before this row's handler runs; the click then closes the modal and
                          scrolls the transcript under that live selection. */}
                      <text selectable={false} width={2} flexShrink={0} fg={theme.textMuted}>{expandable() ? tail() === undefined ? "▸" : "▾" : " "}</text>
                      <box flexDirection="column" flexGrow={1} flexShrink={1}>
                        <text selectable={false} fg={entry().dimmed ? theme.textMuted : theme.text} wrapMode="word">{row().option.title}</text>
                        {/* The status line is muted in every row; the title alone carries the
                            dimming. No text slot is dimmer than `textMuted` in every theme:
                            `textSubtle` defaults to the midpoint of `text` and `textMuted`. */}
                        <Show when={row().option.rightDetail}>
                          <text selectable={false} fg={theme.textMuted} wrapMode="word">{row().option.rightDetail}</text>
                        </Show>
                      </box>
                      <Show when={canStopBackgroundRow(entry().row)}>
                        <ProcessStopControl onPress={() => props.onStopClick(row().rowIndex)} />
                      </Show>
                    </box>
                    <Show when={tail()}>
                      <box flexDirection="column" flexShrink={0} paddingLeft={3 + 2 * entry().depth} paddingRight={1} paddingTop={1}>
                        <text fg={theme.textSubtle}>Recent output</text>
                        <For each={tail()} fallback={<text fg={theme.textMuted}>No output yet</text>}>
                          {(line) => <text fg={theme.textMuted} wrapMode="word">{line || " "}</text>}
                        </For>
                      </box>
                    </Show>
                  </box>
                )
              }}
            </Key>
          </box>
        </scrollbox>
        <box paddingTop={1}>
          <ModalFooter rows={[MODAL_CONTROL_COPY.background[0]]} />
        </box>
      </Show>
    </ModalFrame>
  )
}
