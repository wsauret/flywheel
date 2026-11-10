import type { EventStoreReadSurface, FactQuery, StoredFact } from "../../src/infra/event-store-types.js"
import type { ToolContentRow } from "../../src/infra/tool-content.js"

/** Filter semantics of the SQLite read surface over an in-memory fact list. */
export function matchesFactQuery(event: StoredFact, query: FactQuery): boolean {
  if (query.aggregateId !== undefined && event.aggregateId !== query.aggregateId) return false
  if (query.aggregatePrefix !== undefined && !event.aggregateId.startsWith(query.aggregatePrefix)) return false
  if (query.aggregateIds !== undefined && !query.aggregateIds.includes(event.aggregateId)) return false
  if (query.sessionId !== undefined && event.sessionId !== query.sessionId) return false
  if (query.positions !== undefined && !query.positions.includes(event.position)) return false
  if (query.types !== undefined && !query.types.includes(event.type)) return false
  if (query.afterPosition !== undefined && event.position <= query.afterPosition) return false
  if (query.beforePosition !== undefined && event.position >= query.beforePosition) return false
  if (query.fromSeq !== undefined && event.seq < query.fromSeq) return false
  if (query.parentToolUseIds !== undefined) {
    // A parentless fact matches nothing, exactly like SQL's NULL IN (...).
    const parent = event.payload.parentToolUseId
    if (typeof parent !== "string" || !query.parentToolUseIds.includes(parent)) return false
  }
  return true
}

/** Complete in-memory read surface over a live `StoredFact` array,
 *  mirroring the SQLite read surface's filtering semantics. The array is read
 *  at call time, so a fixture that appends later events is observed. Fixtures
 *  are expected in position order and never hold corrupt rows, so the
 *  tolerant variant returns the strict results. Content rows for the
 *  tool-content resolver are seeded per session id. */
export function inMemoryEventReader(
  events: readonly StoredFact[],
  contentRowsBySession: ReadonlyMap<string, readonly ToolContentRow[]> = new Map(),
): EventStoreReadSurface {
  const byAggregate = (aggregateId: string) => events.filter((event) => event.aggregateId === aggregateId)
  const read = (query: FactQuery = {}) => {
    const order = query.aggregateId !== undefined && query.types === undefined && query.afterPosition === undefined && query.beforePosition === undefined && query.positions === undefined ? "seq" : "position"
    const direction = query.order === "desc" ? -1 : 1
    const taken = new Map<string, number>()
    return events.filter((event) => matchesFactQuery(event, query))
      .sort((a, b) => direction * (a[order] - b[order]))
      .filter((event) => {
        const count = (taken.get(event.aggregateId) ?? 0) + 1
        taken.set(event.aggregateId, count)
        return query.limitPerAggregate === undefined || count <= query.limitPerAggregate
      })
      .slice(0, query.limit)
  }
  const latestByAggregateAndType = (aggregateId: string, type: string) =>
    byAggregate(aggregateId).filter((event) => event.type === type).at(-1)

  return {
    read,
    readTolerant: read,
    toolContent: {
      resolve: (sessionId, sha256) =>
        contentRowsBySession.get(sessionId)?.find((row) => row.sha256 === sha256)?.content ?? null,
    },
    readLatestPayloadByAggregateAndType: (aggregateId, type) => {
      const latest = latestByAggregateAndType(aggregateId, type)
      return latest ? JSON.stringify(latest.payload) : null
    },
    readLatestByAggregateAndTypes: (aggregateId, types) => types
      .flatMap((type) => latestByAggregateAndType(aggregateId, type) ?? [])
      .sort((a, b) => a.position - b.position),
    currentPosition: () => events.at(-1)?.position ?? 0,
    countByAggregate: (aggregateId) => byAggregate(aggregateId).length,
    aggregateSeq: (aggregateId) => byAggregate(aggregateId).at(-1)?.seq ?? -1,
    // In-flight state is never folded from facts, so a fact-list double holds none.
    readInFlight: () => [],
    sessionsWithInFlight: () => [],
    inFlightProfileKeys: () => [],
    // A fact list is never rewritten, so its generation stays zero.
    foldEvidence: (scope, at) => {
      const anchor = read({ ...scope, beforePosition: at + 1, order: "desc", limit: 1 })[0]
      return { head: events.at(-1)?.position ?? 0, generation: 0, anchor: anchor ? { position: anchor.position, id: anchor.id } : null }
    },
  }
}
