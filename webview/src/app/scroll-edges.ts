import { onCleanup, onMount } from "solid-js"

interface ScrollMetrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
  readonly classList: { toggle(name: string, enabled: boolean): void }
}

/** Marks the visible edges; CSS pixel rounding counts a fractional last pixel as the end. */
export function updateScrollEdges(element: ScrollMetrics): void {
  element.classList.toggle("scroll-above", element.scrollTop > 0)
  element.classList.toggle("scroll-below", Math.ceil(element.scrollTop + element.clientHeight) < element.scrollHeight)
}

const containers = new Map<EventTarget, HTMLElement>()
const owners = new Map<Element, HTMLElement>()
const pending = new Set<HTMLElement>()
let observer: ResizeObserver | undefined
let frame: number | undefined

function schedule(element: HTMLElement): void {
  pending.add(element)
  frame ??= element.ownerDocument.defaultView!.requestAnimationFrame(() => {
    frame = undefined
    for (const container of pending) updateScrollEdges(container)
    pending.clear()
  })
}

function scrolled(event: Event): void {
  const element = event.target && containers.get(event.target)
  if (element) schedule(element)
}

/** Solid ref for a scroller with one content wrapper. Observes both viewport and content size, and releases them on cleanup. */
export function scrollEdges(element: HTMLElement): void {
  onMount(() => {
    const document = element.ownerDocument
    const window = document.defaultView!
    if (!observer) {
      observer = new window.ResizeObserver(entries => {
        for (const entry of entries) {
          const container = owners.get(entry.target)
          if (container) schedule(container)
        }
      })
      document.addEventListener("scroll", scrolled, { capture: true, passive: true })
    }
    containers.set(element, element)
    const observed = [element, ...element.children]
    for (const target of observed) {
      owners.set(target, element)
      observer.observe(target)
    }
    schedule(element)
    onCleanup(() => {
      containers.delete(element)
      pending.delete(element)
      for (const target of observed) {
        owners.delete(target)
        observer?.unobserve(target)
      }
      if (containers.size === 0) {
        observer?.disconnect()
        observer = undefined
        document.removeEventListener("scroll", scrolled, true)
        if (frame !== undefined) window.cancelAnimationFrame(frame)
        frame = undefined
      }
    })
  })
}
