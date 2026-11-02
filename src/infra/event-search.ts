import type { StoredFact } from "./event-store-types.js"
import {
  type EventScanFilter,
  type EventSearchConnection,
  type EventTypeSummary,
  openEventSearch,
  matchesEventType,
} from "./event-store-search.js"
import { type DebugLogRecord, listDebugLogFiles, resolveDebugLogDirectory, scanDebugLogFiles } from "./debug-log.js"
import { asRecord, isRecord } from "./record.js"
import { resolveEventStoreDbFile } from "./paths.js"

interface Payload {
  readonly [key: string]: unknown
}

export interface EventSearchQuery {
  baseDir: string
  pattern?: string
  sessionId?: string
  requestId?: string
  typePatterns?: readonly string[]
  actor?: string
  errorsOnly?: boolean
  caseSensitive?: boolean
  regex?: boolean
  limit?: number
  order?: "asc" | "desc"
  afterPosition?: number
  sinceTimestamp?: number
  untilTimestamp?: number
  includeSnapshots?: boolean
  aroundPosition?: number
  aroundRadius?: number
}

type EventSearchSource = "store" | "log"

/** One row of the merged timeline: a durable store fact or a debug-log
 *  diagnostics record, tagged by source. */
export type EventSearchRow =
  | { source: "store"; fact: StoredFact }
  | { source: "log"; record: DebugLogRecord }

export function rowTimestamp(row: EventSearchRow): number {
  return row.source === "store" ? row.fact.timestamp : row.record.ts
}

export function rowType(row: EventSearchRow): string {
  return row.source === "store" ? row.fact.type : row.record.type
}

export function rowActor(row: EventSearchRow): string | undefined {
  return row.source === "store" ? row.fact.actor : row.record.actor
}

interface EventSearchResult {
  dbPath: string
  logDir: string
  storeFound: boolean
  logFilesFound: boolean
  matches: EventSearchRow[]
}

/** The timestamp window the debug-log side of a merged search is limited to.
 *  Null means the log side is excluded because the anchoring store position
 *  could not resolve. */
type LogWindow = { sinceTimestamp?: number; untilTimestamp?: number } | null

interface SearchCandidate {
  row: EventSearchRow
  /** Heap movement must not change arrival order for equal log timestamps. */
  sequence: number
}

export function searchEvents(query: EventSearchQuery): EventSearchResult {
  const dbPath = resolveEventStoreDbFile(query.baseDir)
  const logDir = resolveDebugLogDirectory(query.baseDir)
  const logFiles = listDebugLogFiles(logDir)
  // Absent store = fresh workspace, a normal debug-CLI condition, not
  // corruption; surfaced explicitly as storeFound. Debug-log files are still
  // searched so a log-only workspace stays inspectable.
  const connection = openEventSearch(dbPath)
  try {
    const limit = query.limit ?? 80
    const logWindow = connection ? deriveLogWindow(connection, query) : missingStoreLogWindow(query)
    const sources = [
      connection ? scanStoreSource(connection, query, limit) : [],
      logWindow === null ? [] : scanLogSource(logFiles, query, logWindow),
    ]
    const compareRows = rowComparator(query.order ?? "asc")
    const compare = (a: SearchCandidate, b: SearchCandidate) => compareRows(a.row, b.row) || a.sequence - b.sequence
    const candidates: SearchCandidate[] = []
    let sequence = 0
    for (const source of sources) {
      for (const row of source) {
        const candidate = { row, sequence: sequence++ }
        if (limit > 0) retainCandidate(candidates, candidate, limit, compare)
        else candidates.push(candidate)
      }
    }
    candidates.sort(compare)
    if (connection) {
      for (const { row } of candidates) {
        if (row.source === "store") row.fact = connection.hydrate(row.fact)
      }
    }
    return {
      dbPath,
      logDir,
      storeFound: connection !== null,
      logFilesFound: logFiles.length > 0,
      matches: candidates.map(({ row }) => row),
    }
  } finally {
    connection?.close()
  }
}

