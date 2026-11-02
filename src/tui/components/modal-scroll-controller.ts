import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { createSignal, type Accessor } from "solid-js"
import { patchScrollBoxLayoutHooks } from "./scrollbox-layout-hooks.js"

export interface ModalScrollController {
  readonly hasAbove: Accessor<boolean>
  readonly hasBelow: Accessor<boolean>
  readonly hasOverflow: Accessor<boolean>
  attach: (renderable: ScrollBoxRenderable) => void
  detach: () => void
  scrollBy: (rows: number) => void
  pageBy: (direction: -1 | 1) => void
  scrollTo: (row: number) => void
  /** Reveal one descendant of the scrollbox whose row offset is not known,
   *  because the rows above it have variable height. With `preferTop`, the
   *  content's first row also stays in view whenever the descendant fits
   *  below it, so a heading above a focused row is not scrolled away. The
   *  reveal applies again when the viewport changes size, until a scroll
   *  through this controller replaces it. */
  scrollIntoView: (element: Renderable, options?: { readonly preferTop?: boolean; readonly row?: number }) => void
  /** Whether a screen row lies inside the scrollbox viewport. */
  showsScreenRow: (screenY: number) => boolean
  /** Keep one mounted descendant at its current screen row across the next layout. */
  preserveAnchor: (element: Renderable) => void
  /** An explicit destination replaces any pending reader-position correction. */
  releaseAnchor: () => void
  /** Find the first supplied descendant whose header intersects the viewport. */
  firstVisible: (elements: readonly Renderable[]) => Renderable | undefined
  reset: () => void
}

type ScrollTarget =
  | { readonly kind: "row"; readonly row: number }
  | { readonly kind: "element"; readonly element: Renderable; readonly preferTop: boolean; readonly row: number | undefined; pending: boolean }

/** The scroll that brings one span into a viewport along one axis, with
 *  positions relative to the viewport's start. This is OpenTUI's
 *  scrollChildIntoView rule, except that a span exactly as long as the
 *  viewport also moves. OpenTUI leaves such a span where it is, so a one-row
 *  choice in a one-row viewport stays hidden. */
function nearestDelta(start: number, end: number, viewportSize: number): number {
  const size = end - start
  const startOutside = start < 0
  const endOutside = end > viewportSize
  if (startOutside && endOutside) return 0
  if ((startOutside && size <= viewportSize) || (endOutside && size > viewportSize)) return start
  if ((startOutside && size > viewportSize) || (endOutside && size <= viewportSize)) return end - viewportSize
  return 0
}

