/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable } from "@opentui/core"
import type { TuiTheme } from "@tui/context/theme/resolve"
import { BOLD } from "@tui/utils/text-attributes"
import { createEffect, createMemo, createSignal, For, type JSX, Match, on, onCleanup, Show, Switch } from "solid-js"
import type { Action, ModalSelectOption, FilteredResult, FlatRow } from "./modal-select-types.js"
import { ModalFooter } from "./modal-footer.js"

interface ModalSelectProps<T> {
  result: FilteredResult<T>
  cursor: number
  theme: TuiTheme
  listMaxHeight: number
  onRowClick: (rowIndex: number) => void
  footerRows: readonly string[]
  emptyFooterRows?: readonly string[]
  onMove?: (option: ModalSelectOption<T>) => void
  current?: T
  actions?: Action<T>[]
}

export function ModalSelect<T>(props: ModalSelectProps<T>) {
  const [scrollboxRef, setScrollboxRef] = createSignal<ScrollBoxRenderable>()

  function syncCursorScroll(): void {
    const scrollbox = scrollboxRef()
    const cursor = props.cursor
    const maxH = props.listMaxHeight
    if (!scrollbox || maxH <= 0) return
    const top = scrollbox.scrollTop
    const bottom = top + maxH - 1
    if (cursor < top) scrollbox.scrollTo(cursor)
    else if (cursor > bottom) scrollbox.scrollTo(Math.max(0, cursor - maxH + 1))
  }

  createEffect(() => {
    if (props.result.rows.length === 0) return
    // scrollHeight settles only after a layout frame; retry across
    // sync/microtask/timer so the cursor lands once layout reports real heights.
    syncCursorScroll()
    queueMicrotask(syncCursorScroll)
    const timer = setTimeout(syncCursorScroll, 0)
    onCleanup(() => clearTimeout(timer))
  })

  createEffect(on(() => props.cursor, () => {
    const row = props.result.rows[props.cursor]
    if (row?.kind === "option") props.onMove?.(row.option)
  }, { defer: true }))


  return (
    <>
      <Show when={props.result.rows.length === 0}>
        <box paddingTop={1} paddingBottom={1} paddingLeft={2}>
          <text fg={props.theme.textMuted}>No results found</text>
        </box>
      </Show>
      <Show when={props.result.rows.length > 0}>
        <scrollbox
          ref={(el: ScrollBoxRenderable) => { setScrollboxRef(el) }}
          maxHeight={props.listMaxHeight}
          scrollbarOptions={{ visible: false }}
        >
          <For each={props.result.rows}>
            {(row) => <SelectRow row={row} cursor={props.cursor} current={props.current} theme={props.theme} onRowClick={props.onRowClick} />}
          </For>
        </scrollbox>
      </Show>
      <Show when={props.result.capped}>
        <box paddingLeft={2}>
          <text fg={props.theme.textMuted}>
            {`${props.result.totalMatches} results (showing first ${props.result.rows.filter(r => r.kind === "option").length})`}
          </text>
        </box>
      </Show>
      <Footer actions={props.actions} rows={props.result.rows.length === 0 && props.emptyFooterRows !== undefined ? props.emptyFooterRows : props.footerRows} />
    </>
  )
}

function CategoryRow(props: { label: string; theme: TuiTheme }): JSX.Element {
  return (
    <box paddingRight={1}>
      <text fg={props.theme.textMuted} attributes={BOLD} overflow="hidden" wrapMode="none">
        {` ${props.label}`}
      </text>
    </box>
  )
}

function OptionRow<T>(props: { option: ModalSelectOption<T>; rowIndex: number; cursor: number; current: T | undefined; theme: TuiTheme; onRowClick: (i: number) => void }): JSX.Element {
  const isSelected = createMemo(() => props.cursor === props.rowIndex)
  const isCurrent = createMemo(() => props.current !== undefined && props.current === props.option.value)
  const backgroundColor = createMemo(() => props.option.bg ?? (isSelected() ? props.theme.backgroundElement : undefined))

  return (
    <box selectable={false} backgroundColor={backgroundColor()} paddingLeft={1} paddingRight={1} onMouseDown={() => props.onRowClick(props.rowIndex)}>
      <text flexGrow={1} overflow="hidden" wrapMode="none" truncate>
        {/* Fixed-width marker slot so titles align across plain, current, and icon rows. */}
        <Show when={isCurrent()} fallback={
          <Show when={props.option.statusIcon} fallback={<span>{"  "}</span>}>
            <span style={{ fg: props.option.statusColor ?? (isSelected() ? props.theme.primary : props.theme.textMuted) }}>
              {`${props.option.statusIcon} `}
            </span>
          </Show>
        }>
          <span style={{ fg: props.theme.primary }}>{"● "}</span>
        </Show>
        <span style={{ fg: isSelected() ? props.theme.primary : props.theme.textMuted }}>
          {isSelected() ? ">" : " "}
        </span>
        <Show when={props.option.footer} fallback={<span style={{ fg: props.theme.textMuted }}>{" "}</span>}>
          <span style={{ fg: isSelected() ? props.theme.textSubtle : props.theme.textMuted }}>
            {` ${props.option.footer}  `}
          </span>
        </Show>
        <span style={{ fg: isSelected() || isCurrent() ? props.theme.text : props.theme.textSubtle, attributes: isSelected() || isCurrent() ? BOLD : undefined }}>
          {props.option.title}
        </span>
        <Show when={props.option.description}>
          <span style={{ fg: props.theme.textMuted }}>{` - ${props.option.description}`}</span>
        </Show>
        <Show when={props.option.rightDetail}>
          <span style={{ fg: props.theme.textMuted }}>{` ${props.option.rightDetail}`}</span>
        </Show>
      </text>
    </box>
  )
}

function SelectRow<T>(props: { row: FlatRow<T>; cursor: number; current: T | undefined; theme: TuiTheme; onRowClick: (i: number) => void }): JSX.Element {
  return (
    <Switch>
      <Match when={props.row.kind === "category" ? props.row : null}>
        {(cat) => <CategoryRow label={cat().categoryLabel} theme={props.theme} />}
      </Match>
      <Match when={props.row.kind === "option" ? props.row : null}>
        {(opt) => <OptionRow option={opt().option} rowIndex={opt().rowIndex} cursor={props.cursor} current={props.current} theme={props.theme} onRowClick={props.onRowClick} />}
      </Match>
    </Switch>
  )
}

function Footer<T>(props: { actions?: readonly Action<T>[]; rows: readonly string[] }): JSX.Element {
  const actionHint = createMemo(() => (props.actions?.length ?? 0) > 0 ? props.actions?.map((action) => `${action.key} ${action.label}`).join(" · ") : undefined)
  const rows = createMemo(() => actionHint() === undefined ? props.rows : [actionHint() ?? "", ...props.rows.slice(1)])
  return <box paddingTop={1}><ModalFooter rows={rows()} /></box>
}