/** Keep the best k candidates in a max-heap whose root is the worst retained row. */
function retainCandidate(
  heap: SearchCandidate[],
  candidate: SearchCandidate,
  limit: number,
  compare: (a: SearchCandidate, b: SearchCandidate) => number,
): void {
  if (heap.length < limit) {
    let index = heap.length
    heap.push(candidate)
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)
      // SAFETY: parentIndex is inside the dense heap below index.
      const parent = heap[parentIndex]!
      if (compare(candidate, parent) <= 0) break
      heap[index] = parent
      index = parentIndex
    }
    heap[index] = candidate
    return
  }

  // SAFETY: this branch has heap.length >= limit > 0.
  if (compare(candidate, heap[0]!) >= 0) return
  let index = 0
  while (index * 2 + 1 < heap.length) {
    let childIndex = index * 2 + 1
    // SAFETY: the loop bounds the left child within the dense heap.
    let child = heap[childIndex]!
    if (childIndex + 1 < heap.length) {
      // SAFETY: the branch bounds the right child within the dense heap.
      const right = heap[childIndex + 1]!
      if (compare(right, child) > 0) {
        childIndex += 1
        child = right
      }
    }
    if (compare(candidate, child) >= 0) break
    heap[index] = child
    index = childIndex
  }
  heap[index] = candidate
}

/** One type of the merged vocabulary with the source(s) it appears in.
 *  Positions exist only for store rows; log records are not
 *  position-addressed. */
export interface MergedEventTypeSummary {
  type: string
  sources: EventSearchSource[]
  count: number
  firstTimestamp: number
  lastTimestamp: number
  firstPosition?: number
  lastPosition?: number
}

interface EventTypeSummaryResult {
  dbPath: string
  logDir: string
  storeFound: boolean
  logFilesFound: boolean
  types: MergedEventTypeSummary[]
}

/** The row filters a type summary honors: every search filter that selects
 *  rows by metadata. Payload filters have no summary meaning here. */
type EventTypeQuery = Pick<
  EventSearchQuery,
  "baseDir" | "sessionId" | "typePatterns" | "actor" | "afterPosition" | "sinceTimestamp" | "untilTimestamp" | "aroundPosition" | "aroundRadius"
>

export function listEventTypes(query: EventTypeQuery): EventTypeSummaryResult {
  const dbPath = resolveEventStoreDbFile(query.baseDir)
  const logDir = resolveDebugLogDirectory(query.baseDir)
  const logFiles = listDebugLogFiles(logDir)
  const typePatterns = query.typePatterns ?? []
  const connection = openEventSearch(dbPath)
  let storeTypes: EventTypeSummary[] = []
  let logWindow: LogWindow
  try {
    logWindow = connection ? deriveLogWindow(connection, query) : missingStoreLogWindow(query)
    if (connection) storeTypes = connection.typeSummaries({ ...toScanFilter(query), typePatterns })
  } finally {
    connection?.close()
  }
  const logRecords = logWindow === null ? [] : scanDebugLogFiles(logFiles, logScanFilter(query, logWindow))

  const merged = new Map<string, MergedEventTypeSummary>()
  for (const summary of storeTypes) {
    merged.set(summary.type, {
      type: summary.type,
      sources: ["store"],
      count: summary.count,
      firstTimestamp: summary.firstTimestamp,
      lastTimestamp: summary.lastTimestamp,
      firstPosition: summary.firstPosition,
      lastPosition: summary.lastPosition,
    })
  }
  for (const record of logRecords) {
    if (!matchesEventType(record.type, typePatterns)) continue
    const existing = merged.get(record.type)
    if (!existing) {
      merged.set(record.type, {
        type: record.type,
        sources: ["log"],
        count: 1,
        firstTimestamp: record.ts,
        lastTimestamp: record.ts,
      })
      continue
    }
    if (!existing.sources.includes("log")) existing.sources.push("log")
    existing.count += 1
    existing.firstTimestamp = Math.min(existing.firstTimestamp, record.ts)
    existing.lastTimestamp = Math.max(existing.lastTimestamp, record.ts)
  }

  return {
    dbPath,
    logDir,
    storeFound: connection !== null,
    logFilesFound: logFiles.length > 0,
    types: [...merged.values()].sort((a, b) => a.type.localeCompare(b.type)),
  }
}

