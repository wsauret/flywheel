import type { Database } from "bun:sqlite"

/** Relational causal anchors can retain ownership when a linked payload is unreadable. */
export function includeLinkedEventOwnership(db: Database, aggregateId: string, owners: ReadonlyMap<string, readonly number[]>, factTypes: readonly string[]): ReadonlyMap<string, readonly number[]> {
  const headers = db.query<{ id: string; position: number; type: string; parent_event_id: string | null; caused_by_event_id: string | null }, [string]>(
    "select id, position, type, parent_event_id, caused_by_event_id from event where aggregate_id = ? order by position",
  ).all(aggregateId)
  const byPosition = new Map([...owners].flatMap(([owner, positions]) => positions.map(position => [position, owner] as const)))
  const byId = new Map(headers.flatMap(row => {
    const owner = byPosition.get(row.position)
    return owner ? [[row.id, owner] as const] : []
  }))
  const allowed = new Set(factTypes)
  for (;;) {
    let changed = false
    for (const row of headers) {
      if (byPosition.has(row.position) || !allowed.has(row.type)) continue
      const parent = row.parent_event_id ? byId.get(row.parent_event_id) : undefined
      const cause = row.caused_by_event_id ? byId.get(row.caused_by_event_id) : undefined
      if (!parent && !cause || parent && cause && parent !== cause) continue
      const owner = parent ?? cause
      if (!owner) continue
      byPosition.set(row.position, owner)
      byId.set(row.id, owner)
      changed = true
    }
    if (!changed) break
  }
  const result = new Map<string, number[]>()
  for (const [position, owner] of byPosition) {
    const positions = result.get(owner)
    if (positions) positions.push(position)
    else result.set(owner, [position])
  }
  return result
}

/** A migration changes only relational ownership, never the recorded evidence.
 * The caller must hold a transaction and prove the destination of every position.
 * The destination aggregate is renumbered in position order. */
export function transferEventOwnership(db: Database, positions: readonly number[], sessionId: string, aggregateId: string): void {
  // The destination's own rows step aside to negative sequence numbers, so each row is renumbered
  // in one write without a unique-index collision.
  db.query("update event set seq = -position where aggregate_id = ?").run(aggregateId)
  db.query(`with ranked as (
      select position, row_number() over (order by position) - 1 as seq from event
      where aggregate_id = ?1 or position in (select value from json_each(?2)))
    update event set seq = ranked.seq, aggregate_id = ?1, session_id = iif(event.aggregate_id = ?1, event.session_id, ?3)
    from ranked where event.position = ranked.position`).run(aggregateId, JSON.stringify(positions), sessionId)
  db.query("update event_sequence set seq = (select count(*) - 1 from event where aggregate_id = ?1) where aggregate_id = ?1").run(aggregateId)
}
