import { errorDetail, errorMessage } from "./error-message.js"
import { InFlightSwapConflictError, PersistenceWriteRefused, type EventStoreAppend, type EventStoreWriteItem, type GuardedAppendResult, type GuardedEventStoreAppend, type InFlightSwap, type InFlightWrite, type StoredFact } from "./event-store-types.js"
import { Log } from "./log.js"
import { isSqliteBusyError } from "./sqlite-durability.js"
import { durationMs, logCompletion } from "./operation-log.js"
import { parseSessionContentNodeRow, SESSION_CONTENT_STAGE_BYTES, type SessionContentNodeRow } from "./session-content.js"
import type {
  EventStoreBatchWriter,
  EventStoreDrainResult,
  EventStoreEnqueueResult,
  EventStorePendingTicket,
  EventStoreWriteAdmission,
  EventStoreWriterFailure,
  EventStoreWriterLane,
  EventStoreWriterLaneConfig,
  EventStoreWriterLaneSnapshot,
  EventStoreWriterLaneState,
  EventStoreWriterLease,
  PendingEventState,
} from "./event-store-writer-lane-types.js"

const DEFAULT_EVENT_STORE_WRITER_LANE_CONFIG: EventStoreWriterLaneConfig = {
  maxQueuedEvents: 4_096,
  maxQueuedBytes: 8 * 1024 * 1024,
  maxBatchEvents: 256,
  maxBatchBytes: 1024 * 1024,
}

// A batch the store refused because another connection held the write lock is
// still a valid batch: the lane waits and re-commits it instead of failing
// facts the producer can never re-offer. Patience lives here rather than in a
// longer `busy_timeout` because bun:sqlite spends that timeout inside one
// synchronous call, parking the loop that also publishes UI patches.
const LOCK_RETRY_DELAYS_MS = [10, 20, 40, 50] as const
// Preserve the former four native 5s waits plus the three cooperative delays.
const LOCK_RETRY_BUDGET_MS = 20_525
// Pressure retry hint: flushes are microtask-scheduled, so pressure clears as
// soon as the caller yields; this only paces the retry loop.
const PRESSURE_RETRY_MS = 25
// Bound on the append()/appendBatch() pressure-retry loop: each attempt awaits
// a full flush, so exhausting this many means producers outrun the substrate.
const MAX_APPEND_ATTEMPTS = 8
const MAX_CONTINUOUS_WORK_MS = 4
/** A final drain this slow holds a project's close where a person waits. */
const SLOW_LANE_DRAIN_MS = 1_000
const log = Log.create({ service: "event-store-writer-lane" })

type DeferredCommit = {
  readonly promise: Promise<GuardedAppendResult>
  readonly resolve: (result: GuardedAppendResult) => void
  readonly reject: (error: unknown) => void
}

/** One queue entry: one or more appends committed and settled as a unit. A
 *  lease enqueue and lane.append() carry one event; lane.appendBatch() carries
 *  the whole atomic batch. */
interface PendingItem {
  readonly id: number
  readonly sessionId: string
  readonly acceptedAt: number
  readonly bytes: number
  readonly events: readonly GuardedEventStoreAppend[]
  readonly inFlight?: readonly InFlightWrite[]
  readonly sessionContentNodes?: readonly SessionContentNodeRow[]
  readonly units: number
  readonly commit: DeferredCommit
  readonly owner?: Set<PendingItem>
  state: PendingEventState
}

/** Serializes accepted items through commit and drain. The clock must be
 * monotonic; sleep and nextTurn must yield to the event loop. */
