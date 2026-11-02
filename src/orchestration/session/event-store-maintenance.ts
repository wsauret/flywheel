import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import { Schema } from "effect"
import { declaredFactRetentionTypes, factRetention } from "../../infra/fact-retention-registry.js"
import { isRecord } from "../../infra/record.js"
import { ToolContentReferenceSchema } from "../../infra/tool-content.js"
import { createToolContentTable, factRowsChanged } from "../../infra/sqlite-event-store-core.js"

/** Rows one prune statement deletes. Bounded so the cross-process write lock
 *  is held for milliseconds: a live runtime's append waits out one chunk, never
 *  a whole family. */
const PRUNE_CHUNK_ROWS = 5_000
/** The window between chunks a competing writer takes the lock in. */
const PRUNE_CHUNK_PAUSE_MS = 15
const VACUUM_MIN_BYTES = 64 * 1024 * 1024
const VACUUM_MIN_RATIO = 0.2
const VACUUM_ALWAYS_BYTES = 512 * 1024 * 1024

/** Historical families no current producer writes durably. Nothing replays
 * them, so existing stores can drop every row. */
export const RETIRED_FACT_TYPES = [
  "model.stream.event_observed",
  "model.stream.started",
  "model.stream.completed",
  "model.assistant_message.recorded",
  "model.user_message.recorded",
  "agent.wait_placeholder.dropped",
  "agent.subagent.dispatched",
  "agent.subagent.queued",
  "agent.subagent_model.selected",
  "agent.workflow_link.published",
  "span.started",
  "span.completed",
  "trace.finalized",
  "file.read",
  // An unfinished turn's fragments, and the marker for a chain that could not
  // be adopted. An interrupted turn is now reported from the facts its actions
  // wrote, so nothing folds either family.
  "chat.entry.provisional",
  "chat.provisionals.discarded",
  // The core-cleanup lease and its cooldowns moved to the in-flight companion
  // table; only skill.cleanup.completed remains a fact. The transition bridge
  // reads these as latest-per-type probes, so pruning is safe once no older
  // binary can still hold a live lease as facts.
  "skill.cleanup.claimed",
  "skill.cleanup.renewed",
  "skill.cleanup.deferred",
  // Dead registration: nothing emits it and every renderer maps it to null.
  "agent.waiting_on_subagents.recorded",
  "session.stats.snapshotted",
] as const

interface EventTypeMaintenanceSummary {
  type: string
  count: number
  payloadBytes: number
}

export interface EventStoreMaintenanceStats {
  storeFound: boolean
  dbPath: string
  dbFileSize: number
  walFileSize: number
  pageCount: number
  pageSize: number
  freelistCount: number
  reclaimableBytes: number
  topByRowCount: EventTypeMaintenanceSummary[]
  topByPayloadBytes: EventTypeMaintenanceSummary[]
  retiredRowCount: number
  retiredPayloadBytes: number
}

export interface RetiredFamilyPruneResult {
  storeFound: boolean
  dbPath: string
  /** Families that had rows to delete this run; an already-clean store yields an empty list. */
  deletedByType: EventTypeMaintenanceSummary[]
  rowsDeleted: number
  payloadBytesDeleted: number
}

export interface VacuumResult {
  storeFound: boolean
  dbPath: string
  skippedReason?: "below-threshold"
  before: Pick<EventStoreMaintenanceStats, "dbFileSize" | "walFileSize" | "pageCount" | "pageSize" | "freelistCount" | "reclaimableBytes">
  after?: Pick<EventStoreMaintenanceStats, "dbFileSize" | "walFileSize" | "pageCount" | "pageSize" | "freelistCount" | "reclaimableBytes">
}

/** The store's file and page accounting alone. This is what the startup
 *  sweep needs for its vacuum advice, and it reads no event row: the per-type
 *  summaries in readEventStoreMaintenanceStats walk the whole table, which on a
 *  multi-gigabyte workspace is minutes of synchronous I/O in the maintenance
 *  Worker, and the shutdown barrier waits for that Worker's job. */
