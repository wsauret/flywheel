import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import { Effect, Schema } from "effect"
import type { ProjectDirectories } from "../../../../infra/directory-authorities.js"
import { admitPrivateDatabaseFiles } from "../../../../infra/private-path.js"
import { createSqliteEventInserter } from "../../../../infra/sqlite-event-store-core.js"
import { isRecord } from "../../../../infra/record.js"
import { hashDefinition } from "../../../../workflows/definition-hash.js"
import {
  DEFINITION_IDENTITY_GRAPH_MIGRATION_ID,
  DefinitionIdentitySchema,
  type DefinitionIdentity,
} from "../../../../workflows/vm/definition-identity.js"
import { buildDefinitionIdentityMigratedFact } from "../../../../workflows/vm/session-facts.js"
import { MIGRATED_FACT_TYPE } from "./workflow-identity-chain.js"
import { tableExists } from "../../../migrations/engine.js"

const BUSY_TIMEOUT_MS = 5000

/** The graph of a workflow snapshot as the builds that recorded whole-workflow
 *  identity wrote it: an array `steps` of graph nodes. Frozen, because the
 *  graph hash this pass derives must be the hash those builds would have
 *  taken, whatever the current workflow schema says. Only `id` and the graph
 *  enter the hash, so the other snapshot keys pass unread. */
interface FrozenThenRef {
  readonly step: string
  readonly when?: string
  readonly then?: FrozenThenRef
}
const FrozenThenRefSchema: Schema.Codec<FrozenThenRef> = Schema.suspend((): Schema.Codec<FrozenThenRef> => Schema.Struct({
  step: Schema.NonEmptyString,
  when: Schema.optionalKey(Schema.String),
  then: Schema.optionalKey(FrozenThenRefSchema),
}))
const FrozenGraphNodeSchema = Schema.Union([
  Schema.Struct({
    step: Schema.NonEmptyString,
    then: Schema.optionalKey(FrozenThenRefSchema),
    retry: Schema.optionalKey(Schema.Struct({
      maxIterations: Schema.Int,
      detectStuck: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
    })),
  }),
  Schema.Struct({
    while: Schema.NonEmptyString,
    do: Schema.NonEmptyString,
    then: Schema.optionalKey(Schema.NonEmptyString),
    maxIterations: Schema.Int,
    detectStuck: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
  }),
  Schema.Struct({
    for: Schema.NonEmptyString,
    do: Schema.NonEmptyString,
    then: Schema.optionalKey(Schema.NonEmptyString),
  }),
])
const FrozenWorkflowGraphSchema = Schema.Struct({
  id: Schema.String,
  steps: Schema.NonEmptyArray(FrozenGraphNodeSchema),
})
const MAX_CANDIDATES = 1000

interface CandidateRow {
  readonly aggregateId: string
  readonly sessionId: string
  readonly expectedSeq: number | null
  readonly rootPayload: string
  readonly adoptedPayload: string | null
  readonly snapshotPayload: string | null
}

interface PlannedAdoption {
  readonly aggregateId: string
  readonly sessionId: string
  readonly expectedSeq: number
  readonly fact: ReturnType<typeof buildDefinitionIdentityMigratedFact>
}

export interface WorkflowDefinitionIdentityGraphMigration {
  readonly adopted: readonly string[]
}

const NOTHING: WorkflowDefinitionIdentityGraphMigration = { adopted: [] }

/** Replace legacy whole-workflow identity with graph identity derived only from the workflow snapshot recorded by the same aggregate. */
export function migrateWorkflowDefinitionIdentityGraph(
  dbFile: string,
  _directories: ProjectDirectories,
): WorkflowDefinitionIdentityGraphMigration {
  if (!fs.existsSync(dbFile)) return NOTHING
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    if (!tableExists(db, "event")) return NOTHING
    const rows = selectCandidates(db)
    const planned = rows.flatMap((row) => {
      try {
        return [planAdoption(row)]
      } catch {
        return []
      }
    })
    if (planned.length === 0) return NOTHING
    return applyAdoptions(db, planned)
  } finally {
    db.close()
  }
}

