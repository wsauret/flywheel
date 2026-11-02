/** @jsxImportSource @opentui/solid */

import type { MouseEvent } from "@opentui/core"
import type { Accessor } from "solid-js"
import { For, createEffect, createMemo, createSignal, on, untrack } from "solid-js"
import { BOLD } from "../utils/text-attributes.js"
import { CellColumn, type CellColumnState, type Gutter } from "./cell-column.js"
import type { TuiTheme } from "../context/theme/resolve.js"
import type { TabInfo } from "../hooks/create-tabs.js"

interface TabsBarProps {
  tabs: Accessor<readonly TabInfo[]>
  availableWidth: Accessor<number>
  theme: TuiTheme
  onActivate: (id: string) => void
  onNewTab: () => void
  onReorder?: (id: string, beforeId: string | null) => void
}

const TAB_GAP = 1
const TAB_FRAME = 2
// Reserved label-width slack so the centered title has >=2 cols of left padding,
// enough for the gutter glyph plus a 1-char gap when present.
const GUTTER_SLOT = 4
// Every tab renders at this fixed width regardless of tab count or available
// space. Available width only decides how many tabs are visible; overflow
// side-scrolls via the arrow controls, it never resizes cells. This keeps tab
// width invariant to the foreground session's stats column (which fluctuates
// as you switch tabs and as elapsed/cost tick), the source of width jitter.
const TAB_WIDTH = 20
const ARROW_WIDTH = 1
const ARROW_LEFT = "‹"
const ARROW_RIGHT = "›"
const NEW_TAB_WIDTH = 3
// Width reserved for the "+ new tab" affordance at the end of the row: a gap
// before it plus the glyph itself. Subtracted from `availableWidth` before
// layoutTabs so overflow packing accounts for it.
const NEW_TAB_RESERVED = TAB_GAP + NEW_TAB_WIDTH
// Col-0 gutter glyph for a tab cell: an animated spinner or a blocked marker.
const BLOCKED_GLYPH = "?"
const DRAG_GLYPH = "↔"
const INSERT_GLYPH = "│"
const DRAG_THRESHOLD = 2

interface TabLayout {
  tab: TabInfo
  title: string
}

type Cell = CellColumnState & { key: string }

function truncate(label: string, max: number): string {
  if (label.length <= max) return label
  return label.slice(0, max)
}

interface Layout {
  items: TabLayout[]
  hasOverflow: boolean
  visibleCount: number
}
interface DragState {
  readonly sessionId: string
  readonly startX: number
  readonly startIndex: number
  readonly minIndex: number
  readonly maxIndex: number
  readonly active: boolean
  readonly beforeId: string | null
}

function layoutTabs(tabs: readonly TabInfo[], available: number): Layout {
  if (tabs.length === 0) return { items: [], hasOverflow: false, visibleCount: 0 }
  const labelMax = Math.max(1, TAB_WIDTH - TAB_FRAME - GUTTER_SLOT)
  const items = tabs.map((tab) => ({ tab, title: truncate(tab.title, labelMax) }))
  if (tabs.length * TAB_WIDTH + (tabs.length - 1) * TAB_GAP <= available) {
    return { items, hasOverflow: false, visibleCount: tabs.length }
  }
  // Overflow: reserve the ‹ › controls (each with a flanking gap), then pack as
  // many fixed-width cells as fit into what remains. visibleCount only shifts
  // when `available` crosses a whole cell+gap boundary, so a 1–2 col stats tick
  // adds or removes a tab at the edge rather than resizing the visible ones.
  const reservedForArrows = 2 * ARROW_WIDTH + 2 * TAB_GAP
  const forCells = Math.max(0, available - reservedForArrows)
  const visibleCount = Math.max(1, Math.floor((forCells + TAB_GAP) / (TAB_WIDTH + TAB_GAP)))
  return { items, hasOverflow: true, visibleCount }
}

interface AppendTabCellsInput {
  item: TabLayout
  index: number
  items: readonly TabLayout[]
  state: DragState | null
  theme: TuiTheme
  onActivate: (id: string) => void
  startTabDrag: (id: string, event: MouseEvent) => void
}

function appendTabCells(result: Cell[], input: AppendTabCellsInput): void {
  if (input.index > 0) result.push(tabGapCell(input))
  result.push(tabCell(input))
}

function tabGapCell(input: AppendTabCellsInput): Cell {
  const marker = input.state?.active === true && input.item.tab.id === input.state.sessionId
  return {
    key: `gap-${input.index}`,
    width: TAB_GAP,
    text: marker ? INSERT_GLYPH : "",
    textFg: marker ? input.theme.primary : input.theme.textSubtle,
    textCentered: false,
    barColor: marker ? input.theme.primary : input.theme.border,
    leftBreak: !marker && input.items[input.index - 1]?.tab.isForeground === true,
    rightBreak: !marker && input.item.tab.isForeground,
  }
}