export function readEventStoreSizeStats(dbPath: string): Pick<EventStoreMaintenanceStats, "storeFound" | "dbPath" | "dbFileSize" | "walFileSize" | "pageCount" | "pageSize" | "freelistCount" | "reclaimableBytes"> {
  const db = openMaintenanceDb(dbPath, { readonly: true })
  if (!db) return { storeFound: false, dbPath, dbFileSize: 0, walFileSize: 0, pageCount: 0, pageSize: 0, freelistCount: 0, reclaimableBytes: 0 }
  try {
    return { storeFound: true, dbPath, ...readSizeStats(db, dbPath) }
  } finally {
    db.close()
  }
}

export function readEventStoreMaintenanceStats(dbPath: string, options: { topLimit?: number } = {}): EventStoreMaintenanceStats {
  const db = openMaintenanceDb(dbPath, { readonly: true })
  if (!db) return emptyStats(dbPath)
  try {
    const size = readSizeStats(db, dbPath)
    const topLimit = options.topLimit ?? 10
    const retired = retiredFamilySummaries(db)
    return {
      storeFound: true,
      dbPath,
      ...size,
      topByRowCount: eventTypeSummaries(db, "count", topLimit),
      topByPayloadBytes: eventTypeSummaries(db, "payloadBytes", topLimit),
      retiredRowCount: sum(retired, (row) => row.count),
      retiredPayloadBytes: sum(retired, (row) => row.payloadBytes),
    }
  } finally {
    db.close()
  }
}

/** Deletes every row of the retired fact families. Idempotent: a clean store
 *  deletes nothing. Nothing produces these facts and nothing replays them, so
 *  every historical row is noise and no retention safeguard exists.
 *
 *  Lock posture: a live runtime shares this file, and its appends are on the
 *  path that publishes UI patches, so this sweep may never make one wait long.
 *  Rows delete in bounded chunks over `event_type_idx`, each chunk its own
 *  implicit transaction, with a pause between chunks - SQLite grants no
 *  fairness, so a tight loop would re-take the write lock the runtime is
 *  waiting for. The whole-file rebuild is deliberately NOT part of this
 *  operation: `VACUUM` holds an exclusive lock for its full duration and
 *  cannot yield, so it belongs only to a caller that owns the store alone.
 *  See `vacuumEventStore`. */
export async function pruneRetiredFactFamilies(dbPath: string, options: { busyTimeoutMs?: number; signal?: AbortSignal } = {}): Promise<RetiredFamilyPruneResult> {
  options.signal?.throwIfAborted()
  const db = openMaintenanceDb(dbPath, { readonly: false, busyTimeoutMs: options.busyTimeoutMs })
  if (!db) return emptyPrune(dbPath)
  try {
    // A workspace whose store was never initialized has no event table; the
    // prune is a no-op there, matching every other maintenance entry point.
    if (!tableExists(db, "event")) return emptyPrune(dbPath)
    return await sweepRetiredFamilies(dbPath, retiredFamilySummaries(db), (type) => deleteRetiredChunk(db, type), options.signal)
  } finally {
    db.close()
  }
}

/** The same sweep beside a live project, whose state Worker is the store's
 *  sole writer (ARCH-SUBSTRATE-018). The families present are read on a read-only
 *  connection, and each bounded chunk is deleted by `deleteChunk`, which asks
 *  that writer for one `deleteRetiredFamilyChunk` step. */
