import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, on, onCleanup, untrack, type Accessor } from "solid-js"
import { createModalScrollController } from "./modal-scroll-controller.js"

/** Attachment and explicit navigation authorize reveal. Publications and layout
 *  can finish a pending request, but otherwise preserve the reader's anchor. */
export function useListSelectionReveal(deps: {
  viewport: Accessor<ScrollBoxRenderable | undefined>
  revision: Accessor<number>
  layout: Accessor<unknown>
  fixedKeys?: Accessor<readonly string[]>
  /** The fixed key of the selected line. When a data change moves the
   *  selected line while it is in view, it keeps its screen line, so the
   *  selection never leaves the screen; else the top line keeps its place. */
  selectedKey?: Accessor<string | undefined>
  elements: (viewport: ScrollBoxRenderable) => readonly Renderable[]
  reveal: (viewport: ScrollBoxRenderable) => boolean
}): void {
  const renderer = useRenderer()
  const scroll = createModalScrollController()
  let pending = true
  let completion: (() => void) | undefined
  let anchorCompletion: (() => void) | undefined
  let previousKeys: readonly string[] = []
  const cancel = (): void => {
    if (completion) renderer.off("frame", completion)
    completion = undefined
  }
  const releaseAnchor = (): void => {
    scroll.releaseAnchor()
    if (anchorCompletion) renderer.off("frame", anchorCompletion)
    anchorCompletion = undefined
  }
  const complete = (): void => untrack(() => {
    const viewport = deps.viewport()
    if (!pending || !viewport || !deps.reveal(viewport)) return
    cancel()
    completion = () => {
      completion = undefined
      if (deps.viewport() === viewport) {
        deps.reveal(viewport)
        pending = false
      }
    }
    renderer.once("frame", completion)
  })
  createEffect(on(deps.viewport, (viewport) => {
    if (viewport) scroll.attach(viewport)
    onCleanup(scroll.detach)
  }))
  createEffect(on([deps.viewport, deps.revision], () => {
    cancel()
    releaseAnchor()
    pending = true
    complete()
  }))
  createEffect(on(deps.layout, () => {
    releaseAnchor()
    const keys = deps.fixedKeys?.()
    const oldKeys = previousKeys
    if (keys) previousKeys = keys
    if (pending) { complete(); return }
    untrack(() => {
      const viewport = deps.viewport()
      if (!viewport) return
      if (keys) {
        const top = viewport.scrollTop
        const line = Math.floor(top)
        const selected = deps.selectedKey?.()
        const selectedLine = selected === undefined ? -1 : oldKeys.indexOf(selected)
        const inView = selectedLine >= line && selectedLine < line + viewport.viewport.height && keys.includes(selected ?? "")
        const anchorLine = inView ? selectedLine : line
        const key = oldKeys[anchorLine]
        const index = key === undefined ? -1 : keys.indexOf(key)
        if (index >= 0) {
          const restore = () => viewport.scrollTo(Math.max(0, index - (anchorLine - line)) + top - line)
          restore()
          anchorCompletion = restore
          renderer.once("frame", restore)
        }
        return
      }
      const anchor = scroll.firstVisible(deps.elements(viewport))
      if (anchor) scroll.preserveAnchor(anchor)
    })
  }))
  onCleanup(cancel)
  onCleanup(releaseAnchor)
}
