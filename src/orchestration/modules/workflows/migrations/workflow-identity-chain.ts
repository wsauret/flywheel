/** Shared machinery of the definition-identity migration chain. Each pass normalizes only the identity member it owns, so a control can hold a later pass's legacy form while the chain is mid-flight. */

import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { DebugLog } from "../../../../infra/debug-log.js"
import { isRecord } from "../../../../infra/record.js"
import {
  DefinitionIdentitySchema,
  type DefinitionIdentity,
  type DefinitionIdentityMigrationId,
} from "../../../../workflows/vm/definition-identity.js"

interface UnknownRecord {
  [key: string]: unknown
}

export const MIGRATED_FACT_TYPE = "workflow.definition_identity.migrated"

const MAX_CANDIDATES = 1000

/** One workflow aggregate a chain migration may adopt. `prior` is the identity
 *  the aggregate currently holds: the latest adoption's adopted identity, or the
 *  initialized control's identity when the chain has not reached it yet. The
 *  initialized row itself is named too, because a pass that normalizes a legacy
 *  identity shape rewrites exactly those bytes. */
export interface AdoptionCandidate {
  readonly position: number
  readonly aggregateId: string
  readonly sessionId: string
  readonly expectedSeq: number
  readonly initializedPayload: string
  readonly prior: DefinitionIdentity
}

interface CandidateQueryRow {
  readonly position: number
  readonly aggregateId: string
  readonly sessionId: string
  readonly expectedSeq: number | null
  readonly initializedPayload: string
  readonly adoptedPayload: string | null
}

export function recordSkippedWorkflowMigrationCandidate(
  migrationId: DefinitionIdentityMigrationId,
  candidate: Pick<CandidateQueryRow, "sessionId" | "aggregateId" | "position">,
): void {
  DebugLog.record({
    sessionId: candidate.sessionId,
    type: "workspace.migration.candidate_skipped",
    actor: "flywheel",
    payload: { migrationId, aggregateId: candidate.aggregateId, position: candidate.position, reason: "unreadable" },
  })
}

/** Every workflow aggregate in `scope` that has not yet recorded `migrationId`.
 *  Selection is scoped to the one migration, which is what makes the chain a
 *  chain: an aggregate that already adopted an earlier migration is still a
 *  candidate for a later one. `scope` is the SQL condition over the `initialized`
 *  row that names the evidence the migration needs to examine an aggregate at
 *  all, so a pass with nothing left to do selects nothing and builds no
 *  registry. */
export function selectAdoptionCandidates(
  db: Database,
  migrationId: DefinitionIdentityMigrationId,
  scope: string,
): AdoptionCandidate[] {
  const rows = db.query<CandidateQueryRow, { $migrationId: string }>(`
    select
      initialized.position,
      initialized.aggregate_id as aggregateId,
      initialized.session_id as sessionId,
      sequence.seq + 1 as expectedSeq,
      initialized.payload as initializedPayload,
      (
        select adoption.payload from event adoption
        where adoption.aggregate_id = initialized.aggregate_id
          and adoption.type = '${MIGRATED_FACT_TYPE}'
        order by adoption.position desc
        limit 1
      ) as adoptedPayload
    from event initialized
    left join event_sequence sequence on sequence.aggregate_id = initialized.aggregate_id
    where initialized.aggregate_id glob 'workflow:*'
      and initialized.type = 'workflow.control.initialized'
      and initialized.version = 2
      and not exists (
        select 1 from event recorded
        where recorded.aggregate_id = initialized.aggregate_id
          and recorded.type = '${MIGRATED_FACT_TYPE}'
          and json_valid(recorded.payload)
          and json_extract(recorded.payload, '$.migrationId') = $migrationId
      )
      and (case when json_valid(initialized.payload) then (${scope}) else 1 end)
    order by initialized.position
    limit ${MAX_CANDIDATES + 1}
  `).all({ $migrationId: migrationId })

  if (rows.length > MAX_CANDIDATES) {
    throw new Error(`workspace has more than ${MAX_CANDIDATES} workflow control facts to adopt the current definition identity`)
  }
  return rows.flatMap((row) => {
    try {
      if (row.expectedSeq === null) {
        throw new Error(`workflow control aggregate ${row.aggregateId} has no aggregate sequence row`)
      }
      return [{
        position: row.position,
        aggregateId: row.aggregateId,
        sessionId: row.sessionId,
        expectedSeq: row.expectedSeq,
        initializedPayload: row.initializedPayload,
        prior: currentlyAdoptedIdentity(row),
      }]
    } catch {
      recordSkippedWorkflowMigrationCandidate(migrationId, row)
      return []
    }
  })
}

function currentlyAdoptedIdentity(row: CandidateQueryRow): DefinitionIdentity {
  if (row.adoptedPayload !== null) {
    const adoption: unknown = JSON.parse(row.adoptedPayload)
    if (!isRecord(adoption)) throw new Error(`workflow control aggregate ${row.aggregateId} has a malformed identity adoption`)
    return parseIdentity(adoption.adopted, row.aggregateId)
  }
  const payload: unknown = JSON.parse(row.initializedPayload)
  if (!isRecord(payload) || !isRecord(payload.control)) {
    throw new Error(`workflow control aggregate ${row.aggregateId} has no definition identity`)
  }
  return parseIdentity(payload.control.definitionIdentity, row.aggregateId)
}

function parseIdentity(value: unknown, aggregateId: string): DefinitionIdentity {
  try {
    return Schema.decodeUnknownSync(DefinitionIdentitySchema, { onExcessProperty: "error" })(
      isRecord(value) ? normalizeLegacyIdentityMembers(value) : value,
    )
  } catch (err) {
    throw new Error(`workflow control aggregate ${aggregateId} has an unreadable definition identity`, { cause: err })
  }
}

/** The retired identity member the unification cutover replaced. */
const LEGACY_STEP_DEFINITIONS_MEMBER = "stepDefinitions"

/** Read one recorded identity under the current member names. A pre-cutover
 *  build hashed the step definitions of a workflow; the same graph positions are
 *  now workflow-local bindings, and a legacy step id is the binding id of the
 *  position that named it, so the mapping is a rename of the member and of its
 *  entry key. Malformed entries pass through unchanged and fail the strict parse
 *  of whichever pass read them. */
export function normalizeLegacyIdentityMembers(identity: UnknownRecord): UnknownRecord {
  if (!(LEGACY_STEP_DEFINITIONS_MEMBER in identity)) return identity
  const { [LEGACY_STEP_DEFINITIONS_MEMBER]: legacy, ...rest } = identity
  if (!Array.isArray(legacy)) return { ...rest, bindings: legacy }
  return {
    ...rest,
    bindings: legacy.map((entry) =>
      isRecord(entry) && "definitionId" in entry
        ? { bindingId: entry.definitionId, sha256: entry.sha256 }
        : entry),
  }
}


