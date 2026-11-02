import type { MouseEvent, Renderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { usePreserveScroll } from "@tui/context/scroll-preserve.js"
import { hitsArea, hitsDrawnContent } from "@tui/utils/content-hit.js"
import { hasSelectedCells } from "@tui/utils/selection.js"
import { useHoverHighlight, type HoverHandlers, type HoverHighlightHook } from "./use-hover-highlight.js"

/** The pointer handlers of a click toggle, spread onto its box. A site that
 *  handles its own controls overrides `onMouseUp` and calls this one. */
export interface ClickToggleHandlers extends HoverHandlers {
  onMouseDown: (event: MouseEvent) => void
  onMouseUp: (event: MouseEvent) => void
}

export interface ClickToggleHook extends Omit<HoverHighlightHook, "handlers"> {
  handlers: ClickToggleHandlers
  /** Ref for the box of the body that the toggle shows. Every cell of that box
   *  hovers and clicks (PI-INTERACTION-080), so a blank line, the space after a
   *  short line, padding, and a rail toggle as its text does. A toggle that
   *  binds no body, or whose body is not mounted, takes only drawn content. */
  body: (box: Renderable) => void
}

/** A point hovers and clicks when `hits` accepts it or it lies in the bound
 *  body; a miss does nothing and bubbles. A handled click stops propagation,
 *  so the innermost body under the pointer takes it and an enclosing toggle
 *  never sees it. */
function useClickToggle(clickable: () => boolean, toggle: () => void, stopWhenInert: () => boolean, hitsContent: (event: MouseEvent) => boolean): ClickToggleHook {
  const renderer = useRenderer()
  const preserveScroll = usePreserveScroll()
  let body: Renderable | undefined
  const hits = (event: MouseEvent) => hitsContent(event) || hitsArea(event, body)
  const hover = useHoverHighlight(clickable, hits)
  // A click is mouse-down + mouse-up on the same element. A mouse-up whose
  // matching mouse-down happened elsewhere (e.g. a selection drag started in
  // the gutter and released over this block) is not a click: it must never
  // toggle, and it must bubble to the shell root so the selection is copied.
  // A press or release off the block's hit area is not a click either.
  let armedTarget: MouseEvent["target"] | undefined
  const handlers: ClickToggleHandlers = {
    ...hover.handlers,
    onMouseOut: (event) => {
      // A press without prior motion can precede the old leaf's mouse-out.
      // Only leaving the leaf that received this press cancels its click.
      if (event.target === armedTarget) armedTarget = undefined
      hover.handlers.onMouseOut(event)
    },
    onMouseDown: (event) => {
      armedTarget = hits(event) ? event.target : undefined
    },
    onMouseUp: (event) => {
      const wasArmed = armedTarget !== undefined
      armedTarget = undefined
      if (!wasArmed || !hits(event)) return
      // A mouse-up that ends a text selection must bubble to the shell root,
      // which copies the selection and clears the highlight; never toggle or
      // swallow it here. An ordinary cell selection with at most one cell of
      // same-row travel is click noise, so discard it and toggle. Word and
      // line selections are intentional even when the pointer does not move.
      const selection = renderer.getSelection()
      if (selection !== null && hasSelectedCells(selection)) {
        const { anchor, focus } = selection
        const isClickJitter = selection.behavior === "cell" && focus.y === anchor.y && Math.abs(focus.x - anchor.x) <= 1
        if (!isClickJitter) return
        renderer.clearSelection()
      }
      if (!clickable()) {
        if (stopWhenInert()) event.stopPropagation()
        return
      }
      event.stopPropagation()
      preserveScroll(toggle)
    },
  }
  return { ...hover, handlers, body: (box) => { body = box } }
}

/** Whole-body expand/contract affordance: hovering the body bound through
 *  `body` (any cell of it) or the drawn content of a row without one shows the
 *  highlight, and clicking it toggles,
 *  unless the mouse-up ends a text selection (so drag-to-copy inside the body
 *  never toggles). Always stops propagation, even when not currently
 *  toggleable: the body is content, not dead space, so a click on it must
 *  never fall through to an enclosing toggleable body (e.g. collapse the
 *  agent group a tool row is nested in). */
export function useBodyToggle(clickable: () => boolean, toggle: () => void): ClickToggleHook {
  return useClickToggle(clickable, toggle, () => true, hitsDrawnContent)
}

/** Header expand/contract affordance. A header takes only its drawn content,
 *  so it binds no `body`. Toggles on mouse-up, never mouse-down:
 *  a mouse-down toggle mounts the body while the button is still held, the
 *  scroll anchor slides the content under the cursor, and the mouse-up then
 *  lands on the freshly mounted body, whose own toggle immediately undoes the
 *  expand (the bash-output flicker). An inert header lets the click fall
 *  through, so clicking a plain row inside a group body still collapses the
 *  group. */
export function useHeaderToggle(clickable: () => boolean, toggle: () => void): ClickToggleHook {
  return useClickToggle(clickable, toggle, () => false, hitsDrawnContent)
}

/** Single toggle target spanning a header and its expanded body, so the
 *  header's drawn content and every cell of the body bound through `body` hover
 *  and click as one. While the body is hidden it behaves
 *  like a header (an inert click falls through, e.g. to collapse an enclosing
 *  group); once the body is visible an inert click is swallowed, because the
 *  body is content, not dead space (see useBodyToggle). A block that draws
 *  inline controls passes `hits` that also accept each control's whole label,
 *  whose padding is blank, so the control hovers and presses as a button. */
export function useUnifiedToggle(clickable: () => boolean, toggle: () => void, bodyVisible: () => boolean, hits: (event: MouseEvent) => boolean = hitsDrawnContent): ClickToggleHook {
  return useClickToggle(clickable, toggle, bodyVisible, hits)
}
