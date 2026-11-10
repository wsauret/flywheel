import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { EventReaderService, EventStoreService, EventStoreWriterLaneService, EventStoreWriterService, type EventStoreRuntime, type RuntimeEventState } from "../../infra/event-store-effect.js"
import type { EventStoreItemSettlement } from "../../infra/event-store-types.js"
import { createEventStoreWriterLane } from "../../infra/event-store-writer-lane.js"
import { ProjectStateRefusedError, ProjectStateUnavailableError, storedSettlement, type ProjectStateClient } from "./project-state-client.js"

/** Acquires transport backpressure after state startup without opening SQLite.
 * The account must keep state and its generation alive until this runtime is disposed.
 * Disposal drains local writes and closes only stored subscriptions.
 * State refusals and commit conflicts retain their typed errors.
 * The state client is the one reader of the executor. Held projections, run
 * controls, and reconciliation lanes are keyed by reader identity, so a hold
 * and its release must name the same object. */
export async function createProjectExecutionState(state: ProjectStateClient) {
  await state.capturePosition()
  const layer = Layer.effectContext(Effect.acquireRelease(
    Effect.sync(() => openExecutionStore(state)),
    (store) => Effect.promise(() => store.close()),
  ).pipe(Effect.map((store) => Context.make(EventReaderService, state).pipe(
    Context.add(EventStoreService, store),
    Context.add(EventStoreWriterService, store),
    Context.add(EventStoreWriterLaneService, store.writerLane),
  ))))
  const eventStoreRuntime: EventStoreRuntime = ManagedRuntime.make(layer)
  try {
    const eventStore = await eventStoreRuntime.runPromise(EventStoreService)
    return {
      eventStoreRuntime,
      eventStore,
      eventReader: state,
      eventWriter: eventStore,
      writerLane: eventStore.writerLane,
      sessionManager: state.sessions,
    }
  } catch (error) {
    await eventStoreRuntime.dispose()
    throw error
  }
}

function openExecutionStore(state: ProjectStateClient): RuntimeEventState {
  const lane = createEventStoreWriterLane({
    async commitItems(items) {
      const settlements: EventStoreItemSettlement[] = []
      for (const item of items) {
        // Each remote item is already a transaction. Settle separately so a later
        // transport failure cannot retry or erase an earlier committed item.
        try {
          const result = await state.control({ kind: "append", item })
          if (result.kind === "failed") throw result.error
          if (result.kind === "refused") throw new ProjectStateRefusedError(result.reason, result.message)
          if (result.kind !== "stored" || result.settlements.length !== 1) {
            throw new ProjectStateUnavailableError("atomic append returned an invalid settlement")
          }
          const settlement = result.settlements[0]
          if (!settlement) throw new ProjectStateUnavailableError("atomic append returned no settlement")
          settlements.push(storedSettlement(item, settlement))
        } catch (error) {
          settlements.push({ kind: "rejected", error })
        }
      }
      return settlements
    },
  })
  const subscriptions = new Set<() => void>()
  let closing: Promise<void> | undefined
  return {
    capturePosition: state.capturePosition,
    latestPosition: state.latestPosition,
    readPage: state.readPage,
    readSlice: state.readSlice,
    contentFor: state.contentFor,
    readSessionContentNode: state.readSessionContentNode,
    readSessionContentRange: state.readSessionContentRange,
    readLatestPayloadByAggregateAndType: state.readLatestPayloadByAggregateAndType,
    readLatestByAggregateAndTypes: state.readLatestByAggregateAndTypes,
    readInFlight: state.readInFlight,
    sessionsWithInFlight: state.sessionsWithInFlight,
    inFlightProfileKeys: state.inFlightProfileKeys,
    countByAggregate: state.countByAggregate,
    aggregateSeq: state.aggregateSeq,
    append: lane.append,
    appendBatch: lane.appendBatch,
    appendGuarded: lane.appendGuarded,
    appendBatchGuarded: lane.appendBatchGuarded,
    stageSessionContentNodes: lane.stageSessionContentNodes,
    putInFlight: lane.putInFlight,
    dropInFlight: lane.dropInFlight,
    swapInFlight: lane.swapInFlight,
    swapInFlightBatch: lane.swapInFlightBatch,
    pruneSupersededEvents: state.writer.pruneSupersededEvents,
    pruneSupersededKeyedEvents: state.writer.pruneSupersededKeyedEvents,
    writerLane: lane,
    onStored(listener) {
      const stop = state.onStored(listener)
      const unsubscribe = () => { stop(); subscriptions.delete(unsubscribe) }
      subscriptions.add(unsubscribe)
      return unsubscribe
    },
    close() {
      closing ??= (async () => {
        try {
          const drained = await lane.dispose()
          if (drained.kind === "failed") throw new Error(`execution writer lane drain failed: ${drained.error.message}`)
        } finally {
          for (const stop of subscriptions) stop()
        }
      })()
      return closing
    },
  }
}
