import type { PositionedEventProjection } from "./event-projection.js"
import type { StoredFact } from "./event-store-types.js"

export interface PushFedView<S extends object> {
  /** The folded state. The first read replays the projection; later reads
   *  return the state of the last fold and make no durable request. */
  read(): Promise<S>
  /** Advances the fold by a committed batch that its owner observed. A batch
   *  that follows the facts already seen without a gap and holds no fact of
   *  the view's types makes no durable request. */
  observe(events: readonly StoredFact[]): void
}

/** A held projection of rare facts that an owner fed by the commit stream
 *  reads on every commit. `projection` returns the held projection. The
 *  state that `read` returns is current through the newest position of every
 *  batch that `observe` met. A connection announces only its own commits:
 *  another process that shares the store, such as a headless run, commits
 *  facts that no batch holds. Store positions are unique and increase in
 *  commit order, so such a fact leaves a gap below the next observed batch,
 *  and that batch replays the projection, which reads the gap. A failed fold
 *  is not kept, so the next read retries it. */
export function createPushFedView<S extends object>(projection: () => PositionedEventProjection<S>): PushFedView<S> {
  let current: Promise<S> | undefined
  // Every committed fact at or below this position was read by a fold or
  // held by an observed batch.
  let seen = 0
  const hold = (fold: Promise<S>): Promise<S> => {
    current = fold
    fold.catch(() => { if (current === fold) current = undefined })
    return fold
  }
  return {
    read: () => current ?? hold(projection().replay()),
    observe(events) {
      // Before the first read there is no fold to advance: that read replays.
      if (current === undefined) return
      const held = projection()
      seen = Math.max(seen, held.getReadPosition())
      let gap = false
      for (const { position } of events) {
        if (position === seen + 1) seen = position
        else if (position > seen) {
          gap = true
          seen = position
        }
      }
      // A push reads only through the facts that the projection folds, so a
      // gap, which can hold such a fact from another process, needs a replay.
      void hold(gap ? held.replay() : held.apply(events))
    },
  }
}
