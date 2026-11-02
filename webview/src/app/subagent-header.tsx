import { createEffect, createMemo, createSignal, Index, on, onCleanup, onMount } from "solid-js"
import type { SubagentHeaderPart } from "../../../src/protocol/client/subagent-line.js"

/** Drops optional figures before cutting the goal. The resident spans keep
 *  their identity while both the available width and the figures change. */
export function SubagentHeader(props: { readonly parts: readonly SubagentHeaderPart[] }) {
  let root!: HTMLSpanElement
  const elements: HTMLSpanElement[] = []
  const parts = createMemo(() => props.parts, undefined, {
    equals: (a, b) => a.length === b.length && a.every((part, index) => {
      const next = b[index]!
      return part.kind === next.kind && part.text === next.text && part.rank === next.rank && part.tone === next.tone
    }),
  })
  const [droppedThrough, setDroppedThrough] = createSignal(-1)
  const [wrap, setWrap] = createSignal(false)
  const measure = () => {
    const widths = parts().map((_part, index) => {
      const element = elements[index]!
      const previous = element.style.cssText
      // Measure the resident text at its natural width, even after wrapping or hiding it.
      element.style.cssText = `${previous};flex:none;width:max-content;max-width:none;white-space:pre`
      const width = element.getBoundingClientRect().width
      element.style.cssText = previous
      return width
    })
    const identityWidth = parts().reduce((sum, part, index) => sum + (Number.isFinite(part.rank) ? 0 : widths[index]!), 0)
    // The flex row must reserve the identity before deciding where controls fit.
    root.style.setProperty("--subagent-identity-width", `${identityWidth}px`)
    setWrap(identityWidth > root.clientWidth)
    let total = widths.reduce((sum, width) => sum + width, 0)
    let through = -1
    for (const part of parts().toSorted((a, b) => a.rank - b.rank)) {
      if (total <= root.clientWidth || part.kind === "goal" || !Number.isFinite(part.rank)) break
      total -= widths[parts().indexOf(part)]!
      through = part.rank
    }
    setDroppedThrough(through)
  }
  onMount(() => {
    const observer = new (root.ownerDocument.defaultView!).ResizeObserver(measure)
    observer.observe(root)
    createEffect(on(parts, measure))
    onCleanup(() => observer.disconnect())
  })
  return <span ref={element => { root = element }} class="subagent-header-parts" classList={{ "subagent-header-wrap": wrap() }}>
    <Index each={parts()}>{(part, index) => <span ref={element => { elements[index] = element }}
      class={`subagent-header-${part().kind} ${part().kind === "persona" ? "tool-title" : "tool-detail"}`}
      classList={{ "subagent-header-dropped": part().rank <= droppedThrough() }}>
      {index > 0 ? " · " : ""}{part().text}
    </span>}</Index>
  </span>
}
