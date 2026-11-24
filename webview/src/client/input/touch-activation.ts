const controls = 'button, a[href], summary, label, input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], input[type="radio"], input[type="file"], [role="button"], [role="option"], [role="menuitem"], [role="radio"], [role="checkbox"], .changes-file-header'
const nativeGestures = 'textarea, select, [contenteditable], input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), [role="slider"], .selection-grip'

/** The document members touch activation listens on and reads. */
type TouchActivationDocument = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> & {
  elementFromPoint(x: number, y: number): EventTarget | null
  getSelection(): { readonly isCollapsed: boolean } | null
}

/** The root members touch activation reads. `contains` receives only targets that passed `instanceof Element`. */
export interface TouchActivationRoot {
  readonly isConnected: boolean
  readonly ownerDocument: TouchActivationDocument
  closest(selectors: string): object | null
  contains(other: Element): boolean
}

/** Installs touch activation for one mounted client and returns its disposer.
 * WebKit can stop compatibility mouse events after hover when visible content
 * changes during a tap. An uncancelled single-finger control tap therefore
 * calls HTMLElement.click() during touchend and cancels compatibility events.
 * Native editing, selection, scrolling and owned gestures remain native.
 * Detached, hidden and inert roots cannot activate controls. */
export function installTouchActivation(root: TouchActivationRoot): () => void {
  const document = root.ownerDocument
  let gesture: { readonly id: number; readonly x: number; readonly y: number; readonly control: HTMLElement } | undefined
  const active = () => root.isConnected && !root.closest("[hidden], [inert]") && document.visibilityState === "visible"
  const controlAt = (target: EventTarget | null): HTMLElement | undefined => {
    if (!(target instanceof Element) || !root.contains(target) || target.closest(nativeGestures)) return
    const control = target.closest(controls) ?? (target.matches(".scrim") ? target : null)
    if (!(control instanceof HTMLElement) || !root.contains(control) || control.closest('[inert], [hidden], [aria-disabled="true"]') || control.matches(":disabled")) return
    if (control instanceof HTMLLabelElement) {
      const input = control.control
      if (!input || !input.matches('input[type="checkbox"], input[type="radio"], input[type="file"]') || input.matches(":disabled")) return
    }
    return control
  }
  const cancel = () => { gesture = undefined }
  const start = (event: TouchEvent) => {
    cancel()
    const touch = event.touches[0]
    if (!active() || event.defaultPrevented || event.touches.length !== 1 || !touch) return
    const control = controlAt(event.target)
    if (control) gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, control }
  }
  const moved = (touch: Touch) => gesture !== undefined &&
    Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y) >= 10
  const move = (event: TouchEvent) => {
    const touch = event.touches[0]
    if (event.defaultPrevented || event.touches.length !== 1 || !touch || touch.identifier !== gesture?.id || moved(touch)) cancel()
  }
  const end = (event: TouchEvent) => {
    const pending = gesture
    const touch = event.changedTouches[0]
    const valid = pending && touch && touch.identifier === pending.id && !moved(touch)
    cancel()
    if (!valid || !active() || event.defaultPrevented || !event.cancelable || event.touches.length !== 0) return
    if (controlAt(document.elementFromPoint(touch.clientX, touch.clientY)) !== pending.control) return
    event.preventDefault()
    pending.control.click()
  }
  const scroll = (event: Event) => {
    if (gesture && (Object.is(event.target, document) || event.target instanceof Element && event.target.contains(gesture.control))) cancel()
  }
  const selection = () => { if (document.getSelection()?.isCollapsed === false) cancel() }
  document.addEventListener("touchstart", start, { passive: true })
  document.addEventListener("touchmove", move, { capture: true, passive: true })
  document.addEventListener("touchend", end, { passive: false })
  document.addEventListener("touchcancel", cancel)
  document.addEventListener("pointercancel", cancel)
  document.addEventListener("contextmenu", cancel)
  document.addEventListener("scroll", scroll, true)
  document.addEventListener("selectionchange", selection)
  document.addEventListener("visibilitychange", cancel)
  return () => {
    cancel()
    document.removeEventListener("touchstart", start)
    document.removeEventListener("touchmove", move, true)
    document.removeEventListener("touchend", end)
    document.removeEventListener("touchcancel", cancel)
    document.removeEventListener("pointercancel", cancel)
    document.removeEventListener("contextmenu", cancel)
    document.removeEventListener("scroll", scroll, true)
    document.removeEventListener("selectionchange", selection)
    document.removeEventListener("visibilitychange", cancel)
  }
}
