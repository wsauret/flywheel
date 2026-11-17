import { ScrollBoxRenderable, type Renderable } from "@opentui/core"

/** Screen rows from `top` up to but not including `bottom`. */
interface ScreenRows {
  readonly top: number
  readonly bottom: number
}

/** The screen rows that every scrollbox around `element` shows, from `top` up to but not including `bottom`, on a
 *  screen of `screenHeight` rows. A scrollbox clips the glyphs of its content but not what a descendant places on the
 *  screen itself, such as the terminal cursor, so such a descendant checks its rows against this window first. */
export function visibleScreenRows(element: Renderable, screenHeight: number): ScreenRows {
  let top = 0
  let bottom = screenHeight
  for (let parent = element.parent; parent; parent = parent.parent) {
    if (parent instanceof ScrollBoxRenderable) {
      top = Math.max(top, parent.viewport.screenY)
      bottom = Math.min(bottom, parent.viewport.screenY + parent.viewport.height)
    }
  }
  return { top, bottom }
}
