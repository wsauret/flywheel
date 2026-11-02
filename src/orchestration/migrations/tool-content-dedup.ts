import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import { Schema } from "effect"
import { admitPrivateDatabaseFiles } from "../../infra/private-path.js"
import { errorMessage } from "../../infra/error-message.js"
import { TOOL_CONTENT_INLINE_FACT_DEFINITIONS, type SessionRuntimeFact } from "../../infra/runtime-fact-types.js"
import { createToolContentTable, factRowsChanged } from "../../infra/sqlite-event-store-core.js"
import { extractToolContentFact } from "../../infra/tool-content-extraction.js"
import { TOOL_CONTENT_INLINE_MAX_BYTES, type ToolContentRow } from "../../infra/tool-content.js"
import { parseConversationTreeFact } from "../session/conversation/conversation-facts.js"
import { extractTreeFactContent } from "../session/conversation/conversation-tree-content-extraction.js"
import { migrationRecorded, recordMigration, requirePlannedScope, tableExists } from "./engine.js"

const BUSY_TIMEOUT_MS = 5000

const TOOL_CONTENT_DEDUP_MIGRATION_ID = "tool-content-dedup"

/** The durable field sites the dedup design rewrites (R5): the two tool facts
 *  and the entry-carrying chat fact. No other live family holds inline tool
 *  text. Retired families are absent on purpose - `--prune-retired` deletes
 *  their rows, and rewriting bytes on the way to deletion is wasted work. */
const CANDIDATE_TYPES = [
  "tool.result.recorded",
  "tool.execution_output.recorded",
  "chat.entries.appended",
] as const

/** A version-1 row whose whole payload fits inside the inline threshold cannot
 *  hold a text field over it (JSON escaping never shortens text), so the byte
 *  prefilter is a strict superset of the rows extraction can rewrite. */
const CANDIDATE_PREDICATE = `
  version = 1
  and type in (${CANDIDATE_TYPES.map((type) => `'${type}'`).join(", ")})
  and length(cast(payload as blob)) > ${TOOL_CONTENT_INLINE_MAX_BYTES}
`

const [ToolResultInline, ToolExecutionOutputInline] = TOOL_CONTENT_INLINE_FACT_DEFINITIONS
const decodeToolResultPayload = Schema.decodeUnknownSync(ToolResultInline.payload, { onExcessProperty: "error" })
const decodeExecutionOutputPayload = Schema.decodeUnknownSync(ToolExecutionOutputInline.payload, { onExcessProperty: "error" })

interface ToolContentDedupSessionResult {
  readonly sessionId: string
  readonly factsRewritten: number
  readonly contentRowsWritten: number
  readonly payloadBytesMoved: number
}

interface ToolContentDedupSkippedSession {
  readonly sessionId: string
  readonly reason: string
}

export interface ToolContentDedupResult {
  readonly sessions: readonly ToolContentDedupSessionResult[]
  /** Sessions whose candidate rows refused the strict decode. They stay fully
   *  inline, which remains a valid prior version (R3); a rewrite may never
   *  touch state it cannot read exactly. */
  readonly skipped: readonly ToolContentDedupSkippedSession[]
  readonly factsRewritten: number
  readonly contentRowsWritten: number
  readonly payloadBytesMoved: number
}

interface CandidateRow {
  readonly position: number
  readonly type: string
  readonly actor: string
  readonly payload: string
}

interface PlannedRewrite {
  readonly row: CandidateRow
  readonly migratedVersion: number
  readonly migratedPayload: string
  readonly contentRows: readonly ToolContentRow[]
}

interface SessionPlan {
  readonly candidates: readonly CandidateRow[]
  readonly rewrites: readonly PlannedRewrite[]
}