/** Owns a modal scrollbox across lazy mounting, layout, and viewport changes. */
export function createModalScrollController(): ModalScrollController {
  const [hasAbove, setHasAbove] = createSignal(false)
  const [hasBelow, setHasBelow] = createSignal(false)
  const [hasOverflow, setHasOverflow] = createSignal(false)
  let renderable: ScrollBoxRenderable | undefined
  let resetPending = true
  let target: ScrollTarget | undefined
  let restoreHooks: (() => void) | undefined
  let anchor: { readonly element: Renderable; screenY: number; frames: number } | undefined
  let appliedViewport = { width: 0, height: 0 }

  const sync = (): void => {
    if (!renderable) {
      setHasAbove(false)
      setHasBelow(false)
      setHasOverflow(false)
      return
    }
    const maxTop = Math.max(0, renderable.scrollHeight - renderable.viewport.height)
    setHasOverflow(maxTop > 0)
    setHasAbove(renderable.scrollTop > 0)
    setHasBelow(renderable.scrollTop < maxTop)
  }
  // Element targets survive their first paint to realign after viewport
  // resizing. Row destinations apply once against the first painted layout,
  // so a jump to the end does not become follow-on scrolling.
  const applyTarget = (scroll: ScrollBoxRenderable): void => {
    appliedViewport = { width: scroll.viewport.width, height: scroll.viewport.height }
    if (target?.kind === "row") scroll.scrollTo(target.row)
    else if (target?.kind === "element") {
      const element = target.element
      // Native local layouts are current before paint, but descendant screen
      // coordinates are not published until that descendant's own layout hook.
      let top = -scroll.scrollTop
      let left = -scroll.scrollLeft
      let descendant: Renderable | null = element
      while (descendant !== scroll.content) {
        if (!descendant) return
        const layout = descendant.getLayout()
        top += layout.top + descendant.translateY
        left += layout.left + descendant.translateX
        descendant = descendant.parent
      }
      // A row target reveals one row of the element, such as an editor's caret line.
      top += target.row ?? 0
      const bottom = top + (target.row === undefined ? element.getLayout().height : 1)
      if (target.preferTop && bottom + scroll.scrollTop <= scroll.viewport.height) {
        scroll.scrollTo({ x: scroll.scrollLeft, y: 0 })
        return
      }
      const x = nearestDelta(left, left + element.getLayout().width, scroll.viewport.width)
      const y = nearestDelta(top, bottom, scroll.viewport.height)
      if (x !== 0 || y !== 0) scroll.scrollBy({ x, y })
    }
  }
  const afterLayout = (scroll: ScrollBoxRenderable): void => {
    const update = (): void => {
      if (renderable !== scroll || scroll.isDestroyed) return
      applyTarget(scroll)
      sync()
    }
    queueMicrotask(update)
    setTimeout(update, 0)
  }
  const seek = (next: ScrollTarget): void => {
    anchor = undefined
    target = next
    if (!renderable) return
    applyTarget(renderable)
    sync()
    afterLayout(renderable)
  }

  return {
    hasAbove,
    hasBelow,
    hasOverflow,
    attach: (scroll) => {
      restoreHooks?.()
      renderable = scroll
      const restoreAnchor = (): void => {
        if (renderable !== scroll || !anchor) return
        const delta = anchor.element.screenY - anchor.screenY
        if (delta !== 0) {
          scroll.scrollBy(delta)
          anchor.screenY = anchor.element.screenY
        }
        sync()
      }
      restoreHooks = patchScrollBoxLayoutHooks(scroll, {
        onFrame: () => {
          scroll.verticalScrollBar.scrollSize = scroll.content.getLayout().height
          if (target && (target.kind === "row" || target.pending || scroll.viewport.width !== appliedViewport.width || scroll.viewport.height !== appliedViewport.height)) {
            applyTarget(scroll)
            if (target.kind === "row") target = undefined
            else target.pending = false
            sync()
          }
          restoreAnchor()
          if (anchor && --anchor.frames <= 0) anchor = undefined
        },
        onBarsRecalculated: restoreAnchor,
      })
      if (resetPending) {
        scroll.scrollTo(0)
        resetPending = false
      }
      applyTarget(scroll)
      sync()
      afterLayout(scroll)
    },
    detach: () => {
      restoreHooks?.()
      restoreHooks = undefined
      anchor = undefined
      renderable = undefined
      sync()
    },
    scrollBy: (rows) => {
      target = undefined
      anchor = undefined
      if (!renderable) return
      renderable.scrollBy(rows)
      sync()
      afterLayout(renderable)
    },
    pageBy: (direction) => {
      target = undefined
      anchor = undefined
      if (!renderable) return
      renderable.scrollBy(direction * renderable.viewport.height)
      sync()
      afterLayout(renderable)
    },
    scrollTo: (row) => seek({ kind: "row", row }),
    scrollIntoView: (element, options) => seek({ kind: "element", element, preferTop: options?.preferTop ?? false, row: options?.row, pending: true }),
    showsScreenRow: (screenY) => renderable !== undefined && screenY >= renderable.viewport.screenY && screenY < renderable.viewport.screenY + renderable.viewport.height,
    preserveAnchor: (element) => {
      target = undefined
      const scroll = renderable
      if (!scroll) return
      anchor = { element, screenY: element.screenY, frames: 2 }
      const restore = (): void => {
        if (renderable !== scroll || scroll.isDestroyed || anchor?.element !== element) return
        const delta = element.screenY - anchor.screenY
        if (delta !== 0) {
          scroll.scrollBy(delta)
          anchor.screenY = element.screenY
        }
        sync()
      }
      queueMicrotask(restore)
    },
    releaseAnchor: () => { anchor = undefined },
    firstVisible: (elements) => {
      if (!renderable) return
      const top = renderable.viewport.screenY
      const bottom = top + renderable.viewport.height
      return elements.find(element => element.screenY < bottom && element.screenY + element.height > top)
    },
    reset: () => {
      target = undefined
      anchor = undefined
      resetPending = true
      if (renderable) {
        renderable.scrollTo(0)
        resetPending = false
      }
      sync()
    },
  }
}
