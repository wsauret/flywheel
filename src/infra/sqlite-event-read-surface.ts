import type { Database, Statement } from "bun:sqlite"

import { rowToStoredFact, rowToStoredFactTolerant, type EventRow } from "./event-row.js"
import type { CorruptEventRowError, EventStoreReadSurface, FactQuery, FoldAnchor, FoldScope, InFlightRecord, StoredFact } from "./event-store-types.js"
import { factRetention } from "./fact-retention-registry.js"
import { AGGREGATE_DELETED, ALL_AGGREGATES } from "./sqlite-event-store-core.js"
// The typed read surface is the single definition of how the event substrate is
// read. Every store connection (writable or read-only) builds its query side
// from here, so a SQL / ORDER-BY / index change can't silently diverge the
// live and replay read paths.
export function createSqliteEventReadSurface(db: Database): EventStoreReadSurface {
  interface SqlParameters { [name: string]: string | number }

  // `indexed by` on the type-filtered reads: without it the planner prefers a
  // sort-free scan over the type-scoped index - for `type IN` it walks the
  // whole table by rowid (bun's bundled SQLite), and for aggregate+type it
  // walks every event of the aggregate via event_aggregate_position_idx --
  // turning catalog reads into O(total events) and dominating cold start on
  // large workspaces (~300x measured). ANALYZE does not change the choice, so
  // the indexes (created in initializeSqliteEventStore) are pinned.
  //
  // Parent-filtered child reads also ride event_aggregate_type_position_idx:
  // the aggregate+type probe bounds the scan to one session's tool facts, and
  // the json_extract residual filter is cheap at that size. A dedicated
  // payload expression index would be built synchronously inside store open
  // and stalls runtime readiness for seconds on a large workspace.
  function indexHint(query: FactQuery): string {
    // NOT INDEXED leaves rowid lookup available and prevents a type/session
    // index from scanning past the exact primary-key positions.
    if (query.positions !== undefined) return " not indexed"
    // The plan follows the query shape, never the cursor value, so every page
    // of a catch-up uses the same ordered seek. No index orders one family by
    // position: the aggregate index orders by aggregate first, so it must sort
    // the rest of the family on each page. A typed family read seeks each type
    // in position order and filters the family. An untyped family read walks
    // the rowid range after its cursor, which `ProjectionDefinition` requires
    // to start at a captured position.
    if (query.aggregatePrefix !== undefined) return query.types === undefined ? " not indexed" : " indexed by event_type_idx"
    if ((query.aggregateId !== undefined || query.aggregateIds !== undefined) && query.types !== undefined) return " indexed by event_aggregate_type_position_idx"
    // Each aggregate seeks its position range, so a catch-up of many
    // aggregates reads only the facts after its cursor.
    if (query.aggregateIds !== undefined) return " indexed by event_aggregate_position_idx"
    if (query.aggregateId === undefined && query.sessionId !== undefined) return " indexed by event_session_idx"
    if (query.types !== undefined) return " indexed by event_type_idx"
    return ""
  }

  // The old method family made these shapes unrepresentable; keep producer
  // bugs loud instead of returning a plausible-looking wrong subset.
  function assertSupportedQuery(query: FactQuery): void {
    if (query.fromSeq !== undefined && query.aggregateId === undefined) throw new Error("FactQuery.fromSeq requires aggregateId")
    if (query.parentToolUseIds !== undefined && (query.aggregateId === undefined || query.types === undefined)) throw new Error("FactQuery.parentToolUseIds requires aggregateId and types")
    if (query.toolUseIds !== undefined && (query.aggregateId === undefined || query.types === undefined)) throw new Error("FactQuery.toolUseIds requires aggregateId and types")
    if (query.aggregateIds !== undefined && query.aggregateId !== undefined) throw new Error("FactQuery.aggregateIds excludes aggregateId")
    if (query.aggregatePrefix !== undefined && !query.aggregatePrefix.endsWith(":")) throw new Error("FactQuery.aggregatePrefix requires a trailing colon")
    if (query.aggregatePrefix !== undefined && query.aggregateId !== undefined) throw new Error("FactQuery.aggregatePrefix excludes aggregateId")
    if (query.limitPerAggregate !== undefined && query.aggregateIds === undefined) throw new Error("FactQuery.limitPerAggregate requires aggregateIds")
    if (query.limitPerAggregate !== undefined && query.types === undefined) throw new Error("FactQuery.limitPerAggregate requires types")
  }

  // A per-aggregate bound reads each aggregate apart: its type seeks merge in
  // position order and stop at the bound, so the read costs the bound and
  // never the aggregate's history. One `aggregate_id in (...)` read with a
  // window rank would instead rank every row of every aggregate. SQLite caps
  // one compound select at 500 arms, so one such read takes at most 500
  // aggregates and 500 types.
  function perAggregateSql(aggregates: number, types: number, where: readonly string[], direction: string, limit: string): string {
    const perAggregate = Array.from({ length: aggregates }, (_, a) => {
      const seeks = Array.from({ length: types }, (_unused, t) => `select * from event indexed by event_aggregate_type_position_idx where ${[`aggregate_id = $a${a}`, `type = $t${t}`, ...where].join(" and ")}`)
      return `select * from (${seeks.join(" union all ")} order by position ${direction} limit $limitPerAggregate)`
    })
    return `${perAggregate.join(" union all ")} order by position ${direction}${limit}`
  }

  // Filtered by-type reads can't bind arrays (bun:sqlite has no array-binding)
  // so the IN clause arity is baked into the SQL text. Each projection reads a
  // fixed type set, so caching by SQL text (db.query's own cache) converges to
  // a handful of statements prepared once per connection.
  function queryRows(query: FactQuery): EventRow[] {
    assertSupportedQuery(query)
    if (query.types?.length === 0 || query.aggregateIds?.length === 0 || query.positions?.length === 0 || query.parentToolUseIds?.length === 0 || query.toolUseIds?.length === 0 || query.limit === 0 || query.limitPerAggregate === 0) return []
    const where: string[] = []
    const parameters: SqlParameters = {}
    if (query.aggregateId !== undefined) {
      where.push("aggregate_id = $aggregateId")
      parameters.$aggregateId = query.aggregateId
    }
    if (query.aggregatePrefix !== undefined) {
      where.push("aggregate_id >= $aggregatePrefix and aggregate_id < $aggregatePrefixEnd")
      parameters.$aggregatePrefix = query.aggregatePrefix
      parameters.$aggregatePrefixEnd = `${query.aggregatePrefix.slice(0, -1)};`
    }
    const aggregateIds = query.aggregateIds === undefined ? undefined : [...new Set(query.aggregateIds)]
    if (aggregateIds !== undefined) {
      if (query.limitPerAggregate === undefined) where.push(`aggregate_id in (${aggregateIds.map((_, i) => `$a${i}`).join(", ")})`)
      for (const [i, aggregateId] of aggregateIds.entries()) parameters[`$a${i}`] = aggregateId
    }
    if (query.sessionId !== undefined) {
      where.push("session_id = $sessionId")
      parameters.$sessionId = query.sessionId
    }
    if (query.positions !== undefined) {
      where.push(`position in (${query.positions.map((_, i) => `$n${i}`).join(", ")})`)
      for (const [i, position] of query.positions.entries()) parameters[`$n${i}`] = position
    }
    const types = query.types === undefined || (query.aggregateIds !== undefined && query.limitPerAggregate === undefined) ? query.types : [...new Set(query.types)]
    if (types !== undefined) for (const [i, type] of types.entries()) parameters[`$t${i}`] = type
    if (query.afterPosition !== undefined) {
      where.push("position > $position")
      parameters.$position = query.afterPosition
    }
    if (query.beforePosition !== undefined) {
      where.push("position < $beforePosition")
      parameters.$beforePosition = query.beforePosition
    }
    if (query.fromSeq !== undefined) {
      where.push("seq >= $seq")
      parameters.$seq = query.fromSeq
    }
    if (query.parentToolUseIds !== undefined) {
      where.push(`json_extract(payload, '$.parentToolUseId') in (${query.parentToolUseIds.map((_, i) => `$p${i}`).join(", ")})`)
      for (const [i, parentToolUseId] of query.parentToolUseIds.entries()) parameters[`$p${i}`] = parentToolUseId
    }
    if (query.toolUseIds !== undefined) {
      where.push(`json_extract(payload, '$.toolUseId') in (${query.toolUseIds.map((_, i) => `$u${i}`).join(", ")})`)
      for (const [i, toolUseId] of query.toolUseIds.entries()) parameters[`$u${i}`] = toolUseId
    }
    // Whole-aggregate and from-seq reads order by seq (the aggregate's own
    // clock); every position-filtered or workspace-wide read orders by the
    // workspace position. Within one aggregate the two orders agree, so the
    // split only exists to match each shape's covering index.
    const order = query.aggregateId !== undefined && query.types === undefined && query.afterPosition === undefined && query.beforePosition === undefined && query.positions === undefined ? "seq" : "position"
    const direction = query.order ?? "asc"
    const limit = query.limit === undefined ? "" : " limit $limit"
    if (query.limit !== undefined) parameters.$limit = query.limit
    if (aggregateIds !== undefined && types !== undefined && query.limitPerAggregate !== undefined) {
      parameters.$limitPerAggregate = query.limitPerAggregate
      return db.query<EventRow, [SqlParameters]>(perAggregateSql(aggregateIds.length, types.length, where, direction, limit)).all(parameters)
    }
    const hint = indexHint(query)
    // Global and single-aggregate type equality scans merge in index order.
    // Multi-aggregate reads keep one IN query and its existing sort.
    // Session and exact-position indexes already give position order.
    const typePredicates = types !== undefined && query.aggregateIds === undefined && (hint === " indexed by event_type_idx" || hint === " indexed by event_aggregate_type_position_idx")
      ? types.map((_, i) => `type = $t${i}`)
      : [types === undefined ? undefined : `type in (${types.map((_, i) => `$t${i}`).join(", ")})`]
    const selects = typePredicates.map((typePredicate) => {
      const predicates = typePredicate === undefined ? where : [...where, typePredicate]
      return `select * from event${hint}${predicates.length === 0 ? "" : ` where ${predicates.join(" and ")}`}`
    })
    // db.query, not db.prepare: cached statements are finalized at close, which
    // the store's WAL-sidecar cleanup depends on.
    return db.query<EventRow, [SqlParameters]>(`${selects.join(" union all ")} order by ${order} ${direction}${limit}`).all(parameters)
  }

  const selectMaxPosition = db.query<{ position: number }, []>(
    "select coalesce(max(position), 0) as position from event",
  )
  const selectAggregateCount = db.query<{ count: number }, { $aggregateId: string }>(
    "select count(*) as count from event where aggregate_id = $aggregateId",
  )
  const selectInFlightSessions = db.query<{ session_id: string }, { $kind: string }>(
    "select distinct session_id from in_flight where kind = $kind order by session_id",
  )
  const selectInFlightProfile = db.query<{ found: number }, { $kind: string; $profileId: string }>(`
    select 1 as found from in_flight where kind = $kind
      and json_extract(case when json_valid(payload) then payload else '{}' end, '$.profileId') = $profileId
    union all
    select 1 as found from in_flight where kind = $kind
      and json_extract(case when json_valid(payload) then payload else '{}' end, '$.entry.profileId') = $profileId
    limit 1
  `)
  const selectAggregateSeq = db.query<{ seq: number } | null, { $aggregateId: string }>(
    "select seq from event_sequence where aggregate_id = $aggregateId",
  )
  const selectLatestPayloadByAggregateAndType = db.query<{ payload: string }, { $aggregateId: string; $type: string }>(
    "select payload from event where aggregate_id = $aggregateId and type = $type order by position desc limit 1",
  )
  const selectLatestByAggregateAndType = db.query<EventRow, { $aggregateId: string; $type: string }>(
    "select * from event indexed by event_aggregate_type_position_idx where aggregate_id = $aggregateId and type = $type order by position desc limit 1",
  )

  // Prepared on first resolve, not at surface creation: a read-only connection
  // to a store no current build has opened writable yet has no tool_content
  // table, and such a store cannot hold a reference to resolve either.
  let selectToolContent: Statement<{ content: string } | null, [{ $sessionId: string; $sha256: string }]> | null = null

  function resolveToolContent(sessionId: string, sha256: string): string | null {
    selectToolContent ??= db.query<{ content: string } | null, { $sessionId: string; $sha256: string }>(
      "select content from tool_content where session_id = $sessionId and sha256 = $sha256",
    )
    return selectToolContent.get({ $sessionId: sessionId, $sha256: sha256 })?.content ?? null
  }

  let hasSessionContentNodes = false
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: preserve malformed immutable storage values for shared validation and unavailable-evidence results.
  function readSessionContentNode(sessionId: string, sha256: string): unknown | null {
    if (!hasSessionContentNodes) {
      hasSessionContentNodes = db.query<{ name: string }, []>("pragma table_info(tool_content)").all()
        .some(column => column.name === "session_content_node")
      if (!hasSessionContentNodes) return null
    }
    const row = db.query<{ content: string } | null, { $sessionId: string; $sha256: string }>(
      "select content from tool_content where session_id = $sessionId and sha256 = $sha256 and session_content_node = 1",
    ).get({ $sessionId: sessionId, $sha256: sha256 })
    if (!row) return null
    try { return JSON.parse(row.content) } catch { return row.content }
  }

  function readInFlight(sessionId: string, kind: string | readonly string[], keyPrefix?: string): InFlightRecord[] {
    const kinds = typeof kind === "string" ? [kind] : kind
    if (kinds.length === 0) return []
    const parameters: SqlParameters = { $sessionId: sessionId }
    const placeholders = kinds.map((value, index) => {
      const name = `$kind${index}`
      parameters[name] = value
      return name
    })
    if (keyPrefix !== undefined) parameters.$keyPrefix = keyPrefix
    const prefixPredicate = keyPrefix === undefined ? "" : " and substr(key, 1, length($keyPrefix)) = $keyPrefix"
    const rows = db.query<{ kind: string; key: string; payload: string }, [SqlParameters]>(
      `select kind, key, payload from in_flight where session_id = $sessionId and kind in (${placeholders.join(", ")})${prefixPredicate} order by rowid`,
    ).all(parameters)
    return rows.map((row) => ({ kind: row.kind, key: row.key, payload: asRecordOrEmpty(row.payload), raw: row.payload }))
  }
  // One index seek per aggregate and type, so the evidence of a large scope
  // costs its aggregate and type counts, never its history.
  function anchorAt(scope: FoldScope, position: number): FoldAnchor | null {
    const types = scope.types?.filter((type) => !replacesLatest(type))
    if (types?.length === 0) return null
    const aggregates = scope.aggregateId !== undefined ? [scope.aggregateId] : scope.aggregateIds
    let anchor: FoldAnchor | null = null
    for (const aggregate of aggregates ?? [undefined]) {
      for (const type of types ?? [undefined]) {
        const parameters: SqlParameters = { $at: position }
        const where = ["position <= $at"]
        if (aggregate !== undefined) { where.push("aggregate_id = $aggregate"); parameters.$aggregate = aggregate }
        if (type !== undefined) { where.push("type = $type"); parameters.$type = type }
        const hint = aggregate === undefined ? type === undefined ? "" : " indexed by event_type_idx"
          : type === undefined ? " indexed by event_aggregate_position_idx" : " indexed by event_aggregate_type_position_idx"
        const row = db.query<FoldAnchor, [SqlParameters]>(`select position, id from event${hint} where ${where.join(" and ")} order by position desc limit 1`).get(parameters)
        if (row && (anchor === null || row.position > anchor.position)) anchor = { position: row.position, id: row.id }
      }
    }
    return anchor
  }

  // Primary-key seeks of the scope's aggregates, or of the rows that total
  // every aggregate, and of its types with the aggregate deletions, so the
  // generation never scans the table.
  function rewriteGeneration(scope: FoldScope): number {
    const parameters: SqlParameters = {}
    const list = (prefix: string, values: readonly string[]): string => values.map((value, index) => {
      parameters[`${prefix}${index}`] = value
      return `${prefix}${index}`
    }).join(", ")
    const aggregates = scope.aggregateId !== undefined ? [scope.aggregateId] : scope.aggregateIds ? [...new Set(scope.aggregateIds)] : [ALL_AGGREGATES]
    const types = scope.types && [...new Set(scope.types), AGGREGATE_DELETED]
    const typeFilter = types ? ` and type in (${list("$t", types)})` : ""
    let generation = 0
    for (const row of db.query<{ type: string; updated: number; deleted: number }, [SqlParameters]>(
      `select type, updated, deleted from event_rewrite where aggregate_id in (${list("$a", aggregates)})${typeFilter}`,
    ).all(parameters)) {
      generation += row.updated + (replacesLatest(row.type) ? 0 : row.deleted)
    }
    return generation
  }

  function read(query: FactQuery = {}): StoredFact[] {
    return queryRows(query).map(rowToStoredFact)
  }

  function readTolerant(query: FactQuery = {}): Array<StoredFact | CorruptEventRowError> {
    return queryRows(query).map(rowToStoredFactTolerant)
  }

  return {
    readSessionContentNode,
    read,
    readTolerant,
    toolContent: { resolve: resolveToolContent },
    readLatestPayloadByAggregateAndType: (aggregateId, type) =>
      selectLatestPayloadByAggregateAndType.get({ $aggregateId: aggregateId, $type: type })?.payload ?? null,
    readLatestByAggregateAndTypes: (aggregateId, types) => types
      .flatMap((type) => {
        const row = selectLatestByAggregateAndType.get({ $aggregateId: aggregateId, $type: type })
        return row ? [rowToStoredFact(row)] : []
      })
      .sort((a, b) => a.position - b.position),
    currentPosition: () => selectMaxPosition.get()?.position ?? 0,
    countByAggregate: (aggregateId) => selectAggregateCount.get({ $aggregateId: aggregateId })?.count ?? 0,
    aggregateSeq: (aggregateId) => selectAggregateSeq.get({ $aggregateId: aggregateId })?.seq ?? -1,
    sessionsWithInFlight: (kind) => selectInFlightSessions.all({ $kind: kind }).map((row) => row.session_id),
    hasInFlightProfile: (kind, profileId) => selectInFlightProfile.get({ $kind: kind, $profileId: profileId }) !== null,
    readInFlight,
    foldEvidence: (scope, at) => ({ head: selectMaxPosition.get()?.position ?? 0, generation: rewriteGeneration(scope), anchor: anchorAt(scope, at) }),
  }
}

/** A family whose superseded rows a prune deletes without changing any fold. */
function replacesLatest(type: string): boolean {
  const policy = factRetention(type)?.policy
  return policy === "replace-latest" || policy === "replace-latest-keyed"
}

/** An in-flight payload decodes to a record or, if it cannot, to nothing: the
 *  recovery path treats an unreadable entry as an operation it cannot resume
 *  rather than failing the read that found it. */
function asRecordOrEmpty(payload: string): { [key: string]: unknown } {
  try {
    const parsed: unknown = JSON.parse(payload)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {}
  } catch {
    return {}
  }
}
