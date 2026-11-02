import { BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"

export interface ScrollBoxLayoutHookHandlers {
  /** Once per frame, after the viewport resize and before the size callbacks
   *  of the rows inside the viewport. */
  readonly onFrameStart?: (deltaTime: number) => void
  /** Once per frame, after the initial viewport-subtree traversal and before
   *  paint. Changes made here can cause later size callbacks in the same frame. */
  readonly onFrame: (deltaTime: number) => void
  readonly onBarsRecalculated: () => void
}

function readUpdate<Target extends object>(target: Target): ((deltaTime: number) => void) | undefined {
  if (!("onUpdate" in target) || typeof target.onUpdate !== "function") return undefined
  const method = target.onUpdate
  return deltaTime => method.call(target, deltaTime)
}

function readRecalculateBars<Target extends object>(target: Target): (() => void) | undefined {
  if (!("recalculateBarProps" in target) || typeof target.recalculateBarProps !== "function") return undefined
  const method = target.recalculateBarProps
  return () => method.call(target)
}

/** Installs the scroll hooks of `handlers` on `scroll`: `onFrameStart` and
 *  `onFrame` once per frame, and `onBarsRecalculated` after each scrollbar
 *  recalculation. Returns the function that removes them. */
export function patchScrollBoxLayoutHooks(scroll: ScrollBoxRenderable, handlers: ScrollBoxLayoutHookHandlers): () => void {
  // OpenTUI has no public recurring layout callbacks. It runs a node's update
  // and resize hooks before those of its children: the content update runs
  // after the viewport resize. The zero-size sentinel after the viewport
  // flushes this traversal's row reports before paint, without polling rows.
  // The scrollbars cannot host it: they hide while the content fits.
  const onFrameStart = handlers.onFrameStart
  const baseUpdate = onFrameStart === undefined ? undefined : readUpdate(scroll.content)
  if (onFrameStart !== undefined) {
    Reflect.set(scroll.content, "onUpdate", (deltaTime: number) => {
      baseUpdate?.(deltaTime)
      onFrameStart(deltaTime)
    })
  }
  const frameHook = new BoxRenderable(scroll.ctx, { position: "absolute", width: 0, height: 0 })
  Reflect.set(frameHook, "onUpdate", handlers.onFrame)
  scroll.wrapper.add(frameHook)
  const baseRecalculateBars = readRecalculateBars(scroll)
  Reflect.set(scroll, "recalculateBarProps", () => {
    baseRecalculateBars?.()
    handlers.onBarsRecalculated()
  })
  return () => {
    if (onFrameStart !== undefined) Reflect.set(scroll.content, "onUpdate", baseUpdate)
    frameHook.destroyRecursively()
    Reflect.set(scroll, "recalculateBarProps", baseRecalculateBars)
  }
}
