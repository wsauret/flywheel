/** @jsxImportSource @opentui/solid */

import { StyledText, bold as stBold, fg as stFg, type ScrollBoxRenderable, type TextChunk, type TextRenderable } from "@opentui/core"
import { modalDisclosureHelp, modalDisclosureMarker } from "../components/modal-disclosure.js"
import { useTheme } from "@tui/context/theme"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import { ModalFrame } from "@tui/components/modal-frame"
import { truncateToWidth, useWrappedLineCount } from "@tui/utils/text"
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { ModalSelect } from "../components/modal-select.js"
import type { FilteredResult } from "../components/modal-select-types.js"
import { refusalReason, type SettingsView, type SettingsVisibleRow } from "../hooks/settings-modal-types.js"
import stringWidth from "string-width"

import { ModalFooter } from "../components/modal-footer.js"
import { MODAL_CONTROL_COPY, MODAL_FRAME_WIDTHS } from "../components/modal-copy.js"
import { ControlledTextField } from "../components/controlled-text-field.js"
import { useKeyedListScroll } from "../hooks/use-keyed-list-scroll.js"
import { WORKFLOWS_MODE_LABELS } from "../../protocol/client/capabilities.js"
import { createModalScrollController } from "../components/modal-scroll-controller.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"
interface SettingsModalProps {
  cursor: number
  view: SettingsView
  onClose: () => void
  onEditBlur?: () => void
  onActivate: (index: number) => void
  onToggle: (rowIndex: number) => void
  onSelect: (rowIndex: number) => void
}


