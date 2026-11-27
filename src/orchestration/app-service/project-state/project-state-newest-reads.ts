import type { AsyncEventStateReadSurface, CorruptEventRowError, StoredFact } from "../../../infra/substrate/store/event-store-types.js"
import { ProjectStateRefusedError } from "./project-state-client.js"
import { PROJECT_STATE_MAX_PAGE_ROWS } from "./project-state-protocol.js"

/** SQLite caps one compound select, so one read names at most this many aggregates. */
const MAX_AGGREGATES_PER_READ = 500

/** The facts that a newest read found, and the aggregates that the state
 *  boundary could not serve. */
export interface NewestPerAggregateRead {
  readonly facts: readonly (StoredFact | CorruptEventRowError)[]
  readonly unserved: readonly string[]
}

/** Reads the newest `perAggregate` facts of `types` of each aggregate of
 *  `aggregateIds`, after `afterPosition` when it is given, through tolerant
 *  descending reads that the state boundary serves. Each read names at most
 *  `min(500, floor(PROJECT_STATE_MAX_PAGE_ROWS / perAggregate))` aggregates,
 *  and at least one, so it stays under the row bound. A read that the
 *  boundary refuses as `oversize` is split in two until it names one
 *  aggregate; one aggregate whose facts alone are still oversize is returned
 *  in `unserved`, and its facts are not read. Facts come in read order, not
 *  position order. Every other error throws. */
export async function readNewestPerAggregate(
  reader: Pick<AsyncEventStateReadSurface, "readSlice">,
  aggregateIds: readonly string[],
  types: readonly string[],
  perAggregate: number,
  afterPosition?: number,
): Promise<NewestPerAggregateRead> {
  const facts: (StoredFact | CorruptEventRowError)[] = []
  const unserved: string[] = []
  const read = async (ids: readonly string[]): Promise<void> => {
    try {
      const query = { aggregateIds: ids, types, ...(afterPosition === undefined ? {} : { afterPosition }), order: "desc" as const, limitPerAggregate: perAggregate, limit: ids.length * perAggregate }
      facts.push(...(await reader.readSlice(query, true)).facts)
    } catch (error) {
      if (!(error instanceof ProjectStateRefusedError && error.reason === "oversize")) throw error
      if (ids.length === 1) {
        unserved.push(...ids)
        return
      }
      const half = Math.ceil(ids.length / 2)
      await read(ids.slice(0, half))
      await read(ids.slice(half))
    }
  }
  const perRead = Math.max(1, Math.min(MAX_AGGREGATES_PER_READ, Math.floor(PROJECT_STATE_MAX_PAGE_ROWS / perAggregate)))
  for (let index = 0; index < aggregateIds.length; index += perRead) await read(aggregateIds.slice(index, index + perRead))
  return { facts, unserved }
}
