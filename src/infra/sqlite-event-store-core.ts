import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"

import { InFlightSwapConflictError, storedFact, type AggregateSeqConflict, type GuardedEventStoreAppend, type InFlightWrite, type StoredFact } from "./event-store-types.js"
import { assertNever } from "./assert-never.js"
import { applySqliteBusyTimeout, applySqliteDurabilityPragmas } from "./sqlite-durability.js"
import { admitPrivateDatabaseFiles } from "./private-path.js"
import { assertChatEntriesToolContentReferences } from "./tool-content.js"
import { assertSessionContentNodeChildren, parseSessionContentNodeRow, SESSION_CONTENT_STAGE_BYTES, type SessionContentNodeRow } from "./session-content.js"
import { assertMutationEvidence, assertMutationFileEvidence } from "./mutation-evidence.js"
import { isRecord } from "./record.js"

export interface SqliteEventInsert extends GuardedEventStoreAppend {
  readonly id: string
}

/** Private control signal used only to roll back the current SQLite savepoint. */
export class SqliteAggregateSeqConflict extends Error {
  override readonly name = "SqliteAggregateSeqConflict"

  constructor(readonly conflict: AggregateSeqConflict) {
    super(`aggregate ${conflict.aggregateId} seq conflict: expected ${conflict.expectedSeq}, next is ${conflict.actualSeq}`)
  }
}

export interface SqliteEventInserter {
  stageSessionContentNodes(sessionId: string, nodes: readonly SessionContentNodeRow[]): void
  insertEventRows(events: readonly SqliteEventInsert[]): StoredFact[]
  /** In-flight recovery state written with no fact beside it, for the moment
   *  an operation begins. Retirement rides the append that records the
   *  outcome, so the fact and the state it retires land together. */
  writeInFlight(sessionId: string, write: InFlightWrite): void
}

export function configureSqliteEventStore(db: Database): void {
  // All constructors must wait through WAL and schema acquisition, including
  // two processes creating the database concurrently. Runtime lane commits
  // lower the timeout only while their established connection writes.
  applySqliteDurabilityPragmas(db, 5000)
  db.exec("PRAGMA cache_size = -65536")
  db.exec("PRAGMA temp_store = MEMORY")
  db.exec("PRAGMA wal_autocheckpoint = 1000")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA wal_checkpoint(PASSIVE)")
  initializeSqliteEventStore(db)
}

