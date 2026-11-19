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

/** Rows one superseded-prune step deletes beside a live runtime. Each row's
 *  delete checks again that a newer row of its live value exists, so a step
 *  holds the write lock for milliseconds. */
const SUPERSEDED_STEP_ROWS = 500

/** One bounded step of the superseded prune beside a live runtime: rows of
 *  one family that the planning read found superseded. */
export interface SupersededPruneStep {
  readonly eventType: string
  readonly positions: readonly number[]
}

export interface SupersededStepPruneResult {
  readonly rowsDeleted: number
  readonly payloadBytesDeleted: number
}

/** The position through which each replace-latest family was planned, by
 *  fact type. A row above it is one a later plan has not seen yet. */
export interface SupersededPlanBounds { readonly [eventType: string]: number }

/** The superseded prune beside a live project, whose state Worker is the
 *  store's sole writer (ARCH-SUBSTRATE-018). Every family is planned first,
 *  once per run, on a read-only connection; then the planned rows are
 *  deleted by `deleteStep` in bounded steps, each one `deleteSupersededStep`
 *  of that writer. A family planned through a position before plans only the
 *  aggregates that rows above it touched: a row can become superseded only
 *  when a newer row of its aggregate lands, and the plan through the bound
 *  left none behind. So a run's planning grows with the rows written since
 *  the last run, a family with no new rows costs one index read, and the
 *  planned rows are every superseded row of the store. `onPending` hears the
 *  payload bytes of the planned rows not deleted yet: once the plan is read,
 *  and again as each family finishes. `onPlanned` hears each family's new bound once all its rows are deleted;
 *  a withdrawn run keeps the bound of a family it did not finish. Tool content
 *  collection is not part of it: its scan and delete must share one
 *  transaction, which only a caller that owns the store alone may hold. */
export async function pruneSupersededFactsThrough(
  dbPath: string,
  deleteStep: (step: SupersededPruneStep) => Promise<number>,
  options: {
    readonly signal: AbortSignal
    readonly plannedThrough?: SupersededPlanBounds
    readonly onPending?: (supersededBytes: number) => void
    readonly onPlanned?: (eventType: string, through: number) => void
  },
): Promise<SupersededStepPruneResult> {
  const { signal } = options
  signal.throwIfAborted()
  const db = openMaintenanceDb(dbPath, { readonly: true })
  if (!db) return { rowsDeleted: 0, payloadBytesDeleted: 0 }
  let rowsDeleted = 0
  let payloadBytesDeleted = 0
  try {
    if (!tableExists(db, "event")) return { rowsDeleted, payloadBytesDeleted }
    const plans: { type: string; through: number; rows: { position: number; bytes: number }[] }[] = []
    for (const family of supersededFamilies()) {
      signal.throwIfAborted()
      const after = options.plannedThrough?.[family.type] ?? 0
      // Read before the plan: a row that lands between the two is planned now
      // and again next run, which deletes nothing twice.
      const through = db.query<{ through: number }, { $type: string }>("select coalesce(max(position), 0) as through from event where type = $type").get({ $type: family.type })?.through ?? 0
      if (through <= after) continue
      plans.push({ type: family.type, through, rows: planSuperseded(db, family, after) })
    }
    let pending = sum(plans, (plan) => sum(plan.rows, (row) => row.bytes))
    options.onPending?.(pending)
    for (const plan of plans) {
      for (let offset = 0; offset < plan.rows.length; offset += SUPERSEDED_STEP_ROWS) {
        if (offset > 0) await Bun.sleep(PRUNE_CHUNK_PAUSE_MS)
        signal.throwIfAborted()
        const rows = plan.rows.slice(offset, offset + SUPERSEDED_STEP_ROWS)
        const deleted = await deleteStep({ eventType: plan.type, positions: rows.map((row) => row.position) })
        rowsDeleted += deleted
        // The planned bytes of a step that deleted every planned row; a row a
        // concurrent delete took first is not counted.
        if (deleted === rows.length) payloadBytesDeleted += sum(rows, (row) => row.bytes)
      }
      options.onPlanned?.(plan.type, plan.through)
      pending -= sum(plan.rows, (row) => row.bytes)
      options.onPending?.(pending)
    }
    return { rowsDeleted, payloadBytesDeleted }
  } finally {
    db.close()
  }
}

