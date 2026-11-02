import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import { rowToStoredFact, type EventRow } from "./event-row.js"
import type { StoredFact } from "./event-store-types.js"
import { hydrateToolContentFact } from "./tool-content-hydration.js"

/** Metadata predicates applied before payload decoding. Payload predicates
 *  belong to the incremental consumer, which hydrates only when needed. */
export interface EventScanFilter {
  afterPosition?: number
  /** Inclusive position window; takes precedence over afterPosition. */
  positionRange?: { start: number; end: number }
  sessionId?: string
  actor?: string
  /** Exact, case-sensitive type list (SQL IN). */
  types?: readonly string[]
  typePatterns?: readonly string[]
  excludeSnapshots?: boolean
  sinceTimestamp?: number
  untilTimestamp?: number
  order?: "asc" | "desc"
  sortBy?: "timestamp"
  /** Positive row limit, only when no payload predicate remains. */
  limit?: number
}

export interface EventTypeSummary {
  type: string
  count: number
  firstPosition: number
  lastPosition: number
  firstTimestamp: number
  lastTimestamp: number
}

interface EventSearchBindings {
  [placeholder: string]: string | number
}

// Facts arrive in roughly timestamp order, with inversions between writers;
// the largest seen in a 5.7M-row store was 52 seconds. Widen only the position
// lookup by ten minutes; the SQL timestamp predicates still enforce the exact
// requested window, so the margin costs rows scanned, never rows returned.
const timestampPositionMarginMs = 600_000

export interface EventSearchConnection {
  /** Consume before closing the connection. Strictly parses owned JSON without
   *  expanding content references. Corrupt consumed payloads throw. */
  scan(filter: EventScanFilter): Iterable<StoredFact>
  /** Expand references to exact verified text before closing. Missing or corrupt
   *  content throws. Already inline facts return unchanged. */
  hydrate(fact: StoredFact): StoredFact
  timestampRange(filter: EventScanFilter): { sinceTimestamp: number; untilTimestamp: number } | null
  /** Per-type counts and extents over the rows `filter` selects. */
  typeSummaries(filter: EventScanFilter): EventTypeSummary[]
  close(): void
}

/** Read-only debug-path companion to `createSqliteEventStore`: same schema,
 *  same row mapping, no write surface, and it never creates the database.
 *  Returns null when no store exists at `dbPath`. */