export function SettingsModal(props: SettingsModalProps) {
  const wrappedLineCount = useWrappedLineCount()
  const { theme } = useTheme()
  const { modalWidth, listMaxHeight } = useModalDimensions(MODAL_FRAME_WIDTHS.settings)
  const rowContentWidth = createMemo(() => Math.max(0, modalWidth() - 9))
  const visibleItems = createMemo<readonly SettingsVisibleRow[]>(() => props.view.kind === "list" ? props.view.rows : [])
  const valueColumn = createMemo(() => {
    const widestLabel = Math.max(0, ...visibleItems().map((row) => row.kind === "separator" ? 0 : stringWidth(row.label) + (row.warning === undefined ? 0 : 4)))
    return Math.min(widestLabel + 4, Math.max(4, rowContentWidth() - 7))
  })
  const title = createMemo(() => props.view.label === undefined ? KERNEL_COMMAND_NAMES.settings : `${KERNEL_COMMAND_NAMES.settings} › ${props.view.label}`)
  const footerDescription = createMemo(() => {
    const row = visibleItems()[props.cursor]
    if (row === undefined || row.kind === "separator") return ""
    return refusalReason(row) ?? (row.warning === undefined ? undefined : `[!] ${row.warning}`) ?? row.description ?? ""
  })
  // The description wraps, so the list gives up each line past the first
  // and the whole modal still fits the terminal.
  const listHeight = createMemo(() => Math.max(1, listMaxHeight() - (wrappedLineCount(footerDescription() || " ", Math.max(1, modalWidth() - 8)) - 1)))
  const footerControls = createMemo(() => {
    if (props.view.kind !== "list") return MODAL_CONTROL_COPY.settings.list
    if (props.view.label !== undefined) return MODAL_CONTROL_COPY.settings.group
    const row = visibleItems()[props.cursor]
    return row?.disclosure === undefined ? MODAL_CONTROL_COPY.settings.list : `${modalDisclosureHelp(row.disclosure)} · ↑↓ navigate · esc close`
  })
  const [scrollboxRef, setScrollboxRef] = createSignal<ScrollBoxRenderable>()
  const listScroll = createModalScrollController()
  onCleanup(listScroll.detach)
  /** The cursor row's rendered line, and the reveal line an upward scroll
   *  targets: the start of the separator block directly above the cursor, so a
   *  section header scrolls into view together with its first row. Rows are
   *  one line each, except a separator after the first row, whose top padding
   *  adds a second line. */
  const cursorLines = createMemo(() => {
    let reveal = props.cursor
    while (reveal > 0 && visibleItems()[reveal - 1]?.kind === "separator") reveal--
    let line = 0
    let revealLine = 0
    for (let index = 0; index < props.cursor; index++) {
      if (index === reveal) revealLine = line
      line += visibleItems()[index]?.kind === "separator" && index > 0 ? 2 : 1
    }
    if (reveal === props.cursor) revealLine = line
    return { line, revealLine }
  })

  function syncCursorScroll(): void {
    const scrollbox = scrollboxRef()
    const maxH = listHeight()
    if (!scrollbox || maxH <= 0) return
    const { line, revealLine } = cursorLines()
    const top = scrollbox.scrollTop
    const bottom = top + maxH - 1
    const destination = revealLine < top ? revealLine : line > bottom ? Math.max(0, line - maxH + 1) : top
    listScroll.scrollTo(destination)
  }

  createEffect(() => {
    if (props.view.kind !== "list") return
    // The controller retains the destination until native layout can apply it.
    syncCursorScroll()
  })

  return (
    <ModalFrame title={title()} width={modalWidth()} onClose={() => props.onClose()} onMouseDown={props.onEditBlur}>
      <box height={1} />
      <Switch>
        <Match when={props.view.kind === "list" ? props.view : null}>
          {(view) => (
            <>
              <box paddingLeft={2} paddingBottom={1}>
                <ControlledTextField presentation={view().presentation} focused selectionForeground={theme.selectionForeground} selectionBackground={theme.selectionBackground} placeholder="type to filter" width={Math.max(1, modalWidth() - 8)} textColor={theme.text} placeholderColor={theme.textMuted} />
              </box>
              <scrollbox ref={(el: ScrollBoxRenderable) => { listScroll.attach(el); setScrollboxRef(el) }} maxHeight={listHeight()} scrollbarOptions={{ visible: false }}>
                <For each={visibleItems()}>
                  {(row, index) => <SettingsModalRow row={row} index={index()} cursor={props.cursor} valueColumn={valueColumn()} onActivate={props.onActivate} />}
                </For>
              </scrollbox>
              <box paddingTop={1} flexDirection="column" alignItems="center">
                {/* A reason can be longer than one line, so it wraps whole instead of losing its end. */}
                <text fg={theme.textMuted} wrapMode="word">{footerDescription() || " "}</text>
                <ModalFooter rows={[footerControls()]} />
              </box>
            </>
          )}
        </Match>
        <Match when={props.view.kind === "edit" ? props.view : null}>
          {(view) => <SettingsEditor view={view()} width={Math.max(1, modalWidth() - 10)} />}
        </Match>
        <Match when={props.view.kind === "multiselect" ? props.view : null}>
          {(view) => (
            <>
              <box paddingLeft={2} paddingBottom={1}>
                <ControlledTextField presentation={view().presentation} focused selectionForeground={theme.selectionForeground} selectionBackground={theme.selectionBackground} placeholder="type to filter" width={Math.max(1, modalWidth() - 8)} textColor={theme.text} placeholderColor={theme.textMuted} />
              </box>
              <ModalSelect
                result={markSelected(view().result, view().selectedIds)}
                cursor={view().cursor}
                theme={theme}
                listMaxHeight={listMaxHeight()}
                onRowClick={props.onToggle}
                footerRows={[MODAL_CONTROL_COPY.settings.multiselect, ""]}
              />
            </>
          )}
        </Match>
        <Match when={props.view.kind === "single-select" ? props.view : null}>
          {(view) => (
            <>
              <Show when={view().filterable}>
                <box paddingLeft={2} paddingBottom={1}>
                  <ControlledTextField presentation={view().presentation} focused selectionForeground={theme.selectionForeground} selectionBackground={theme.selectionBackground} placeholder="type to filter" width={Math.max(1, modalWidth() - 8)} textColor={theme.text} placeholderColor={theme.textMuted} />
                </box>
              </Show>
              <ModalSelect
                result={view().result}
                cursor={view().cursor}
                current={view().currentId}
                theme={theme}
                listMaxHeight={listMaxHeight()}
                onRowClick={props.onSelect}
                footerRows={[MODAL_CONTROL_COPY.settings.singleSelect, view().hotkeyHint ?? ""]}
              />
            </>
          )}
        </Match>
        <Match when={props.view.kind === "confirmation" ? props.view : null}>
          {(view) => <SettingsConfirmation view={view()} maxHeight={listMaxHeight()} />}
        </Match>
      </Switch>
    </ModalFrame>
  )
}

