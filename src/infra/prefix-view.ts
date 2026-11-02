/** One entry of a `PrefixView`'s shared index. */
interface PrefixEntry<V> {
  readonly key: string
  readonly value: V
}

/** The first `size` entries of an append-only index of values by key. Every
 *  view taken from one fold shares the index, so a fold state that holds a
 *  view keeps its meaning while later folds append, and an append costs one
 *  entry instead of a copy of the whole index. A view is immutable: an append
 *  returns a new view. Plain (objects, arrays, Maps, and primitives only), so
 *  a persisted fold can hold it. */
export interface PrefixView<V> {
  readonly index: {
    readonly ordinals: Map<string, number>
    readonly entries: PrefixEntry<V>[]
  }
  readonly size: number
}

export function emptyPrefixView<V>(): PrefixView<V> {
  return { index: { ordinals: new Map(), entries: [] }, size: 0 }
}

/** The value that `view` holds for `key`, or undefined when `key` was
 *  appended after the view was taken or never. */
export function prefixGet<V>(view: PrefixView<V>, key: string): V | undefined {
  const ordinal = view.index.ordinals.get(key)
  return ordinal !== undefined && ordinal < view.size ? view.index.entries[ordinal]?.value : undefined
}

/** `view` with `key` appended. Requires that `view` does not hold `key`.
 *
 *  Only the newest state of a fold folds on, so the entries past `view.size`
 *  belong to no live state: a copy of an earlier state taken after a later
 *  fold appended, such as a persisted fold, carries them. They are dropped
 *  first, and since a key is appended only when the view does not hold it,
 *  no dropped key has an entry inside the view. */
export function prefixAppend<V>(view: PrefixView<V>, key: string, value: V): PrefixView<V> {
  const { index, size } = view
  for (const dropped of index.entries.splice(size)) {
    index.ordinals.delete(dropped.key)
  }
  index.ordinals.set(key, size)
  index.entries.push({ key, value })
  return { index, size: size + 1 }
}