/** Every superseded row of one family in the aggregates that rows above
 *  `after` touched, in one statement, so SQLite builds the newest-row set
 *  once. With `after` 0 that is every aggregate of the family. */
function planSuperseded(db: Database, family: SupersededFamily, after: number): { position: number; bytes: number }[] {
  const grouping = family.key === undefined ? "aggregate_id" : "aggregate_id, json_extract(payload, $key)"
  const keyed = family.key === undefined ? "" : "and json_extract(payload, $key) is not null"
  return db.query<{ position: number; bytes: number }, { [name: string]: string | number }>(`
    with touched as (select distinct aggregate_id from event where type = $type and position > $after)
    select position, length(payload) as bytes from event
    where type = $type ${keyed} and aggregate_id in touched and position not in (
      select max(position) from event where type = $type and aggregate_id in touched group by ${grouping}
    )
    order by position
  `).all({ ...familyBindings(family), $after: after })
}

/** One bounded step of the superseded prune, run by the store's writer:
 *  deletes each named row that a newer row of the same live value still
 *  supersedes, and answers how many it deleted. The check runs again here
 *  because the plan was read on another connection; a row whose newer value
 *  is gone since is kept. A type the retention registry does not declare as
 *  one live value is refused, so this step can never delete history. */
export function deleteSupersededStep(dbPath: string, step: SupersededPruneStep): number {
  const family = supersededFamilies().find((candidate) => candidate.type === step.eventType)
  if (family === undefined) throw new Error(`${step.eventType} is not a replace-latest fact family`)
  if (step.positions.length === 0) return 0
  const db = openMaintenanceDb(dbPath, { readonly: false })
  if (!db) return 0
  try {
    const sameValue = family.key === undefined ? "" : "and json_extract(newer.payload, $key) = json_extract(event.payload, $key)"
    db.query<unknown, SqlBindings>(`
      delete from event
      where position in (select value from json_each($positions)) and type = $type
        and exists (
          select 1 from event newer
          where newer.aggregate_id = event.aggregate_id and newer.type = event.type and newer.position > event.position ${sameValue}
        )
    `).run({ ...familyBindings(family), $positions: JSON.stringify(step.positions) })
    return factRowsChanged(db)
  } finally {
    db.close()
  }
}

/** Pages one incremental-vacuum step gives back. On a 4 KiB page this is
 *  1 MiB, and a step measured at most 18.5 ms in the probe that chose it. */
export const INCREMENTAL_VACUUM_STEP_PAGES = 256

/** One bounded step of idle reclaim, run by the store's writer: moves at most
 *  `pages` free pages to the end of the file and truncates them, and answers
 *  how many pages it freed. A store that is not in incremental auto-vacuum
 *  mode frees nothing: only a full VACUUM changes the mode, and only the
 *  Reclaim storage run does one (ARCH-RUNTIME-083). The file shrinks on disk only
 *  when the WAL checkpoints, so the step that empties the free list
 *  checkpoints. */
