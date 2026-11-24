import type { InputReloadCheckpoint } from "./input-reload-checkpoint.js"

/** Semantic keys name the owner, not its position or current label. */
function captureInputFocus(root: HTMLElement, active: EventTarget | null = root.ownerDocument.activeElement): InputReloadCheckpoint["focus"] {
  if (!(active instanceof HTMLElement) || !root.contains(active)) return undefined
  const key = active.dataset.inputFocus
  if (key === undefined) return undefined
  const selection = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
    ? { start: active.selectionStart ?? undefined, end: active.selectionEnd ?? undefined, direction: active.selectionDirection ?? undefined }
    : {}
  return { key, ...selection, scrollTop: active.scrollTop, scrollLeft: active.scrollLeft }
}

/** Retains semantic focus through involuntary blur and restores transferred focus when its subject exists. */
export function createInputFocus(root: HTMLElement, restored: InputReloadCheckpoint["focus"]) {
  let pending = restored
  let observer: MutationObserver | undefined
  const cancel = () => {
    pending = undefined
    observer?.disconnect()
    root.removeEventListener("pointerdown", cancel, true)
    root.removeEventListener("keydown", cancel, true)
  }
  const onFocusIn = () => {
    cancel()
    pending = captureInputFocus(root)
  }
  const onFocusOut = (event: FocusEvent) => {
    if (event.relatedTarget === null && pending !== undefined) pending = captureInputFocus(root, event.target)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") cancel()
  }
  root.ownerDocument.addEventListener("focusin", onFocusIn, true)
  root.addEventListener("focusout", onFocusOut, true)
  root.addEventListener("keydown", onKeyDown, true)
  const restore = () => {
    const focus = pending
    if (focus === undefined) return true
    const target = [...root.querySelectorAll<HTMLElement>("[data-input-focus]")].find((element) => element.dataset.inputFocus === focus.key)
    if (!target) return false
    target.focus({ preventScroll: true })
    if ((target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && focus.start !== undefined && focus.end !== undefined) {
      target.setSelectionRange(focus.start, focus.end, focus.direction)
    }
    target.scrollTop = focus.scrollTop
    target.scrollLeft = focus.scrollLeft
    cancel()
    pending = focus
    return true
  }
  return {
    capture: () => captureInputFocus(root) ?? pending,
    adopt() {
      if (restore()) return
      observer = new MutationObserver(restore)
      observer.observe(root, { childList: true, subtree: true })
      root.addEventListener("pointerdown", cancel, true)
      root.addEventListener("keydown", cancel, true)
    },
    dispose() {
      cancel()
      root.ownerDocument.removeEventListener("focusin", onFocusIn, true)
      root.removeEventListener("focusout", onFocusOut, true)
      root.removeEventListener("keydown", onKeyDown, true)
    },
  }
}

/** Composition remains accepted until its end. During commit, events are refused
 *  at capture without disabling or disconnecting the focused controls. */
export function createInputAdmission(root: HTMLElement) {
  let held = false
  let composing = false
  const waiting = new Set<() => void>()
  const start = () => { composing = true }
  const end = () => { composing = false; for (const done of waiting) done(); waiting.clear() }
  const refuse = (event: Event) => { if (held) { event.preventDefault(); event.stopImmediatePropagation() } }
  const events = ["beforeinput", "input", "keydown", "click", "pointerdown", "paste", "drop", "change", "compositionstart"]
  for (const name of events) root.addEventListener(name, refuse, true)
  root.addEventListener("compositionstart", start)
  root.addEventListener("compositionend", end)
  return {
    get held() { return held },
    settled: () => composing ? new Promise<void>((resolve) => { waiting.add(resolve) }) : Promise.resolve(),
    hold: () => { held = true; return () => { held = false } },
    dispose() {
      end()
      for (const name of events) root.removeEventListener(name, refuse, true)
      root.removeEventListener("compositionstart", start)
      root.removeEventListener("compositionend", end)
    },
  }
}