/** One-time conversion of existing sessions' inline tool text to session-scoped
 *  content rows (dedup design R5). Each session converts in one transaction:
 *  insert the (session_id, sha256) content rows, then rewrite each fact payload
 *  in place to the reference shape at version 2, preserving every other column.
 *  An interrupted run leaves each session fully converted or fully untouched
 *  and resumes cleanly, because converted rows are version 2 and stop matching
 *  the candidate predicate; a second full run is a no-op for the same reason.
 *  The FTS table is deliberately untouched: its rows are keyed by entry id and
 *  index text the rewrite does not change semantically, so the payload rewrite
 *  bypasses the insert seam by design. */
export function dedupToolContent(dbFile: string): ToolContentDedupResult {
  const sessions: ToolContentDedupSessionResult[] = []
  const skipped: ToolContentDedupSkippedSession[] = []
  if (!fs.existsSync(dbFile)) return totals(sessions, skipped)
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    if (!tableExists(db, "event")) return totals(sessions, skipped)
    createToolContentTable(db)
    for (const sessionId of candidateSessions(db)) {
      let plan: SessionPlan
      try {
        plan = planSession(db, sessionId)
      } catch (err) {
        skipped.push({ sessionId, reason: errorMessage(err) })
        continue
      }
      if (plan.rewrites.length === 0) continue
      const converted = convertSession(db, sessionId, plan)
      if (converted) sessions.push(converted)
    }
    return totals(sessions, skipped)
  } finally {
    db.close()
  }
}

function candidateSessions(db: Database): string[] {
  return db.query<{ sessionId: string }, []>(`
    select distinct session_id as sessionId from event
    where ${CANDIDATE_PREDICATE}
    order by session_id
  `).all().map((row) => row.sessionId)
}

function selectCandidates(db: Database, sessionId: string): CandidateRow[] {
  return db.query<CandidateRow, { $sessionId: string }>(`
    select position, type, actor, payload from event
    where session_id = $sessionId and ${CANDIDATE_PREDICATE}
    order by position
  `).all({ $sessionId: sessionId })
}

function planSession(db: Database, sessionId: string): SessionPlan {
  const candidates = selectCandidates(db, sessionId)
  const rewrites: PlannedRewrite[] = []
  for (const row of candidates) {
    const rewrite = planRewrite(row)
    if (rewrite) rewrites.push(rewrite)
  }
  return { candidates, rewrites }
}

/** Extract one candidate through the shipped producer-side transform for its
 *  family. Null means every text field fits inline, so the row stays exactly
 *  as stored. */
function planRewrite(row: CandidateRow): PlannedRewrite | null {
  const extracted = row.type === ToolResultInline.type || row.type === ToolExecutionOutputInline.type
    ? extractToolFact(row)
    : extractChatFact(row)
  if (!extracted) return null
  return {
    row,
    migratedVersion: extracted.version,
    migratedPayload: JSON.stringify(extracted.payload),
    contentRows: extracted.contentRows,
  }
}

interface ExtractedRewrite {
  readonly version: number
  readonly payload: unknown
  readonly contentRows: readonly ToolContentRow[]
}

function extractToolFact(row: CandidateRow): ExtractedRewrite | null {
  const extracted = extractToolContentFact(decodeInlineToolFact(row))
  if (!extracted.contentRows) return null
  return { version: extracted.fact.version, payload: extracted.fact.payload, contentRows: extracted.contentRows }
}

function decodeInlineToolFact(row: CandidateRow): SessionRuntimeFact {
  requireActor(row, "flywheel")
  if (row.type === ToolResultInline.type) {
    return { type: ToolResultInline.type, version: 1, actor: "flywheel", payload: decodeToolResultPayload(JSON.parse(row.payload)) }
  }
  return { type: ToolExecutionOutputInline.type, version: 1, actor: "flywheel", payload: decodeExecutionOutputPayload(JSON.parse(row.payload)) }
}

function extractChatFact(row: CandidateRow): ExtractedRewrite | null {
  requireActor(row, "flywheel")
  const fact = parseConversationTreeFact({ type: row.type, version: 1, actor: row.actor, payload: JSON.parse(row.payload) })
  const extracted = extractTreeFactContent(fact)
  if (extracted.contentRows.length === 0) return null
  return { version: extracted.fact.version, payload: extracted.fact.payload, contentRows: extracted.contentRows }
}

