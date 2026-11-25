/** A batched loader: call it with a key to request that key's value. */
export interface MicrotaskBatch<K, V> {
  (key: K): Promise<V>
  /** Closes the open batch and starts its load now instead of at the next
   *  microtask, so a caller can order the load before other work. A key
   *  requested later opens a new batch. Does nothing when no batch is open. */
  readonly flush: () => void
}

/** Loads every key requested in one synchronous pass with one `load` call.
 *  The batch closes at the next microtask or at `flush`, so callers that map
 *  over many items and request each item's key share one read. A key
 *  requested twice in a batch shares one value. `load` returns a value for
 *  each key it receives; a key it omits rejects with an error. A failed load
 *  rejects every request in its batch, and nothing is kept, so the next
 *  request loads again. */
export function createMicrotaskBatch<K, V extends NonNullable<unknown>>(load: (keys: readonly K[]) => Promise<ReadonlyMap<K, V>>): MicrotaskBatch<K, V> {
  let batch: Map<K, PromiseWithResolvers<V>> | undefined

  async function settle(requests: ReadonlyMap<K, PromiseWithResolvers<V>>): Promise<void> {
    try {
      const values = await load([...requests.keys()])
      for (const [key, request] of requests) {
        const value = values.get(key)
        if (value === undefined) request.reject(new Error("A batched load returned no value for a requested key"))
        else request.resolve(value)
      }
    } catch (error) {
      for (const request of requests.values()) request.reject(error)
    }
  }

  function flush(): void {
    const requests = batch
    batch = undefined
    if (requests) void settle(requests)
  }

  function requestValue(key: K): Promise<V> {
    if (!batch) {
      const requests = new Map<K, PromiseWithResolvers<V>>()
      batch = requests
      queueMicrotask(() => { if (batch === requests) flush() })
    }
    let pending = batch.get(key)
    if (!pending) {
      pending = Promise.withResolvers<V>()
      batch.set(key, pending)
    }
    return pending.promise
  }

  return Object.assign(requestValue, { flush })
}
