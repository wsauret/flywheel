import type { EventStoreAppend, EventStoreItemSettlement, EventStoreWriteItem, GuardedAppendResult, GuardedEventStoreAppend, InFlightSwap, StoredFact } from "./event-store-types.js"
import type { SessionContentNodeRow } from "./session-content.js"
import type { DurableOwner } from "./durable-owner.js"

export type EventStoreWriterLaneState = "open" | "draining" | "disposed"
export type PendingEventState = "queued" | "submitted" | "acked" | "failed"

export interface EventStoreWriterLaneConfig {
  readonly maxQueuedEvents: number
  readonly maxQueuedBytes: number
  readonly maxBatchEvents: number
  readonly maxBatchBytes: number
}

export interface EventStoreWriterFailure {
  readonly message: string
}

export interface EventStorePendingTicket {
  readonly id: number
  readonly sessionId: string
  readonly acceptedAt: number
  readonly bytes: number
  state(): PendingEventState
  /** Resolves with the stored fact when the item's flush commits; rejects with
   *  the real storage error when it does not. The lane keeps its own rejection handler on
   *  this promise, so a caller that drops it never raises an unhandled
   *  rejection. */
  readonly commit: Promise<StoredFact>
}

export type EventStoreEnqueueResult =
  | {
    readonly kind: "accepted"
    readonly ticket: EventStorePendingTicket
    readonly commit: Promise<StoredFact>
    readonly queuedEvents: number
    readonly queuedBytes: number
  }
  | {
    readonly kind: "pressure"
    readonly reason: "queued_events" | "queued_bytes"
    readonly queuedEvents: number
    readonly queuedBytes: number
    readonly maxQueuedEvents: number
    readonly maxQueuedBytes: number
    readonly retryAfterMs: number
  }
  | {
    readonly kind: "closed"
    readonly state: "draining" | "disposed"
    readonly scope: "lane" | "lease"
    readonly message: string
  }
  | { readonly kind: "invalid"; readonly message: string }

export type EventStoreDrainResult =
  | { readonly kind: "drained"; readonly acked: readonly StoredFact[] }
  | { readonly kind: "failed"; readonly error: EventStoreWriterFailure; readonly acked: readonly StoredFact[] }

export interface EventStoreWriterLaneSnapshot {
  readonly state: EventStoreWriterLaneState
  readonly queuedEvents: number
  readonly queuedBytes: number
  readonly submittedEvents: number
}

export interface EventStoreWriterLease {
  readonly sessionId: string
  enqueue(event: EventStoreAppend): EventStoreEnqueueResult
  flush(): Promise<EventStoreDrainResult>
  drain(): Promise<EventStoreDrainResult>
  dispose(): void
}

export interface EventStoreWriterLane {
  /** Stage at most SESSION_CONTENT_STAGE_BYTES of canonical nodes per item.
   * Children precede parents. Commit adds no facts or sequence positions. */
  stageSessionContentNodes(sessionId: string, nodes: readonly SessionContentNodeRow[]): Promise<void>
  lease(owner: DurableOwner): EventStoreWriterLease
  /** Enqueue one complete write item without splitting its facts from its
   * in-flight transitions. Guard conflicts resolve as values. */
  appendWriteItem(item: EventStoreWriteItem): Promise<GuardedAppendResult>
  /** Enqueue one ordinary event as its own item and await its commit. Queue
   * pressure is absorbed by awaiting the in-flight flush and retrying. */
  append(event: EventStoreAppend): Promise<StoredFact>
  /** Enqueue the events as one atomic item: they all land in one committed
   *  unit or the promise rejects with the real error and none of them land.
   *  Other items in the same flush are unaffected either way. */
  appendBatch(events: readonly EventStoreAppend[]): Promise<StoredFact[]>
  appendGuarded(event: GuardedEventStoreAppend): Promise<GuardedAppendResult>
  appendBatchGuarded(events: readonly GuardedEventStoreAppend[]): Promise<GuardedAppendResult>
  /** Writes or retires a standalone recovery cell through the bounded lane.
   * Resolves after commit; rejection means the change was not durable. */
  putInFlight(sessionId: string, kind: string, key: string, payload: unknown): Promise<void>
  dropInFlight(sessionId: string, kind: string, key: string): Promise<void>
  /** Guarded in-flight transition ordered with all fact appends. The payload is
   * serialized before admission and its bytes participate in lane limits. */
  swapInFlight(sessionId: string, kind: string, key: string, expectedRaw: string | null, payload: unknown | null): Promise<boolean>
  swapInFlightBatch(sessionId: string, swaps: readonly InFlightSwap[]): Promise<boolean>
  /** Installs, once, the admission that every later append of a fact or an
   *  in-flight cell passes before the lane accepts it. Content staging alone
   *  passes at once: it lands no state, and the fact that later references
   *  the content passes the admission. A lane with an admission serves no
   *  leases, because a lease enqueues synchronously and could not wait for it. */
  admitWritesThrough(admission: EventStoreWriteAdmission): void
  flush(): Promise<EventStoreDrainResult>
  dispose(): Promise<EventStoreDrainResult>
  state(): EventStoreWriterLaneState
  snapshot(): EventStoreWriterLaneSnapshot
}

/** Holds an append until the sessions it writes may take new writes, or
 *  returns null when they may take them now, so an ordinary append pays no
 *  extra turn. A rejection refuses the append. */
export type EventStoreWriteAdmission = (sessionIds: readonly string[]) => Promise<void> | null

/** The lane's substrate boundary: one flush transaction per call, one
 *  settlement per item. See `EventStoreItemSettlement` in event-store-types. */
export interface EventStoreBatchWriter {
  commitItems(items: ReadonlyArray<EventStoreWriteItem>): EventStoreItemSettlement[] | Promise<EventStoreItemSettlement[]>
}