export function openEventSearch(dbPath: string): EventSearchConnection | null {
  if (!fs.existsSync(dbPath)) return null
  const db = new Database(dbPath, { readonly: true })
  const toolContent = {
    resolve: (sessionId: string, sha256: string): string | null =>
      db.query<{ content: string }, [string, string]>(
        "select content from tool_content where session_id = ? and sha256 = ?",
      ).get(sessionId, sha256)?.content ?? null,
  }

  function timestampPosition(timestamp: number, strictlyAfter: boolean): number {
    const first = db.query<{ position: number }, []>("select position from event order by position limit 1").get()
    const last = db.query<{ position: number }, []>("select position from event order by position desc limit 1").get()
    if (!first || !last) return 0
    let lower = first.position
    let upper = last.position + 1
    const next = db.query<{ position: number; timestamp: number }, [number]>(
      "select position, timestamp from event where position >= ? order by position limit 1",
    )
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2)
      const row = next.get(middle)
      if (!row || (strictlyAfter ? row.timestamp > timestamp : row.timestamp >= timestamp)) upper = middle
      else lower = row.position + 1
    }
    return lower
  }

  function predicates(filter: EventScanFilter) {
    const clauses: string[] = []
    const params: EventSearchBindings = {}
    let afterPosition = filter.positionRange ? filter.positionRange.start - 1 : filter.afterPosition ?? 0
    let endPosition = filter.positionRange?.end
    if (filter.sinceTimestamp !== undefined) {
      afterPosition = Math.max(afterPosition, timestampPosition(filter.sinceTimestamp - timestampPositionMarginMs, false) - 1)
    }
    if (filter.untilTimestamp !== undefined) {
      const untilPosition = timestampPosition(filter.untilTimestamp + timestampPositionMarginMs, true) - 1
      endPosition = endPosition === undefined ? untilPosition : Math.min(endPosition, untilPosition)
    }
    // SQLite can seek from the weaker of redundant rowid bounds. Intersect
    // them here so the only lower bound is the one the scan must start at.
    clauses.push("position > $afterPosition")
    params.$afterPosition = afterPosition
    if (endPosition !== undefined) {
      clauses.push("position <= $endPosition")
      params.$endPosition = endPosition
    }
    if (filter.sessionId) {
      clauses.push("session_id = $sessionId")
      params.$sessionId = filter.sessionId
    }
    if (filter.actor) {
      clauses.push("actor = $actor")
      params.$actor = filter.actor
    }
    if (filter.sinceTimestamp !== undefined) {
      clauses.push("timestamp >= $sinceTimestamp")
      params.$sinceTimestamp = filter.sinceTimestamp
    }
    if (filter.untilTimestamp !== undefined) {
      clauses.push("timestamp <= $untilTimestamp")
      params.$untilTimestamp = filter.untilTimestamp
    }
    if (filter.types && filter.types.length > 0) {
      const placeholders = filter.types.map((_, i) => `$t${i}`).join(", ")
      clauses.push(`type in (${placeholders})`)
      for (const [i, type] of filter.types.entries()) params[`$t${i}`] = type
    }
    if (filter.typePatterns?.length) {
      // SQLite's LIKE/lower only fold ASCII. Resolve the indexed vocabulary
      // with the existing JS semantics, then bind exact types in the row query.
      // Skip-scan event_type_idx one seek per distinct type; `select distinct`
      // reads every index entry, which takes seconds on a large store.
      const placeholders: string[] = []
      const nextType = db.query<{ type: string }, [string]>("select type from event where type > ? order by type limit 1")
      for (let row = nextType.get(""); row; row = nextType.get(row.type)) {
        if (!matchesEventType(row.type, filter.typePatterns)) continue
        const placeholder = `$patternType${placeholders.length}`
        placeholders.push(placeholder)
        params[placeholder] = row.type
      }
      clauses.push(placeholders.length ? `type in (${placeholders.join(", ")})` : "0")
    }
    if (filter.excludeSnapshots) {
      clauses.push("type != $snapshot")
      params.$snapshot = "output.snapshot.recorded"
    }
    // Without statistics SQLite prefers event_type_idx for a type predicate,
    // which walks that type across every session. One session is a far
    // narrower seek, so a session-scoped read pins its index.
    const source = filter.sessionId ? "event indexed by event_session_idx" : "event"
    return { source, where: clauses.join(" and "), params }
  }

  function* scan(filter: EventScanFilter): Generator<StoredFact> {
    const { source, where, params } = predicates(filter)
    const order = filter.order === "desc" ? "desc" : "asc"
    const ordering = filter.sortBy === "timestamp" ? `timestamp ${order}, position ${order}` : `position ${order}`
    let limit = ""
    if (filter.limit !== undefined && filter.limit > 0) {
      limit = "limit $limit"
      params.$limit = filter.limit
    }
    // No timestamp index exists. Keep payloads out of SQLite's temporary sorter.
    const identities = db.query<{ position: number; timestamp: number }, [EventSearchBindings]>(`
      select position, timestamp
      from ${source}
      where ${where}
      order by ${ordering}
      ${limit}
    `).iterate(params)
    const rowByPosition = db.query<EventRow, [number]>("select * from event where position = ?")
    for (const { position } of identities) {
      // SAFETY: the active identity iterator holds this connection's read view, so its primary-key row still exists.
      yield rowToStoredFact(rowByPosition.get(position)!)
    }
  }

  function timestampRange(filter: EventScanFilter): { sinceTimestamp: number; untilTimestamp: number } | null {
    const { source, where, params } = predicates(filter)
    const range = db.query<{ sinceTimestamp: number | null; untilTimestamp: number | null }, [EventSearchBindings]>(`
      select min(timestamp) as sinceTimestamp, max(timestamp) as untilTimestamp
      from ${source} where ${where}
    `).get(params)
    return range?.sinceTimestamp != null && range.untilTimestamp != null
      ? { sinceTimestamp: range.sinceTimestamp, untilTimestamp: range.untilTimestamp }
      : null
  }

  function typeSummaries(filter: EventScanFilter): EventTypeSummary[] {
    const { source, where, params } = predicates(filter)
    return db.query<EventTypeSummary, [EventSearchBindings]>(`
      select
        type,
        count(*) as count,
        min(position) as firstPosition,
        max(position) as lastPosition,
        min(timestamp) as firstTimestamp,
        max(timestamp) as lastTimestamp
      from ${source}
      where ${where}
      group by type
      order by type asc
    `).all(params)
  }

  return {
    scan,
    hydrate: (fact) => hydrateToolContentFact(fact, toolContent),
    timestampRange,
    typeSummaries,
    close: () => db.close(),
  }
}

/** Case-insensitive substring patterns, or anchored globs with `*` only. */
export function matchesEventType(type: string, patterns: readonly string[]): boolean {
  return patterns.length === 0 || patterns.some((pattern) => {
    if (!pattern.includes("*")) return type.toLowerCase().includes(pattern.toLowerCase())
    const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")
    return new RegExp(`^${escaped}$`, "i").test(type)
  })
}