/** The checkbox marker is presentation over the row's own selected ids, so the
 *  controller never holds a copy of what is selected. */
function markSelected(result: FilteredResult<string>, selectedIds: readonly string[]): FilteredResult<string> {
  const selected = new Set(selectedIds)
  return {
    ...result,
    rows: result.rows.map((row) => row.kind === "option"
      ? { ...row, option: { ...row.option, statusIcon: selected.has(row.option.id) ? "[x]" : "[ ]" } }
      : row),
  }
}

function SettingsModalRow(props: { row: SettingsVisibleRow; index: number; cursor: number; valueColumn: number; onActivate: (index: number) => void }) {
  const { theme } = useTheme()
  const active = createMemo(() => props.cursor === props.index && props.row.kind !== "separator")
  const content = createMemo(() => new StyledText(rowChunks(props.row, active(), theme, Math.max(4, props.valueColumn - props.row.depth * 2))))

  return (
    <Switch>
      <Match when={props.row.kind === "separator" ? props.row : null}>
        {(row) => (
          <box paddingLeft={2 + props.row.depth * 2} paddingRight={1} paddingTop={props.index > 0 ? 1 : 0}>
            <text fg={theme.textMuted}>{row().label ?? "────────────────"}</text>
          </box>
        )}
      </Match>
      <Match when={props.row.kind !== "separator"}>
        <box selectable={false} backgroundColor={active() ? theme.backgroundElement : undefined} paddingLeft={2 + props.row.depth * 2} paddingRight={1} onMouseDown={() => props.onActivate(props.index)}>
          <text ref={(el: TextRenderable) => { createEffect(() => { el.content = content() }) }} overflow="hidden" wrapMode="none" />
        </box>
      </Match>
    </Switch>
  )
}

function rowChunks(row: SettingsVisibleRow, active: boolean, theme: ReturnType<typeof useTheme>["theme"], valueColumn: number): TextChunk[] {
  if (row.kind === "separator") return []

  const marker = stFg(active ? theme.primary : theme.textMuted)(active ? ">" : " ")
  const warning = row.warning === undefined ? "" : "[!] "
  const label = truncateToWidth(row.label, Math.max(0, valueColumn - 4 - stringWidth(warning)))
  const gap = " ".repeat(Math.max(2, valueColumn - 2 - stringWidth(warning) - stringWidth(label)))
  const value = rowValue(row)
  const displayValue = row.kind === "cycle" && row.onStep !== undefined && refusalReason(row) === undefined ? `‹ ${value} ›` : value

  return [
    marker,
    stFg(theme.text)(" "),
    ...(warning === "" ? [] : [stFg(theme.warning)(warning)]),
    settingsLabelChunk(label, active, theme),
    stFg(theme.text)(gap),
    stFg(valueColor(value, active, theme))(displayValue),
  ]
}

function rowValue(row: Exclude<SettingsVisibleRow, { kind: "separator" }>): string {
  if (row.unavailableReason?.()) return "N/A"
  if (row.kind === "disclosure") return modalDisclosureMarker(row.disclosure)
  return row.kind === "navigation" || row.kind === "confirmation" || row.kind === "group" ? "→" : row.value()
}

/** YES, On, Ask first, NO, Off, None, N/A, and the CLI-forced policy label
 *  are the status vocabulary every row shares, so they keep one colour
 *  wherever the cursor is; any other value follows the cursor. Ask first and
 *  a CLI-forced policy are effective capabilities, so they read as enabled;
 *  None is a disabled numeric limit, so it reads as off. */
