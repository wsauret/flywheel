import { Log } from "../../infra/log.js"
import type { SessionHolder } from "./session-holds.js"

const log = Log.create({ service: "output-watches" })

/** Which sessions' live output each client connection of one project
 *  follows, and the union of them, which is all the project's executor
 *  ships output for (ARCH-PROTOCOL-057). A connection states its whole set with each
 *  `output.watch`, and its set ends with it: a client watches again on each
 *  lane, so a set never outlives its connection. The protocol boundary
 *  states and drops the sets and asks it which `output.delta` each
 *  connection receives; the executor generations read the union. */
export interface OutputWatches {
  /** Replaces the set of `holder` with `sessionIds`. */
  state(holder: SessionHolder, sessionIds: readonly string[]): void
  /** `holder` ended. Its set leaves the union at once. */
  drop(holder: SessionHolder): void
  /** Whether `holder` follows the live output of `sessionId`. */
  watches(holder: SessionHolder, sessionId: string): boolean
  /** Every session that some connection watches. */
  union(): readonly string[]
}

/** `onUnionChange` hears the whole union, synchronously, each time a
 *  session enters or leaves it, so the executor hears a statement before any
 *  call that the same connection sends after it. */
export function createOutputWatches(options: { readonly onUnionChange: (sessionIds: readonly string[]) => void }): OutputWatches {
  const sets = new Map<SessionHolder, ReadonlySet<string>>()
  // How many connections watch each session of the union.
  const watchers = new Map<string, number>()
  const union = (): readonly string[] => [...watchers.keys()]

  function replace(holder: SessionHolder, next: ReadonlySet<string>): void {
    const prior = sets.get(holder) ?? new Set<string>()
    if (next.size === 0) sets.delete(holder)
    else sets.set(holder, next)
    let changed = false
    for (const sessionId of prior) {
      if (next.has(sessionId)) continue
      const count = (watchers.get(sessionId) ?? 1) - 1
      if (count > 0) watchers.set(sessionId, count)
      else {
        watchers.delete(sessionId)
        changed = true
      }
    }
    for (const sessionId of next) {
      if (prior.has(sessionId)) continue
      const count = watchers.get(sessionId) ?? 0
      watchers.set(sessionId, count + 1)
      if (count === 0) changed = true
    }
    if (!changed) return
    log.debug("output watch union changed", { sessions: watchers.size, connections: sets.size })
    options.onUnionChange(union())
  }

  return {
    state: (holder, sessionIds) => replace(holder, new Set(sessionIds)),
    drop: (holder) => replace(holder, new Set()),
    watches: (holder, sessionId) => sets.get(holder)?.has(sessionId) === true,
    union,
  }
}
