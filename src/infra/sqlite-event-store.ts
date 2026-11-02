import { constants, Database } from "bun:sqlite"
import * as crypto from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import * as path from "node:path"

import { errorDetail, errorMessage } from "./error-message.js"
import { factRetention } from "./fact-retention-registry.js"
import {
  InFlightSwapConflictError,
  type AsyncGuardedEventWriter,
  type EventStoreAppend,
  type EventStoreItemSettlement,
  type EventStoreWriteItem,
  type EventStoreReadSurface,
  type GuardedAppendResult,
  type GuardedEventStoreAppend,
  type InFlightSwap,
  type LocalSqliteEventStore,
  type StoredFact,
} from "./event-store-types.js"
import { createEventStoreWriterLane } from "./event-store-writer-lane.js"
import type { EventStoreWriterLane } from "./event-store-writer-lane-types.js"
import { Log } from "./log.js"
import { createSqliteEventReadSurface } from "./sqlite-event-read-surface.js"
import { applySqliteBusyTimeout, isSqliteBusyError } from "./sqlite-durability.js"
import { configureSqliteEventStore, createSqliteEventInserter, factRowsChanged, SqliteAggregateSeqConflict, type SqliteEventInsert } from "./sqlite-event-store-core.js"
import { admitPrivateDatabaseFiles, ensurePrivateDirectoryUnder, ensurePrivateFile } from "./private-path.js"
import type { SessionContentNodeRow } from "./session-content.js"

const log = Log.create({ service: "sqlite-event-store" })

/** The runtime's event store: the process's single writable connection with
 *  every durable append and recovery-cell write in one serialized lane, so
 *  in-process write contention is structurally impossible. The write surface
 *  is async - each append resolves with its stored fact when the owning flush
 *  commits. Guard conflicts return typed outcomes; real storage failures
 *  reject. The read surface stays the shared synchronous one. Lane commits
 *  return lock contention immediately for cooperative retry; acquisition and
 *  synchronous maintenance keep the 5s native lock wait. */
export interface RuntimeEventStore extends EventStoreReadSurface, AsyncGuardedEventWriter {
  /** The single writer lane over this connection: lease creation for
   *  session-scoped streaming writers, plus flush/drain control. */
  readonly writerLane: EventStoreWriterLane
  /** Post-commit broadcast of every fact stored through this connection.
   *  Fires synchronously after the owning flush commit (never for a
   *  rolled-back fact). Returns the unsubscribe. */
  onStored(listener: (events: readonly StoredFact[]) => void): () => void
  /** Drains the writer lane, then closes the connection. */
  close(): Promise<void>
}

/** The lane-owned runtime store. The synchronous `createSqliteEventStore`
 *  shape remains only for cross-process tooling connections (maintenance,
 *  migrations, CLI commands, tests) that never share the runtime's hot path. */
export function createRuntimeEventStore(filePath: string): RuntimeEventStore {
  const store = openSqliteEventStore(filePath, "cooperative")
  const lane = createEventStoreWriterLane(store)
  return {
    ...readSurfaceOf(store),
    append: (event) => lane.append(event),
    appendBatch: (events) => lane.appendBatch(events),
    appendGuarded: (event) => lane.appendGuarded(event),
    appendBatchGuarded: (events) => lane.appendBatchGuarded(events),
    stageSessionContentNodes: (sessionId, nodes) => lane.stageSessionContentNodes(sessionId, nodes),
    // Maintenance mutations, not appends: they run directly between flush
    // transactions (each flush is one synchronous SQLite transaction, so no
    // interleaving is possible) and stay off the ordered append funnel.
    pruneSupersededEvents: async (aggregateId, eventType) => store.pruneSupersededEvents(aggregateId, eventType),
    pruneSupersededKeyedEvents: async (aggregateId, eventType, payloadKey) => store.pruneSupersededKeyedEvents(aggregateId, eventType, payloadKey),
    putInFlight: (sessionId, kind, key, payload) => lane.putInFlight(sessionId, kind, key, payload),
    dropInFlight: (sessionId, kind, key) => lane.dropInFlight(sessionId, kind, key),
    swapInFlight: (sessionId, kind, key, expectedRaw, payload) => lane.swapInFlight(sessionId, kind, key, expectedRaw, payload),
    swapInFlightBatch: (sessionId, swaps) => lane.swapInFlightBatch(sessionId, swaps),
    writerLane: lane,
    onStored: store.onStored,
    close: async () => {
      await lane.dispose()
      store.close()
    },
  }
}

