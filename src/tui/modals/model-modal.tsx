/** @jsxImportSource @opentui/solid */

import { StyledText, bold as stBold, fg as stFg, type ScrollBoxRenderable, type TextChunk, type TextRenderable } from "@opentui/core"
import { OpaqueBox } from "@tui/components/opaque-box"
import { useTheme } from "@tui/context/theme"
import type { TuiTheme } from "@tui/context/theme/resolve"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import { BOLD } from "@tui/utils/text-attributes"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useKeyedListScroll } from "../hooks/use-keyed-list-scroll.js"
import { displayWidth } from "@tui/utils/text"
import { isSelectableItem } from "./model-modal-helpers.js"
import { contextLine, descriptionLine, modalHelpRows, modalTitle } from "./model-modal-chrome.js"
import { modelAssignmentText, modelLabelColumn, modelText, providerChainText, type ModelLabelColumn } from "./model-modal-text.js"
import type { ModelAssignmentItem, ModelModalState } from "./model-modal-types.js"
import { modalDisclosureMarker } from "../components/modal-disclosure.js"
import { scopeChromeColor } from "../hooks/use-model-modal-scope.js"
import { ModalFooter } from "../components/modal-footer.js"
import { MODAL_FRAME_WIDTHS } from "../components/modal-copy.js"
import { costBarText, modelModalContentWidth, priceHeaderText, priceValueText } from "./model-modal-cost.js"
import type { ModelOptionRow, ModelSelectionEffort } from "../../protocol/model-assignment-protocol-types.js"


interface ModelModalProps {
  state: ModelModalState
  onClose: () => void
  onSelect: (flatIndex: number) => void
}

