import type { StoredFact } from "./event-store-types.js"

/** The narrow write surface a typed-fact recorder needs: append a validated fact
 *  and group a burst of appends into one store transaction. `SessionFactWriter`
 *  satisfies this structurally, so handoff and improvement recorders share one
 *  interface instead of each declaring a private writer shape. */
export interface FactRecorder<T> {
  record(fact: T): Promise<StoredFact | null>
  transaction(fn: () => void): Promise<void>
}