/** The rewritten fact keeps the stored actor column, so the transform's fixed
 *  actor must equal it; a mismatch means the row is not the fact its type
 *  claims, and the pass refuses to rewrite it. */
function requireActor(row: CandidateRow, actor: string): void {
  if (row.actor !== actor) {
    throw new Error(`${row.type} fact at position ${row.position} has actor "${row.actor}"; expected "${actor}"`)
  }
}

function convertSession(db: Database, sessionId: string, plan: SessionPlan): ToolContentDedupSessionResult | null {
  db.exec("BEGIN IMMEDIATE")
  try {
    const observed = selectCandidates(db, sessionId)
    if (observed.length === 0 && migrationRecorded(db, sessionMigrationId(sessionId))) {
      // A racing run converted this session between the plan and the lock.
      db.exec("COMMIT")
      return null
    }
    requirePlannedScope(plan.candidates, observed, (planned, candidate) =>
      candidate.position === planned.position
        && candidate.type === planned.type
        && candidate.actor === planned.actor
        && candidate.payload === planned.payload)
    const insertContent = db.query<unknown, { $sessionId: string; $sha256: string; $content: string; $bytes: number }>(`
      insert into tool_content (session_id, sha256, content, bytes)
      values ($sessionId, $sha256, $content, $bytes)
      on conflict (session_id, sha256) do nothing
    `)
    const update = db.query<unknown, {
      $position: number
      $type: string
      $actor: string
      $payload: string
      $migratedVersion: number
      $migratedPayload: string
    }>(`
      update event set version = $migratedVersion, payload = $migratedPayload
      where position = $position
        and type = $type
        and version = 1
        and actor = $actor
        and payload = $payload
    `)
    let contentRowsWritten = 0
    let payloadBytesMoved = 0
    for (const rewrite of plan.rewrites) {
      // Bytes land before the reference that names them, matching the store's
      // insert order, so no committed state ever holds a dangling reference.
      for (const content of rewrite.contentRows) {
        contentRowsWritten += insertContent.run({
          $sessionId: sessionId,
          $sha256: content.sha256,
          $content: content.content,
          $bytes: content.bytes,
        }).changes
      }
      update.run({
        $position: rewrite.row.position,
        $type: rewrite.row.type,
        $actor: rewrite.row.actor,
        $payload: rewrite.row.payload,
        $migratedVersion: rewrite.migratedVersion,
        $migratedPayload: rewrite.migratedPayload,
      })
      if (factRowsChanged(db) !== 1) {
        throw new Error(`${rewrite.row.type} fact at position ${rewrite.row.position} changed while the dedup migration waited for the write lock`)
      }
      payloadBytesMoved += Buffer.byteLength(rewrite.row.payload, "utf-8") - Buffer.byteLength(rewrite.migratedPayload, "utf-8")
    }
    recordMigration(db, {
      migrationId: sessionMigrationId(sessionId),
      factTypes: [...new Set(plan.rewrites.map(({ row }) => row.type))].sort(),
      repaired: plan.rewrites.length,
    })
    db.exec("COMMIT")
    return { sessionId, factsRewritten: plan.rewrites.length, contentRowsWritten, payloadBytesMoved }
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}

function sessionMigrationId(sessionId: string): string {
  return `${TOOL_CONTENT_DEDUP_MIGRATION_ID}:${sessionId}`
}

function totals(
  sessions: readonly ToolContentDedupSessionResult[],
  skipped: readonly ToolContentDedupSkippedSession[],
): ToolContentDedupResult {
  return {
    sessions,
    skipped,
    factsRewritten: sum(sessions, (session) => session.factsRewritten),
    contentRowsWritten: sum(sessions, (session) => session.contentRowsWritten),
    payloadBytesMoved: sum(sessions, (session) => session.payloadBytesMoved),
  }
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((acc, value) => acc + select(value), 0)
}