export function createSqliteEventInserter(db: Database): SqliteEventInserter {
  // A writer guarantees the schema it writes to. Migration passes build
  // inserters over raw connections before the store is configured, and a store
  // written by an older release lacks companion tables (in_flight,
  // tool_content) that the statements below prepare against eagerly.
  initializeSqliteEventStore(db)
  // db.query, not db.prepare: cached statements are finalized at close, which
  // the store's WAL-sidecar cleanup depends on.
  const selectSeq = db.query<{ seq: number } | null, { $aggregateId: string }>(
    "select seq from event_sequence where aggregate_id = $aggregateId",
  )
  const upsertSeq = db.query<unknown, { $aggregateId: string; $seq: number }>(`
    insert into event_sequence (aggregate_id, seq)
    values ($aggregateId, $seq)
    on conflict(aggregate_id) do update set seq = excluded.seq
  `)
  // Idempotent by primary key: the second through nth writers of the same
  // text within a session insert nothing and store only their reference.
  const insertContent = db.query<unknown, { $sessionId: string; $sha256: string; $content: string; $bytes: number }>(`
    insert into tool_content (session_id, sha256, content, bytes)
    values ($sessionId, $sha256, $content, $bytes)
    on conflict (session_id, sha256) do nothing
  `)
  const selectContent = db.query<{ content: string } | null, { $sessionId: string; $sha256: string }>(
    "select content from tool_content where session_id = $sessionId and sha256 = $sha256",
  )
  const selectNode = db.query<{ content: string } | null, { $sessionId: string; $sha256: string }>(
    "select content from tool_content where session_id = $sessionId and sha256 = $sha256 and session_content_node = 1",
  )
  const insertNode = db.query<unknown, { $sessionId: string; $sha256: string; $content: string; $bytes: number }>(`
    insert into tool_content (session_id, sha256, content, bytes, session_content_node)
    values ($sessionId, $sha256, $content, $bytes, 1)
    on conflict(session_id, sha256) do update set session_content_node = 1
    where tool_content.content = excluded.content and tool_content.bytes = excluded.bytes
  `)
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: closure proof must validate stored node bytes against their referenced hash and length.
  function readNode(sessionId: string, sha256: string): unknown | null {
    const row = selectNode.get({ $sessionId: sessionId, $sha256: sha256 })
    return row ? JSON.parse(row.content) : null
  }
  function stageSessionContentNodes(sessionId: string, nodes: readonly SessionContentNodeRow[]): void {
    if (nodes.length > 0 && db.query("select 1 from event where session_id = ?1 and type = 'session.deleted' limit 1").get(sessionId)) {
      throw new Error("Cannot stage content for a deleted session")
    }
    if (Buffer.byteLength(JSON.stringify(nodes)) > SESSION_CONTENT_STAGE_BYTES) throw new Error("Session content staging set exceeds its encoded limit")
    for (const raw of nodes) {
      const row = parseSessionContentNodeRow(raw)
      assertSessionContentNodeChildren(row, sha256 => readNode(sessionId, sha256))
      const content = JSON.stringify(row.node)
      const existing = selectContent.get({ $sessionId: sessionId, $sha256: row.sha256 })
      if (existing && existing.content !== content) throw new Error("Session content hash has different stored bytes")
      insertNode.run({ $sessionId: sessionId, $sha256: row.sha256, $content: content, $bytes: Buffer.byteLength(content) })
      if (readNode(sessionId, row.sha256) === null) throw new Error("Session content role promotion refused")
    }
  }

  function proveMutation(value: unknown, sessionId: string): void {
    if (isRecord(value) && value.version === 2) assertMutationEvidence(value, sha256 => readNode(sessionId, sha256))
  }

  function proveDetails(details: unknown, sessionId: string): void {
    if (isRecord(details)) proveMutation(details.mutationEvidence, sessionId)
  }

  function proveFact(type: string, payload: unknown, sessionId: string): void {
    if (!isRecord(payload)) return
    if (type === "tool.result.recorded") proveDetails(payload.details, sessionId)
    if (type === "tool.execution_output.recorded") proveMutation(payload.mutationEvidence, sessionId)
    if (type === "file.artifact.recorded" && payload.artifactKind === "mutation_diff" && payload.evidence !== undefined) {
      assertMutationFileEvidence(payload.evidence, sha256 => readNode(sessionId, sha256))
    }
    if (type === "chat.entries.appended" && Array.isArray(payload.entries)) {
      for (const entry of payload.entries) {
        if (!isRecord(entry) || entry.kind !== "message" || !isRecord(entry.message) || entry.message.kind !== "system") continue
        proveMutation(entry.message.mutationEvidence, sessionId)
      }
    }
  }
  const putInFlight = db.query<unknown, { $sessionId: string; $kind: string; $key: string; $payload: string }>(`
    insert into in_flight (session_id, kind, key, payload)
    values ($sessionId, $kind, $key, $payload)
    on conflict (session_id, kind, key) do update set payload = excluded.payload
  `)
  const dropInFlight = db.query<unknown, { $sessionId: string; $kind: string; $key: string }>(
    "delete from in_flight where session_id = $sessionId and kind = $kind and key = $key",
  )
  const insertInFlightIfAbsent = db.query<unknown, { $sessionId: string; $kind: string; $key: string; $payload: string }>(`
    insert into in_flight (session_id, kind, key, payload)
    values ($sessionId, $kind, $key, $payload)
    on conflict (session_id, kind, key) do nothing
  `)
  const updateInFlightIfMatching = db.query<unknown, { $sessionId: string; $kind: string; $key: string; $expected: string; $payload: string }>(
    "update in_flight set payload = $payload where session_id = $sessionId and kind = $kind and key = $key and payload = $expected",
  )
  const deleteInFlightIfMatching = db.query<unknown, { $sessionId: string; $kind: string; $key: string; $expected: string }>(
    "delete from in_flight where session_id = $sessionId and kind = $kind and key = $key and payload = $expected",
  )
  const clearInFlight = db.query<unknown, { $sessionId: string; $kind: string }>(
    "delete from in_flight where session_id = $sessionId and kind = $kind",
  )
  const clearSessionInFlight = db.query<unknown, { $sessionId: string }>(
    "delete from in_flight where session_id = $sessionId",
  )
  const clearSessionContent = db.query<unknown, { $sessionId: string }>(
    "delete from tool_content where session_id = $sessionId",
  )

  /** Writes in-flight state with no fact beside it, for the moment an
   *  operation begins. Settlement rides the append that records the outcome,
   *  because only then is there a fact the state must be retired with. */
  function writeInFlight(sessionId: string, write: InFlightWrite): void {
    applyInFlight(sessionId, write)
  }

  function applyInFlight(sessionId: string, write: InFlightWrite): void {
    if ((write.op === "put" || write.op === "swap") && write.kind === "finalized-tool-result" && write.payload !== null) {
      const payload: unknown = JSON.parse(write.payloadJson ?? JSON.stringify(write.payload))
      if (isRecord(payload)) proveDetails(payload.details, sessionId)
    }
    switch (write.op) {
      case "put":
        putInFlight.run({ $sessionId: sessionId, $kind: write.kind, $key: write.key, $payload: write.payloadJson ?? JSON.stringify(write.payload) })
        return
      case "drop":
        dropInFlight.run({ $sessionId: write.sessionId ?? sessionId, $kind: write.kind, $key: write.key })
        return
      case "clear":
        clearInFlight.run({ $sessionId: sessionId, $kind: write.kind })
        return
      case "clear_session":
        clearSessionInFlight.run({ $sessionId: sessionId })
        clearSessionContent.run({ $sessionId: sessionId })
        return
      case "swap": {
        const holder = write.sessionId ?? sessionId
        const payloadJson = write.payload === null ? null : (write.payloadJson ?? JSON.stringify(write.payload))
        const changes = write.expectedRaw === null
          ? payloadJson === null
            ? 0
            : insertInFlightIfAbsent.run({ $sessionId: holder, $kind: write.kind, $key: write.key, $payload: payloadJson }).changes
          : payloadJson === null
            ? deleteInFlightIfMatching.run({ $sessionId: holder, $kind: write.kind, $key: write.key, $expected: write.expectedRaw }).changes
            : updateInFlightIfMatching.run({ $sessionId: holder, $kind: write.kind, $key: write.key, $expected: write.expectedRaw, $payload: payloadJson }).changes
        if (changes !== 1) throw new InFlightSwapConflictError(holder, write.kind, write.key)
        return
      }
      default:
        assertNever(write)
    }
  }

  const insertEvent = db.query<{ position: number }, {
    $id: string
    $aggregateId: string
    $seq: number
    $type: string
    $version: number
    $timestamp: number
    $actor: string
    $sessionId: string
    $runId: string | null
    $parentEventId: string | null
    $causedByEventId: string | null
    $payload: string
  }>(`
    insert into event (
      id, aggregate_id, seq, type, version, timestamp, actor, session_id,
      run_id, parent_event_id, caused_by_event_id, payload
    ) values (
      $id, $aggregateId, $seq, $type, $version, $timestamp, $actor, $sessionId,
      $runId, $parentEventId, $causedByEventId, $payload
    ) returning position
  `)

  function insertEventRows(events: readonly SqliteEventInsert[]): StoredFact[] {
    const assigned: Array<{ event: SqliteEventInsert; seq: number; payload: string }> = []
    const nextSeqByAggregate = new Map<string, number>()

    for (const event of events) {
      for (const guard of event.aggregateGuards ?? []) {
        const actualSeq = (selectSeq.get({ $aggregateId: guard.aggregateId })?.seq ?? -1) + 1
        if (guard.expectedSeq !== actualSeq) throw new SqliteAggregateSeqConflict({ ...guard, actualSeq })
      }
    }
    for (const event of events) {
      const existingNextSeq = nextSeqByAggregate.get(event.aggregateId)
      const seq = existingNextSeq ?? ((selectSeq.get({ $aggregateId: event.aggregateId })?.seq ?? -1) + 1)
      // The optimistic-concurrency check: this runs while the surrounding
      // BEGIN IMMEDIATE holds the write lock, so the comparison is atomic
      // across processes. The throw rolls back the whole batch.
      if (event.expectedSeq !== undefined && event.expectedSeq !== seq) {
        throw new SqliteAggregateSeqConflict({
          aggregateId: event.aggregateId,
          expectedSeq: event.expectedSeq,
          actualSeq: seq,
        })
      }
      nextSeqByAggregate.set(event.aggregateId, seq + 1)
      // The writer lane pre-serializes at enqueue so byte limits bound true
      // bytes; its string is inserted verbatim. Every other writer omits
      // payloadJson and this is the single serialization point.
      assigned.push({ event, seq, payload: event.payloadJson ?? JSON.stringify(event.payload) })
    }

    // Content rows land before the event rows that reference them, so within
    // this commit unit a stored reference always has its bytes; the enclosing
    // transaction or savepoint rolls both back together.
    for (const event of events) {
      for (const row of event.contentRows ?? []) {
        insertContent.run({ $sessionId: event.sessionId, $sha256: row.sha256, $content: row.content, $bytes: row.bytes })
      }
      // In the same unit as the fact that makes them true, so a fact saying an
      // operation finished can never survive without the state it retires
      // being gone, and a rolled-back append leaves the state untouched.
      for (const write of event.inFlight ?? []) {
        applyInFlight(event.sessionId, write)
      }
    }

    const toolContent = {
      resolve: (sessionId: string, sha256: string) =>
        selectContent.get({ $sessionId: sessionId, $sha256: sha256 })?.content ?? null,
    }
    for (const { event, payload } of assigned) {
      if (event.type === "tool.result.recorded" || event.type === "tool.execution_output.recorded"
        || event.type === "file.artifact.recorded" || event.type === "chat.entries.appended") {
        proveFact(event.type, JSON.parse(payload), event.sessionId)
      }
      if (event.type !== "chat.entries.appended") continue
      assertChatEntriesToolContentReferences(event.payload, toolContent, event.sessionId, {
        eventType: event.type,
        eventPosition: 0,
        aggregateId: event.aggregateId,
      })
    }

    for (const [aggregateId, nextSeq] of nextSeqByAggregate) {
      upsertSeq.run({ $aggregateId: aggregateId, $seq: nextSeq - 1 })
    }

    return assigned.map(({ event, seq, payload }) => {
      const inserted = insertEvent.get({
        $id: event.id,
        $aggregateId: event.aggregateId,
        $seq: seq,
        $type: event.type,
        $version: event.version,
        $timestamp: event.timestamp,
        $actor: event.actor,
        $sessionId: event.sessionId,
        $runId: event.runId ?? null,
        $parentEventId: event.parentEventId ?? null,
        $causedByEventId: event.causedByEventId ?? null,
        $payload: payload,
      })
      if (!inserted) {
        throw new Error(
          `event-store: insert into event returned no row (aggregate=${event.aggregateId}, seq=${seq}, type=${event.type})`,
        )
      }
      return storedFact(event, { id: event.id, position: inserted.position, seq })
    })
  }

  return { insertEventRows, writeInFlight, stageSessionContentNodes }
}

