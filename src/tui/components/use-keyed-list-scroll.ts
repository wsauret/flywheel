import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, onCleanup, type Accessor } from "solid-js"

/** Keeps the top row and its offset on publication; cursor navigation still scrolls into view. */
export function useKeyedListScroll(deps: {
  scrollbox: Accessor<ScrollBoxRenderable | undefined>
  keys: Accessor<readonly string[]>
  cursor: Accessor<number>
  anchor: Accessor<number>
  height: Accessor<number>
}): void {
  let previousKeys: readonly string[] = []
  let previousSelection: string | undefined
  // The offset requested for the next layout and not applied yet. It is an
  // offset into previousKeys, so a second change before that layout keeps
  // the same top row.
  let plannedTop: number | undefined
  createEffect(() => {
    const keys = deps.keys()
    const cursor = deps.cursor()
    const anchor = deps.anchor()
    const height = deps.height()
    const scrollbox = deps.scrollbox()
    const selection = keys[cursor]
    const top = plannedTop ?? scrollbox?.scrollTop ?? 0
    const topKey = previousKeys[Math.floor(top)]
    const nextTop = topKey === undefined ? -1 : keys.indexOf(topKey)
    const rowsChanged = keys.length !== previousKeys.length || keys.some((key, index) => key !== previousKeys[index])
    const retainedTop = (rowsChanged || selection === previousSelection) && nextTop >= 0 ? nextTop + top - Math.floor(top) : undefined
    previousKeys = keys
    previousSelection = selection
    if (!scrollbox || height <= 0 || keys.length === 0) {
      plannedTop = undefined
      return
    }
    let target = retainedTop ?? top
    const firstVisible = retainedTop === undefined ? anchor : cursor
    if (firstVisible < target) target = firstVisible
    else if (cursor > target + height - 1) target = Math.max(0, cursor - height + 1)
    plannedTop = target
    // Scroll only after the frame lays out the new rows, before it paints.
    // OpenTUI keeps a box that scrolls to a position at or past its laid-out
    // content height pinned to the end, so a scroll made before the rows
    // that replace a shorter list exist leaves the box at the bottom.
    let current = true
    onCleanup(() => { current = false })
    scrollbox.afterLayout(() => {
      if (!current) return
      plannedTop = undefined
      scrollbox.scrollTo(target)
    })
  })
}
