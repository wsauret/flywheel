/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable } from "@opentui/core"
import type { TuiTheme } from "@tui/context/theme/resolve"
import { useTickPool } from "@tui/context/tick-pool-context"
import { BOLD } from "@tui/utils/text-attributes.js"
import { createMemo, createSignal, Show, type JSX } from "solid-js"
import { useListSelectionReveal } from "../hooks/use-list-selection-reveal.js"
import { Key } from "@solid-primitives/keyed"
import { isWorkingStatus, type StatusView } from "../../protocol/status-protocol-types.js"
import { SessionPickerRow } from "./session-picker-row.js"
import type { PickerRow } from "./picker-types.js"
import { ModalFooter } from "../components/modal-footer.js"
import { SESSION_CONTROL_COPY } from "../components/modal-copy.js"
import { ControlledTextField } from "../components/controlled-text-field.js"
import type { TextEditorPresentation } from "../keymap/text-entry.js"
import { SHORT_TITLE_MAX_CHARS } from "../../protocol/app-service-types.js"

interface SessionPickerResult {
  rows: readonly PickerRow[]
  totalMatches: number
  capped: boolean
  effectiveHighlightQuery: string
  timeAgoWidth: number
}

interface SessionPickerAction {
  key: string
  label: string
}

interface SessionPickerListProps {
  result: SessionPickerResult
  cursor: number
  navigationRevision: number
  actions: readonly SessionPickerAction[]
  theme: TuiTheme
  /** Total pane height; the scroll viewport subtracts the search/footer chrome. */
  height: number
  rowWidth: number
  foregroundId?: string
  statusView: (sessionId: string) => StatusView | undefined
  now: number
  confirmDeleteSessionId?: string
  filterQuery: string
  inputPresentation: TextEditorPresentation
  inputPlaceholder: string
  renaming: boolean
  renameField?: "title" | "shortTitle"
  renamePresentation: (field: "title" | "shortTitle") => TextEditorPresentation
  onRowClick: (rowIndex: number) => void
}

/** Rows around the scrollbox: search input + padding (2) and footer + padding (2). */
const LIST_CHROME_ROWS = 4

