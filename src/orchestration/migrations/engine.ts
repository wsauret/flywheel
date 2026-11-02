/** Named, transactional upgrade of historical facts to the version the current
 *  registry parses. A strict reader refuses an unregistered `type@version`, so
 *  a fact whose shape changed is rewritten in place before any runtime reader
 *  opens the store, never discarded: the workspace holds the user's work.
 *
 *  The rewrite is representation only. The semantic authority is the typed
 *  `workspace.facts.migrated` fact the pass appends inside the same
 *  transaction (ARCH-SUBSTRATE-027): it states which pass adopted which fact types over
 *  how many rows, and it is the evidence a racing second start reads to
 *  recognize a pass another process already completed. A pass runs in pages
 *  of bounded size, each one transaction under the write lock that plans,
 *  rewrites, and proves its rows together; a store larger than one page runs
 *  as many pages as it needs instead of refusing to open. A page committed
 *  is whole, and a crash between pages leaves the rest above the watermark
 *  for the next open.
 *
 *  The kernel runs the passes only at an open where a fact was appended or a
 *  pass is new since their last complete run, which one `workspace.facts.settled`
 *  row states. A pass that runs must still cost what was written since it last
 *  looked, not the whole store: when a pass has
 *  looked at every fact below the head it appends `workspace.facts.checked`,
 *  one live row per pass whose own position is the watermark, and the next
 *  open scans only above it. Below that watermark candidates were examined;
 *  family-declared unreadable rows retain their original bytes and versions.
 *  Current writers append current versions and an older binary
 *  writing behind a newer one appends above the newer one's watermark, where
 *  the next open finds its rows. A pass that finds nothing above its
 *  watermark and nothing else appended since writes nothing.
 *
 *  This module is the one migration engine. Passes that rewrite versioned
 *  facts call `migrateFactVersions`; a pass with its own repair shape (the
 *  definition-identity migration) composes the exported helpers instead of
 *  copying them. */

import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import { Schema } from "effect"
import { admitPrivateDatabaseFiles } from "../../infra/private-path.js"
import { defineFact } from "../../infra/event-registry.js"
import type { EventPayload } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { createSqliteEventInserter, factRowsChanged } from "../../infra/sqlite-event-store-core.js"

/** Rows one transaction rewrites. The bound is on the write lock's hold and
 *  the transaction's size, never on how many rows a store may hold. */
const PAGE_SIZE = 10_000
const BUSY_TIMEOUT_MS = 5000
const MIGRATED_FACT_TYPE = "workspace.facts.migrated"
const CHECKED_FACT_TYPE = "workspace.facts.checked"
const SETTLED_FACT_TYPE = "workspace.facts.settled"
const log = Log.create({ service: "workspace.migration" })

/** The aggregate that holds workspace-maintenance evidence. Migrations run
 *  before any session exists, so their facts belong to the workspace itself,
 *  not to a session aggregate. */
const WORKSPACE_AGGREGATE_ID = "workspace"

/** One completed in-place migration pass. The payload names the pass, the fact
 *  types it rewrote, and how many rows it repaired; the append itself, inside
 *  the pass's transaction, is what makes the semantic adoption part of the
 *  event-sourced substrate instead of a side table. */
const WorkspaceFactsMigratedFactSchema = defineFact({
  type: "workspace.facts.migrated",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    migrationId: Schema.NonEmptyString,
    factTypes: Schema.Array(Schema.NonEmptyString),
    repaired: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
})

/** How far one pass has looked: every fact below this row was a candidate
 *  once, so the next open scans only above it. Replaced per pass. */
const WorkspaceFactsCheckedFactSchema = defineFact({
  type: "workspace.facts.checked",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    migrationId: Schema.NonEmptyString,
  }),
})

/** The kernel's statement that every named pass has examined every fact at or
 *  below `through`, a position that excludes the workspace aggregate's own
 *  maintenance rows. One live row (replace-latest). */
