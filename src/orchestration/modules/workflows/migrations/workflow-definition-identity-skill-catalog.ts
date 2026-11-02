import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import type { ProjectDirectories } from "../../../../infra/directory-authorities.js"
import { admitPrivateDatabaseFiles } from "../../../../infra/private-path.js"
import { factRowsChanged } from "../../../../infra/sqlite-event-store-core.js"
import { Log } from "../../../../infra/log.js"
import { isRecord } from "../../../../infra/record.js"
import { parseHistoricalWorkflowControlV2 } from "../../../../workflows/vm/historical-codecs.js"
import { DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID } from "../../../../workflows/vm/definition-identity.js"
import {
  normalizeLegacyIdentityMembers,
  selectAdoptionCandidates,
  recordSkippedWorkflowMigrationCandidate,
  type AdoptionCandidate,
} from "./workflow-identity-chain.js"
import { migrationRecorded, recordMigration, requirePlannedScope, tableExists } from "../../../migrations/engine.js"

interface UnknownRecord {
  [key: string]: unknown
}

const BUSY_TIMEOUT_MS = 5000
const LEGACY_IDENTITY_SCOPE = "json_type(initialized.payload, '$.control.definitionIdentity.stepDefinitions') is not null"

export interface DefinitionIdentitySkillCatalogMigration {
  readonly normalized: readonly string[]
  readonly adopted: readonly string[]
}

interface PlannedNormalization {
  readonly candidate: AdoptionCandidate
  readonly normalizedPayload: string
}

const NOTHING: DefinitionIdentitySkillCatalogMigration = { normalized: [], adopted: [] }
const log = Log.create({ service: "workspace.identity.migration" })

/** Normalize recorded identity member names and remove retired graph policy without changing recorded ids or hashes. Unreadable aggregates stay unchanged.
 * Remove this conversion after 2027-04-30. */
export function migrateDefinitionIdentitySkillCatalog(
  dbFile: string,
  _directories: ProjectDirectories,
): DefinitionIdentitySkillCatalogMigration {
  if (!fs.existsSync(dbFile)) return NOTHING
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    if (!tableExists(db, "event")) return NOTHING
    const candidates = selectCandidates(db)
    const planned = candidates.flatMap((candidate) => {
      try {
        return [planNormalization(candidate)]
      } catch {
        recordSkippedWorkflowMigrationCandidate(DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID, candidate)
        return []
      }
    })
    if (planned.length === 0) return NOTHING
    return applyNormalizations(db, planned)
  } finally {
    db.close()
  }
}

function selectCandidates(db: Database): AdoptionCandidate[] {
  return selectAdoptionCandidates(db, DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID, LEGACY_IDENTITY_SCOPE)
}

function planNormalization(candidate: AdoptionCandidate): PlannedNormalization {
  const payload: unknown = JSON.parse(candidate.initializedPayload)
  if (!isRecord(payload) || !isRecord(payload.control) || !isRecord(payload.control.definitionIdentity)) {
    throw new Error(`workflow control aggregate ${candidate.aggregateId} has no definition identity to migrate`)
  }
  const bridgedControl = normalizeLegacyCatalogControl(payload.control)
  const control = parseHistoricalWorkflowControlV2({
    ...bridgedControl,
    definitionIdentity: normalizeLegacyIdentityMembers(payload.control.definitionIdentity),
  })
  return {
    candidate,
    normalizedPayload: JSON.stringify({ ...payload, control: { ...bridgedControl, definitionIdentity: control.definitionIdentity } }),
  }
}

function normalizeLegacyCatalogControl(control: UnknownRecord): UnknownRecord {
  const graph = control.graph
  if (!isRecord(graph) || !Array.isArray(graph.nodes)) return control
  return { ...control, graph: { ...graph, nodes: graph.nodes.map((node) => normalizeLegacyGraphNode(node)) } }
}

function normalizeLegacyGraphNode(value: unknown): UnknownRecord {
  if (!isRecord(value)) throw new Error("Legacy workflow graph records a malformed node")
  const node = withoutLegacyOverrides(value)
  if (node.kind === "step") return { ...node, then: normalizeLegacyFollowUp(node.then) }
  if ((node.kind === "while" || node.kind === "for") && Array.isArray(node.body)) {
    return { ...node, body: node.body.map((unit) => {
      if (!isRecord(unit)) throw new Error("Legacy workflow graph records a malformed loop unit")
      return withoutLegacyOverrides(unit)
    }) }
  }
  return node
}

function normalizeLegacyFollowUp(value: unknown): UnknownRecord | null | undefined {
  if (value === null) return null
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error("Legacy workflow graph records a malformed follow-up")
  const followUp = withoutLegacyOverrides(value)
  return { ...followUp, then: normalizeLegacyFollowUp(followUp.then) }
}

function withoutLegacyOverrides(value: UnknownRecord): UnknownRecord {
  const normalized = { ...value }
  delete normalized.overrides
  return normalized
}

function applyNormalizations(db: Database, planned: readonly PlannedNormalization[]): DefinitionIdentitySkillCatalogMigration {
  db.exec("BEGIN IMMEDIATE")
  try {
    const observed = selectCandidates(db)
    if (observed.length === 0 && migrationRecorded(db, DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID)) {
      db.exec("COMMIT")
      return NOTHING
    }
    const plannedAggregateIds = new Set(planned.map(({ candidate }) => candidate.aggregateId))
    const relevantObserved = observed.filter(({ aggregateId }) => plannedAggregateIds.has(aggregateId))
    requirePlannedScope(planned, relevantObserved, ({ candidate }, current) =>
      current.position === candidate.position
      && current.aggregateId === candidate.aggregateId
      && current.sessionId === candidate.sessionId
      && current.initializedPayload === candidate.initializedPayload
      && current.expectedSeq === candidate.expectedSeq)
    const normalize = db.query<unknown, { $position: number; $payload: string }>(`
      update event set payload = $payload where position = $position
        and json_type(payload, '$.control.definitionIdentity.stepDefinitions') is not null
    `)
    for (const { candidate, normalizedPayload } of planned) {
      normalize.run({ $position: candidate.position, $payload: normalizedPayload })
      if (factRowsChanged(db) !== 1) throw new Error(`workflow control fact at position ${candidate.position} no longer records step definitions`)
    }
    recordMigration(db, {
      migrationId: DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID,
      factTypes: ["workflow.control.initialized"],
      repaired: planned.length,
    })
    db.exec("COMMIT")
    log.info("workflow control normalized the unified catalog identity", { workflows: planned.length })
    return { normalized: planned.map(({ candidate }) => candidate.aggregateId), adopted: [] }
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}