function valueColor(value: string, active: boolean, theme: ReturnType<typeof useTheme>["theme"]) {
  if (value === "YES" || value === WORKFLOWS_MODE_LABELS.ask || value === "On" || value === "On - active" || value === "On - not configured" || value === "On for this run via CLI") return theme.primary
  if (value === "NO" || value === "Off" || value === "None" || value === "N/A") return theme.textMuted
  return active ? theme.primary : theme.textMuted
}

function settingsLabelChunk(label: string, active: boolean, theme: ReturnType<typeof useTheme>["theme"]): TextChunk {
  return active ? stBold(stFg(theme.text)(label)) : stFg(theme.textSubtle)(label)
}

function SettingsEditor(props: { view: Extract<SettingsView, { kind: "edit" }>; width: number }) {
  const { theme } = useTheme()

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.textMuted} overflow="hidden" wrapMode="none" truncate>{props.view.hint}</text>
      <box border={["top", "bottom", "left", "right"]} borderStyle="rounded" borderColor={theme.primary} paddingLeft={1} paddingRight={1} onMouseDown={(event) => event.stopPropagation()}>
        <ControlledTextField presentation={props.view.presentation} focused selectionForeground={theme.selectionForeground} selectionBackground={theme.selectionBackground} placeholder={props.view.current} width={props.width} textColor={theme.text} placeholderColor={theme.textMuted} />
      </box>
      <text fg={theme.error} wrapMode="word">{props.view.error ?? " "}</text>
      <ModalFooter rows={[props.view.saving ? "Saving..." : props.view.action ? MODAL_CONTROL_COPY.settings.action : MODAL_CONTROL_COPY.settings.edit]} align="left" />
    </box>
  )
}

function SettingsConfirmation(props: { view: Extract<SettingsView, { kind: "confirmation" }>; maxHeight: number }) {
  const { theme } = useTheme()
  const selection = () => "phase" in props.view ? props.view : undefined
  const candidates = () => selection()?.candidates ?? []
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()
  const cursor = () => candidates().findIndex((candidate) => candidate.id === selection()?.selectedId)
  const height = () => Math.min(candidates().length, Math.max(1, props.maxHeight - 8))
  const disabled = () => selection()?.phase === "loading" || (candidates().length > 0 && selection()?.selectedId === undefined)
  useKeyedListScroll({ scrollbox: scroll, keys: () => candidates().map((candidate) => candidate.id), cursor, anchor: cursor, height })
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text} wrapMode="word">{props.view.message}</text>
      <Show when={candidates().length > 0}>
        <text fg={theme.textMuted}>Move sessions to (required, Up/Down to choose)</text>
        <scrollbox ref={setScroll} height={height()} scrollbarOptions={{ visible: false }}>
          <For each={candidates()}>{(candidate) => <text fg={candidate.id === selection()?.selectedId ? theme.primary : theme.text} wrapMode="none" overflow="hidden">{candidate.id === selection()?.selectedId ? "> " : "  "}{candidate.displayName}</text>}</For>
        </scrollbox>
      </Show>
      <Show when={selection()?.error}><text fg={theme.error} wrapMode="word">{selection()?.error}</text></Show>
      <Show when={!selection()?.pending} fallback={<text fg={theme.textMuted}>Deleting...</text>}>
        <box flexDirection="row" gap={2}>
          <text fg={props.view.choice === "cancel" ? theme.primary : theme.text}>{props.view.choice === "cancel" ? "> " : "  "}Cancel</text>
          <text fg={disabled() ? theme.textMuted : props.view.choice === "confirm" ? theme.primary : theme.text}>{props.view.choice === "confirm" ? "> " : "  "}{props.view.actionLabel}{disabled() ? " (disabled)" : ""}</text>
        </box>
        <ModalFooter rows={[MODAL_CONTROL_COPY.settings.confirmation]} align="left" />
      </Show>
    </box>
  )
}