function readSurfaceOf(store: EventStoreReadSurface): EventStoreReadSurface {
  return {
    read: store.read.bind(store),
    readTolerant: store.readTolerant.bind(store),
    readLatestPayloadByAggregateAndType: store.readLatestPayloadByAggregateAndType.bind(store),
    readLatestByAggregateAndTypes: store.readLatestByAggregateAndTypes.bind(store),
    currentPosition: store.currentPosition.bind(store),
    countByAggregate: store.countByAggregate.bind(store),
    aggregateSeq: store.aggregateSeq.bind(store),
    readInFlight: store.readInFlight.bind(store),
    sessionsWithInFlight: store.sessionsWithInFlight.bind(store),
    hasInFlightProfile: store.hasInFlightProfile.bind(store),
    foldEvidence: store.foldEvidence.bind(store),
    toolContent: store.toolContent,
    ...(store.readSessionContentNode ? { readSessionContentNode: store.readSessionContentNode.bind(store) } : {}),
  }
}

/** Read-only companion connection for in-process readers that must never hold
 *  write authority (the runtime background Worker): same schema, same read
 *  surface, no write surface, and it never creates the database. */
export function openReadonlyEventReader(filePath: string): EventStoreReadSurface & { close(): void } {
  if (!existsSync(filePath)) throw new Error(`no event store exists at ${filePath}`)
  const db = new Database(filePath, { readonly: true })
  // Cross-process courtesy: ride out a checkpoint or maintenance write lock
  // instead of failing the read immediately.
  db.exec("PRAGMA busy_timeout = 5000")
  return { ...createSqliteEventReadSurface(db), close: () => db.close() }
}

export function createSqliteEventStore(filePath: string): LocalSqliteEventStore {
  return openSqliteEventStore(filePath, "native")
}