export function ModelModal(props: ModelModalProps) {
  const { theme } = useTheme()
  const [scrollboxRef, setScrollboxRef] = createSignal<ScrollBoxRenderable>()
  const [viewportHeight, setViewportHeight] = createSignal(0)
  const { modalWidth, listMaxHeight, termHeight } = useModalDimensions(MODAL_FRAME_WIDTHS.model, 17)
  const title = createMemo(() => modalTitle(props.state))
  const context = createMemo(() => contextLine(props.state))
  const contextGap = createMemo(() => props.state.view.kind === "assignments")
  const help = createMemo(() => modalHelpRows(props.state, modalWidth()))
  const description = createMemo(() => descriptionLine(props.state))
  const chromeColor = createMemo(() => scopeChromeColor(props.state.profileOwned ? "defaults" : props.state.scope, theme))
  const view = createMemo(() => props.state.view)
  const assignments = createMemo(() => props.state.assignmentItems)
  const options = createMemo(() => props.state.modelOptions)
  const auth = createMemo(() => props.state.auth)
  const rows = createMemo(() => {
    const current = view()
    if (current.kind === "assignments") return assignmentRows(assignments())
    return modelRows(options())
  })
  const rowKeys = createMemo(() => rows().map(rowKey))
  const rowCount = createMemo(() => rows().length)
  const cursorDisplayIndex = createMemo(() => selectedDisplayIndex(rows(), props.state))
  const scrollAnchorIndex = createMemo(() => selectedScrollAnchorIndex(rows(), props.state))
  const contentWidth = createMemo(() => modelModalContentWidth(modalWidth()))
  const selectedModel = createMemo(() => props.state.view.kind === "models" ? props.state.modelOptions[props.state.cursor] : undefined)
  const inputPrices = createMemo(() => props.state.modelOptions.flatMap((option) => option.cost ? [option.cost.input] : []))
  const showCost = createMemo(() => props.state.view.kind === "models" && !(props.state.loading && props.state.modelOptions.length === 0))

  useKeyedListScroll({ scrollbox: scrollboxRef, keys: rowKeys, cursor: cursorDisplayIndex, anchor: scrollAnchorIndex, height: viewportHeight })

  return (
    <OpaqueBox flexDirection="column" maxHeight={termHeight()} borderColor={chromeColor()} border={["top", "bottom", "left", "right"]} borderStyle="rounded" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} width={modalWidth()}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={chromeColor()} attributes={BOLD}>{title()}</text>
        <box selectable={false} onMouseDown={() => props.onClose()}><text selectable={false} fg={theme.textMuted}>x</text></box>
      </box>
      <Show when={context() || props.state.loading}>
        <box paddingTop={1}>
          <text ref={(el: TextRenderable) => { createEffect(() => { el.content = sectionHeadingContent(context(), props.state.loading, theme) }) }} overflow="hidden" wrapMode="none" />
        </box>
      </Show>
      <Show when={props.state.view.kind === "models"}>
        <box height={1}>
          <text fg={props.state.query ? theme.text : theme.textMuted} overflow="hidden" wrapMode="none">Search: {props.state.query || "type to filter"}</text>
        </box>
      </Show>
      <Show when={contextGap()}>
        <box height={1} />
      </Show>

      <scrollbox
        ref={(el: ScrollBoxRenderable) => { setScrollboxRef(el) }}
        maxHeight={listMaxHeight()}
        flexShrink={1}
        viewportOptions={{ paddingRight: 1, onSizeChange() { setViewportHeight(this.height) } }}
        verticalScrollbarOptions={{ paddingLeft: 1, trackOptions: { foregroundColor: theme.border, backgroundColor: theme.backgroundElement } }}
      >
        <Show when={rowCount() === 0}>
          <box paddingTop={1} paddingBottom={1}><text fg={theme.textMuted}>{emptyText(props.state)}</text></box>
        </Show>
        <For each={rowKeys()}>
          {(_key, index) => {
            // SAFETY: For owns an index into the keys derived from these same rows.
            const row = createMemo(() => rows()[index()]!)
            const isSelected = createMemo(() => rowSelected(row(), index(), props.state))
            const pendingEffort = createMemo(() => {
              const current = row()
              return current.kind === "model" && current.option.model !== null ? props.state.pendingEfforts.get(current.option.model) : undefined
            })
            const rowWidth = createMemo(() => rowContentWidth(row(), contentWidth()))
            const rowContent = createMemo(() => rowText(row(), isSelected(), theme, rowWidth(), auth(), pendingEffort()))
            return (
              <box selectable={false} backgroundColor={isSelected() ? theme.backgroundElement : undefined} paddingLeft={rowPaddingLeft(row())} paddingRight={1} onMouseDown={() => selectRow(row(), index(), props.onSelect)}>
                <text selectable={false} ref={(el: TextRenderable) => { createEffect(() => { el.content = rowContent() }) }} overflow="hidden" wrapMode="none" />
              </box>
            )
          }}
        </For>
      </scrollbox>

      <Show when={showCost()}>
        <box height={1} />
        <box paddingLeft={2} flexDirection="column" flexShrink={0}>
          <Show when={inputPrices().length > 0}>
            <text ref={(el: TextRenderable) => { createEffect(() => { el.content = costBarText(selectedModel()?.cost?.input, inputPrices(), theme, contentWidth()) }) }} overflow="hidden" wrapMode="none" />
          </Show>
          <text ref={(el: TextRenderable) => { createEffect(() => { el.content = priceHeaderText(theme) }) }} overflow="hidden" wrapMode="none" />
          <text ref={(el: TextRenderable) => { createEffect(() => { el.content = priceValueText(selectedModel()?.cost, theme) }) }} overflow="hidden" wrapMode="none" />
        </box>
      </Show>

      <Show when={showCost()} fallback={<box paddingTop={1}><ModalFooter rows={[description()]} align="left" /></box>}>
        <box paddingTop={1} paddingLeft={2} flexShrink={0}>
          <text ref={(el: TextRenderable) => { createEffect(() => { el.content = providerChainText(selectedModel()?.providers ?? [], theme) }) }} wrapMode="word" />
        </box>
        <Show when={description()}><box paddingTop={1}><ModalFooter rows={[description()]} align="left" /></box></Show>
      </Show>
      <box paddingTop={1}><ModalFooter rows={help()} /></box>
    </OpaqueBox>
  )
}

type ModalRow =
  | { kind: "assignment"; item: ModelAssignmentItem; labelWidth: number }
  | { kind: "model-tier"; tier: ModelOptionTier }
  | { kind: "model"; index: number; option: ModelOptionRow; column: ModelLabelColumn }

type ModelOptionTier = NonNullable<ModelModalState["modelOptions"][number]["tier"]>

function rowKey(row: ModalRow, index: number): string {
  if (row.kind === "model") return `model:${row.option.model ?? "inherit"}`
  if (row.kind === "model-tier") return `tier:${row.tier}`
  const item = row.item
  if (item.kind === "assignment") return `role:${item.row.slot.roleId}`
  if (item.kind === "heading") return `heading:${item.title}`
  return `spacer:${index}`
}

function assignmentRows(items: readonly ModelAssignmentItem[]): ModalRow[] {
  const rowIndent = (item: ModelAssignmentItem): number => item.depth * 2
  const labelWidth = Math.max(
    12,
    ...items.map((item) => item.kind === "assignment" ? displayWidth(item.row.label) + rowIndent(item) : 0),
  )
  return items.map((item) => ({
    kind: "assignment",
    item,
    labelWidth: item.kind === "assignment" ? labelWidth - rowIndent(item) : labelWidth,
  }))
}