/** The index for one session's facts of one type. SQLite chooses it without
 *  a hint, so the sqlite3 CLI and agent scripts, which cannot pin an index,
 *  seek those facts instead of walking every fact of that type in the store. */
const CREATE_SESSION_TYPE_INDEX = "create index if not exists event_session_type_position_idx on event(session_id, type, position)"

/** Builds the session-type index on a store that a release before 2026-10-27
 *  wrote, and calls `onBuild` first. The build reads every fact and holds the
 *  write lock until it ends, which is minutes on a large store, so only a
 *  start that owns the store alone calls this, in its own startup step. A
 *  store that has the index, or has no event table, builds nothing.
 *  Remove after 2027-04-27, when every store opened since has the index. */
export function buildMissingSessionTypeIndex(dbFile: string, onBuild: () => void): void {
  if (!existsSync(dbFile)) return
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    applySqliteBusyTimeout(db, 5000)
    const present = (name: string) => db.query("select 1 from sqlite_schema where name = ?").get(name) !== null
    if (!present("event") || present("event_session_type_position_idx")) return
    onBuild()
    db.exec(CREATE_SESSION_TYPE_INDEX)
  } finally {
    db.close()
  }
}

function initializeSqliteEventStore(db: Database): void {
  db.exec("create table if not exists event_sequence (aggregate_id text primary key, seq integer not null)")
  createInFlightTable(db)
  db.exec(`
    create table if not exists event (
      position integer primary key autoincrement,
      id text not null unique,
      aggregate_id text not null references event_sequence(aggregate_id) on delete cascade,
      seq integer not null,
      type text not null,
      version integer not null,
      timestamp integer not null,
      actor text not null,
      session_id text not null,
      run_id text,
      parent_event_id text,
      caused_by_event_id text,
      payload text not null,
      unique(aggregate_id, seq)
    )
  `)
  // These indexes are pinned by name via `indexed by` in
  // sqlite-event-read-surface.ts; renaming them breaks statement prepare there.
  db.exec("create index if not exists event_session_idx on event(session_id, position)")
  db.exec("create index if not exists event_type_idx on event(type, position)")
  db.exec("create index if not exists event_aggregate_position_idx on event(aggregate_id, position)")
  db.exec("create index if not exists event_aggregate_type_position_idx on event(aggregate_id, type, position)")
  // A store with facts builds this index only in its start's own step.
  if (db.query("select 1 from event limit 1").get() === null) db.exec(CREATE_SESSION_TYPE_INDEX)
  createEventRewriteGeneration(db)
  createToolContentTable(db)
}