export function incrementalVacuumStep(dbPath: string, pages: number): number {
  const db = openMaintenanceDb(dbPath, { readonly: false })
  if (!db) return 0
  try {
    if (pragmaNumber(db, "auto_vacuum") !== AUTO_VACUUM_INCREMENTAL) return 0
    const before = pragmaNumber(db, "freelist_count")
    // The pragma frees one page per result row it steps, so every row is read.
    db.query(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(pages))})`).all()
    const after = pragmaNumber(db, "freelist_count")
    // The state Worker's writer stays open while the project idles, so no close
    // checkpoints and the truncated pages would wait in the WAL until the next
    // write. PASSIVE waits on no reader or writer.
    if (after === 0 && after < before) db.query("PRAGMA wal_checkpoint(PASSIVE)").all()
    return Math.max(0, before - after)
  } finally {
    db.close()
  }
}

/** The `auto_vacuum` pragma value of incremental mode. */
const AUTO_VACUUM_INCREMENTAL = 2

/** How large a store is and what the Reclaim storage command can give back.
 *  `reclaimableBytes` is the free pages, the payload of the retired families,
 *  and `supersededBytes`, the payload of the superseded rows the last plan
 *  counted and no prune has deleted yet. `liveBytes` is what a full VACUUM
 *  copies. */
export interface StoreUsage {
  readonly storeBytes: number
  readonly reclaimableBytes: number
  readonly supersededBytes: number
  readonly liveBytes: number
  readonly incremental: boolean
}

/** Reads the store's usage on a read-only connection: page headers and the
 *  retired families' index, never a walk of every event row. No index counts
 *  the superseded rows, and planning them walks every replace-latest row and
 *  payload (51 s on a 42 GB store), so the caller passes the bytes that a
 *  superseded prune's plan counted, or 0 where a finished prune left them as
 *  free pages, which this read counts already. */
export function readStoreUsage(dbPath: string, supersededBytes: number): StoreUsage | undefined {
  const db = openMaintenanceDb(dbPath, { readonly: true })
  if (!db) return undefined
  try {
    const size = readSizeStats(db, dbPath)
    const retired = tableExists(db, "event") ? sum(retiredFamilySummaries(db), (row) => row.payloadBytes) : 0
    return {
      storeBytes: size.dbFileSize + size.walFileSize,
      reclaimableBytes: size.reclaimableBytes + retired + supersededBytes,
      supersededBytes,
      liveBytes: (size.pageCount - size.freelistCount) * size.pageSize,
      incremental: pragmaNumber(db, "auto_vacuum") === AUTO_VACUUM_INCREMENTAL,
    }
  } finally {
    db.close()
  }
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
  const superseded = supersededPredicate(family)
  const params = familyBindings(family)
  const measured = db.query<{ count: number; payloadBytes: number }, SqlBindings>(
    `select count(*) as count, coalesce(sum(length(payload)), 0) as payloadBytes from event where ${superseded}`,
  ).get(params)
  if (!measured || measured.count === 0) return { type: family.type, count: 0, payloadBytes: 0 }
  db.query<unknown, SqlBindings>(`delete from event where ${superseded}`).run(params)
  return { type: family.type, ...measured }
}

function supersededPredicate(family: SupersededFamily): string {
  const grouping = family.key === undefined ? "aggregate_id" : "aggregate_id, json_extract(payload, $key)"
  const keyed = family.key === undefined ? "" : "and json_extract(payload, $key) is not null"
  return `
    type = $type ${keyed} and position not in (
      select max(position) from event where type = $type group by ${grouping}
    )
  `
}

function familyBindings(family: SupersededFamily): SqlBindings {
  return family.key === undefined ? { $type: family.type } : { $type: family.type, $key: family.key }
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

/** Rebuilds the whole file to reclaim freed pages, and moves the store to
 *  incremental auto-vacuum, so idle reclaim can give later freed pages back in
 *  small steps. `VACUUM` holds an exclusive lock for its full duration -
 *  minutes on a multi-gigabyte store - and cannot be chunked or yielded, so
 *  every other connection's write blocks for the whole run. Only a caller that
 *  owns the store alone may run it: the Reclaim storage command after the
 *  account service closed the project, and the explicit
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
    // Takes effect through this VACUUM; on its own the pragma changes nothing.
    db.exec("PRAGMA auto_vacuum = INCREMENTAL")
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

function pragmaNumber(db: Database, name: "page_count" | "page_size" | "freelist_count" | "auto_vacuum"): number {
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