export async function pruneRetiredFactFamiliesThrough(
  dbPath: string,
  deleteChunk: (eventType: string) => Promise<number>,
  signal: AbortSignal,
): Promise<RetiredFamilyPruneResult> {
  signal.throwIfAborted()
  const db = openMaintenanceDb(dbPath, { readonly: true })
  if (!db) return emptyPrune(dbPath)
  let present: EventTypeMaintenanceSummary[]
  try {
    if (!tableExists(db, "event")) return emptyPrune(dbPath)
    present = retiredFamilySummaries(db)
  } finally {
    db.close()
  }
  return sweepRetiredFamilies(dbPath, present, deleteChunk, signal)
}

/** One bounded step of the retired-family sweep, run by the store's writer:
 *  deletes at most one chunk of one retired family and answers how many rows
 *  it deleted. A type that is not retired is refused, so this step can never
 *  delete a live fact. */
export function deleteRetiredFamilyChunk(dbPath: string, eventType: string): number {
  if (!RETIRED_FACT_TYPE_SET.has(eventType)) throw new Error(`${eventType} is not a retired fact family`)
  const db = openMaintenanceDb(dbPath, { readonly: false })
  if (!db) return 0
  try {
    return tableExists(db, "event") ? deleteRetiredChunk(db, eventType) : 0
  } finally {
    db.close()
  }
}

const RETIRED_FACT_TYPE_SET: ReadonlySet<string> = new Set(RETIRED_FACT_TYPES)

function deleteRetiredChunk(db: Database, eventType: string): number {
  db.query<unknown, { $type: string }>(
    `delete from event where rowid in (select rowid from event where type = $type limit ${PRUNE_CHUNK_ROWS})`,
  ).run({ $type: eventType })
  return factRowsChanged(db)
}

/** Deletes each present family chunk by chunk, pausing between chunks so the
 *  writer serves other work in between. `present` is measured before deletion
 *  because SQLite reports only changed-row counts. */
async function sweepRetiredFamilies(
  dbPath: string,
  present: readonly EventTypeMaintenanceSummary[],
  deleteChunk: (eventType: string) => number | Promise<number>,
  signal: AbortSignal | undefined,
): Promise<RetiredFamilyPruneResult> {
  const deletedByType: EventTypeMaintenanceSummary[] = []
  for (const family of present) {
    let deleted = 0
    for (;;) {
      // A withdrawn job stops at the chunk boundary it is already yielding
      // at; the rows it did not reach wait for the next sweep.
      signal?.throwIfAborted()
      const chunk = await deleteChunk(family.type)
      deleted += chunk
      if (chunk < PRUNE_CHUNK_ROWS) break
      await Bun.sleep(PRUNE_CHUNK_PAUSE_MS)
    }
    deletedByType.push({ ...family, count: deleted })
  }
  return {
    storeFound: true,
    dbPath,
    deletedByType,
    rowsDeleted: sum(deletedByType, (row) => row.count),
    payloadBytesDeleted: sum(deletedByType, (row) => row.payloadBytes),
  }
}

export interface SupersededFactPruneResult {
  storeFound: boolean
  dbPath: string
  /** Families that had superseded rows this run; a clean store yields an empty list. */
  deletedByType: EventTypeMaintenanceSummary[]
  rowsDeleted: number
  payloadBytesDeleted: number
  /** Tool content rows no remaining fact names, and their text bytes. */
  contentRowsDeleted: number
  contentBytesDeleted: number
}

interface SupersededFamily {
  readonly type: string
  /** The payload JSON path that scopes one live value; absent for one live value per aggregate. */
  readonly key?: string
}

/** Every family the retention registry declares as one live value per
 *  aggregate or per payload key. Their older rows are loss-free dead weight by
 *  that declaration, so this list is derived from the registry and never kept
 *  by hand. */
function supersededFamilies(): SupersededFamily[] {
  return declaredFactRetentionTypes().flatMap((type): SupersededFamily[] => {
    const retention = factRetention(type)
    if (retention?.policy === "replace-latest") return [{ type }]
    if (retention?.policy === "replace-latest-keyed") return [{ type, key: retention.key }]
    return []
  })
}

