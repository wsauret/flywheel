/** The storage a success memo writes through: a `Map` or a `WeakMap`. */
interface SuccessMemoCache<K, V> {
  get(key: K): V | Promise<V> | undefined
  set(key: K, value: V | Promise<V>): void
  delete(key: K): void
}

/** Returns the cached value for `key`, or starts `load` and shares its promise
 *  with every caller that asks while it runs. A success replaces the promise
 *  with its value, so later callers read it without a microtask. A rejection
 *  removes the entry, so a transient read failure reaches only the callers that
 *  shared it and the next caller reads again. An entry that a newer load or a
 *  delete replaced is never touched. `V` excludes `undefined` because an
 *  undefined entry reads as a miss. */
export function memoizeSuccess<K, V extends NonNullable<unknown>>(cache: SuccessMemoCache<K, V>, key: K, load: () => Promise<V>): V | Promise<V> {
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const pending = load()
  cache.set(key, pending)
  pending.then(
    (value) => { if (cache.get(key) === pending) cache.set(key, value) },
    () => { if (cache.get(key) === pending) cache.delete(key) },
  )
  return pending
}
