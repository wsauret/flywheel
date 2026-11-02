/** Counts the keyed entries that `work` visits: each entry that a Map
 *  iterator yields, each key that a copy or a read takes from a plain-object
 *  member of `state`, such as a fold's held state, and with `lookups` each
 *  `Map.get` and each entry that a Set iterator yields. A fold that copies or
 *  scans its whole keyed state on every change visits every entry, so a
 *  work-count test asserts that the count does not grow with the entries
 *  that the change leaves alone. Lookups also count the store's own work for
 *  a query, which grows with the aggregates the query names. Plain-object
 *  members of `state` are replaced in place by counting proxies; they behave
 *  as before. */
export async function entriesVisited(work: () => Promise<unknown>, options: { readonly state?: object, readonly lookups?: boolean } = {}): Promise<number> {
  let visited = 0
  const state = options.state ?? {}
  for (const [key, value] of Object.entries(state)) {
    if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) continue
    Reflect.set(state, key, new Proxy(value, {
      get: (target, property, receiver) => {
        visited += 1
        return Reflect.get(target, property, receiver)
      },
      getOwnPropertyDescriptor: (target, property) => {
        visited += 1
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    }))
  }
  const prototype = Map.prototype
  const originals = { get: prototype.get, values: prototype.values, keys: prototype.keys, entries: prototype.entries, iterator: prototype[Symbol.iterator] }
  const setIterators = { values: Set.prototype.values, iterator: Set.prototype[Symbol.iterator] }
  const counted = <I extends Iterator<unknown>>(iterator: I): I => {
    const step = iterator.next.bind(iterator)
    return Object.assign(iterator, { next: () => {
      const result = step()
      if (!result.done) visited += 1
      return result
    } })
  }
  if (options.lookups) {
    prototype.get = function get(key: unknown) {
      visited += 1
      return originals.get.call(this, key)
    }
    Set.prototype.values = function values() { return counted(setIterators.values.call(this)) }
    Set.prototype[Symbol.iterator] = function iterator() { return counted(setIterators.iterator.call(this)) }
  }
  prototype.values = function values() { return counted(originals.values.call(this)) }
  prototype.keys = function keys() { return counted(originals.keys.call(this)) }
  prototype.entries = function entries() { return counted(originals.entries.call(this)) }
  prototype[Symbol.iterator] = function iterator() { return counted(originals.iterator.call(this)) }
  try {
    await work()
  } finally {
    Object.assign(prototype, { get: originals.get, values: originals.values, keys: originals.keys, entries: originals.entries, [Symbol.iterator]: originals.iterator })
    Object.assign(Set.prototype, { values: setIterators.values, [Symbol.iterator]: setIterators.iterator })
  }
  return visited
}