function modelRows(options: readonly ModelOptionRow[]): ModalRow[] {
  const rows: ModalRow[] = []
  // One label column for the whole list, so every effort meter starts in the
  // same column and the rows read as a table.
  const column = modelLabelColumn(options)
  let previousTier: ModelOptionTier | undefined
  for (const [index, option] of options.entries()) {
    if (option.tier && option.tier !== previousTier) {
      rows.push({ kind: "model-tier", tier: option.tier })
      previousTier = option.tier
    }
    rows.push({ kind: "model", index, option, column })
  }
  return rows
}

function selectedDisplayIndex(rows: readonly ModalRow[], state: ModelModalState): number {
  const index = rows.findIndex((row, displayIndex) => rowSelected(row, displayIndex, state))
  return index >= 0 ? index : 0
}

function selectedScrollAnchorIndex(rows: readonly ModalRow[], state: ModelModalState): number {
  const selected = selectedDisplayIndex(rows, state)
  return rows[selected - 1]?.kind === "model-tier" ? selected - 1 : selected
}

function rowSelected(row: ModalRow, displayIndex: number, state: ModelModalState): boolean {
  if (row.kind === "model-tier") return false
  if (row.kind === "model") return state.cursor === row.index
  if (row.item.kind === "spacer") return false
  return state.cursor === displayIndex
}

function rowPaddingLeft(row: ModalRow): number {
  if (row.kind === "model-tier") return 0
  if (row.kind !== "assignment") return 2
  const item = row.item
  if (item.kind === "spacer") return 0
  if (item.kind !== "assignment") return 2 + item.depth * 2
  return 2 + item.depth * 2
}

function rowContentWidth(row: ModalRow, contentWidth: number): number {
  return Math.max(24, contentWidth + 2 - rowPaddingLeft(row))
}

function selectRow(row: ModalRow, displayIndex: number, onSelect: (flatIndex: number) => void): void {
  if (row.kind === "model-tier") return
  if (row.kind === "model") {
    onSelect(row.index)
    return
  }
  if (!isSelectableItem(row.item)) return
  onSelect(displayIndex)
}

function emptyText(state: ModelModalState): string {
  if (state.view.kind === "models") return state.query ? "No matching models." : "No models available."
  return "No model assignments found."
}

function rowText(row: ModalRow, selected: boolean, theme: TuiTheme, width: number, auth: ModelModalState["auth"], pendingEffort?: ModelSelectionEffort): StyledText {
  if (row.kind === "assignment") return assignmentText(row.item, selected, theme, row.labelWidth, width, auth)
  if (row.kind === "model-tier") return tierText(row.tier, theme)
  if (row.kind === "model") {
    return modelText(row.option, selected, theme, width, row.column, pendingEffort)
  }
  return new StyledText([])
}

function tierText(tier: ModelOptionTier, theme: TuiTheme): StyledText {
  return new StyledText([
    stBold(stFg(theme.textMuted)(` ${tierLabel(tier)}`)),
  ])
}

function assignmentText(item: ModelAssignmentItem, selected: boolean, theme: TuiTheme, labelWidth: number, width: number, auth: ModelModalState["auth"]): StyledText {
  if (item.kind === "spacer") return new StyledText([stFg(theme.textSubtle)(" ")])
  if (item.kind === "heading") return new StyledText([stBold(stFg(theme.textMuted)(` ${item.title}`))])
  const markerWidth = item.disclosure === undefined ? 0 : 2
  const labelStyle = item.row.slot.roleId === "chat" ? "heading" : "plain"
  const text = modelAssignmentText(item.row, selected, theme, labelWidth, width - markerWidth, labelStyle, auth)
  if (item.disclosure === undefined) return text
  return new StyledText([
    ...text.chunks,
    stFg(selected ? theme.primary : theme.textMuted)(` ${modalDisclosureMarker(item.disclosure)}`),
  ])
}

function tierLabel(tier: ModelOptionTier): string {
  if (tier === "default") return "Default"
  if (tier === "powerful") return "Powerful"
  if (tier === "mid") return "Mid"
  return "Cheap"
}


function sectionHeadingContent(text: string, loading: boolean, theme: TuiTheme): StyledText {
  const chunks: TextChunk[] = []
  if (text) chunks.push(stBold(stFg(theme.textMuted)(text)))
  if (loading) chunks.push(stFg(theme.textSubtle)(text ? " · loading" : "loading"))
  return new StyledText(chunks)
}