export function createEventStoreWriterLane(
  writer: EventStoreBatchWriter,
  config: Partial<EventStoreWriterLaneConfig> = {},
  time: { now(): number; sleep(ms: number): Promise<void>; nextTurn?(): Promise<void> } = {
    now: () => performance.now(),
    sleep: (ms) => Bun.sleep(ms),
  },
): EventStoreWriterLane {
  const cfg = { ...DEFAULT_EVENT_STORE_WRITER_LANE_CONFIG, ...config }
  const nextTurn = time.nextTurn ?? (() => Bun.sleep(0))
  const queue: PendingItem[] = []
  const submitted = new Set<PendingItem>()

  let laneState: EventStoreWriterLaneState = "open"
  let queuedEvents = 0
  let queuedBytes = 0
  let nextId = 1
  let flushScheduled = false
  let flushing: Promise<EventStoreDrainResult> | null = null
  let disposal: Promise<EventStoreDrainResult> | null = null
  let turn: { startedAt: number; ended: Promise<void> } | null = null
  let admission: EventStoreWriteAdmission | null = null
  let leased = false

  function admitWritesThrough(next: EventStoreWriteAdmission): void {
    if (admission) throw new Error("event writer lane already has a write admission")
    if (leased) throw new Error("event writer lane with leases cannot take a write admission")
    admission = next
  }

  function lease(owner: import("./durable-owner.js").DurableOwner): EventStoreWriterLease {
    if (admission) throw new Error("event writer lane with a write admission serves no leases")
    leased = true
    const sessionId = owner.kind === "session" ? owner.sessionId : owner.workflowId
    const aggregateId = `${owner.kind}:${sessionId}`
    let leaseState: "open" | "draining" | "disposed" = "open"
    const items = new Set<PendingItem>()

    async function flushLease(): Promise<EventStoreDrainResult> {
      const start = performance.now()
      const accepted = [...items]
      log.debug("lease flush start", { sessionId, items: accepted.length, laneState })
      if (accepted.length === 0) {
        const result = { kind: "drained" as const, acked: [] }
        log.debug("lease flush done", { sessionId, kind: result.kind, acked: 0, durationMs: durationMs(start) })
        return result
      }

      await flush()
      const settlements = await Promise.allSettled(accepted.map((item) => item.commit.promise))
      const acked = settlements.flatMap((settled) =>
        settled.status === "fulfilled" && settled.value.kind === "stored" ? [...settled.value.events] : [])
      for (const item of accepted) items.delete(item)
      const failed = settlements.find((settled) => settled.status === "rejected")
      const result = failed
        ? { kind: "failed" as const, error: { message: errorMessage(failed.reason) }, acked }
        : { kind: "drained" as const, acked }
      log.debug("lease flush done", { sessionId, kind: result.kind, accepted: accepted.length, acked: acked.length, durationMs: durationMs(start) })
      return result
    }

    return {
      sessionId,
      enqueue(event) {
        if (leaseState !== "open") return closed(leaseState, "lease", leaseState === "disposed" ? "session event writer disposed" : "session event writer draining")
        if (event.sessionId !== sessionId || event.aggregateId !== aggregateId) {
          return { kind: "invalid", message: `event does not belong to ${aggregateId}` }
        }
        return enqueueEvent(event, items)
      },
      flush() {
        return flushLease()
      },
      async drain() {
        const wasDisposed = leaseState === "disposed"
        if (!wasDisposed) leaseState = "draining"
        const start = performance.now()
        log.debug("lease drain start", { sessionId, items: items.size, laneState })
        try {
          const result = await flushLease()
          log.debug("lease drain done", { sessionId, kind: result.kind, acked: result.acked.length, durationMs: durationMs(start) })
          return result
        } finally {
          if (!wasDisposed && leaseState === "draining") leaseState = "open"
        }
      },
      dispose() {
        leaseState = "disposed"
      },
    }
  }

  function enqueueEvent(event: EventStoreAppend, owner?: Set<PendingItem>): EventStoreEnqueueResult {
    const result = enqueueItem([event], owner)
    if (result.kind !== "item") return result
    const item = result.item
    const commit = item.commit.promise.then((settlement) => {
      if (settlement.kind === "conflict") throw new Error("unguarded lease append produced an aggregate sequence conflict")
      // SAFETY: a stored settlement returns one fact per append; this item carries exactly one.
      return settlement.events[0]!
    })
    // The lane's own handler: an abandoned commit must never surface as an
    // unhandled rejection; awaiting callers still observe the real error.
    commit.catch(() => {})
    const ticket = createTicket(item, commit)
    return { kind: "accepted", ticket, commit, queuedEvents, queuedBytes }
  }

  type ItemEnqueueResult = { kind: "item"; item: PendingItem } | Exclude<EventStoreEnqueueResult, { kind: "accepted" }>

  function enqueueItem(
    events: readonly GuardedEventStoreAppend[],
    owner?: Set<PendingItem>,
    inFlight?: readonly InFlightWrite[],
    operationSessionId?: string,
    sessionContentNodes?: readonly SessionContentNodeRow[],
  ): ItemEnqueueResult {
    if (laneState === "draining" || laneState === "disposed") {
      return closed(laneState, "lane", `event writer lane is ${laneState}`)
    }

    const serialized = events.map(serializeEvent)
    const serializedInFlight = inFlight?.map(serializeInFlightWrite)
    const nodes = sessionContentNodes?.map(parseSessionContentNodeRow)
    const nodeBytes = nodes ? Buffer.byteLength(JSON.stringify(nodes)) : 0
    if (nodeBytes > SESSION_CONTENT_STAGE_BYTES) return { kind: "invalid", message: "session content staging set exceeds its encoded limit" }
    const units = Math.max(1, serialized.length)
    const sessionId = operationSessionId ?? serialized[0]?.sessionId
    if (!sessionId) return { kind: "invalid", message: "writer lane item has no session" }
    const bytes = serialized.reduce((sum, event) => sum + eventBytes(event, event.payloadJson), 0)
      + (serializedInFlight ? serializedInFlight.reduce((sum, write) => sum + inFlightBytes(write), Buffer.byteLength(sessionId)) : 0)
      + nodeBytes

    if (queuedEvents + units > cfg.maxQueuedEvents) return pressure("queued_events", sessionId, serialized, bytes)
    // A single atomic item reaches the substrate even when it exceeds the
    // queue's memory target. Only the transport knows its complete wire size.
    if (queuedBytes > 0 && queuedBytes + bytes > cfg.maxQueuedBytes) return pressure("queued_bytes", sessionId, serialized, bytes)

    const item: PendingItem = {
      id: nextId,
      sessionId,
      acceptedAt: Date.now(),
      bytes,
      events: serialized,
      ...(serializedInFlight && serializedInFlight.length > 0 ? { inFlight: serializedInFlight } : {}),
      ...(nodes ? { sessionContentNodes: nodes } : {}),
      units,
      commit: deferredCommit(),
      ...(owner ? { owner } : {}),
      state: "queued",
    }
    nextId += 1
    queue.push(item)
    queuedEvents += units
    queuedBytes += bytes
    scheduleFlush()

    owner?.add(item)
    return { kind: "item", item }
  }

  /** Async writer surface over the lane: one event, one item, awaited commit.
   *  Queue pressure is drained by awaiting the flush and retrying in place. */
  async function append(event: EventStoreAppend): Promise<StoredFact> {
    // SAFETY: appendBatch stores one fact per append; we pass exactly one.
    return (await appendBatch([event]))[0]!
  }

  async function appendBatch(events: readonly EventStoreAppend[]): Promise<StoredFact[]> {
    if (events.length === 0) return []
    const result = await appendItem(events)
    if (result.kind === "conflict") throw new Error("unguarded append produced an aggregate sequence conflict")
    return [...result.events]
  }

  function appendGuarded(event: GuardedEventStoreAppend): Promise<GuardedAppendResult> {
    return appendBatchGuarded([event])
  }

  function appendBatchGuarded(events: readonly GuardedEventStoreAppend[]): Promise<GuardedAppendResult> {
    if (events.length > 0 && !events.some((event) => event.expectedSeq !== undefined)) {
      throw new Error("guarded append batch requires expectedSeq")
    }
    if (events.length === 0) return Promise.resolve({ kind: "stored", events: [] })
    return appendItem(events)
  }

  function appendWriteItem(item: EventStoreWriteItem): Promise<GuardedAppendResult> {
    return appendItem(item.events, item.inFlight, item.sessionId, item.sessionContentNodes)
  }

  async function stageSessionContentNodes(sessionId: string, nodes: readonly SessionContentNodeRow[]): Promise<void> {
    await appendWriteItem({ sessionId, events: [], sessionContentNodes: nodes })
  }

  async function appendItem(
    events: readonly GuardedEventStoreAppend[],
    inFlight?: readonly InFlightWrite[],
    sessionId?: string,
    sessionContentNodes?: readonly SessionContentNodeRow[],
  ): Promise<GuardedAppendResult> {
    // Content staging alone lands no fact and no cell: it adds immutable
    // content that a later fact references, and that fact waits here. A read
    // stages content too, when it normalizes historical facts, and a held
    // projection's catch-up is one read that several recoveries join. Holding
    // the catch-up of one recovery for the session another recovery is
    // repairing, while that recovery waits for the same catch-up, never ends.
    const landsState = events.length > 0 || (inFlight?.length ?? 0) > 0
    const held = landsState ? admission?.(writtenSessionIds(events, sessionId)) : null
    if (held) await held
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt += 1) {
      const result = enqueueItem(events, undefined, inFlight, sessionId, sessionContentNodes)
      if (result.kind === "item") return result.item.commit.promise
      if (result.kind !== "pressure") {
        throw new Error(`event writer lane refused the append: ${result.kind}${"reason" in result ? ` (${result.reason})` : ""}${"message" in result ? ` ${result.message}` : ""}`)
      }
      // A full flush empties the queue, so one await normally clears pressure;
      // the attempt cap only guards a sustained producer flood.
      await flush()
    }
    throw new Error(`event writer lane append attempts exhausted under queue pressure (${MAX_APPEND_ATTEMPTS} attempts)`)
  }

  async function putInFlight(sessionId: string, kind: string, key: string, payload: unknown): Promise<void> {
    const result = await appendItem([], [{ op: "put", kind, key, payload }], sessionId)
    if (result.kind === "conflict") throw new Error("unguarded in-flight write produced an aggregate sequence conflict")
  }

  async function dropInFlight(sessionId: string, kind: string, key: string): Promise<void> {
    const result = await appendItem([], [{ op: "drop", kind, key }], sessionId)
    if (result.kind === "conflict") throw new Error("unguarded in-flight write produced an aggregate sequence conflict")
  }

  async function swapInFlight(
    sessionId: string,
    kind: string,
    key: string,
    expectedRaw: string | null,
    payload: unknown | null,
  ): Promise<boolean> {
    return swapInFlightBatch(sessionId, [{ op: "swap", kind, key, expectedRaw, payload }])
  }

  async function swapInFlightBatch(
    sessionId: string,
    swaps: readonly InFlightSwap[],
  ): Promise<boolean> {
    if (swaps.length === 0) return true
    if (swaps.some((swap) => swap.expectedRaw === null && swap.payload === null)) {
      throw new Error("swapInFlight cannot expect absence and write absence")
    }
    try {
      const result = await appendItem([], swaps, sessionId)
      if (result.kind === "conflict") throw new Error("in-flight swap produced an aggregate sequence conflict")
      return true
    } catch (error) {
      if (error instanceof InFlightSwapConflictError) return false
      throw error
    }
  }

  // Microtask-scheduled, deliberately not a timer: fact persistence is the
  // durability path, and a starved event loop wedges the timer wheel long
  // before it stops draining microtasks (2026-07-07 incident: a 25ms flush
  // timer stalled fact persistence ~6 minutes behind fact creation). A
  // microtask still coalesces every item enqueued in the current synchronous
  // burst -- and flushes a lone enqueue promptly with no batch-peer wait --
  // while flushLoop's drain absorbs anything enqueued mid-flush. Sustained
  // work yields between transactions after one shared event-loop slice.
  function scheduleFlush(): void {
    if (flushScheduled || flushing) return
    flushScheduled = true
    queueMicrotask(() => {
      flushScheduled = false
      void flush()
    })
  }

  async function flush(): Promise<EventStoreDrainResult> {
    if (flushing) {
      log.debug("lane flush join", { ...snapshot() })
      return flushing
    }
    log.debug("lane flush start", { ...snapshot() })
    const start = performance.now()
    // The finally reschedules when the queue refilled between flushLoop's
    // final empty check and this clear: an enqueue in that window saw
    // `flushing` set and no-oped, so without this its commit never resolves.
    flushing = flushLoop().finally(() => {
      flushing = null
      if (queue.length > 0) scheduleFlush()
    })
    const result = await flushing
    log.debug("lane flush done", { ...snapshot(), kind: result.kind, acked: result.acked.length, durationMs: durationMs(start) })
    return result
  }

  async function flushLoop(): Promise<EventStoreDrainResult> {
    const acked: StoredFact[] = []
    let flushFailure: EventStoreWriterFailure | null = null
    while (queue.length > 0) {
      await yieldIfNeeded()
      const batch = takeBatch()
      for (const item of batch) {
        item.state = "submitted"
        submitted.add(item)
      }

      try {
        const settlements = await commitItems(batch)
        if (settlements.length !== batch.length) throw new Error(`event writer settled ${settlements.length} of ${batch.length} items`)
        for (let i = 0; i < batch.length; i += 1) {
          // SAFETY: i < batch.length, so the index is in bounds.
          const item = batch[i]!
          // SAFETY: the length check above proved settlements.length === batch.length.
          const settlement = settlements[i]!
          if (settlement.kind === "stored") {
            item.state = "acked"
            item.commit.resolve(settlement)
            acked.push(...settlement.events)
          } else if (settlement.kind === "conflict") {
            item.state = "acked"
            item.commit.resolve(settlement)
          } else {
            flushFailure ??= { message: errorMessage(settlement.error) }
            failItem(item, settlement.error)
          }
          submitted.delete(item)
          if (settlement.kind !== "rejected") clearOwner(item)
        }
      } catch (err) {
        // The whole flush transaction failed (or the writer misbehaved): every
        // item of THIS batch rejects with the real error, and the lane stays
        // open for everything queued behind it -- callers decide what a
        // persistence failure means for them.
        flushFailure = { message: errorMessage(err) }
        log.error("lane batch failed; lane stays open", { ...snapshot(), batchItems: batch.length, error: flushFailure.message, errorDetail: errorDetail(err) })
        for (const item of batch) {
          failItem(item, err)
          submitted.delete(item)
        }
      }
    }

    async function commitItems(batch: readonly PendingItem[]) {
      const start = performance.now()
      log.debug("lane batch commit start", batchFields(batch))
      const items: EventStoreWriteItem[] = batch.map((item) => ({
        sessionId: item.sessionId,
        events: item.events,
        ...(item.inFlight ? { inFlight: item.inFlight } : {}),
        ...(item.sessionContentNodes ? { sessionContentNodes: item.sessionContentNodes } : {}),
      }))
      const settlements = await commitThroughLockContention(items, batch)
      const conflicts = settlements.filter((settlement) => settlement.kind === "conflict").length
      const rejected = settlements.filter((settlement) => settlement.kind === "rejected").length
      log.debug("lane batch commit done", { ...batchFields(batch), conflicts, rejected, durationMs: durationMs(start) })
      return settlements
    }

    async function commitThroughLockContention(items: readonly EventStoreWriteItem[], batch: readonly PendingItem[]) {
      const deadline = time.now() + LOCK_RETRY_BUDGET_MS
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await writer.commitItems(items)
        } catch (err) {
          const remainingMs = deadline - time.now()
          if (!isSqliteBusyError(err) || remainingMs <= 0) throw err
          const delayMs = Math.min(LOCK_RETRY_DELAYS_MS[attempt] ?? LOCK_RETRY_DELAYS_MS[3], remainingMs)
          log.warn("lane batch deferred by the store write lock; retrying", { ...batchFields(batch), attempt: attempt + 1, delayMs })
          await time.sleep(delayMs)
          if (time.now() >= deadline) throw err
        }
      }
    }

    return flushFailure ? { kind: "failed", error: flushFailure, acked } : { kind: "drained", acked }
  }

  // One slice spans successive flushes: each may empty before the producer's
  // next microtask refills it. The turn marker resets an idle lane without
  // making its next lone enqueue wait for a timer.
  async function yieldIfNeeded(): Promise<void> {
    if (turn && time.now() - turn.startedAt >= MAX_CONTINUOUS_WORK_MS) await turn.ended
    if (!turn) {
      turn = { startedAt: time.now(), ended: nextTurn().then(() => { turn = null }) }
    }
  }

  function takeBatch(): PendingItem[] {
    const batch: PendingItem[] = []
    let batchEvents = 0
    let batchBytes = 0
    while (queue.length > 0 && (batchEvents < cfg.maxBatchEvents || batch.length === 0)) {
      // SAFETY: the loop guard requires queue.length > 0, so index 0 is present.
      const next = queue[0]!
      if (batch.length > 0 && batchBytes + next.bytes > cfg.maxBatchBytes) break
      queue.shift()
      queuedEvents -= next.units
      queuedBytes -= next.bytes
      batch.push(next)
      batchEvents += next.units
      batchBytes += next.bytes
    }
    return batch
  }

  function failItem(item: PendingItem, error: unknown): void {
    if (item.state === "acked" || item.state === "failed") return
    item.state = "failed"
    if (!(error instanceof PersistenceWriteRefused)) log.warn("lane item rejected", { sessionId: item.sessionId, events: item.events.length, factTypes: [...new Set(item.events.map((event) => event.type))].slice(0, 12), error: errorMessage(error) })
    item.commit.reject(error)
  }

  function clearOwner(item: PendingItem): void {
    item.owner?.delete(item)
  }

  /** The durable drain authority: one settlement, however many callers ask for it.
   *  The lane stops admitting first, so the flush below is the last write this lane
   *  will ever make, and its result is what every caller reads - a repeat cannot
   *  report a clean drain over a final batch that failed. */
  function dispose(): Promise<EventStoreDrainResult> {
    disposal ??= drain()
    return disposal
  }

  async function drain(): Promise<EventStoreDrainResult> {
    // What the lane held when disposal began is what the drain had to write.
    const held = snapshot()
    const start = performance.now()
    laneState = "draining"
    // Dispose always disposes: a failed final batch already rejected its
    // items' commits, so there is nothing left to hold the lane open for.
    const result = await flush()
    await turn?.ended
    laneState = "disposed"
    // A step of the shutdown barrier, which records the whole; this record
    // reaches the default level only when the final drain failed or ran slow.
    const fields = { queuedEvents: held.queuedEvents, queuedBytes: held.queuedBytes, submittedEvents: held.submittedEvents, kind: result.kind, acked: result.acked.length }
    if (result.kind === "drained") logCompletion(log, "lane dispose done", fields, { durationMs: durationMs(start), slowMs: SLOW_LANE_DRAIN_MS })
    else log.warn("lane dispose done", { ...fields, error: result.error.message, durationMs: durationMs(start) })
    return result
  }

  function snapshot(): EventStoreWriterLaneSnapshot {
    return {
      state: laneState,
      queuedEvents,
      queuedBytes,
      submittedEvents: [...submitted].reduce((sum, item) => sum + item.units, 0),
    }
  }

  function pressure(reason: "queued_events" | "queued_bytes", sessionId: string, events: readonly EventStoreAppend[], bytes: number): Extract<EventStoreEnqueueResult, { kind: "pressure" }> {
    log.warn("lane pressure", { reason, sessionId, factTypes: [...new Set(events.map((event) => event.type))].slice(0, 12), bytes, queuedEvents, queuedBytes, maxQueuedEvents: cfg.maxQueuedEvents, maxQueuedBytes: cfg.maxQueuedBytes })
    return {
      kind: "pressure",
      reason,
      queuedEvents,
      queuedBytes,
      maxQueuedEvents: cfg.maxQueuedEvents,
      maxQueuedBytes: cfg.maxQueuedBytes,
      retryAfterMs: PRESSURE_RETRY_MS,
    }
  }

  return {
    stageSessionContentNodes,
    lease,
    appendWriteItem,
    admitWritesThrough,
    append,
    appendBatch,
    appendGuarded,
    appendBatchGuarded,
    putInFlight,
    dropInFlight,
    swapInFlight,
    swapInFlightBatch,
    flush,
    dispose,
    state: () => laneState,
    snapshot,
  }
}