function tabCell(input: AppendTabCellsInput): Cell {
  const tab = input.item.tab
  const isFg = tab.isForeground
  const blocked = tab.isBlocked
  const dragging = input.state?.active === true && input.state.sessionId === tab.id
  return {
    key: `tab-${tab.id}`,
    width: TAB_WIDTH,
    text: input.item.title,
    ...tabTextStyle(input.theme, isFg, blocked, dragging),
    textCentered: true,
    paddingLeft: 1,
    paddingRight: 1,
    barColor: dragging ? input.theme.primary : isFg ? input.theme.primary : input.theme.border,
    leftBreak: false,
    rightBreak: false,
    gutter: tabGutter(tab, dragging, blocked),
    onClick: () => input.onActivate(tab.id),
    onMouseDown: (event) => input.startTabDrag(tab.id, event),
  }
}

function tabTextStyle(theme: TuiTheme, isFg: boolean, blocked: boolean, dragging: boolean): Pick<Cell, "textFg" | "textFgHover"> {
  return {
    textFg: dragging ? theme.primary : blocked ? theme.warning : (isFg ? theme.text : theme.textMuted),
    textFgHover: !isFg && !blocked ? theme.text : undefined,
  }
}

function tabGutter(tab: TabInfo, dragging: boolean, blocked: boolean): Gutter | undefined {
  if (dragging) return { kind: "glyph", char: DRAG_GLYPH }
  if (blocked) return { kind: "glyph", char: BLOCKED_GLYPH }
  return tab.isBusy ? { kind: "spinner" } : undefined
}

