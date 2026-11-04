import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import type { BlockDisclosure } from "./block-disclosure.js"
import "../styles/person-text.css"

/** Clamps rendered lines, while the transcript owns the person's expansion choice. */
export function PersonText(props: { content: string; sessionId: string; blockId: string; disclosure: BlockDisclosure }) {
  let text: HTMLDivElement | undefined
  const [overflowing, setOverflowing] = createSignal(false)
  const key = () => `userMessage:${props.blockId}:text`
  const expanded = () => props.disclosure.state(props.sessionId, key())().open
  const measure = () => {
    if (!text) return
    // oxlint-disable-next-line unicorn/prefer-number-coercion -- boundary: a computed CSS length carries a unit suffix that only parseFloat skips
    const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight)
    setOverflowing(text.scrollHeight > lineHeight * 8 + 1)
  }
  onMount(() => {
    measure()
    const observer = new ResizeObserver(measure)
    if (text) observer.observe(text)
    onCleanup(() => observer.disconnect())
  })
  createEffect(on(() => props.content, () => { if (text) measure() }))
  return <div class="person-text">
    <div ref={element => { text = element }} class="user-text" classList={{ "person-text-clipped": !expanded() }}>{props.content}</div>
    <Show when={overflowing()}>
      <button type="button" class="ghost-text person-text-toggle" aria-expanded={expanded()} onClick={() => props.disclosure.setOpen(props.sessionId, key(), !expanded())}>
        {expanded() ? "Show less" : "Show more"}
      </button>
    </Show>
  </div>
}