/** The sessions an item writes: its own and the session of each fact. */
function writtenSessionIds(events: readonly GuardedEventStoreAppend[], sessionId: string | undefined): readonly string[] {
  const ids = new Set(events.map((event) => event.sessionId))
  if (sessionId !== undefined) ids.add(sessionId)
  return [...ids]
}

function createTicket(item: PendingItem, commit: Promise<StoredFact>): EventStorePendingTicket {
  return {
    id: item.id,
    sessionId: item.sessionId,
    acceptedAt: item.acceptedAt,
    bytes: item.bytes,
    state: () => item.state,
    commit,
  }
}

function batchFields(batch: readonly PendingItem[]) {
  const events = batch.flatMap((item) => item.events)
  return {
    items: batch.length,
    events: events.length,
    bytes: batch.reduce((sum, item) => sum + item.bytes, 0),
    factTypes: [...new Set(events.map((event) => event.type))].slice(0, 12),
    sessions: [...new Set(events.map((event) => event.sessionId))].slice(0, 12),
  }
}

interface SerializedEventStoreAppend extends GuardedEventStoreAppend {
  payloadJson: string
}

/** True queued size: the serialized payload plus the append's other string
 *  columns and its content-row sidecar, as UTF-8 bytes. Content rows count
 *  because the store writes them with the event, so the byte limits keep
 *  bounding exactly what one commit will write. */
