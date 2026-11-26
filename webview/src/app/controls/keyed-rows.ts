import { keyArray } from "@solid-primitives/keyed"
import { children, createEffect, onCleanup, type Accessor, type JSX } from "solid-js"

function isElement(row: JSX.Element): row is HTMLElement {
  return row !== null && typeof row === "object" && "nodeType" in row && row.nodeType === 1
}

/** Owns one list in its existing parent. Each key renders one resident element.
 * Surviving focused rows stay connected while siblings move around them.
 * The caller must not give these children to another Solid inserter. */
export function keyedRows<T, K>(parent: HTMLElement, each: Accessor<readonly T[]>, by: (item: T) => K, render: (item: Accessor<T>, index: Accessor<number>) => JSX.Element): void {
  const rows = keyArray(each, by, (item, index) => {
    const row = children(() => render(item, index))()
    if (!isElement(row)) throw new Error("A keyed row must render one element")
    return row
  })
  let previous: readonly HTMLElement[] = []
  onCleanup(() => { for (const row of previous) row.remove() })
  createEffect(() => {
    const next = rows()
    const kept = new Set<Node>(next)
    for (const old of previous) if (!kept.has(old)) old.remove()
    let before: ChildNode | null = null
    for (let index = next.length - 1; index >= 0; index--) {
      const row = next[index]
      if (row === undefined) continue
      if (row.parentNode !== parent || row.nextSibling !== before) {
        if (row.parentNode === parent && row.contains(parent.ownerDocument.activeElement)) {
          // insertBefore on the focused row blurs its descendants in Chromium and Safari.
          const siblings = Array.from(parent.childNodes)
          const from = siblings.indexOf(row)
          const to = before === null ? siblings.length : siblings.indexOf(before)
          if (from < to) for (const sibling of siblings.slice(from + 1, to)) row.before(sibling)
          else {
            const after = row.nextSibling
            for (const sibling of siblings.slice(to, from)) { if (after) after.before(sibling); else parent.append(sibling) }
          }
        } else if (before) before.before(row)
        else parent.append(row)
      }
      before = row
    }
    previous = next
  })
}