export function TabsBar(props: TabsBarProps) {
  const [dragState, setDragState] = createSignal<DragState | null>(null)
  const previewTabs = createMemo(() => {
    const state = dragState()
    const tabs = props.tabs()
    if (!state?.active) return tabs
    const dragged = tabs.find((tab) => tab.id === state.sessionId)
    if (!dragged) return tabs
    const without = tabs.filter((tab) => tab.id !== state.sessionId)
    const targetIndex = state.beforeId === null ? without.length : without.findIndex((tab) => tab.id === state.beforeId)
    if (targetIndex === -1) return tabs
    return [...without.slice(0, targetIndex), dragged, ...without.slice(targetIndex)]
  })
  const layout = createMemo(() => {
    const reserved = NEW_TAB_RESERVED
    return layoutTabs(previewTabs(), Math.max(0, props.availableWidth() - reserved))
  })
  // Hover and renderable identity follow semantic cells so width changes cannot
  // reuse a tab's interaction binding for an arrow or other chrome.
  const [scrollAnchor, setScrollAnchor] = createSignal(0)
  const [hoveredKey, setHoveredKey] = createSignal<string | null>(null)
  const visibleCount = createMemo(() => layout().visibleCount)
  const startIndex = createMemo(() => {
    const max = Math.max(0, previewTabs().length - visibleCount())
    return Math.max(0, Math.min(scrollAnchor(), max))
  })

  // The foreground tab must stay in the visible window. Its slot and the window
  // size are the only triggers, so a manual arrow or wheel scroll can still move
  // the window away from it until the foreground, the order, or the width changes.
  const foregroundIndex = createMemo(() => previewTabs().findIndex((t) => t.isForeground))
  createEffect(on([foregroundIndex, visibleCount], ([fgIdx, count]) => {
    if (fgIdx === -1) return
    untrack(() => {
      const start = startIndex()
      if (fgIdx < start) setScrollAnchor(fgIdx)
      else if (fgIdx >= start + count) setScrollAnchor(fgIdx - count + 1)
    })
  }))

  const visibleItems = createMemo(() => layout().items.slice(startIndex(), startIndex() + visibleCount()))
  const canScrollLeft = createMemo(() => startIndex() > 0)
  const canScrollRight = createMemo(() => startIndex() + visibleCount() < previewTabs().length)
  const scrollLeft = () => { if (canScrollLeft()) setScrollAnchor(startIndex() - 1) }
  const scrollRight = () => { if (canScrollRight()) setScrollAnchor(startIndex() + 1) }

  createEffect(() => {
    const state = dragState()
    if (state && !props.tabs().some((tab) => tab.id === state.sessionId)) setDragState(null)
  })

  const beforeIdForDrag = (state: DragState, currentX: number): string | null => {
    const tabs = props.tabs()
    const without = tabs.filter((tab) => tab.id !== state.sessionId)
    const rawTarget = Math.round((state.startIndex * (TAB_WIDTH + TAB_GAP) + currentX - state.startX) / (TAB_WIDTH + TAB_GAP))
    const targetIndex = Math.max(state.minIndex, Math.min(state.maxIndex, rawTarget))
    return without[targetIndex]?.id ?? null
  }

  const startTabDrag = (sessionId: string, event: MouseEvent): void => {
    const tabs = props.tabs()
    const index = tabs.findIndex((tab) => tab.id === sessionId)
    if (!props.onReorder || index === -1 || tabs.length < 2) return
    const visibleStart = startIndex()
    const visibleEnd = Math.min(tabs.length - 1, visibleStart + visibleItems().length - 1)
    setDragState({ sessionId, startX: event.x, startIndex: index, minIndex: visibleStart, maxIndex: visibleEnd, active: false, beforeId: null })
    event.stopPropagation()
  }

  const updateTabDrag = (event: MouseEvent): void => {
    const state = dragState()
    if (!state) return
    const active = state.active || Math.abs(event.x - state.startX) >= DRAG_THRESHOLD
    setDragState({ ...state, active, beforeId: active ? beforeIdForDrag(state, event.x) : state.beforeId })
    event.stopPropagation()
  }

  const finishTabDrag = (event: MouseEvent): void => {
    const state = dragState()
    if (!state) return
    const finalState = state.active ? { ...state, beforeId: beforeIdForDrag(state, event.x) } : state
    setDragState(null)
    event.stopPropagation()
    if (!finalState.active) return
    const tabs = props.tabs()
    const currentIndex = tabs.findIndex((tab) => tab.id === finalState.sessionId)
    const without = tabs.filter((tab) => tab.id !== finalState.sessionId)
    const targetIndex = finalState.beforeId === null ? without.length : without.findIndex((tab) => tab.id === finalState.beforeId)
    if (currentIndex === -1 || targetIndex === -1 || currentIndex === targetIndex) return
    props.onReorder?.(finalState.sessionId, finalState.beforeId)
  }

  const handleTabBarMouse = (event: MouseEvent): void => {
    if (event.type === "scroll" && layout().hasOverflow) {
      const direction = event.scroll?.direction
      if (direction === "left") scrollLeft()
      else if (direction === "right") scrollRight()
      else return
      event.stopPropagation()
    } else if (event.type === "drag" || event.type === "move" || event.type === "over") updateTabDrag(event)
    else if (event.type === "drag-end" || event.type === "up") finishTabDrag(event)
  }

  /** Non-tab chrome (gaps, arrows, "+", trailing filler) shares one base shape;
   *  each cell states only what distinguishes it. */
  const chromeCell = (key: string, width: number, overrides: Partial<Cell> = {}): Cell => ({
    key,
    width,
    text: "",
    textFg: props.theme.textSubtle,
    textCentered: false,
    barColor: props.theme.border,
    leftBreak: false,
    rightBreak: false,
    ...overrides,
  })

  // Replacing a cell leaves a no-hit interval between frames and loses drag
  // capture. Stable semantic keys preserve controls while their positions change.
  const cells = createMemo<Cell[]>(() => {
    const items = visibleItems()
    const hasOverflow = layout().hasOverflow
    const state = dragState()
    const result: Cell[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item) appendTabCells(result, { item, index: i, items, state, theme: props.theme, onActivate: props.onActivate, startTabDrag })
    }
    if (hasOverflow) {
      result.push(
        chromeCell("gap-pre-left-arrow", TAB_GAP, { leftBreak: items[items.length - 1]?.tab.isForeground === true }),
        chromeCell("arrow-left", ARROW_WIDTH, {
          text: ARROW_LEFT,
          textFg: canScrollLeft() ? props.theme.text : props.theme.textMuted,
          onClick: scrollLeft,
        }),
        chromeCell("gap-between-arrows", TAB_GAP),
        chromeCell("arrow-right", ARROW_WIDTH, {
          text: ARROW_RIGHT,
          textFg: canScrollRight() ? props.theme.text : props.theme.textMuted,
          onClick: scrollRight,
        }),
      )
    }
    // "+" new-tab affordance. Sits after the arrows in overflow mode, after the
    // last tab otherwise. The leading gap carries the right-side break when
    // the last visible tab is the foreground (non-overflow case); in overflow
    // mode that break already lives in gap-pre-left-arrow.
    const lastIsActive = items.length > 0 && items[items.length - 1]?.tab.isForeground === true
    result.push(
      chromeCell("gap-pre-new-tab", TAB_GAP, { leftBreak: lastIsActive && !hasOverflow }),
      chromeCell("new-tab", NEW_TAB_WIDTH, {
        text: "+",
        textFg: props.theme.text,
        textFgHover: props.theme.primary,
        textAttributes: BOLD,
        textCentered: true,
        onClick: () => props.onNewTab(),
      }),
    )
    // The assembled row must never exceed availableWidth: the container clips
    // overflow from the right and the rightmost functional cell is the "+"
    // new-tab affordance.
    const aw = props.availableWidth()
    const used = result.reduce((acc, c) => acc + c.width, 0)
    const trailingWidth = Math.max(0, aw - used)
    if (trailingWidth > 0) result.push(chromeCell("trailing", trailingWidth))
    return result
  })
  const cellsByKey = createMemo(() => new Map(cells().map((cell) => [cell.key, cell])))
  const cellKeys = createMemo(() => cells().map((cell) => cell.key))
  const cellForKey = (key: string): Cell => {
    const cell = cellsByKey().get(key)
    if (!cell) throw new Error(`Missing tab bar cell: ${key}`)
    return cell
  }
  return (
    <box flexDirection="row" overflow="hidden" flexShrink={1} onMouse={handleTabBarMouse}>
      <For each={cellKeys()}>
        {(key) => (
          <CellColumn
            cell={() => cellForKey(key)}
            hovered={() => hoveredKey() === key}
            onHover={(hovered) => setHoveredKey((current) => hovered ? key : (current === key ? null : current))}
          />
        )}
      </For>
    </box>
  )
}