/** The `event_rewrite` aggregate of the rows that total every aggregate, and
 *  the type of the rows that count aggregate deletions. A fact with an empty
 *  aggregate id or type would only add to these counts, which can make a fold
 *  miss but never keep a stale one. */
export const ALL_AGGREGATES = ""
export const AGGREGATE_DELETED = ""

/** The fact rows that the last statement on `db` updated or deleted. The
 *  `changes` of a bun:sqlite statement result also counts the rows that the
 *  rewrite-generation triggers write, so a statement that rewrites facts
 *  reads its own count here. */
export function factRowsChanged(db: Database): number {
  return db.query<{ changes: number }, []>("select changes() as changes").get()?.changes ?? 0
}

/** The rewrite generation of each aggregate and family (ARCH-SUBSTRATE-046).
 *
 *  Triggers, because they live in the schema: every connection that updates
 *  or deletes a fact advances it in the same transaction, including migration
 *  and maintenance connections, older builds, and foreign-key cascades, so no
 *  rewrite path can skip it. Inserts never rewrite history and count nothing.
 *  An update that moves a fact to another aggregate or type advances both.
 *  Updates and deletes count apart because a prune of superseded rows of a
 *  replace-only family is loss-free and a reader ignores those deletes.
 *
 *  Each row of aggregate `ALL_AGGREGATES` totals one family over every
 *  aggregate, so a scope of families alone reads one row per family. Each
 *  row of type `AGGREGATE_DELETED` counts the deletions of one aggregate, or
 *  of every aggregate, so a deletion invalidates a scope whose families are
 *  all replace-only, whose own deletes a reader ignores. */