/** Deletes every row a newer row of the same live value supersedes, as the
 *  retention registry declares it, then deletes the tool content rows that no
 *  remaining fact references. Idempotent: a clean store deletes nothing.
 *
 *  Runtime owners prune their own families as they write, so on a current
 *  store this finds little. It exists for history written before a family's
 *  owner pruned it, such as the running execution-output tails that earlier
 *  builds recorded once per output tick.
 *
 *  Lock posture: each family deletes in one transaction and each session's
 *  content in one more, with no chunking, so only a caller that owns the store
 *  alone may run it. That is the `flywheel events maintain` command, which
 *  holds the project state generation exclusively. */
export function pruneSupersededFacts(dbPath: string, options: { busyTimeoutMs?: number } = {}): SupersededFactPruneResult {
  const db = openMaintenanceDb(dbPath, { readonly: false, busyTimeoutMs: options.busyTimeoutMs })
  if (!db) return emptySupersededPrune(dbPath)
  try {
    if (!tableExists(db, "event")) return emptySupersededPrune(dbPath)
    const deletedByType: EventTypeMaintenanceSummary[] = []
    for (const family of supersededFamilies()) {
      const deleted = db.transaction(() => deleteSuperseded(db, family))()
      if (deleted.count > 0) deletedByType.push(deleted)
    }
    const content: ContentCollection = tableExists(db, "tool_content") ? deleteUnreferencedToolContent(db) : { rows: 0, bytes: 0 }
    return {
      storeFound: true,
      dbPath,
      deletedByType,
      rowsDeleted: sum(deletedByType, (row) => row.count),
      payloadBytesDeleted: sum(deletedByType, (row) => row.payloadBytes),
      contentRowsDeleted: content.rows,
      contentBytesDeleted: content.bytes,
    }
  } finally {
    db.close()
  }
}

/** The newest row per aggregate, or per aggregate and key, survives. The
 *  survivor set is computed in the same transaction as the delete, so no row
 *  appended in between can lose its place. A keyed row whose payload lacks
 *  the key names no live value, so it is never treated as superseded: SQLite
 *  would otherwise group every such row of an aggregate as one value. */
function deleteSuperseded(db: Database, family: SupersededFamily): EventTypeMaintenanceSummary {
  const grouping = family.key === undefined ? "aggregate_id" : "aggregate_id, json_extract(payload, $key)"
  const keyed = family.key === undefined ? "" : "and json_extract(payload, $key) is not null"
  const superseded = `
    type = $type ${keyed} and position not in (
      select max(position) from event where type = $type group by ${grouping}
    )
  `
  const params: SqlBindings = family.key === undefined ? { $type: family.type } : { $type: family.type, $key: family.key }
  const measured = db.query<{ count: number; payloadBytes: number }, SqlBindings>(
    `select count(*) as count, coalesce(sum(length(payload)), 0) as payloadBytes from event where ${superseded}`,
  ).get(params)
  if (!measured || measured.count === 0) return { type: family.type, count: 0, payloadBytes: 0 }
  db.query<unknown, SqlBindings>(`delete from event where ${superseded}`).run(params)
  return { type: family.type, ...measured }
}

interface SqlBindings { [name: string]: string }

interface ContentCollection {
  rows: number
  bytes: number
}

const isToolContentReference = Schema.is(ToolContentReferenceSchema)

/** Ordinary tool text is live exactly when a fact of its session names its
 *  sha256. Staged session-content nodes, including indirect children and nodes
 *  not yet named by a settlement, stay until the session is deleted.
 *  References sit at different paths in different families (a tool fact's
 *  `output`, a chat entry's `text_reference` part), so the scan walks each
 *  payload for the reference shape instead of naming paths. Every payload is
 *  serialized JSON, so a payload that holds a reference contains the literal
 *  `"sha256"` key, and the scan parses only those. */
