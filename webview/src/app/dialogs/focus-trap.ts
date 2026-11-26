import { onCleanup, onMount } from "solid-js"

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Isolates an overlay from the page, keeps keyboard focus inside it while it
 *  is open, and gives focus back when it closes.
 *
 *  Focus trapping alone does not remove background controls from assistive
 *  technology. Every sibling of the overlay becomes inert for the same
 *  lifetime, with prior inert state restored for nested overlays. */
export function trapFocus(root: () => HTMLElement | undefined): void {
  onMount(() => {
    const element = root()
    if (!element) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const overlay = element.closest<HTMLElement>(".scrim")
    const siblings = overlay?.parentElement
      ? [...overlay.parentElement.children]
        .filter((sibling): sibling is HTMLElement => sibling instanceof HTMLElement && sibling !== overlay)
        .map((sibling) => ({ sibling, inert: sibling.inert }))
      : []
    for (const { sibling } of siblings) sibling.inert = true
    const focusables = () => [...element.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const initial = element.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0] ?? element
    if (!element.contains(document.activeElement)) initial.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab") return
      const items = focusables()
      const first = items[0]
      const last = items.at(-1)
      if (!first || !last) {
        event.preventDefault()
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    element.addEventListener("keydown", onKeyDown)
    onCleanup(() => {
      element.removeEventListener("keydown", onKeyDown)
      for (const { sibling, inert } of siblings) sibling.inert = inert
      previous?.focus()
    })
  })
}