function eventBytes(event: GuardedEventStoreAppend, payloadJson: string): number {
  return Buffer.byteLength(payloadJson)
    + Buffer.byteLength(event.aggregateId)
    + Buffer.byteLength(event.type)
    + Buffer.byteLength(event.actor)
    + Buffer.byteLength(event.sessionId)
    + Buffer.byteLength(event.runId ?? "")
    + Buffer.byteLength(event.parentEventId ?? "")
    + Buffer.byteLength(event.causedByEventId ?? "")
    + (event.contentRows ?? []).reduce((sum, row) => sum + Buffer.byteLength(row.content) + Buffer.byteLength(row.sha256), 0)
    + (event.inFlight ?? []).reduce((sum, write) => sum + inFlightBytes(write), 0)
}

function serializeEvent(event: GuardedEventStoreAppend): SerializedEventStoreAppend {
  return {
    ...event,
    payloadJson: event.payloadJson ?? JSON.stringify(event.payload),
    ...(event.inFlight ? { inFlight: event.inFlight.map(serializeInFlightWrite) } : {}),
  }
}

function serializeInFlightWrite(write: InFlightWrite): InFlightWrite {
  if (write.op === "put") return { ...write, payloadJson: write.payloadJson ?? JSON.stringify(write.payload) }
  if (write.op === "swap") return { ...write, payloadJson: write.payloadJson ?? (write.payload === null ? null : JSON.stringify(write.payload)) }
  return write
}

function inFlightBytes(write: InFlightWrite): number {
  let bytes = Buffer.byteLength(write.op)
  if ("kind" in write) bytes += Buffer.byteLength(write.kind)
  if ("key" in write) bytes += Buffer.byteLength(write.key)
  if ((write.op === "drop" || write.op === "swap") && write.sessionId !== undefined) bytes += Buffer.byteLength(write.sessionId)
  if (write.op === "put") bytes += Buffer.byteLength(write.payloadJson ?? JSON.stringify(write.payload))
  if (write.op === "swap") bytes += Buffer.byteLength(write.expectedRaw ?? "") + Buffer.byteLength(write.payloadJson ?? "")
  return bytes
}

function deferredCommit(): DeferredCommit {
  let resolve!: (result: GuardedAppendResult) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<GuardedAppendResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  // The lane's own handler: an abandoned commit must never surface as an
  // unhandled rejection; awaiting callers still observe the real error.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function closed(state: "draining" | "disposed", scope: "lane" | "lease", message: string): Extract<EventStoreEnqueueResult, { kind: "closed" }> {
  return { kind: "closed", state, scope, message }
}