function* scanStoreSource(
  connection: EventSearchConnection,
  query: EventSearchQuery,
  limit: number,
): Generator<EventSearchRow> {
  const matcher = createPatternMatcher(query)
  const typePatterns = query.typePatterns ?? []
  const scanned = connection.scan({
    ...toScanFilter(query),
    typePatterns,
    excludeSnapshots: !query.includeSnapshots && typePatterns.length === 0,
    sortBy: "timestamp",
    ...(!matcher && !query.requestId && !query.errorsOnly && limit > 0 ? { limit } : {}),
  })
  let matched = 0

  for (const event of scanned) {
    if (query.requestId && event.payload.requestId !== query.requestId) continue
    if (query.errorsOnly && !isFailureEvent(event.type, event.payload)) continue
    const fact = matcher ? connection.hydrate(event) : event
    if (matcher && !matcher(eventSearchText(fact))) continue
    yield { source: "store", fact }
    matched += 1
    if (limit > 0 && matched >= limit) break
  }
}

/** How the debug-log side is windowed when the query addresses store
 *  positions, which log records do not have:
 *  - `--around <position>`: `-C` counts store rows, so the store's position
 *    window is scanned first and the log side is limited to that window's
 *    timestamp envelope [min ts, max ts]. The merged neighborhood then covers
 *    exactly the wall-clock span the store context covers. An empty window
 *    (unresolvable anchor) excludes the log side entirely.
 *  - `--after <position>`: the log side requires ts > the anchored row's
 *    timestamp, mirroring the store's strictly-after semantics. When the
 *    position does not resolve (already pruned), log records pass unwindowed
 *    because they are not position-addressed.
 *  - No positional flag: no derived window; only explicit --since/--until
 *    bound the log side. */
function deriveLogWindow(
  connection: EventSearchConnection,
  query: EventSearchQuery,
): LogWindow {
  if (query.aroundPosition !== undefined) {
    return connection.timestampRange(toScanFilter(query))
  }
  const after = query.afterPosition ?? 0
  if (after > 0) {
    const anchor = connection.timestampRange({ positionRange: { start: after, end: after } })
    return anchor ? { sinceTimestamp: anchor.sinceTimestamp + 1 } : {}
  }
  return {}
}

function missingStoreLogWindow(query: EventSearchQuery): LogWindow {
  // --around anchors in the store; with no store there is no anchor and the
  // merged neighborhood is empty. Every other query shape searches the log
  // files of a store-less workspace normally.
  return query.aroundPosition !== undefined ? null : {}
}

function* scanLogSource(
  logFiles: readonly string[],
  query: EventSearchQuery,
  window: NonNullable<LogWindow>,
): Generator<EventSearchRow> {
  const matcher = createPatternMatcher(query)
  const typePatterns = query.typePatterns ?? []
  // File order does not imply timestamp order, even within a single file.
  for (const record of scanDebugLogFiles(logFiles, logScanFilter(query, window))) {
    if (!matchesEventType(record.type, typePatterns)) continue
    if (query.requestId && asRecord(record.payload)?.requestId !== query.requestId) continue
    if (query.errorsOnly && !isFailureRecord(record)) continue
    if (matcher && !matcher(recordSearchText(record))) continue
    yield { source: "log", record }
  }
}