function createEventRewriteGeneration(db: Database): void {
  db.exec(`
    create table if not exists event_rewrite (
      aggregate_id text not null,
      type text not null,
      updated integer not null default 0,
      deleted integer not null default 0,
      primary key (aggregate_id, type)
    ) without rowid
  `)
  db.exec(`
    create trigger if not exists event_rewrite_on_update after update on event begin
      insert into event_rewrite (aggregate_id, type, updated) values (old.aggregate_id, old.type, 1), ('${ALL_AGGREGATES}', old.type, 1)
        on conflict (aggregate_id, type) do update set updated = updated + 1;
      insert into event_rewrite (aggregate_id, type, updated) select new.aggregate_id, new.type, 1
        where new.aggregate_id <> old.aggregate_id or new.type <> old.type
        on conflict (aggregate_id, type) do update set updated = updated + 1;
      insert into event_rewrite (aggregate_id, type, updated) select '${ALL_AGGREGATES}', new.type, 1
        where new.type <> old.type
        on conflict (aggregate_id, type) do update set updated = updated + 1;
    end
  `)
  db.exec(`
    create trigger if not exists event_rewrite_on_delete after delete on event begin
      insert into event_rewrite (aggregate_id, type, deleted) values (old.aggregate_id, old.type, 1), ('${ALL_AGGREGATES}', old.type, 1)
        on conflict (aggregate_id, type) do update set deleted = deleted + 1;
    end
  `)
  db.exec(`
    create trigger if not exists event_rewrite_on_aggregate_delete after delete on event_sequence begin
      insert into event_rewrite (aggregate_id, type, deleted) values (old.aggregate_id, '${AGGREGATE_DELETED}', 1), ('${ALL_AGGREGATES}', '${AGGREGATE_DELETED}', 1)
        on conflict (aggregate_id, type) do update set deleted = deleted + 1;
    end
  `)
}

