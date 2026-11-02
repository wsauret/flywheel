import type { LocalSqliteEventStore } from "./event-store-types.js"
import { createSqliteEventStore } from "./sqlite-event-store.js"
import { resolveEventStoreDbFile } from "./paths.js"

// One close()-guaranteed wrapper for both call shapes: a sync `fn` (e.g. the
// `events:search` CLI command) closes immediately and returns its value; an async
// `fn` (e.g. `withEventStore(dir, async store => ...)`) defers close() to the
// promise's `.finally`, so the store is never closed out from under an
// in-flight async caller. The overloads keep each caller's return type exact.
export function withEventStore<T>(baseDir: string, fn: (store: LocalSqliteEventStore) => Promise<T>): Promise<T>
export function withEventStore<T>(baseDir: string, fn: (store: LocalSqliteEventStore) => T): T
export function withEventStore<T>(baseDir: string, fn: (store: LocalSqliteEventStore) => T | Promise<T>): T | Promise<T> {
  const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  try {
    const result = fn(store)
    if (result instanceof Promise) return result.finally(() => { store.close() })
    store.close()
    return result
  } catch (err) {
    store.close()
    throw err
  }
}