function logScanFilter(query: EventTypeQuery, window: NonNullable<LogWindow>): EventScanFilter {
  const since = maxDefined(window.sinceTimestamp, query.sinceTimestamp)
  const until = minDefined(window.untilTimestamp, query.untilTimestamp)
  return {
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    ...(query.actor ? { actor: query.actor } : {}),
    ...(since !== undefined ? { sinceTimestamp: since } : {}),
    ...(until !== undefined ? { untilTimestamp: until } : {}),
  }
}

function rowComparator(order: "asc" | "desc"): (a: EventSearchRow, b: EventSearchRow) => number {
  const direction = order === "desc" ? -1 : 1
  return (a, b) => {
    const byTime = rowTimestamp(a) - rowTimestamp(b)
    if (byTime !== 0) return byTime * direction
    // Timestamp ties: the durable store outranks diagnostics; two store rows
    // keep position order; log records keep file order (the sort is stable).
    if (a.source !== b.source) return a.source === "store" ? -1 : 1
    if (a.source === "store" && b.source === "store") return (a.fact.position - b.fact.position) * direction
    return 0
  }
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.max(a, b)
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

function toScanFilter(query: EventSearchQuery): EventScanFilter {
  const radius = query.aroundRadius ?? 20
  return {
    ...(query.aroundPosition !== undefined
      ? { positionRange: { start: Math.max(0, query.aroundPosition - radius), end: query.aroundPosition + radius } }
      : { afterPosition: query.afterPosition ?? 0 }),
    ...(query.sessionId ? { sessionId: query.sessionId } : {}),
    ...(query.actor ? { actor: query.actor } : {}),
    ...(query.sinceTimestamp !== undefined ? { sinceTimestamp: query.sinceTimestamp } : {}),
    ...(query.untilTimestamp !== undefined ? { untilTimestamp: query.untilTimestamp } : {}),
    ...(query.order ? { order: query.order } : {}),
  }
}

function createPatternMatcher(query: EventSearchQuery): ((value: string) => boolean) | null {
  if (!query.pattern) return null

  if (query.regex) {
    const flags = query.caseSensitive ? "" : "i"
    const pattern = new RegExp(query.pattern, flags)
    return (value) => pattern.test(value)
  }

  const needle = query.caseSensitive ? query.pattern : query.pattern.toLowerCase()
  return (value) => {
    const haystack = query.caseSensitive ? value : value.toLowerCase()
    return haystack.includes(needle)
  }
}

function eventSearchText(event: StoredFact): string {
  return [
    event.position,
    event.id,
    event.aggregateId,
    event.seq,
    event.type,
    event.version,
    event.timestamp,
    event.actor,
    event.sessionId,
    event.runId,
    event.parentEventId,
    event.causedByEventId,
    JSON.stringify(event.payload),
  ].filter((value) => value != null).join("\n")
}

function recordSearchText(record: DebugLogRecord): string {
  return [
    record.ts,
    record.type,
    record.actor,
    record.sessionId,
    stringifyPayload(record.payload),
  ].filter((value) => value != null).join("\n")
}

function stringifyPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? ""
  } catch {
    return String(payload)
  }
}

function isFailureEvent(type: string, payload: Payload): boolean {
  if (/(error|failed|failure)/i.test(type)) return true
  return payloadHasFailure(payload)
}

// log.warn does not match the failure-name test, but a warning is exactly what
// --errors exists to surface from the diagnostics stream.
function isFailureRecord(record: DebugLogRecord): boolean {
  if (record.type === "log.error" || record.type === "log.warn") return true
  return isFailureEvent(record.type, asRecord(record.payload) ?? {})
}

function payloadHasFailure(payload: Payload): boolean {
  if (payload.outcome === "interrupted") return false
  if (payload.outcome === "error") return true
  if (payload.interrupted === true) return false
  if (payload.isError === true) return true
  if (payload.status === "error" || payload.status === "failed") return true
  if (isRecord(payload.error)) return true

  const span = asRecord(payload.span)
  if (span && payloadHasFailure(span)) return true

  const response = asRecord(payload.response)
  if (response && payloadHasFailure(response)) return true

  return false
}
