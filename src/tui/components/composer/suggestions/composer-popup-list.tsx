/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, MouseEvent, TextChunk, TextRenderable } from "@opentui/core"
import { StyledText, bg as stBg, fg as stFg } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { createEffect, createMemo, For } from "solid-js"

/** Visible row budget shared by every prompt popup and by the frame's
 *  popupHeight sizing. */
export const PROMPT_POPUP_MAX_VISIBLE_ROWS = 5
/** Columns of invisible mouse hit area for the scrollbar (the bar's own
 *  column plus the blank gap columns before it). */
const BAR_HIT_WIDTH = 3

interface ComposerPopupListProps {
  /** Total item count in the backing list. */
  count: () => number
  selectedIndex: () => number
  /** Moves the selection by one step, wrapping per the owning hook. */
  moveSelection: (delta: -1 | 1) => void
  /** Sets the selection to an absolute index; out-of-range is ignored. */
  select: (index: number) => void
  /** Content width available for rows (inside the frame's borders and padding). */
  width: () => number
  onActivate: (index: number) => void
  /** Consumer-owned row content for one absolute item index. */
  rowChunks: (index: number, isSelected: boolean, rowWidth: number) => TextChunk[]
}

/** Wheel input over the popup moves the selection like the arrow keys: one
 *  step per delta unit, so a coalesced high-delta event moves as far as the
 *  input it represents. */
function handleWheel(moveSelection: (delta: -1 | 1) => void, event: MouseEvent): void {
  const direction = event.scroll?.direction
  if (direction !== "up" && direction !== "down") return
  const steps = Math.max(1, event.scroll?.delta ?? 1)
  for (let i = 0; i < steps; i++) moveSelection(direction === "down" ? 1 : -1)
  event.stopPropagation()
}

/** Shared prompt-popup list mechanics rendered inside the prompt frame's
 *  popup section: the five-row window centered on the selection, row width
 *  reservation for the scrollbar, the half-cell scroll cursor, wheel-driven
 *  selection, and press/drag scrollbar behavior. Consumers own row content
 *  (via rowChunks) and activation semantics; the frame gates rendering
 *  (popupHeight) and supplies the borders and the divider. */
export function ComposerPopupList(props: ComposerPopupListProps) {
  const { theme } = useTheme()

  const view = createMemo(() => {
    const count = props.count()
    const selected = props.selectedIndex()
    const max = PROMPT_POPUP_MAX_VISIBLE_ROWS
    const start = Math.max(0, Math.min(selected - Math.floor(max / 2), count - max))
    // Virtualized scroll cursor on a half-cell grid: a single half-block
    // glyph positioned on 2 sub-cells per row, so its position through the
    // list resolves to 10 stops over the 5 visible rows.
    const scrollable = count - max
    const thumbHalf = scrollable > 0 ? Math.round((start / scrollable) * (max * 2 - 1)) : 0
    return {
      indices: Array.from({ length: Math.min(count, max) }, (_, i) => start + i),
      selected,
      hasBar: count > max,
      thumbHalf,
    }
  })

  /** The scrollbar column's full content: one line per visible row, blank gap
   *  columns then the track cell, where the cursor is a single half-block
   *  (top or bottom half of its cell) in the transcript scrollbar's thumb
   *  color over its track color. The bar owns these cells outright; rows do
   *  not extend under them, so a click here can never activate a row. */
  const barContent = createMemo(() => {
    const { indices, thumbHalf } = view()
    const gap = " ".repeat(BAR_HIT_WIDTH - 1)
    const chunks: TextChunk[] = []
    for (let row = 0; row < indices.length; row++) {
      const glyph = Math.floor(thumbHalf / 2) === row ? (thumbHalf % 2 === 0 ? "▀" : "▄") : " "
      chunks.push(stFg(theme.border)(`${row > 0 ? "\n" : ""}${gap}`), stBg(theme.backgroundElement)(stFg(theme.border)(glyph)))
    }
    return new StyledText(chunks)
  })

  let barEl: BoxRenderable | undefined

  /** Maps a pointer row on the bar to the proportional position in the list:
   *  top row selects the first item, bottom row the last, and the window
   *  scrolls to follow the selection. */
  const dragTo = (eventY: number): void => {
    const total = props.count()
    const max = PROMPT_POPUP_MAX_VISIBLE_ROWS
    if (!barEl || total <= max) return
    const localRow = Math.max(0, Math.min(max - 1, eventY - barEl.y))
    props.select(Math.round((localRow / (max - 1)) * (total - 1)))
  }

  /** OpenTUI captures drag motion on the pressed bar, including outside it. */
  const onBarMouse = (event: MouseEvent): void => {
    if (event.type !== "down" && event.type !== "drag") return
    event.stopPropagation()
    dragTo(event.y)
  }

  return (
    <box
      position="relative"
      flexDirection="column"
      width={props.width()}
      selectable={false}
      onMouse={(event) => { if (event.type === "scroll") handleWheel(props.moveSelection, event) }}
    >
      <For each={view().indices}>
        {(index) => {
          const rowWidth = () => Math.max(0, props.width() - (view().hasBar ? BAR_HIT_WIDTH : 0))
          const content = createMemo(() => new StyledText(
            props.rowChunks(index, index === view().selected, rowWidth()),
          ))
          return (
            <box width={rowWidth()} onMouseDown={() => props.onActivate(index)}>
              <text
                ref={(el: TextRenderable) => {
                  createEffect(() => { el.content = content() })
                }}
                selectable={false}
                overflow="hidden"
                wrapMode="none"
              />
            </box>
          )
        }}
      </For>
      <box
        visible={view().hasBar}
        ref={(el: BoxRenderable) => { barEl = el }}
        position="absolute"
        top={0}
        right={0}
        width={BAR_HIT_WIDTH}
        height={view().indices.length}
        selectable={false}
        onMouse={onBarMouse}
      >
        <text
          ref={(el: TextRenderable) => {
            createEffect(() => { el.content = barContent() })
          }}
          selectable={false}
          overflow="hidden"
          wrapMode="none"
        />
      </box>
    </box>
  )
}
