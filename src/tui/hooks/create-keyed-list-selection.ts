import { batch, createMemo, createSignal, untrack, type Accessor } from "solid-js"

/** Selection follows entity keys. Publications can choose a surviving neighbour,
 *  but only an explicit select issues a new navigation revision. Undefined keys
 *  are presentation rows, such as headings, and cannot be selected. */
export function createKeyedListSelection(keys?: Accessor<readonly (string | undefined)[]>, initial?: () => string | undefined) {
  const [chosen, setChosen] = createSignal<string>()
  const [revision, setRevision] = createSignal(0)
  const [published, setPublished] = createSignal<readonly (string | undefined)[]>([])
  let previous: readonly (string | undefined)[] = []
  const reconcileSelection = (next: readonly (string | undefined)[], selected: string | undefined): void => untrack(() => {
    let index = selected === undefined ? -1 : next.indexOf(selected)
    if (index < 0) {
      const oldIndex = selected === undefined ? -1 : previous.indexOf(selected)
      // Removal keeps the next row at the old position, or the preceding last
      // selectable row. Initial acquisition may use a surface-specific default.
      index = selected === undefined ? next.indexOf(initial?.()) : -1
      if (index < 0 || next[index] === undefined) {
        index = next.findIndex((key, at) => key !== undefined && at >= Math.max(0, oldIndex))
        if (index < 0) index = next.findLastIndex((key) => key !== undefined)
      }
    }
    setChosen(next[index])
    previous = next
  })
  const membership = createMemo(() => {
    const next = keys?.() ?? published()
    untrack(() => reconcileSelection(next, chosen()))
    return next
  })
  const cursor = createMemo(() => {
    const next = membership()
    const selected = chosen()
    return Math.max(0, selected === undefined ? -1 : next.indexOf(selected))
  })
  const key = (): string | undefined => { membership(); return chosen() }
  const select = (index: number): void => {
    const next = membership()
    batch(() => {
      reconcileSelection(next, next[index])
      setRevision((value) => value + 1)
    })
  }
  const choose = (value: string | undefined): void => {
    select(value === undefined ? -1 : membership().indexOf(value))
  }
  const reconcile = (next: readonly (string | undefined)[]): number => {
    setPublished(next)
    return cursor()
  }
  return { key, cursor, revision, select, choose, reconcile }
}