function selectCandidates(db: Database): CandidateRow[] {
  const rows = db.query<CandidateRow, { $migrationId: string }>(`
    select root.aggregate_id as aggregateId,
      root.session_id as sessionId,
      sequence.seq + 1 as expectedSeq,
      root.payload as rootPayload,
      (select payload from event adoption
        where adoption.aggregate_id = root.aggregate_id
          and adoption.type = '${MIGRATED_FACT_TYPE}'
        order by adoption.position desc limit 1) as adoptedPayload,
      (select payload from event snapshot
        where snapshot.aggregate_id = root.aggregate_id
          and snapshot.type = 'definition.loaded'
          and snapshot.version = 6
          and json_valid(snapshot.payload)
          and json_extract(snapshot.payload, '$.kind') = 'workflow'
        order by snapshot.position desc limit 1) as snapshotPayload
    from event root
    left join event_sequence sequence on sequence.aggregate_id = root.aggregate_id
    where root.aggregate_id glob 'workflow:*'
      and root.type in ('workflow.control.initialized', 'workflow.control.recovered')
      and root.version in (1, 2, 3)
      and root.position = (select max(position) from event candidate_root
        where candidate_root.aggregate_id = root.aggregate_id
          and candidate_root.type in ('workflow.control.initialized', 'workflow.control.recovered')
          and candidate_root.version in (1, 2, 3))
      and not exists (select 1 from event recorded
        where recorded.aggregate_id = root.aggregate_id
          and recorded.type = '${MIGRATED_FACT_TYPE}'
          and json_valid(recorded.payload)
          and json_extract(recorded.payload, '$.migrationId') = $migrationId)
    order by root.position
    limit ${MAX_CANDIDATES + 1}
  `).all({ $migrationId: DEFINITION_IDENTITY_GRAPH_MIGRATION_ID })
  if (rows.length > MAX_CANDIDATES) throw new Error(`workspace has more than ${MAX_CANDIDATES} workflow graph identities to migrate`)
  return rows
}

function planAdoption(row: CandidateRow): PlannedAdoption {
  if (row.expectedSeq === null || row.snapshotPayload === null) throw new Error("missing migration evidence")
  const root: unknown = JSON.parse(row.rootPayload)
  const latest: unknown = row.adoptedPayload === null ? null : JSON.parse(row.adoptedPayload)
  const identityValue = latest === null
    ? isRecord(root) && isRecord(root.control) ? root.control.definitionIdentity : undefined
    : isRecord(latest) ? latest.adopted : undefined
  const prior = Schema.decodeUnknownSync(DefinitionIdentitySchema, { onExcessProperty: "error" })(identityValue)
  if (!("workflowSha256" in prior)) throw new Error("identity already uses graph hash")
  const snapshot: unknown = JSON.parse(row.snapshotPayload)
  if (!isRecord(snapshot) || snapshot.kind !== "workflow") throw new Error("missing workflow snapshot")
  const workflow = Schema.decodeUnknownSync(FrozenWorkflowGraphSchema, { onExcessProperty: "ignore" })(snapshot.definition)
  if (workflow.id !== prior.workflowDefinitionId) throw new Error("workflow snapshot identity does not match control")
  const adopted: DefinitionIdentity = {
    ...withoutWorkflowHash(prior),
    graphSha256: hashDefinition(workflow.steps).sha256,
  }
  return {
    aggregateId: row.aggregateId,
    sessionId: row.sessionId,
    expectedSeq: row.expectedSeq,
    fact: buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_GRAPH_MIGRATION_ID, prior, adopted),
  }
}

function withoutWorkflowHash(identity: Extract<DefinitionIdentity, { workflowSha256: string }>): Omit<typeof identity, "workflowSha256"> {
  const { workflowSha256: _legacy, ...rest } = identity
  return rest
}

function applyAdoptions(db: Database, planned: readonly PlannedAdoption[]): WorkflowDefinitionIdentityGraphMigration {
  const inserter = createSqliteEventInserter(db)
  const adopted: string[] = []
  db.exec("BEGIN IMMEDIATE")
  try {
    for (const plan of planned) {
      const current = db.query<{ seq: number }, { $aggregateId: string }>(
        "select seq from event_sequence where aggregate_id = $aggregateId",
      ).get({ $aggregateId: plan.aggregateId })
      const exists = db.query<{ present: number }, { $aggregateId: string; $migrationId: string }>(`
        select 1 as present from event where aggregate_id = $aggregateId
          and type = '${MIGRATED_FACT_TYPE}' and json_valid(payload)
          and json_extract(payload, '$.migrationId') = $migrationId limit 1
      `).get({ $aggregateId: plan.aggregateId, $migrationId: DEFINITION_IDENTITY_GRAPH_MIGRATION_ID })
      if (exists) continue
      if (!current || current.seq + 1 !== plan.expectedSeq) throw new Error(`workflow control aggregate ${plan.aggregateId} changed during graph identity migration`)
      inserter.insertEventRows([{
        id: crypto.randomUUID(), aggregateId: plan.aggregateId, sessionId: plan.sessionId,
        timestamp: Date.now(), type: plan.fact.type, version: plan.fact.version,
        actor: plan.fact.actor, payload: plan.fact.payload, expectedSeq: plan.expectedSeq,
      }])
      adopted.push(plan.aggregateId)
    }
    db.exec("COMMIT")
    return { adopted }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
