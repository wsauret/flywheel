import { scrollerKeepsTouch, swipeAbandoned, swipeDirectionOf, swipeRecognized } from "./screen-swipe.js"

/** A sideways drag latches metadata without taking vertical scrolling or text selection. */
export function bindTranscriptTimeReveal(element: EventTarget & {
  readonly classList: Pick<DOMTokenList, "contains" | "toggle" | "remove">
  readonly style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">
}): () => void {
  let start: { x: number; y: number; target: HTMLElement; owned: boolean; reveal: boolean } | undefined
  let dragEndedAt: number | undefined
  const down = (event: Event) => {
    if (!(event instanceof TouchEvent)) return
    const touch = event.touches[0]
    if (event.touches.length !== 1 || touch === undefined || !(event.target instanceof HTMLElement)) { start = undefined; return }
    dragEndedAt = undefined
    start = { x: touch.clientX, y: touch.clientY, target: event.target, owned: false, reveal: false }
  }
  const move = (event: Event) => {
    if (!(event instanceof TouchEvent)) return
    const touch = event.touches[0]
    if (start === undefined || touch === undefined) return
    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y
    if (!start.owned) {
      if (swipeAbandoned(dx, dy)) { start = undefined; return }
      if (!swipeRecognized(dx, dy)) return
      for (let node: HTMLElement | null = start.target; node !== null && node !== element; node = node.parentElement) {
        if (scrollerKeepsTouch(node, swipeDirectionOf(dx))) { start = undefined; return }
      }
      if (dx > 0 && !element.classList.contains("times-revealed")) { start = undefined; return }
      start.owned = true
    }
    event.preventDefault()
    event.stopPropagation()
    element.classList.toggle("dragging-times", true)
    element.style.setProperty("--time-drag", String(Math.max(0, -dx) / (Math.max(0, -dx) + 80)))
    start.reveal = dx < 0
  }
  const end = (event: Event) => {
    if (start?.owned) {
      event.stopPropagation()
      dragEndedAt = event.timeStamp
      if (event.type === "touchend") element.classList.toggle("times-revealed", start.reveal)
    }
    element.classList.remove("dragging-times")
    element.style.removeProperty("--time-drag")
    start = undefined
  }
  const tap = (event: Event) => {
    const fromTouch = event instanceof PointerEvent && event.pointerType === "touch"
    if (fromTouch && dragEndedAt !== undefined && event.timeStamp - dragEndedAt < 750) {
      dragEndedAt = undefined; event.preventDefault(); event.stopPropagation(); return
    }
    if (event.target instanceof HTMLElement && !event.target.closest("button, a, .row-time")) element.classList.remove("times-revealed")
  }
  element.addEventListener("touchstart", down, { passive: true })
  element.addEventListener("touchmove", move, { passive: false })
  element.addEventListener("touchend", end)
  element.addEventListener("touchcancel", end)
  element.addEventListener("click", tap, true)
  return () => {
    element.removeEventListener("touchstart", down)
    element.removeEventListener("touchmove", move)
    element.removeEventListener("touchend", end)
    element.removeEventListener("touchcancel", end)
    element.removeEventListener("click", tap, true)
    element.classList.remove("dragging-times")
    element.style.removeProperty("--time-drag")
  }
}
