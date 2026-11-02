import { errorMessage } from "./error-message.js"
import { CorruptEventRowError } from "./event-store-types.js"
import type { EventPayload, StoredFact } from "./event-store-types.js"

/** One `event` table row as SQLite returns it, before mapping to `StoredFact`. */
export interface EventRow {
  position: number
  id: string
  aggregate_id: string
  seq: number
  type: string
  version: number
  timestamp: number
  actor: string
  session_id: string
  run_id: string | null
  parent_event_id: string | null
  caused_by_event_id: string | null
  payload: string
}

export function rowToStoredFact(row: EventRow): StoredFact {
  return {
    position: row.position,
    id: row.id,
    aggregateId: row.aggregate_id,
    seq: row.seq,
    type: row.type,
    version: row.version,
    timestamp: row.timestamp,
    actor: row.actor,
    sessionId: row.session_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.parent_event_id ? { parentEventId: row.parent_event_id } : {}),
    ...(row.caused_by_event_id ? { causedByEventId: row.caused_by_event_id } : {}),
    payload: parsePayload(row),
  }
}

/** Row mapping for the tolerant read variants: corruption becomes a value in
 *  sequence position instead of aborting the batch. */
export function rowToStoredFactTolerant(row: EventRow): StoredFact | CorruptEventRowError {
  try {
    return rowToStoredFact(row)
  } catch (err) {
    if (err instanceof CorruptEventRowError) return err
    throw err
  }
}

// Our own SQLite substrate: the writer always serializes a JSON object payload,
// so anything else here means the store is corrupt (ARCH-BOUNDARIES-001: the reader throws,
// it does not widen). The typed error carries the row's session identity so the
// tolerant read path can scope the damage to the owning session.
function parsePayload(row: EventRow): EventPayload {
  try {
    const parsed: unknown = JSON.parse(row.payload)
    if (!isPayload(parsed)) throw new Error("payload is not a JSON object")
    return parsed
  } catch (err) {
    throw new CorruptEventRowError({
      aggregateId: row.aggregate_id,
      seq: row.seq,
      type: row.type,
      version: row.version,
      timestamp: row.timestamp,
      actor: row.actor,
      sessionId: row.session_id,
      eventId: row.id,
      position: row.position,
      rawPayload: row.payload,
    }, errorMessage(err))
  }
}

function isPayload(value: unknown): value is EventPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}