const WorkspaceFactsSettledFactSchema = defineFact({
  type: "workspace.facts.settled",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    passes: Schema.Array(Schema.NonEmptyString),
    through: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
})

/** How one stored fact version becomes the current one. */
export interface FactUpgrade {
  readonly type: string
  /** The stored version this upgrade reads. */
  readonly fromVersion: number
  /** Rebuild the fact from one legacy payload and the stored row's actor. The
   *  rebuilt actor must equal the stored actor: an upgrade that derives the
   *  actor from the payload thereby proves the row is the fact it describes,
   *  and one that cannot derive it echoes the stored actor through its own
   *  strict parse. Return unreadable for a family-recognized historical
   *  decode failure; its row stays immutable. Thrown errors roll back the page. */
  readonly rebuild: (legacyPayload: EventPayload, storedActor: string) => { readonly version: number; readonly actor: string; readonly payload: EventPayload } | { readonly kind: "unreadable" }
}

/** Keep a row the rebuild refuses as it is, instead of failing the page. A
 *  representation-only pass uses this: a row that today's strict parser
 *  already refused before the pass existed must not stop the project from
 *  opening, so it keeps its bytes and its version and readers report it as
 *  they did before. The refused row stays below the pass's watermark, so no
 *  later open examines it again. A change that teaches a wrapped rebuild a
 *  new shape must therefore change the pass id and its label. */
export function unreadableWhenRefused(upgrade: FactUpgrade): FactUpgrade {
  return {
    ...upgrade,
    rebuild: (payload, storedActor) => {
      try {
        return upgrade.rebuild(payload, storedActor)
      } catch {
        return { kind: "unreadable" }
      }
    },
  }
}

export interface FactMigrationResult {
  readonly repaired: number
}

interface MigratedPage {
  readonly repaired: number
  readonly examinedThrough: number
  /** No candidate remains above the examined position; the pass is done. */
  readonly exhausted: boolean
}

interface CandidateRow {
  readonly position: number
  readonly type: string
  readonly version: number
  readonly actor: string
  readonly payload: string
}

interface PlannedRepair extends CandidateRow {
  readonly migratedVersion: number
  readonly migratedPayload: string
}

/** `pageSize` is a test seam: production pages are PAGE_SIZE rows. */
export function migrateFactVersions(dbFile: string, migrationId: string, upgrades: readonly FactUpgrade[], pageSize: number = PAGE_SIZE): FactMigrationResult {
  if (!fs.existsSync(dbFile)) return { repaired: 0 }
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    if (!tableExists(db, "event")) return { repaired: 0 }
    retireMigrationLedger(db)
    // Nothing appended since the pass last looked: no scan, no write lock.
    // This is the usual open, so it stays a single read.
    if (headPosition(db) <= checkedThrough(db, migrationId)) return { repaired: 0 }
    let repaired = 0
    let examinedThrough = 0
    for (;;) {
      const page = migratePage(db, migrationId, upgrades, pageSize, examinedThrough)
      repaired += page.repaired
      examinedThrough = page.examinedThrough
      if (page.exhausted) return { repaired }
    }
  } finally {
    db.close()
  }
}

/** One page under the write lock: the scan, the plan, the rewrites, and the
 *  statements that prove them commit together or not at all. A rewritten row
 *  carries the current version. The in-memory cursor also passes unreadable
 *  rows without rewriting them. The watermark moves only after exhaustion,
 *  so unexamined legacy rows are never skipped after a crash;
 *  a fact appended between that scan and the watermark cannot land below it
 *  unseen because both happen under the same lock. */
