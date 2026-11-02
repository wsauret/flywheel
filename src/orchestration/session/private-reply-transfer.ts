import type { Database } from "bun:sqlite"
import { createSqliteEventReadSurface } from "../../infra/sqlite-event-read-surface.js"
import { replyWaitSource, REPLY_WAIT_IN_FLIGHT_KIND } from "./conversation/reply-wait-cells.js"
import { decodeQueuedUserInputCell, QUEUED_USER_INPUT_IN_FLIGHT_KIND, RETAINED_INPUT_GAP_IN_FLIGHT_KIND } from "./conversation/queued-user-inputs.js"
import { heldBackgroundNotificationPut } from "./conversation/queued-background-notifications.js"
import { createSqliteEventInserter } from "../../infra/sqlite-event-store-core.js"

/** A private reply follows one proven question, never the workflow's current seat.
 * The caller holds the conversion transaction and has rehomed its execution units. */
export function transferPrivateReplies(db: Database, source: string, conversations: ReadonlyMap<string, string>): void {
  const reader = createSqliteEventReadSurface(db)
  const waiters = new Map<string, Array<{ sessionId: string; conversationId: string }>>()
  for (const row of reader.readInFlight(source, REPLY_WAIT_IN_FLIGHT_KIND)) {
    const wait = replyWaitSource(row)
    if (!wait) continue
    const matches = db.query<{ sessionId: string }, [string]>(
      "select distinct session_id as sessionId from event where type = 'tool.input.completed' and json_valid(payload) and json_extract(payload, '$.toolUseId') = ?",
    ).all(wait.toolUseId).filter(match => [...conversations.values()].includes(match.sessionId))
    if (matches.length !== 1) continue
    // SAFETY: the query above returned exactly one generation owner.
    const sessionId = matches[0]!.sessionId
    const conversationId = [...conversations].find(([, owner]) => owner === sessionId)?.[0]
    if (!conversationId) continue
    db.query("update in_flight set session_id = ? where session_id = ? and kind = ? and key = ?").run(sessionId, source, row.kind, row.key)
    waiters.set(wait.addresseeSessionId, [...waiters.get(wait.addresseeSessionId) ?? [], { sessionId, conversationId }])
  }
  for (const row of reader.readInFlight(source, QUEUED_USER_INPUT_IN_FLIGHT_KIND)) {
    const input = decodeQueuedUserInputCell(row, source)
    if (input?.target !== "workflow" || input.producer?.kind !== "session") continue
    const matches = waiters.get(input.producer.sessionId)
    if (matches?.length !== 1) continue
    // SAFETY: exactly one proven question owner passed the length check.
    const target = matches[0]!
    const { target: _workflow, ...payload } = row.payload
    db.query("update in_flight set session_id = ?, payload = ? where session_id = ? and kind = ? and key = ?")
      .run(target.sessionId, JSON.stringify({ ...payload, conversationId: target.conversationId }), source, row.kind, row.key)
  }
}

/** An unproven parent reply stays recoverable and is never promoted to workflow direction. */
export function retainAmbiguousPrivateInput(db: Database, source: string, parentSessionId: string, conversationId: string): void {
  const reader = createSqliteEventReadSurface(db)
  const inserter = createSqliteEventInserter(db)
  for (const row of reader.readInFlight(source, QUEUED_USER_INPUT_IN_FLIGHT_KIND)) {
    const input = decodeQueuedUserInputCell(row, source)
    if (input?.target !== "workflow" || input.producer?.kind !== "session" || input.producer.sessionId !== parentSessionId) continue
    db.query("update in_flight set kind = ? where session_id = ? and kind = ? and key = ?")
      .run(RETAINED_INPUT_GAP_IN_FLIGHT_KIND, source, row.kind, row.key)
    inserter.writeInFlight(parentSessionId, heldBackgroundNotificationPut(
      { target: "conversation", conversationId },
      "A historical private message could not be assigned to an agent. It remains retained and was not added as workflow direction.",
      `historical-message-gap:${source}:${row.key}`,
    ))
  }
}