function openSqliteEventStore(filePath: string, lockWait: "native" | "cooperative") {
  // SQLite's in-memory name owns no file. Preparing it as a path would leave
  // an empty file named `:memory:` in the working directory, a name that
  // Windows cannot check out.
  if (filePath !== ":memory:") preparePrivateDatabaseFile(filePath)
  const db = new Database(filePath, { create: true })
  configureSqliteEventStore(db)

  const inserter = createSqliteEventInserter(db)
  const readSurface = createSqliteEventReadSurface(db)

  // Cached (db.query) rather than raw-prepared: Bun finalizes cached
  // statements at close, and an unfinalized statement blocks the clean close
  // that deletes the WAL sidecars.
  const beginTxn = db.query("begin immediate")
  const commitTxn = db.query("commit")
  const rollbackTxn = db.query("rollback")

  // Tracks whether `transaction()` is currently holding an open BEGIN IMMEDIATE
  // so that nested `append` calls participate in the outer commit boundary
  // instead of starting (and failing) a nested transaction.
  let inOuterTransaction = false

  // Post-commit broadcast (session-fairness plan, phase 2): every fact stored
  // through this connection notifies in-process subscribers, so hot read paths
  // fold pushed events instead of polling SQLite for freshness. Facts appended
  // inside an outer transaction buffer until its commit - a rolled-back fact
  // must never announce.
  const storedListeners = new Set<(events: readonly StoredFact[]) => void>()
  let transactionBuffer: StoredFact[] = []

  function onStored(listener: (events: readonly StoredFact[]) => void): () => void {
    storedListeners.add(listener)
    return () => { storedListeners.delete(listener) }
  }

  function notifyStored(events: readonly StoredFact[]): void {
    if (events.length === 0) return
    for (const listener of storedListeners) {
      try {
        listener(events)
      } catch (err) {
        log.error("onStored listener failed", { filePath, events: events.length, error: errorMessage(err), errorDetail: errorDetail(err) })
      }
    }
  }

  function prepareLocalEvents(events: readonly GuardedEventStoreAppend[]): SqliteEventInsert[] {
    return events.map((event) => ({ ...event, id: crypto.randomUUID() }))
  }

  function appendBatchRequest(events: readonly GuardedEventStoreAppend[]): GuardedAppendResult {
    if (events.length === 0) return { kind: "stored", events: [] }

    if (inOuterTransaction) {
      const stored = inserter.insertEventRows(prepareLocalEvents(events))
      transactionBuffer.push(...stored)
      return { kind: "stored", events: stored }
    }
    beginTxn.run()
    try {
      const stored = inserter.insertEventRows(prepareLocalEvents(events))
      commitTxn.run()
      notifyStored(stored)
      return { kind: "stored", events: stored }
    } catch (err) {
      try {
        rollbackTxn.run()
      } catch (rollbackErr) {
        log.error("sqlite append rollback failed", { filePath, error: errorMessage(rollbackErr), errorDetail: errorDetail(rollbackErr), appendError: errorMessage(err), appendErrorDetail: errorDetail(err) })
      }
      if (err instanceof SqliteAggregateSeqConflict) {
        log.info("sqlite append refused by seq guard", { filePath, ...err.conflict })
        return { kind: "conflict", conflict: err.conflict }
      }
      log.error("sqlite append batch failed", appendFields(filePath, events, err))
      throw err
    }
  }

  function appendBatch(events: readonly EventStoreAppend[]): StoredFact[] {
    const result = appendBatchRequest(events)
    if (result.kind === "conflict") throw new Error("unguarded append produced an aggregate sequence conflict")
    return [...result.events]
  }

  function append(event: EventStoreAppend): StoredFact {
    // SAFETY: appendBatch returns one StoredFact per input event; we pass exactly one.
    return appendBatch([event])[0]!
  }

  function appendBatchGuarded(events: readonly GuardedEventStoreAppend[]): GuardedAppendResult {
    if (events.length > 0 && !events.some((event) => event.expectedSeq !== undefined)) {
      throw new Error("guarded append batch requires expectedSeq")
    }
    return appendBatchRequest(events)
  }

  function appendGuarded(event: GuardedEventStoreAppend): GuardedAppendResult {
    return appendBatchGuarded([event])
  }

  const deleteAggregateSequence = db.query<unknown, { $aggregateId: string }>(
    "delete from event_sequence where aggregate_id = $aggregateId",
  )

  function deleteAggregate(aggregateId: string): number {
    const deleted = readSurface.countByAggregate(aggregateId)
    deleteAggregateSequence.run({ $aggregateId: aggregateId })
    return deleted
  }

  // Future post-commit effect deferral belongs at this boundary; writes stay synchronous today.
  function transaction(fn: () => void): void {
    if (inOuterTransaction) throw new Error("EventStore.transaction does not support nesting")
    beginTxn.run()
    inOuterTransaction = true
    let committed: StoredFact[] | null = null
    try {
      // fn is typed () => void, but we must observe its real return to reject an
      // accidental async callback; void is assignable to unknown, so no cast needed.
      const result: unknown = fn()
      if (
        ((typeof result === "object" && result !== null) || typeof result === "function")
        && "then" in result
        && typeof result.then === "function"
      ) {
        throw new Error("EventStore.transaction callback must be synchronous; received a Promise/thenable")
      }
      commitTxn.run()
      committed = transactionBuffer
    } catch (err) {
      try {
        rollbackTxn.run()
      } catch (rollbackErr) {
        log.error("sqlite transaction rollback failed", { filePath, error: errorMessage(rollbackErr), errorDetail: errorDetail(rollbackErr), transactionError: errorMessage(err), transactionErrorDetail: errorDetail(err) })
      }
      log.error("sqlite transaction failed", { filePath, error: errorMessage(err), errorDetail: errorDetail(err) })
      throw err
    } finally {
      inOuterTransaction = false
      transactionBuffer = []
    }
    if (committed) notifyStored(committed)
  }

  // Savepoint statements for the writer-lane commit seam. Cached (db.query)
  // for the same clean-close reason as the transaction statements above.
  const beginItem = db.query("savepoint lane_item")
  const releaseItem = db.query("release lane_item")
  // `rollback to` rewinds but keeps the savepoint on the stack; the release
  // after it pops the frame so the next item starts clean.
  const rollbackItem = db.query("rollback to lane_item")

  /** The writer-lane flush: one BEGIN IMMEDIATE for every item, one savepoint
   *  per item so a failing item (a stale seq guard, a malformed row) rejects
   *  alone while its peers commit together. Throws only when the transaction
   *  itself cannot commit, which fails the whole flush at the lane. */
  function commitItems(items: ReadonlyArray<EventStoreWriteItem>): EventStoreItemSettlement[] {
    if (inOuterTransaction) throw new Error("commitItems cannot run inside an open transaction()")
    const settlements: EventStoreItemSettlement[] = []
    const stored: StoredFact[] = []
    if (lockWait === "cooperative") applySqliteBusyTimeout(db, 0)
    try {
      beginTxn.run()
      try {
        for (const request of items) {
          beginItem.run()
          try {
            inserter.stageSessionContentNodes(request.sessionId, request.sessionContentNodes ?? [])
            for (const write of request.inFlight ?? []) inserter.writeInFlight(request.sessionId, write)
            const events = inserter.insertEventRows(prepareLocalEvents(request.events))
            releaseItem.run()
            settlements.push({ kind: "stored", events })
            stored.push(...events)
          } catch (err) {
            rollbackItem.run()
            releaseItem.run()
            if (err instanceof SqliteAggregateSeqConflict) {
              log.info("sqlite item refused by seq guard", { filePath, ...err.conflict })
              settlements.push({ kind: "conflict", conflict: err.conflict })
            } else if (!(err instanceof InFlightSwapConflictError)) {
              log.error("sqlite item append failed", appendFields(filePath, request.events, err))
              settlements.push({ kind: "rejected", error: err })
            } else {
              settlements.push({ kind: "rejected", error: err })
            }
          }
        }
        commitTxn.run()
      } catch (err) {
        try {
          rollbackTxn.run()
        } catch (rollbackErr) {
          log.error("sqlite flush rollback failed", { filePath, error: errorMessage(rollbackErr), errorDetail: errorDetail(rollbackErr), flushError: errorMessage(err), flushErrorDetail: errorDetail(err) })
        }
        log.error("sqlite flush transaction failed", { filePath, items: items.length, error: errorMessage(err), errorDetail: errorDetail(err) })
        throw err
      }
    } finally {
      // onStored subscribers can read this connection synchronously. Restore
      // their native wait before publication, and after BEGIN refusal or rollback.
      if (lockWait === "cooperative") applySqliteBusyTimeout(db, 5000)
    }
    notifyStored(stored)
    return settlements
  }

  const deleteSuperseded = db.query<unknown, { $aggregateId: string; $type: string }>(`
    delete from event
    where aggregate_id = $aggregateId
      and type = $type
      and position < (
        select max(position) from event where aggregate_id = $aggregateId and type = $type
      )
  `)


  /** Records in-flight recovery state for an operation that has just begun.
   *  Standalone because at that moment there is no fact to be atomic with:
   *  the outcome fact comes later and retires this state in its own commit. */
  function putInFlight(sessionId: string, kind: string, key: string, payload: unknown): void {
    inserter.writeInFlight(sessionId, { op: "put", kind, key, payload })
  }

  function stageSessionContentNodes(sessionId: string, nodes: readonly SessionContentNodeRow[]): void {
    const [settlement] = commitItems([{ sessionId, events: [], sessionContentNodes: nodes }])
    if (settlement?.kind === "rejected") throw settlement.error
    if (settlement?.kind !== "stored") throw new Error("Session content staging produced no stored settlement")
  }

  /** Retires one in-flight value outside an append: the settlement with no
   *  fact beside it (a queued input recalled back into the editor). */
  function dropInFlight(sessionId: string, kind: string, key: string): void {
    inserter.writeInFlight(sessionId, { op: "drop", kind, key })
  }

  /** Compare-and-swap on one in-flight cell. Local tooling uses the same exact
   * raw guard as the writer lane, but executes the single SQLite statement
   * directly because it owns this connection synchronously. */
  function swapInFlight(sessionId: string, kind: string, key: string, expectedRaw: string | null, payload: unknown | null): boolean {
    return swapInFlightBatch(sessionId, [{ op: "swap", kind, key, expectedRaw, payload }])
  }

  function swapInFlightBatch(sessionId: string, swaps: readonly InFlightSwap[]): boolean {
    if (swaps.length === 0) return true
    if (swaps.some((swap) => swap.expectedRaw === null && swap.payload === null)) {
      throw new Error("swapInFlight cannot expect absence and write absence")
    }
    const [settlement] = commitItems([{ sessionId, events: [], inFlight: swaps }])
    if (!settlement) throw new Error("In-flight batch swap produced no settlement")
    if (settlement.kind === "stored") return true
    if (settlement.kind === "conflict") throw new Error("in-flight swap produced an aggregate sequence conflict")
    if (settlement.error instanceof InFlightSwapConflictError) return false
    throw settlement.error
  }

  function pruneSupersededEvents(aggregateId: string, eventType: string): number {
    if (inOuterTransaction) throw new Error("pruneSupersededEvents must run out-of-band, not inside append/transaction")
    if (factRetention(eventType)?.policy !== "replace-latest") {
      throw new Error(`pruneSupersededEvents rejected non-replace-latest fact type ${eventType}`)
    }
    deleteSuperseded.run({ $aggregateId: aggregateId, $type: eventType })
    return factRowsChanged(db)
  }

  const deleteSupersededKeyed = db.query<unknown, { $aggregateId: string; $type: string; $key: string }>(`
    delete from event
    where aggregate_id = $aggregateId
      and type = $type
      and position not in (
        select max(position) from event
        where aggregate_id = $aggregateId and type = $type
        group by json_extract(payload, $key)
      )
  `)

  function pruneSupersededKeyedEvents(aggregateId: string, eventType: string, payloadKey: string): number {
    if (inOuterTransaction) throw new Error("pruneSupersededKeyedEvents must run out-of-band, not inside append/transaction")
    const retention = factRetention(eventType)
    if (retention?.policy !== "replace-latest-keyed" || retention.key !== payloadKey) {
      throw new Error(`pruneSupersededKeyedEvents rejected fact type ${eventType} with key ${payloadKey}`)
    }
    deleteSupersededKeyed.run({ $aggregateId: aggregateId, $type: eventType, $key: payloadKey })
    return factRowsChanged(db)
  }




  function close(): void {
    // Fold the WAL back into the main file on clean shutdown (the duty the
    // writer subprocess used to perform) so a workspace at rest is one file.
    // Two switches make the sidecars actually disappear: Bun keeps
    // SQLITE_FCNTL_PERSIST_WAL on by default, and only a database left in
    // rollback-journal mode is openable readonly with no -shm beside it, so
    // the store re-enters WAL on every open. Best-effort: a concurrent
    // connection holds the mode change back, and that must not fail disposal.
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0)
      db.exec("PRAGMA journal_mode = DELETE")
    } catch (err) {
      // Another connection holding the database is the expected case, not a
      // fault: two service lanes share the account store.
      if (isSqliteBusyError(err)) log.debug("sqlite wal fold on close deferred to another connection", { filePath, error: errorMessage(err) })
      else log.warn("sqlite wal fold on close failed", { filePath, error: errorMessage(err) })
    }
    db.close()
  }

  return {
    ...readSurface,
    append,
    appendBatch,
    appendGuarded,
    appendBatchGuarded,
    commitItems,
    stageSessionContentNodes,
    deleteAggregate,
    transaction,
    onStored,
    pruneSupersededEvents,
    pruneSupersededKeyedEvents,
    putInFlight,
    dropInFlight,
    swapInFlight,
    swapInFlightBatch,
    close,
  }
}

function preparePrivateDatabaseFile(filePath: string): void {
  const parent = path.dirname(filePath)
  // Ancestors above the store directory belong to the caller's own tree and keep
  // the caller's modes; the store directory itself is a newly-created private
  // root when absent, so the Windows backend applies its owner ACL once and
  // descendants inherit it.
  mkdirSync(path.dirname(parent), { recursive: true })
  ensurePrivateDirectoryUnder(path.dirname(parent), path.basename(parent))
  // Every name SQLite is about to follow is admitted first: the database and,
  // when they are already there, its sidecars. A link at any of them is refused
  // before the open, because SQLite would follow it out of the workspace.
  admitPrivateDatabaseFiles(filePath)
  ensurePrivateFile(filePath)
}

interface AppendLogFields { [key: string]: unknown }

function appendFields(filePath: string, events: readonly GuardedEventStoreAppend[], err: unknown): AppendLogFields {
  return {
    filePath,
    events: events.length,
    aggregateCount: new Set(events.map((event) => event.aggregateId)).size,
    types: [...new Set(events.map((event) => event.type))],
    error: errorMessage(err),
    errorDetail: errorDetail(err),
  }
}
