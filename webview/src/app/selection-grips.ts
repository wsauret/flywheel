// The types below name only the DOM members the binding reads, so a stand-in document type-checks and drift fails the build.
interface GripNode {
  readonly nodeType: number
  readonly parentElement: { closest(selectors: string): object | null } | null
}
interface GripRange {
  readonly startContainer: GripNode
  readonly endContainer: GripNode
  readonly startOffset: number
  readonly endOffset: number
  cloneRange(): GripRange
  collapse(start: boolean): void
  getBoundingClientRect(): Pick<DOMRect, "x" | "y" | "bottom" | "height">
}
interface GripSelection {
  readonly isCollapsed: boolean
  readonly rangeCount: number
  getRangeAt(index: number): GripRange
  setBaseAndExtent(anchor: GripNode, anchorOffset: number, focus: GripNode, focusOffset: number): void
}
/** A pad is created by the document and appended back into the layer and body, so one type parameter carries it both ways. */
interface GripPad<Pad> extends Pick<HTMLElement, "className" | "hidden" | "setAttribute" | "remove" | "setPointerCapture" | "hasPointerCapture" | "releasePointerCapture" | "addEventListener" | "removeEventListener"> {
  readonly dataset: DOMStringMap
  readonly style: Pick<CSSStyleDeclaration, "left" | "top" | "pointerEvents" | "clipPath">
  append(...nodes: NoInfer<Pad>[]): void
  getBoundingClientRect(): Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">
}
interface GripDocument<Pad> extends Pick<Document, "addEventListener" | "removeEventListener"> {
  readonly defaultView: (Pick<Window, "addEventListener" | "removeEventListener"> & {
    matchMedia(query: string): Pick<MediaQueryList, "matches">
    readonly visualViewport: Pick<VisualViewport, "addEventListener" | "removeEventListener"> | null
  }) | null
  readonly body: { append(...nodes: NoInfer<Pad>[]): void }
  createElement(tagName: string): Pad
  getSelection(): GripSelection | null
  elementFromPoint(x: number, y: number): object | null
}
interface GripScroller<Pad> extends Pick<HTMLElement, "addEventListener" | "removeEventListener"> {
  readonly ownerDocument: GripDocument<Pad>
  readonly classList: { toggle(token: string, force: boolean): void; remove(token: string): void }
  contains(other: unknown): boolean
  getBoundingClientRect(): Pick<DOMRect, "top" | "right" | "bottom" | "left">
}
type CaretDocument<Pad> = GripDocument<Pad> & {
  caretRangeFromPoint(x: number, y: number): Pick<GripRange, "startContainer" | "startOffset"> | null
}

/** Extends native selection handles on coarse-pointer clients.
 * The caller owns CSS: fixed, centered 64px targets and pinch-zoom touch policy.
 * Dispose before removing the transcript. Native selection and Copy remain browser-owned.
 * This binding uses Safari's caretRangeFromPoint boundary.
 */
