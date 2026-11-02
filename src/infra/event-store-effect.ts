import { Context, Effect, Layer, type ManagedRuntime } from "effect"

import { errorDetail, errorMessage } from "./error-message.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type AsyncGuardedEventWriter, type AsyncEventWriter, type StoredFact } from "./event-store-types.js"
import type { EventStoreWriterLane } from "./event-store-writer-lane-types.js"
import { Log } from "./log.js"
import { durationMs, logCompletion } from "./operation-log.js"
import { createRuntimeEventStore, type RuntimeEventStore } from "./sqlite-event-store.js"

const log = Log.create({ service: "event-store-effect" })
/** Opening or closing a project's store past this delays the project's open or
 *  its close in a way a person notices. */
const SLOW_STORE_LIFECYCLE_MS = 1_000

export interface RuntimeEventState extends AsyncEventStateReadSurface, AsyncGuardedEventWriter {
  readonly writerLane: EventStoreWriterLane
  onStored(listener: (events: readonly StoredFact[]) => void): () => void
  close(): Promise<void>
}

export class EventReaderService extends Context.Service<EventReaderService, AsyncEventStateReadSurface>()("EventReaderService") {}
export class EventStoreService extends Context.Service<EventStoreService, RuntimeEventState>()("EventStoreService") {}
export class EventStoreWriterLaneService extends Context.Service<EventStoreWriterLaneService, EventStoreWriterLane>()("EventStoreWriterLaneService") {}
export class EventStoreWriterService extends Context.Service<EventStoreWriterService, AsyncEventWriter>()("EventStoreWriterService") {}
/** The synchronous connection itself, present only where this process opened
 *  it: the state Worker that owns the primary store and the offline and
 *  headless compositions. An interactive executor's runtime never has it. */
export class LocalEventStoreService extends Context.Service<LocalEventStoreService, RuntimeEventStore>()("LocalEventStoreService") {}

type EventStoreServices = EventReaderService | EventStoreService | EventStoreWriterLaneService | EventStoreWriterService
type LocalEventStoreServices = EventStoreServices | LocalEventStoreService

type EventStoreReadSurfaceFactory = (
  reader: AsyncEventStateReadSurface,
  writer: AsyncGuardedEventWriter,
) => AsyncEventStateReadSurface

/** Process-lifetime EventStore as an Effect resource. The connection is
 *  opened on layer build and closed when the owning runtime is disposed;
 *  the single source of truth for connection lifetime. Session scopes read
 *  the connection from context and never open or close it. The store is the
 *  lane-owned single-writer funnel: every durable append - the writer
 *  service, the lane's leases, and the store's own async surface - goes
 *  through one serialized writer lane over the one writable connection, so
 *  no in-process write can contend on the SQLite write lock.
 *  The optional factory decorates the raw async reader beside that ordered writer.
 *  It must defer reads and writes until a read is selected. Both async state
 *  services share its view; LocalEventStoreService retains the raw connection. */
export function EventStoreLive(filePath: string, readSurface?: EventStoreReadSurfaceFactory): Layer.Layer<LocalEventStoreServices> {
  return Layer.effectContext(
    Effect.acquireRelease(
      Effect.sync(() => {
        const start = performance.now()
        const store = createRuntimeEventStore(filePath)
        logCompletion(log, "event store live acquire done", { filePath }, { durationMs: durationMs(start), slowMs: SLOW_STORE_LIFECYCLE_MS })
        return store
      }),
      releaseEventStore,
    ).pipe(Effect.map(store => eventStoreContext(store, readSurface))),
  )
}

function eventStoreContext(store: RuntimeEventStore, readSurface?: EventStoreReadSurfaceFactory) {
  // One object serves reads and writes, so a registry keyed by the store's
  // identity, such as the live session control registry, sees the same key from either. It
  // carries only the async surfaces: the synchronous connection stays behind
  // LocalEventStoreService, so no consumer of this object can reach it.
  const writer = asAsyncEventWriter(store)
  const rawReader = asAsyncEventReadSurface(store)
  const state: RuntimeEventState = {
    ...writer,
    ...(readSurface ? readSurface(rawReader, writer) : rawReader),
    writerLane: store.writerLane,
    onStored: store.onStored,
    close: store.close,
  }
  return Context.make(EventReaderService, state).pipe(
    Context.add(EventStoreWriterService, store),
    Context.add(EventStoreWriterLaneService, store.writerLane),
    Context.add(EventStoreService, state),
    Context.add(LocalEventStoreService, store),
  )
}

function releaseEventStore(store: RuntimeEventStore): Effect.Effect<void> {
  return Effect.promise(async () => {
    const start = performance.now()
    try {
      await store.close()
    } catch (err) {
      log.error("event store release failed", { durationMs: durationMs(start), error: errorMessage(err), errorDetail: errorDetail(err) })
      throw err instanceof Error ? err : new Error(errorMessage(err))
    }
    logCompletion(log, "event store release done", {}, { durationMs: durationMs(start), slowMs: SLOW_STORE_LIFECYCLE_MS })
  })
}

export type EventStoreRuntime = ManagedRuntime.ManagedRuntime<EventStoreServices, never>
export type LocalEventStoreRuntime = ManagedRuntime.ManagedRuntime<LocalEventStoreServices, never>