/** In-flight recovery state: the one live value of an operation that has begun
 *  and not finished, so an interrupted one can be resumed.
 *
 *  A companion to the log rather than part of it (ARCH-SUBSTRATE-024):
 *  state that exists only so an interrupted operation can finish is never a
 *  fact source. Recording it as
 *  facts wrote one row per revision of a value that has exactly one live
 *  version, then needed a second mechanism to delete the rest, which is how
 *  90,335 superseded chat provisionals and 11,453 mutation pairs accumulated.
 *
 *  Keyed by `(session_id, kind, key)` and upserted, so a value has one row
 *  however many times it is written. Read order is insertion order via rowid,
 *  which an upsert preserves - what a chained family (a provisional turn)
 *  needs. Session-scoped so both deletion paths can empty it: the tombstone
 *  append rides a `clear_session` write, and unreadable-session retirement
 *  deletes the rows beside the session's facts. */
function createInFlightTable(db: Database): void {
  db.exec(`
    create table if not exists in_flight (
      session_id text not null,
      kind text not null,
      key text not null,
      payload text not null,
      primary key (session_id, kind, key)
    )
  `)
  db.exec(`create index if not exists in_flight_profile_idx on in_flight(kind, json_extract(case when json_valid(payload) then payload else '{}' end, '$.profileId'))`)
  db.exec(`create index if not exists in_flight_entry_profile_idx on in_flight(kind, json_extract(case when json_valid(payload) then payload else '{}' end, '$.entry.profileId'))`)
}


/** Session-scoped content-addressed tool text (tool output dedup): facts and
 *  chat entries store a reference; these rows hold the bytes, once per
 *  (session, sha256). Session scoping lets deletion drop a session's content
 *  exactly like its facts, with no reference counting. Exported so the
 *  one-time dedup migration can convert a store that predates this table. */
export function createToolContentTable(db: Database): void {
  db.exec(`
    create table if not exists tool_content (
      session_id text not null,
      sha256 text not null,
      content text not null,
      bytes integer not null,
      session_content_node integer not null default 0,
      primary key (session_id, sha256)
    )
  `)
  // Rows written before 2026-10-16 are ordinary tool text, even if they contain
  // node-shaped JSON. Remove this additive conversion after 2027-04-16.
  const columns = db.query<{ name: string }, []>("pragma table_info(tool_content)").all()
  if (!columns.some(column => column.name === "session_content_node")) {
    db.exec("alter table tool_content add column session_content_node integer not null default 0")
  }
}