function deleteUnreferencedToolContent(db: Database): ContentCollection {
  createToolContentTable(db)
  const sessions = db.query<{ sessionId: string }, []>("select distinct session_id as sessionId from tool_content").all()
  const referencing = db.query<{ payload: string }, { $sessionId: string }>(
    `select payload from event where session_id = $sessionId and instr(payload, '"sha256"') > 0`,
  )
  const stored = db.query<{ sha256: string; bytes: number }, { $sessionId: string }>(
    "select sha256, bytes from tool_content where session_id = $sessionId and session_content_node = 0",
  )
  const deleteRow = db.query<unknown, { $sessionId: string; $sha256: string }>(
    "delete from tool_content where session_id = $sessionId and sha256 = $sha256",
  )
  // The scan and the delete share one transaction, so a reference the scan
  // did not see cannot commit before its content row is gone.
  const collectSession = db.transaction((sessionId: string): number[] => {
    const referenced = new Set<string>()
    for (const { payload } of referencing.iterate({ $sessionId: sessionId })) collectReferences(JSON.parse(payload), referenced)
    const deletedBytes: number[] = []
    for (const row of stored.all({ $sessionId: sessionId })) {
      if (referenced.has(row.sha256)) continue
      deleteRow.run({ $sessionId: sessionId, $sha256: row.sha256 })
      deletedBytes.push(row.bytes)
    }
    return deletedBytes
  })
  const collected: ContentCollection = { rows: 0, bytes: 0 }
  for (const { sessionId } of sessions) {
    const deletedBytes = collectSession(sessionId)
    collected.rows += deletedBytes.length
    collected.bytes += sum(deletedBytes, (bytes) => bytes)
  }
  return collected
}

function collectReferences(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, into)
    return
  }
  if (!isRecord(value)) return
  if (isToolContentReference(value)) into.add(value.sha256)
  for (const child of Object.values(value)) collectReferences(child, into)
}

function emptySupersededPrune(dbPath: string): SupersededFactPruneResult {
  return { storeFound: false, dbPath, deletedByType: [], rowsDeleted: 0, payloadBytesDeleted: 0, contentRowsDeleted: 0, contentBytesDeleted: 0 }
}

function tableExists(db: Database, name: string): boolean {
  return db.query<{ name: string }, [string]>("select name from sqlite_master where type = 'table' and name = ?1").get(name) !== null
}

function emptyPrune(dbPath: string): RetiredFamilyPruneResult {
  return { storeFound: false, dbPath, deletedByType: [], rowsDeleted: 0, payloadBytesDeleted: 0 }
}

/** Indexes earlier builds created at store open and the schema no longer
 *  declares. A payload expression index build at open blocked runtime
 *  readiness for seconds on a large workspace, so startup maintenance asks the
 *  store's writer to retire them after readiness: the drop holds the write
 *  lock for under a second once, then no-ops forever. */
const RETIRED_EVENT_INDEXES = ["event_stream_request_position_idx", "event_parent_tool_fact_idx"] as const

export function dropRetiredEventStoreIndexes(dbPath: string): string[] {
  const db = openMaintenanceDb(dbPath, { readonly: false })
  if (!db) return []
  try {
    const dropped: string[] = []
    for (const name of RETIRED_EVENT_INDEXES) {
      const exists = db.query<{ name: string }, [string]>("select name from sqlite_master where type = 'index' and name = ?1").get(name)
      if (!exists) continue
      // `if exists` keeps a concurrent retirement from turning a lost
      // check-then-act race into a spurious failure.
      db.exec(`drop index if exists ${name}`)
      dropped.push(name)
    }
    return dropped
  } finally {
    db.close()
  }
}

/** Rebuilds the whole file to reclaim freed pages. `VACUUM` holds an exclusive
 *  lock for its full duration - minutes on a multi-gigabyte store - and cannot
 *  be chunked or yielded, so every other connection's write blocks for the whole
 *  run. Only a caller that owns the store alone may run it: the shutdown path
 *  after the runtime generation is disposed, and the explicit
 *  `flywheel events maintain` command. Never a path that runs beside a live
 *  runtime. */
