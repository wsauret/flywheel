/** Metadata predicates applied before payload decoding. Payload predicates
 *  belong to the incremental consumer, which hydrates only when needed. The
 *  event store scan and the debug-log scan both apply it, so it sits below
 *  both. */
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
