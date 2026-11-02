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
  createEffect(() => {
    const keys = deps.keys()
    const cursor = deps.cursor()
    const anchor = deps.anchor()
    const height = deps.height()
    const scrollbox = deps.scrollbox()
    const selection = keys[cursor]
    const top = scrollbox?.scrollTop ?? 0
    const topKey = previousKeys[Math.floor(top)]
    const nextTop = topKey === undefined ? -1 : keys.indexOf(topKey)
    const rowsChanged = keys.length !== previousKeys.length || keys.some((key, index) => key !== previousKeys[index])
    const retainedTop = (rowsChanged || selection === previousSelection) && nextTop >= 0 ? nextTop + top - Math.floor(top) : undefined
    previousKeys = keys
    previousSelection = selection
    if (!scrollbox || height <= 0 || keys.length === 0) return
    const sync = () => {
      if (retainedTop !== undefined) scrollbox.scrollTo(retainedTop)
      const firstVisible = retainedTop === undefined ? anchor : cursor
      if (firstVisible < scrollbox.scrollTop) scrollbox.scrollTo(firstVisible)
      else if (cursor > scrollbox.scrollTop + height - 1) scrollbox.scrollTo(Math.max(0, cursor - height + 1))
    }
    sync()
    queueMicrotask(sync)
    // OpenTUI clamps scroll offsets until the next layout has measured inserted rows.
    const timer = setTimeout(sync, 0)
    onCleanup(() => clearTimeout(timer))
  })
}