export function vacuumEventStore(dbPath: string, options: { force?: boolean; busyTimeoutMs?: number } = {}): VacuumResult {
  const db = openMaintenanceDb(dbPath, { readonly: false, busyTimeoutMs: options.busyTimeoutMs })
  if (!db) return { storeFound: false, dbPath, before: emptyStats(dbPath) }
  try {
    const before = readSizeStats(db, dbPath)
    if (!options.force && !shouldVacuum(before)) {
      return { storeFound: true, dbPath, skippedReason: "below-threshold", before }
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    db.exec("VACUUM")
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    return { storeFound: true, dbPath, before, after: readSizeStats(db, dbPath) }
  } finally {
    db.close()
  }
}

export function shouldVacuum(stats: Pick<EventStoreMaintenanceStats, "dbFileSize" | "reclaimableBytes">): boolean {
  if (stats.reclaimableBytes > VACUUM_ALWAYS_BYTES) return true
  return stats.reclaimableBytes > VACUUM_MIN_BYTES && stats.reclaimableBytes / Math.max(1, stats.dbFileSize) >= VACUUM_MIN_RATIO
}

export function openMaintenanceDb(dbPath: string, options: { readonly: boolean; busyTimeoutMs?: number }): Database | null {
  if (!fs.existsSync(dbPath)) return null
  const db = options.readonly ? new Database(dbPath, { readonly: true }) : new Database(dbPath)
  db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5000}`)
  return db
}

function readSizeStats(db: Database, dbPath: string): Pick<EventStoreMaintenanceStats, "dbFileSize" | "walFileSize" | "pageCount" | "pageSize" | "freelistCount" | "reclaimableBytes"> {
  const pageCount = pragmaNumber(db, "page_count")
  const pageSize = pragmaNumber(db, "page_size")
  const freelistCount = pragmaNumber(db, "freelist_count")
  return {
    dbFileSize: fileSize(dbPath),
    walFileSize: fileSize(`${dbPath}-wal`),
    pageCount,
    pageSize,
    freelistCount,
    reclaimableBytes: freelistCount * pageSize,
  }
}

function eventTypeSummaries(db: Database, orderBy: "count" | "payloadBytes", limit: number): EventTypeMaintenanceSummary[] {
  return db.query<EventTypeMaintenanceSummary, [{ $limit: number }]>(`
    select type, count(*) as count, coalesce(sum(length(payload)), 0) as payloadBytes
    from event
    group by type
    order by ${orderBy} desc
    limit $limit
  `).all({ $limit: limit })
}

function retiredFamilySummaries(db: Database): EventTypeMaintenanceSummary[] {
  const typeList = RETIRED_FACT_TYPES.map((type) => `'${type}'`).join(", ")
  return db.query<EventTypeMaintenanceSummary, []>(`
    select type, count(*) as count, coalesce(sum(length(payload)), 0) as payloadBytes
    from event
    where type in (${typeList})
    group by type
    order by type asc
  `).all()
}

function pragmaNumber(db: Database, name: "page_count" | "page_size" | "freelist_count"): number {
  const row = db.query<StringMap<number>, []>(`PRAGMA ${name}`).get()
  return row?.[name] ?? 0
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function emptyStats(dbPath: string): EventStoreMaintenanceStats {
  return {
    storeFound: false,
    dbPath,
    dbFileSize: 0,
    walFileSize: 0,
    pageCount: 0,
    pageSize: 0,
    freelistCount: 0,
    reclaimableBytes: 0,
    topByRowCount: [],
    topByPayloadBytes: [],
    retiredRowCount: 0,
    retiredPayloadBytes: 0,
  }
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((acc, value) => acc + select(value), 0)
}
interface StringMap<T> { [key: string]: T }