export function bindSelectionGrips<Pad extends GripPad<Pad>>(scroller: GripScroller<Pad>): () => void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the phone browser exposes caretRangeFromPoint, verified in the native Safari probe.
  const document = scroller.ownerDocument as CaretDocument<Pad>
  const view = document.defaultView
  if (!view?.matchMedia("(pointer: coarse)").matches) return () => {}
  const caretFromPoint = document.caretRangeFromPoint.bind(document)

  const layer = document.createElement("div")
  layer.className = "selection-grips"
  layer.setAttribute("aria-hidden", "true")
  const pads = (["start", "end"] as const).map(endpoint => {
    const pad = document.createElement("div")
    pad.className = "selection-grip"
    pad.dataset.endpoint = endpoint
    pad.hidden = true
    const dot = document.createElement("span")
    dot.className = "selection-grip-dot"
    pad.append(dot)
    layer.append(pad)
    return pad
  })
  document.body.append(layer)

  let gesture: { readonly pointerId: number; readonly pad: Pad; readonly start: boolean; readonly dx: number; readonly dy: number } | undefined

  const selectedRange = () => {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0)
    return scroller.contains(range.startContainer) && scroller.contains(range.endContainer) ? range : null
  }
  const endpointRect = (range: GripRange, start: boolean) => {
    const caret = range.cloneRange()
    caret.collapse(start)
    return caret.getBoundingClientRect()
  }
  const release = () => {
    const finished = gesture
    gesture = undefined
    if (finished?.pad.hasPointerCapture(finished.pointerId)) finished.pad.releasePointerCapture(finished.pointerId)
    for (const pad of pads) pad.style.pointerEvents = ""
  }
  const sync = () => {
    const range = selectedRange()
    scroller.classList.toggle("selecting-text", range !== null)
    if (!range) {
      release()
      for (const pad of pads) pad.hidden = true
      return
    }
    const bounds = scroller.getBoundingClientRect()
    layer.style.clipPath = `inset(${bounds.top}px calc(100% - ${bounds.right}px) calc(100% - ${bounds.bottom}px) ${bounds.left}px)`
    for (const pad of pads) pad.style.pointerEvents = "none"
    for (const pad of pads) {
      pad.hidden = false
      const start = pad.dataset.endpoint === "start"
      const rect = endpointRect(range, start)
      pad.style.left = `${rect.x}px`
      pad.style.top = `${start ? rect.y - 10 : rect.bottom + 10}px`
      const target = pad.getBoundingClientRect()
      const left = Math.max(bounds.left, target.left)
      const right = Math.min(bounds.right, target.right) - 1
      const top = Math.max(bounds.top, target.top)
      const bottom = Math.min(bounds.bottom, target.bottom) - 1
      const points: readonly (readonly [number, number])[] = [
        [rect.x, rect.y + rect.height / 2],
        [left, top], [right, top], [left, bottom], [right, bottom],
      ]
      pad.hidden = points.some(([x, y]) => !scroller.contains(document.elementFromPoint(x, y)))
    }
    if (!gesture) for (const pad of pads) pad.style.pointerEvents = ""
  }
  const move = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return
    event.preventDefault()
    const hit = caretFromPoint(event.clientX - gesture.dx, event.clientY - gesture.dy)
    if (!hit) return
    const node = hit.startContainer
    const selection = document.getSelection()
    const range = selectedRange()
    if (node.nodeType !== 3 || !scroller.contains(node) || !selection || !range) return
    if (node.parentElement?.closest("button")) return
    // Safari can reverse anchor/focus during a start-grip drag. The ordered Range retains the fixed endpoint.
    const anchor = gesture.start ? range.endContainer : range.startContainer
    const offset = gesture.start ? range.endOffset : range.startOffset
    selection.setBaseAndExtent(anchor, offset, node, hit.startOffset)
    sync()
  }
  const end = (event: PointerEvent) => {
    if (gesture?.pointerId === event.pointerId) release()
  }
  const blockPan = (event: TouchEvent) => {
    // Safari can pan a wrapped native highlight despite pinch-zoom touch-action.
    if (event.touches.length === 1 && selectedRange()) event.preventDefault()
  }
  const bindings = pads.map(pad => {
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !event.isPrimary || gesture) return
      const range = selectedRange()
      const selection = document.getSelection()
      if (!range || !selection) return
      event.preventDefault()
      let endpoint = pad
      let distance = Infinity
      for (const candidate of pads) {
        const rect = candidate.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) continue
        const nextDistance = (event.clientX - (rect.left + rect.width / 2)) ** 2 + (event.clientY - (rect.top + rect.height / 2)) ** 2
        if (nextDistance < distance) { endpoint = candidate; distance = nextDistance }
      }
      const start = endpoint.dataset.endpoint === "start"
      const rect = endpointRect(range, start)
      gesture = { pointerId: event.pointerId, pad, start, dx: event.clientX - rect.x, dy: event.clientY - (rect.y + rect.height / 2) }
      if (start) selection.setBaseAndExtent(range.endContainer, range.endOffset, range.startContainer, range.startOffset)
      else selection.setBaseAndExtent(range.startContainer, range.startOffset, range.endContainer, range.endOffset)
      pad.setPointerCapture(event.pointerId)
      // Safari can overwrite the Range if either assist target remains hit-testable during capture.
      for (const target of pads) target.style.pointerEvents = "none"
    }
    pad.addEventListener("pointerdown", down)
    pad.addEventListener("pointermove", move)
    pad.addEventListener("pointerup", end)
    pad.addEventListener("pointercancel", end)
    pad.addEventListener("lostpointercapture", end)
    return { pad, down }
  })
  document.addEventListener("selectionchange", sync)
  scroller.addEventListener("touchmove", blockPan, { passive: false })
  scroller.addEventListener("scroll", sync, { passive: true })
  view.addEventListener("resize", sync)
  view.visualViewport?.addEventListener("resize", sync)
  view.visualViewport?.addEventListener("scroll", sync)
  sync()

  return () => {
    release()
    for (const { pad, down } of bindings) {
      pad.removeEventListener("pointerdown", down)
      pad.removeEventListener("pointermove", move)
      pad.removeEventListener("pointerup", end)
      pad.removeEventListener("pointercancel", end)
      pad.removeEventListener("lostpointercapture", end)
    }
    document.removeEventListener("selectionchange", sync)
    scroller.removeEventListener("touchmove", blockPan)
    scroller.removeEventListener("scroll", sync)
    view.removeEventListener("resize", sync)
    view.visualViewport?.removeEventListener("resize", sync)
    view.visualViewport?.removeEventListener("scroll", sync)
    scroller.classList.remove("selecting-text")
    layer.remove()
  }
}
