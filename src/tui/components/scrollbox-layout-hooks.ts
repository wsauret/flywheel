import { BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"

export interface ScrollBoxLayoutHookHandlers {
  /** Once per frame, after the frame's first layout and before the rows of
   *  that layout report their sizes. Rows it mounts lay out in a later round
   *  of the same frame. */
  readonly onFrameStart?: (deltaTime: number) => void
  /** Once per frame, after the rows of the first layout reported their sizes
   *  and before paint. Changes made here can cause later size callbacks in
   *  the same frame. */
  readonly onFrame: (deltaTime: number) => void
  /** After each size change of the viewport or the content, also in the
   *  later layout rounds of a frame. */
  readonly onResize?: () => void
}

/** Sets an own property over a method of `scroll`; the returned function puts
 *  back what was there, so patches stacked on one box unwind in turn. */
function override(scroll: ScrollBoxRenderable, key: "onUpdate" | "add", value: unknown): () => void {
  const prior = Object.getOwnPropertyDescriptor(scroll, key)
  Reflect.set(scroll, key, value)
  return () => { if (prior) Object.defineProperty(scroll, key, prior); else Reflect.deleteProperty(scroll, key) }
}

function readUpdate<Target extends object>(target: Target): ((deltaTime: number) => void) | undefined {
  if (!("onUpdate" in target) || typeof target.onUpdate !== "function") return undefined
  const method = target.onUpdate
  return deltaTime => method.call(target, deltaTime)
}

/** Installs the scroll hooks of `handlers` on `scroll`: `onFrameStart` and
 *  `onFrame` once per frame, and `onResize` after each viewport or content
 *  size change. Returns the function that removes them. */
export function patchScrollBoxLayoutHooks(scroll: ScrollBoxRenderable, handlers: ScrollBoxLayoutHookHandlers): () => void {
  // OpenTUI has no public recurring layout callback; afterLayout runs once and
  // requests the next frame. A frame lays out first, then runs the update
  // hooks and size callbacks, mostly in tree order: the box's own update, its
  // viewport and content size callbacks, the size callbacks of its rows, and
  // then the update of a later child. The frame hook, held as the box's last
  // child, flushes the row reports of this traversal before paint, without
  // polling rows. A row's size callback can still come after it, and OpenTUI
  // requests no frame for a size change, so a row that needs the next onFrame
  // requests that frame itself. The box skips the updates of children outside
  // its viewport, so the hook spans the content's height; with zero width it
  // takes no pointer events and no row ever scrolls sideways out from under it.
  const onFrameStart = handlers.onFrameStart
  const baseUpdate = readUpdate(scroll)
  const restoreUpdate = onFrameStart === undefined ? undefined : override(scroll, "onUpdate", (deltaTime: number) => {
    baseUpdate?.(deltaTime)
    onFrameStart(deltaTime)
  })
  if (restoreUpdate) scroll.refreshHooks()
  const frameHook = new BoxRenderable(scroll.ctx, { position: "absolute", top: 0, bottom: 0, width: 0 })
  Reflect.set(frameHook, "onUpdate", handlers.onFrame)
  frameHook.refreshHooks()
  // Solid appends a new child with an index-free add; it goes at the frame
  // hook's index, before the hook, so that the hook stays after every row.
  const baseAdd = scroll.add
  const restoreAdd = override(scroll, "add", (child: unknown, index?: number) =>
    baseAdd.call(scroll, child, index ?? (frameHook.parent === scroll ? scroll.getChildrenCount() - 1 : undefined)))
  scroll.add(frameHook)
  const onResize = handlers.onResize
  if (onResize) {
    scroll.viewport.on("resize", onResize)
    scroll.content.on("resize", onResize)
  }
  return () => {
    if (onResize) {
      scroll.viewport.off("resize", onResize)
      scroll.content.off("resize", onResize)
    }
    restoreAdd()
    frameHook.destroyRecursively()
    if (restoreUpdate) {
      restoreUpdate()
      scroll.refreshHooks()
    }
  }
}