export function SessionPickerList(props: SessionPickerListProps): JSX.Element {
  const [scrollboxRef, setScrollboxRef] = createSignal<ScrollBoxRenderable>()

  // The working-session blink dot shares the app-wide tick pool instead of a
  // modal-lifetime interval; the tick only runs while a working row is visible.
  const anyWorking = createMemo(() =>
    props.result.rows.some((row) => row.kind === "session" && isWorkingStatus(props.statusView(row.session.id))))
  // eslint-disable-next-line solid/reactivity -- createSharedTick stores and reads the accessor inside its returned reactive tick
  const blinkTick = useTickPool().createSharedTick(700, anyWorking)
  const blinkOn = () => blinkTick() % 2 === 0

  const viewportHeight = createMemo(() =>
    Math.max(1, props.height - LIST_CHROME_ROWS - (props.renaming ? 3 : 0) - (props.result.capped ? 1 : 0)))

  function syncCursorScroll(scrollbox: ScrollBoxRenderable): boolean {
    const cursor = props.cursor
    const maxH = viewportHeight()
    if (props.result.rows.length === 0 || maxH <= 0) return false
    const top = scrollbox.scrollTop
    const bottom = top + maxH - 1
    let reveal = cursor
    while (reveal > 0 && props.result.rows[reveal - 1]?.kind === "header") reveal--
    if (reveal < top) scrollbox.scrollTo(reveal)
    else if (cursor > bottom) scrollbox.scrollTo(Math.max(0, cursor - maxH + 1))
    return true
  }

  useListSelectionReveal({
    viewport: scrollboxRef,
    revision: () => props.navigationRevision,
    layout: () => [props.result.rows, viewportHeight()],
    fixedKeys: () => props.result.rows.map(pickerIdentity),
    elements: () => [],
    reveal: syncCursorScroll,
  })



  const footerHint = createMemo(() => {
    if (props.renaming) return SESSION_CONTROL_COPY[0]
    const selected = props.result.rows[props.cursor]
    if (selected?.kind === "corrupt") return SESSION_CONTROL_COPY[1]
    return props.result.rows.length === 0 ? SESSION_CONTROL_COPY[2] : SESSION_CONTROL_COPY[3]
  })

  return (
    <>
      <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column">
        <Show when={props.renaming}>
          <box flexDirection="column">
            <text fg={props.theme.textMuted}>{`Tab title (${SHORT_TITLE_MAX_CHARS} characters)`}</text>
            <ControlledTextField
              presentation={props.renamePresentation("shortTitle")}
              focused={props.renameField === "shortTitle"}
              selectionForeground={props.theme.selectionForeground}
              selectionBackground={props.theme.selectionBackground}
              placeholder="Tab title"
              width={Math.max(1, props.rowWidth - 4)}
              textColor={props.theme.text}
              placeholderColor={props.theme.textMuted}
            />
            <text fg={props.theme.textMuted}>Description</text>
          </box>
        </Show>
        <ControlledTextField
          presentation={props.renaming ? props.renamePresentation("title") : props.inputPresentation}
          focused={!props.renaming || props.renameField === "title"}
          selectionForeground={props.theme.selectionForeground}
          selectionBackground={props.theme.selectionBackground}
          placeholder={props.renaming ? "Description" : props.inputPlaceholder}
          width={Math.max(1, props.rowWidth - 4)}
          textColor={props.theme.text}
          placeholderColor={props.theme.textMuted}
        />
      </box>
      <Show when={props.result.rows.length === 0}>
        <box paddingTop={1} paddingBottom={1} paddingLeft={2}>
          <text fg={props.theme.textMuted}>No results found</text>
        </box>
      </Show>
      <Show when={props.result.rows.length > 0}>
        <scrollbox
          ref={(el: ScrollBoxRenderable) => { setScrollboxRef(el) }}
          maxHeight={viewportHeight()}
          scrollbarOptions={{ visible: false }}
        >
          <Key each={props.result.rows} by={pickerIdentity}>
            {(row, index) => (
              <PickerListRow
                row={row()}
                rowIndex={index()}
                cursor={props.cursor}
                theme={props.theme}
                rowWidth={props.rowWidth}
                foregroundId={props.foregroundId}
                statusView={props.statusView}
                now={props.now}
                blinkOn={blinkOn()}
                timeAgoWidth={props.result.timeAgoWidth}
                confirmDeleteSessionId={props.confirmDeleteSessionId}
                onRowClick={props.onRowClick}
              />
            )}
          </Key>
        </scrollbox>
      </Show>
      <Show when={props.result.capped}>
        <box paddingLeft={2}>
          <text fg={props.theme.textMuted}>
            {`${props.result.totalMatches} results (showing first ${selectableRowCount(props.result.rows)})`}
          </text>
        </box>
      </Show>
      <box paddingTop={1}><ModalFooter rows={[props.actions.length > 0 ? props.actions.map((action) => `${action.key} ${action.label}`).join(" · ") : footerHint()]} /></box>
    </>
  )
}

function PickerListRow(props: {
  row: PickerRow
  rowIndex: number
  cursor: number
  theme: TuiTheme
  rowWidth: number
  foregroundId?: string
  statusView: (sessionId: string) => StatusView | undefined
  now: number
  blinkOn: boolean
  timeAgoWidth: number
  confirmDeleteSessionId?: string
  onRowClick: (rowIndex: number) => void
}): JSX.Element {
  const renderableRow = () => (props.row.kind === "header" ? undefined : props.row)
  const headerLabel = () => (props.row.kind === "header" ? props.row.label : "")

  return (
    <Show when={renderableRow()} fallback={<HeaderRow label={headerLabel()} theme={props.theme} />}>
      {(row) => {
        const working = () => {
          const current = row()
          return current.kind === "session" ? isWorkingStatus(props.statusView(current.session.id)) : false
        }
        return (
          <SessionPickerRow
            row={row()}
            rowIndex={props.rowIndex}
            theme={props.theme}
            rowWidth={props.rowWidth}
            selected={props.cursor === props.rowIndex}
            foregroundId={props.foregroundId}
            isWorking={working()}
            blinkOn={props.blinkOn}
            now={props.now}
            timeAgoWidth={props.timeAgoWidth}
            confirmDeleteSessionId={props.confirmDeleteSessionId}
            onRowClick={props.onRowClick}
          />
        )
      }}
    </Show>
  )
}

function HeaderRow(props: { label: string; theme: TuiTheme }): JSX.Element {
  return (
    <box paddingRight={1}>
      <text fg={props.theme.textMuted} attributes={BOLD} overflow="hidden" wrapMode="none">
        {` ${props.label}`}
      </text>
    </box>
  )
}


function selectableRowCount(rows: readonly PickerRow[]): number {
  return rows.filter((row) => row.kind !== "header").length
}

function pickerIdentity(row: PickerRow): string {
  return row.kind === "session" ? row.session.id : row.kind === "corrupt" ? row.sessionId : row.id
}
