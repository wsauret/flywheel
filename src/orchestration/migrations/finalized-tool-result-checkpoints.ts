import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { admitPrivateDatabaseFiles } from "../../infra/private-path.js"
import { parseStoredSessionRuntimeFact } from "../../infra/runtime-fact-parser.js"
import { parseConversationTreeFact } from "../session/conversation/conversation-facts.js"
import { decodeRecoverableCheckpoint, FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND, finalizedToolResultRecoveryNeeds } from "../session/finalized-tool-result-checkpoint.js"
import { checkedThrough, recordChecked, recordMigration, tableExists } from "./engine.js"

const MIGRATION_ID = "recorded-finalized-tool-result-checkpoints-2026-10-17"
const PAGE_SIZE = 64

export interface FinalizedCheckpointMaintenancePage {
  readonly afterRowid: number
  readonly examined: number
  readonly retired: number
  readonly complete: boolean
  readonly transactionMs: number
}

interface FactRow {
  readonly position: number
  readonly aggregate_id: string
  readonly type: string
  readonly version: number
  readonly actor: string
  readonly payload: string
}

export interface FinalizedCheckpointMaintenancePlan {
  readonly throughRowid: number
  readonly evidencePositions: readonly number[]
}

/** Plans a bounded page on the maintenance Worker's read-only connection.
 * The serving writer rechecks these immutable facts and cells before retiring. */
export function planFinalizedToolResultCheckpointPage(dbFile: string, afterRowid: number): FinalizedCheckpointMaintenancePlan {
  const empty = { throughRowid: afterRowid, evidencePositions: [] }
  if (!existsSync(dbFile)) return empty
  const db = new Database(dbFile, { readonly: true })
  try {
    if (!tableExists(db, "in_flight") || !tableExists(db, "event") || checkedThrough(db, MIGRATION_ID) > 0) return empty
    const cells = db.query<{ rowid: number; session_id: string; payload: string }, [string, number, number]>(
      "select rowid, session_id, payload from in_flight where kind = ? and rowid > ? order by rowid limit ?",
    ).all(FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND, afterRowid, PAGE_SIZE)
    const groups = new Map<string, { sessionId: string; conversationId: string; ids: string[] }>()
    for (const row of cells) {
      try {
        const checkpoint = decodeRecoverableCheckpoint(JSON.parse(row.payload))
        const key = JSON.stringify([row.session_id, checkpoint.conversationId])
        const group = groups.get(key) ?? { sessionId: row.session_id, conversationId: checkpoint.conversationId, ids: [] }
        group.ids.push(checkpoint.toolUseId)
        groups.set(key, group)
      } catch {
        // An unknown cell stays byte-for-byte intact.
      }
    }
    const positions = new Set<number>()
    for (const group of groups.values()) {
      for (const row of readEvidenceRows(db, group.sessionId, group.conversationId, group.ids)) positions.add(row.position)
    }
    return { throughRowid: cells.at(-1)?.rowid ?? afterRowid, evidencePositions: [...positions] }
  } finally {
    db.close()
  }
}

/** Retires at most 64 leaked cells whose recovery evidence is fully durable.
 * Eligibility is rechecked under the writer lock; unknown bytes stay intact.
 * Only the final page records completion, so a withdrawn job can run again.
 * Remove this conversion after 2027-04-17. */
