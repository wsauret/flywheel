import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import type { ProjectDirectories } from "../../../../infra/directory-authorities.js"
import { admitPrivateDatabaseFiles } from "../../../../infra/private-path.js"
import { factRowsChanged } from "../../../../infra/sqlite-event-store-core.js"
import { DebugLog } from "../../../../infra/debug-log.js"
import { Log } from "../../../../infra/log.js"
import { isRecord } from "../../../../infra/record.js"
import { parseHistoricalWorkflowControlV2 } from "../../../../workflows/vm/historical-codecs.js"
import { DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID } from "../../../../workflows/vm/definition-identity.js"
import { normalizeLegacyIdentityMembers, MIGRATED_FACT_TYPE } from "./workflow-identity-chain.js"
import { requirePlannedScope, tableExists } from "../../../migrations/engine.js"

const MAX_CANDIDATES = 1000
const BUSY_TIMEOUT_MS = 5000

/** Legacy initialized control is in scope when it omits a context identity
 *  member and has no adoption fact for its aggregate. */
const CANDIDATE_PREDICATE = `
  candidate.aggregate_id glob 'workflow:*'
  and candidate.type = 'workflow.control.initialized'
  and candidate.version = 2
  and (
    not json_valid(candidate.payload)
    or case when json_valid(candidate.payload) then
      json_type(candidate.payload, '$.control.definitionIdentity.skills') is null
      or json_type(candidate.payload, '$.control.definitionIdentity.personas') is null
    end
  )
  and not exists (
    select 1 from event migration
    where migration.aggregate_id = candidate.aggregate_id
      and migration.type = '${MIGRATED_FACT_TYPE}'
      and json_valid(migration.payload)
      and json_extract(migration.payload, '$.migrationId') = '${DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID}'
  )
`

export interface WorkflowDefinitionIdentityContextMigration {
  readonly repaired: readonly string[]
}

interface CandidateRow {
  readonly position: number
  readonly aggregateId: string
  readonly sessionId: string
  readonly payload: string
  readonly expectedSeq: number
}
type CandidateQueryRow = Omit<CandidateRow, "expectedSeq"> & { readonly expectedSeq: number | null }

interface PlannedRepair {
  readonly row: CandidateRow
  readonly repairedPayload: string
}

const NOTHING: WorkflowDefinitionIdentityContextMigration = { repaired: [] }
const log = Log.create({ service: "workspace.identity.migration" })

/** Normalize absent skills and personas before any runtime reader opens the
 *  store. The initialized identity remains the sole durable revision authority:
 *  this pass does not adopt handoff contracts or normalize a later migration's
 *  identity members. The ordered chain makes the complete identity strict before
 *  the runtime reads it. */
export function migrateWorkflowDefinitionIdentityContext(
  dbFile: string,
  _directories: ProjectDirectories,
): WorkflowDefinitionIdentityContextMigration {
  if (!fs.existsSync(dbFile)) return NOTHING
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    if (!tableExists(db, "event")) return NOTHING
    const candidates = selectCandidates(db)
    if (candidates.length === 0) return NOTHING
    const planned = candidates.flatMap((candidate) => {
      try {
        return [planRepair(candidate)]
      } catch {
        DebugLog.record({
          sessionId: candidate.sessionId,
          type: "workspace.migration.candidate_skipped",
          actor: "flywheel",
          payload: {
            migrationId: DEFINITION_IDENTITY_CONTEXT_MIGRATION_ID,
            aggregateId: candidate.aggregateId,
            position: candidate.position,
            reason: "unreadable",
          },
        })
        return []
      }
    })
    const repaired = applyRepairs(db, candidates, planned)
    if (repaired.length > 0) {
      log.info("workflow control normalized context identity", { workflows: repaired.length })
    }
    return { repaired }
  } finally {
    db.close()
  }
}


function selectCandidates(db: Database): CandidateRow[] {
  const rows = db.query<CandidateQueryRow, []>(`
    select
      candidate.position,
      candidate.aggregate_id as aggregateId,
      candidate.session_id as sessionId,
      candidate.payload,
      sequence.seq + 1 as expectedSeq
    from event candidate
    left join event_sequence sequence on sequence.aggregate_id = candidate.aggregate_id
    where ${CANDIDATE_PREDICATE}
    order by candidate.position
    limit ${MAX_CANDIDATES + 1}
  `).all()
  if (rows.length > MAX_CANDIDATES) {
    throw new Error(`workspace has more than ${MAX_CANDIDATES} workflow control facts to adopt the current definition identity`)
  }
  return rows.map((row) => {
    if (row.expectedSeq === null) {
      throw new Error(`workflow control fact at position ${row.position} has no aggregate sequence row`)
    }
    return { ...row, expectedSeq: row.expectedSeq }
  })
}

function planRepair(row: CandidateRow): PlannedRepair {

  const payload: unknown = JSON.parse(row.payload)
  if (!isRecord(payload) || !isRecord(payload.control) || !isRecord(payload.control.definitionIdentity)) {
    throw new Error(`workflow control fact at position ${row.position} has no definition identity to migrate`)
  }
  const source = payload.control.definitionIdentity
  const missingMembers = (["skills", "personas"] as const).filter((member) => !(member in source))
  if (missingMembers.length === 0) {
    throw new Error(`workflow control fact at position ${row.position} needs no context identity migration`)
  }
  const repairedIdentity = {
    ...source,
    ...(missingMembers.includes("skills") ? { skills: [] } : {}),
    ...(missingMembers.includes("personas") ? { personas: [] } : {}),
  }
  parseHistoricalWorkflowControlV2({
    ...payload.control,
    definitionIdentity: normalizeLegacyIdentityMembers(repairedIdentity),
  })
  return {
    row,
    repairedPayload: JSON.stringify({
      ...payload,
      control: { ...payload.control, definitionIdentity: repairedIdentity },
    }),
  }
}


/** Normalize under one write lock. Candidate bytes and aggregate scope are
 * rechecked before any update, so a concurrent change aborts the transaction. */
function applyRepairs(
  db: Database,
  candidates: readonly CandidateRow[],
  planned: readonly PlannedRepair[],
): string[] {
  db.exec("BEGIN IMMEDIATE")
  try {
    const observed = selectCandidates(db)
    requirePlannedScope(candidates, observed, (candidate, current) =>
      candidate.position === current.position
        && candidate.aggregateId === current.aggregateId
        && candidate.sessionId === current.sessionId
        && candidate.payload === current.payload
        && candidate.expectedSeq === current.expectedSeq)
    const normalize = db.query<unknown, { $position: number; $payload: string; $repairedPayload: string }>(`
      update event
      set payload = $repairedPayload
      where position = $position
        and payload = $payload
    `)
    for (const { row, repairedPayload } of planned) {
      normalize.run({
        $position: row.position,
        $payload: row.payload,
        $repairedPayload: repairedPayload,
      })
      if (factRowsChanged(db) !== 1) {
        throw new Error(`workflow control fact at position ${row.position} changed after preflight`)
      }
    }
    db.exec("COMMIT")
    return planned.map(({ row }) => row.aggregateId)
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}
