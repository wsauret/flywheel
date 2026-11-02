import type { Database } from "bun:sqlite"
import { isRecord } from "../../infra/record.js"
import { COMMAND_HANDOVER_IN_FLIGHT_KIND, decodeCommandHandover } from "./command-handover.js"
import { FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND, decodeRecoverableCheckpoint } from "./finalized-tool-result-checkpoint.js"
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND, decodeQueuedUserInputCell } from "./conversation/queued-user-inputs.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, decodeQueuedBackgroundNotification } from "./conversation/queued-background-notifications.js"
import { decodeUsageSettlementCheckpoint, USAGE_SETTLEMENT_IN_FLIGHT_KIND } from "../agent-runtime/usage-settlement.js"
import { decodePlannedSessionContinuation, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND } from "./planned-session-continuation.js"

/** Moves the ordered recovery cells whose family proves one conversation.
 * Damaged and unknown cells retain their exact bytes under the residual owner. */
export function transferExecutionCells(db: Database, source: string, conversations: ReadonlyMap<string, string>, operations: ReadonlyMap<string, string | null>): void {
  const rows = db.query<{ rowid: number; kind: string; key: string; payload: string }, [string]>(
    "select rowid, kind, key, payload from in_flight where session_id = ? order by rowid",
  ).all(source)
  for (const row of rows) {
    if (row.kind === "file.mutation") {
      const owner = operations.get(row.key)
      if (owner) db.query("update in_flight set session_id = ? where rowid = ?").run(owner, row.rowid)
      continue
    }
    let payload: unknown
    try { payload = JSON.parse(row.payload) } catch { continue }
    if (!isRecord(payload)) continue
    if (row.kind === PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND) {
      const continuation = decodePlannedSessionContinuation({ ...row, payload, raw: row.payload }, source)
      if (continuation) db.query("update in_flight set payload = ? where rowid = ?").run(JSON.stringify(continuation), row.rowid)
      continue
    }
    let conversationId = payload.conversationId
    if (row.kind === USAGE_SETTLEMENT_IN_FLIGHT_KIND) {
      try {
        const checkpoint = decodeUsageSettlementCheckpoint(payload)
        conversationId = (checkpoint.kind === "draft" ? checkpoint.draft.identity : checkpoint.identity).conversationId
      } catch { continue }
    }
    const owner = typeof conversationId === "string" ? conversations.get(conversationId) : undefined
    if (!owner || typeof conversationId !== "string") continue
    const cell = { ...row, payload, raw: row.payload }
    let rewritten = row.payload
    if (row.kind === COMMAND_HANDOVER_IN_FLIGHT_KIND) {
      const command = decodeCommandHandover(cell, source)
      if (!command) continue
      rewritten = JSON.stringify({ ...payload, sessionId: owner })
    } else if (row.kind === FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND) {
      try { decodeRecoverableCheckpoint(payload) } catch { continue }
    } else if (row.kind === QUEUED_USER_INPUT_IN_FLIGHT_KIND) {
      if (!decodeQueuedUserInputCell(cell, source)) continue
    } else if (row.kind === QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND) {
      if (!decodeQueuedBackgroundNotification(cell, conversationId)) continue
    } else if (row.kind !== USAGE_SETTLEMENT_IN_FLIGHT_KIND) continue
    db.query("update in_flight set session_id = ?, payload = ? where rowid = ?").run(owner, rewritten, row.rowid)
  }
}