function migratePage(db: Database, migrationId: string, upgrades: readonly FactUpgrade[], pageSize: number, examinedThrough: number): MigratedPage {
  db.exec("BEGIN IMMEDIATE")
  try {
    const checked = checkedThrough(db, migrationId)
    const afterPosition = Math.max(checked, examinedThrough)
    const candidates = selectCandidates(db, upgrades, afterPosition, pageSize)
    const exhausted = candidates.length < pageSize
    const planned = candidates.map((row) => planRepair(row, upgrades)).filter((row) => row !== undefined)
    if (planned.length > 0) {
      applyRepairs(db, planned)
      recordMigration(db, {
        migrationId,
        factTypes: [...new Set(planned.map((row) => row.type))].sort(),
        repaired: planned.length,
      })
    }
    if (exhausted && headPosition(db) > checked) recordChecked(db, migrationId)
    db.exec("COMMIT")
    return { repaired: planned.length, examinedThrough: candidates.at(-1)?.position ?? afterPosition, exhausted }
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

function selectCandidates(db: Database, upgrades: readonly FactUpgrade[], afterPosition: number, pageSize: number): CandidateRow[] {
  // One type-indexed range per upgrade, bounded below by the examined position.
  const predicate = upgrades.map(() => "(type = ? and position > ? and version = ?)").join(" or ")
  const parameters: (string | number)[] = upgrades.flatMap((upgrade) => [upgrade.type, afterPosition, upgrade.fromVersion])
  return db.query<CandidateRow, (string | number)[]>(`
    select position, type, version, actor, payload from event
    where ${predicate}
    order by position
    limit ${pageSize}
  `).all(...parameters)
}

function planRepair(row: CandidateRow, upgrades: readonly FactUpgrade[]): PlannedRepair | undefined {
  const upgrade = upgrades.find((candidate) => candidate.type === row.type && candidate.fromVersion === row.version)
  if (!upgrade) throw new Error(`no upgrade describes ${row.type}@${row.version} at position ${row.position}`)
  const migrated = upgrade.rebuild(JSON.parse(row.payload), row.actor)
  if ("kind" in migrated) return undefined
  if (migrated.actor !== row.actor) {
    throw new Error(`${row.type} fact at position ${row.position} has actor "${row.actor}"; its payload implies "${migrated.actor}"`)
  }
  return { ...row, migratedVersion: migrated.version, migratedPayload: JSON.stringify(migrated.payload) }
}

/** Rewrite the planned rows inside the caller's transaction. Each update
 *  names the row it read in full, so a row that is not the one planned is
 *  refused rather than overwritten. */
function applyRepairs(db: Database, planned: readonly PlannedRepair[]): void {
  const update = db.query<unknown, {
    $position: number
    $type: string
    $version: number
    $actor: string
    $payload: string
    $migratedVersion: number
    $migratedPayload: string
  }>(`
    update event set version = $migratedVersion, payload = $migratedPayload
    where position = $position
      and type = $type
      and version = $version
      and actor = $actor
      and payload = $payload
  `)
  for (const row of planned) {
    update.run({
      $position: row.position,
      $type: row.type,
      $version: row.version,
      $actor: row.actor,
      $payload: row.payload,
      $migratedVersion: row.migratedVersion,
      $migratedPayload: row.migratedPayload,
    })
    if (factRowsChanged(db) !== 1) {
      throw new Error(`${row.type} fact at position ${row.position} is not the row the pass planned`)
    }
  }
}

/** Refuse the pass when the preflight plan and the rows the write lock sees
 *  disagree in count, order, or content. Exported for passes with their own
 *  repair shape; each supplies the row comparison its scope needs. */
export function requirePlannedScope<Planned, Observed>(
  planned: readonly Planned[],
  observed: readonly Observed[],
  matches: (planned: Planned, observed: Observed) => boolean,
): void {
  const sameScope = planned.length === observed.length && planned.every((plan, index) => {
    const candidate = observed[index]
    return candidate !== undefined && matches(plan, candidate)
  })
  if (!sameScope) {
    throw new Error(`workspace staged ${observed.length} historical fact(s); the pass planned ${planned.length}`)
  }
}

/** Append the typed statement of one completed pass. The caller holds the
 *  pass's transaction, so the statement commits with the rewrites it proves
 *  or not at all. */
export function recordMigration(
  db: Database,
  evidence: { readonly migrationId: string; readonly factTypes: readonly string[]; readonly repaired: number },
): void {
  const fact = Schema.decodeUnknownSync(WorkspaceFactsMigratedFactSchema, { onExcessProperty: "error" })({
    type: MIGRATED_FACT_TYPE,
    version: 1,
    actor: "flywheel",
    payload: evidence,
  })
  createSqliteEventInserter(db).insertEventRows([{
    id: crypto.randomUUID(),
    aggregateId: WORKSPACE_AGGREGATE_ID,
    sessionId: WORKSPACE_AGGREGATE_ID,
    timestamp: Date.now(),
    type: fact.type,
    version: fact.version,
    actor: fact.actor,
    payload: fact.payload,
  }])
}

/** The position this pass has looked through, or 0 when it never ran here:
 *  the position of its live checked row. Exported for passes with their own
 *  candidate shape, which record it with `recordChecked`. */
export function checkedThrough(db: Database, migrationId: string): number {
  return db.query<{ position: number }, { $id: string }>(`
    select position from event indexed by event_aggregate_type_position_idx
    where aggregate_id = '${WORKSPACE_AGGREGATE_ID}'
      and type = '${CHECKED_FACT_TYPE}'
      and json_extract(payload, '$.migrationId') = $id
    order by position desc
    limit 1
  `).get({ $id: migrationId })?.position ?? 0
}

export function headPosition(db: Database): number {
  return db.query<{ position: number }, []>("select coalesce(max(position), 0) as position from event").get()?.position ?? 0
}

/** Replace this pass's watermark: append the new row, which becomes the
 *  watermark by its own position, and drop the superseded one, so the family
 *  keeps one live row per pass (replace-latest-keyed). The caller holds the
 *  transaction, so nothing lands between the scan it proves and this row. */
export function recordChecked(db: Database, migrationId: string): void {
  const fact = Schema.decodeUnknownSync(WorkspaceFactsCheckedFactSchema, { onExcessProperty: "error" })({
    type: CHECKED_FACT_TYPE,
    version: 1,
    actor: "flywheel",
    payload: { migrationId },
  })
  const [stored] = createSqliteEventInserter(db).insertEventRows([{
    id: crypto.randomUUID(),
    aggregateId: WORKSPACE_AGGREGATE_ID,
    sessionId: WORKSPACE_AGGREGATE_ID,
    timestamp: Date.now(),
    type: fact.type,
    version: fact.version,
    actor: fact.actor,
    payload: fact.payload,
  }])
  if (stored === undefined) throw new Error("the checked watermark was not stored")
  db.query<unknown, { $id: string; $position: number }>(`
    delete from event
    where aggregate_id = '${WORKSPACE_AGGREGATE_ID}'
      and type = '${CHECKED_FACT_TYPE}'
      and json_extract(payload, '$.migrationId') = $id
      and position < $position
  `).run({ $id: migrationId, $position: stored.position })
}

/** Has any run of this pass already committed? A racing second start reads
 *  this after re-selecting zero candidates under the write lock, to tell a
 *  completed pass from rows that changed for an unknown reason. */
export function migrationRecorded(db: Database, migrationId: string): boolean {
  return db.query<{ found: number }, { $id: string }>(`
    select 1 as found from event
    where type = '${MIGRATED_FACT_TYPE}'
      and json_extract(payload, '$.migrationId') = $id
    limit 1
  `).get({ $id: migrationId }) !== null
}


/** Whether the stored-fact phase has work at this open, and the head it saw. */
export interface FactPassSettlement {
  /** Every named pass has examined every fact the store holds. */
  readonly settled: boolean
  /** The newest fact outside the workspace aggregate. A run that starts from
   *  this read examines at least every fact up to it, so it is the `through`
   *  the run records. */
  readonly head: number
}

/** Decide in one open whether any stored-fact pass is due: one indexed read of
 *  the settled row and one read of the head. `passes` names the passes this
 *  start would run. A pass the settled row does not name has never examined
 *  this store, so it makes the phase due; a fact above `through` can need any
 *  pass. The head excludes the workspace aggregate, because the passes' own
 *  watermark and evidence rows land there and no pass reads them. A store
 *  with no settled row, or with no event table yet, is not settled. An
 *  unreadable settled row makes every pass due and says so. */
export function readFactPassSettlement(dbFile: string, passes: readonly string[]): FactPassSettlement {
  if (!fs.existsSync(dbFile)) return { settled: false, head: 0 }
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    if (!tableExists(db, "event")) return { settled: false, head: 0 }
    const head = db.query<{ position: number }, []>(`
      select position from event where aggregate_id <> '${WORKSPACE_AGGREGATE_ID}' order by position desc limit 1
    `).get()?.position ?? 0
    const row = db.query<{ version: number; actor: string; payload: string }, []>(`
      select version, actor, payload from event indexed by event_aggregate_type_position_idx
      where aggregate_id = '${WORKSPACE_AGGREGATE_ID}' and type = '${SETTLED_FACT_TYPE}'
      order by position desc limit 1
    `).get()
    if (row === null) return { settled: false, head }
    let recorded: typeof WorkspaceFactsSettledFactSchema.Type.payload
    try {
      recorded = Schema.decodeUnknownSync(WorkspaceFactsSettledFactSchema, { onExcessProperty: "error" })({
        type: SETTLED_FACT_TYPE, version: row.version, actor: row.actor, payload: JSON.parse(row.payload),
      }).payload
    } catch {
      log.warn("stored-fact settlement unreadable; every stored-fact pass runs", { version: row.version })
      return { settled: false, head }
    }
    return { settled: head <= recorded.through && passes.every((pass) => recorded.passes.includes(pass)), head }
  } finally {
    db.close()
  }
}

/** Record that `passes` examined every fact up to `through`, replacing the
 *  previous settled row in one transaction. */
export function recordFactPassSettlement(dbFile: string, passes: readonly string[], through: number): void {
  if (!fs.existsSync(dbFile)) return
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    if (!tableExists(db, "event")) return
    const fact = Schema.decodeUnknownSync(WorkspaceFactsSettledFactSchema, { onExcessProperty: "error" })({
      type: SETTLED_FACT_TYPE,
      version: 1,
      actor: "flywheel",
      payload: { passes, through },
    })
    db.exec("BEGIN IMMEDIATE")
    try {
      const [stored] = createSqliteEventInserter(db).insertEventRows([{
        id: crypto.randomUUID(),
        aggregateId: WORKSPACE_AGGREGATE_ID,
        sessionId: WORKSPACE_AGGREGATE_ID,
        timestamp: Date.now(),
        type: fact.type,
        version: fact.version,
        actor: fact.actor,
        payload: fact.payload,
      }])
      if (stored === undefined) throw new Error("the stored-fact settlement was not stored")
      db.query<unknown, { $position: number }>(`
        delete from event
        where aggregate_id = '${WORKSPACE_AGGREGATE_ID}' and type = '${SETTLED_FACT_TYPE}' and position < $position
      `).run({ $position: stored.position })
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    }
  } finally {
    db.close()
  }
}

function retireMigrationLedger(db: Database): void {
  if (tableExists(db, "workspace_migration")) db.exec("drop table if exists workspace_migration")
}

export function tableExists(db: Database, name: string): boolean {
  return db.query<{ name: string }, { $name: string }>(
    "select name from sqlite_master where type = 'table' and name = $name",
  ).get({ $name: name }) !== null
}