export function retireRecordedFinalizedToolResultCheckpointPage(
  dbFile: string,
  afterRowid = 0,
  plan: FinalizedCheckpointMaintenancePlan = planFinalizedToolResultCheckpointPage(dbFile, afterRowid),
): FinalizedCheckpointMaintenancePage {
  const empty = { afterRowid, examined: 0, retired: 0, complete: true, transactionMs: 0 }
  if (!existsSync(dbFile)) return empty
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    if (!tableExists(db, "in_flight") || !tableExists(db, "event") || checkedThrough(db, MIGRATION_ID) > 0) return empty
    const started = performance.now()
    const page = db.transaction(() => {
      if (checkedThrough(db, MIGRATION_ID) > 0) return empty
      const cells = db.query<{ rowid: number; session_id: string; payload: string }, [string, number, number, number]>(
        "select rowid, session_id, payload from in_flight where kind = ? and rowid > ? and rowid <= ? order by rowid limit ?",
      ).all(FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND, afterRowid, plan.throughRowid, PAGE_SIZE)
      const facts = db.query<FactRow, [string]>(
        "select position, aggregate_id, type, version, actor, payload from event where position in (select value from json_each(?))",
      ).all(JSON.stringify(plan.evidencePositions))
      const evidence = new Map<string, ReturnType<typeof readEvidence>>()
      const remove = db.query("delete from in_flight where rowid = ?")
      let retired = 0
      const decoded = cells.flatMap(row => {
        try {
          return [{ row, checkpoint: decodeRecoverableCheckpoint(JSON.parse(row.payload)) }]
        } catch {
          // Unknown historical shapes are not evidence of completed recovery.
          return []
        }
      })
      for (const { row, checkpoint } of decoded) {
        const key = JSON.stringify([row.session_id, checkpoint.conversationId])
        let recorded = evidence.get(key)
        if (!recorded) {
          recorded = readEvidence(facts, row.session_id, checkpoint.conversationId)
          evidence.set(key, recorded)
        }
        const needs = finalizedToolResultRecoveryNeeds(checkpoint, recorded)
        if (!needs.result && !needs.executionOutput && !needs.derivative) retired += remove.run(row.rowid).changes
      }
      if (retired > 0) recordMigration(db, { migrationId: MIGRATION_ID, factTypes: ["tool.result.recorded"], repaired: retired })
      const complete = !db.query("select 1 from in_flight where kind = ? and rowid > ? limit 1")
        .get(FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND, plan.throughRowid)
      if (complete) recordChecked(db, MIGRATION_ID)
      return { afterRowid: plan.throughRowid, examined: cells.length, retired, complete }
    }).immediate()
    return { ...page, transactionMs: performance.now() - started }
  } finally {
    db.close()
  }
}

function readEvidenceRows(db: Database, sessionId: string, conversationId: string, toolUseIds: readonly string[]): FactRow[] {
  const ids = JSON.stringify(toolUseIds)
  const facts = db.query<FactRow, [string, string]>(
    `select position, aggregate_id, type, version, actor, payload from event where aggregate_id = ?
      and type in ('tool.result.recorded', 'tool.execution_output.recorded')
      and json_extract(case when json_valid(payload) then payload end, '$.toolUseId') in (select value from json_each(?))`,
  ).all(`session:${sessionId}`, ids)
  const conversation = db.query<FactRow, [string, string]>(
    `select position, aggregate_id, type, version, actor, payload from event where aggregate_id = ? and type = 'chat.entries.appended'
      and exists (select 1 from json_each(case when json_valid(event.payload) then event.payload end, '$.entries') as entry
        where case when entry.type = 'object' then json_extract(entry.value, '$.kind') = 'message'
          and json_extract(entry.value, '$.message.kind') = 'toolResult'
          and json_extract(entry.value, '$.message.toolUseId') in (select value from json_each(?)) end)`,
  ).all(`conversation:${conversationId}`, ids)
  return [...facts, ...conversation]
}

function readEvidence(facts: readonly FactRow[], sessionId: string, conversationId: string) {
  const results = new Set<string>()
  const executionOutput = new Set<string>()
  const derivatives = new Set<string>()
  for (const row of facts.filter(fact => fact.aggregate_id === `session:${sessionId}`)) {
    try {
      const fact = parseStoredSessionRuntimeFact({ type: row.type, version: row.version, actor: row.actor, payload: JSON.parse(row.payload) })
      if (fact.type === "tool.result.recorded") results.add(fact.payload.toolUseId)
      if (fact.type === "tool.execution_output.recorded") executionOutput.add(fact.payload.toolUseId)
    } catch {
      // An unreadable fact cannot prove that its checkpoint is disposable.
    }
  }
  for (const row of facts.filter(fact => fact.aggregate_id === `conversation:${conversationId}`)) {
    try {
      const fact = parseConversationTreeFact({ type: row.type, version: row.version, actor: row.actor, payload: JSON.parse(row.payload) })
      if (fact.type !== "chat.entries.appended") continue
      for (const entry of fact.payload.entries) {
        if (entry.kind === "message" && entry.message.kind === "toolResult") derivatives.add(entry.message.toolUseId)
      }
    } catch {
      // Leave the corresponding cells available to ordinary history recovery.
    }
  }
  return { results, executionOutput, derivatives }
}
