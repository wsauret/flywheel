import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import { admitPrivateDatabaseFiles } from "../../../../infra/private-path.js"
import { isRecord } from "../../../../infra/record.js"
import { createSqliteEventInserter } from "../../../../infra/sqlite-event-store-core.js"
import { createSqliteEventReadSurface } from "../../../../infra/sqlite-event-read-surface.js"
import { hashDefinition } from "../../../../workflows/definition-hash.js"
import { replayWorkflowControl } from "../../../../workflows/vm/fact-fold.js"
import {
  DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_ID,
  isLegacyDefinitionIdentity,
  type DefinitionIdentity,
} from "../../../../workflows/vm/definition-identity.js"
import { buildDefinitionIdentityMigratedFact } from "../../../../workflows/vm/session-facts.js"
import { checkedThrough, headPosition, recordChecked, tableExists } from "../../../migrations/engine.js"
import { MIGRATED_FACT_TYPE, recordSkippedWorkflowMigrationCandidate } from "./workflow-identity-chain.js"

const BUSY_TIMEOUT_MS = 5000

/** The facts that can set a workflow's definition identity. A cheap text test
 *  over their payloads decides whether an aggregate needs a replay at all. */
const IDENTITY_FACT_TYPES = [
  "workflow.control.initialized",
  "workflow.control.recovered",
  MIGRATED_FACT_TYPE,
  "workflow.definition_identity.adopted",
] as const

/** The spec handoff rules of revision 5, which told a step to ask the person,
 *  and of revision 6, which tells it to message its parent. Both are history:
 *  the hashes they produce are what a recorded identity and its adoption
 *  name, so they stay fixed when a later revision changes the rules again. */
const SPEC_HANDOFF = "spec-handoff"
const SPEC_RULES_KEPT_BEFORE = "Resolve newly discovered uncertainty inside the current spec step through repository inspection, focused research, or experiments before handing work to an implementer."
const SPEC_RULES_KEPT_AFTER = [
  "Use outcome.state: blocked only when evidence fundamentally contradicts the approved design and the design must be rewritten in chat. Never use a blocker for ordinary implementation uncertainty.",
  "A completed spec omits outcome and contains no open questions, discovery phases, experiments, spikes, proof-of-concept tasks, or choices deferred to the implementer.",
]
const SPEC_REVISION_5_RULES_SHA256 = hashDefinition([
  SPEC_RULES_KEPT_BEFORE,
  "Use ask_user only as a rare fallback for a narrow user-owned choice that repository evidence cannot answer and that does not invalidate the approved design.",
  ...SPEC_RULES_KEPT_AFTER,
]).sha256
const SPEC_REVISION_6_RULES_SHA256 = hashDefinition([
  SPEC_RULES_KEPT_BEFORE,
  "When a narrow choice belongs to the person and repository evidence cannot answer it, message your parent with message_session and wait for its reply. The parent holds the approved design and asks the person when it must.",
  ...SPEC_RULES_KEPT_AFTER,
]).sha256

interface SnapshotRow {
  readonly aggregateId: string
  readonly sessionId: string
  readonly payload: string
}

/** One workflow aggregate's binding snapshots, keyed by binding id. */
interface AggregateSnapshots {
  readonly sessionId: string
  readonly bindings: Map<string, RetiredBindingHashes>
}

/** One binding snapshot's hashes: what its identity hash was while its tool
 *  scope still stated `ask_user`, and what it is now that the key is gone. */
interface RetiredBindingHashes {
  readonly withRetiredKey: ReadonlySet<string>
  readonly current: string
}

interface PlannedAdoption {
  readonly aggregateId: string
  readonly sessionId: string
  readonly expectedSeq: number
  readonly fact: ReturnType<typeof buildDefinitionIdentityMigratedFact>
}

export interface WorkflowDefinitionIdentityRetiredChildAskUserMigration {
  readonly adopted: readonly string[]
}

const NOTHING: WorkflowDefinitionIdentityRetiredChildAskUserMigration = { adopted: [] }

/** Let a workflow that recorded identities over the retired `ask_user` tool
 *  scope and the spec handoff revision that named it adopt the identities
 *  without them, so a paused workflow resumes instead of reporting definition
 *  drift.
 *
 *  The proof needs only the aggregate's own evidence and the two fixed spec
 *  rule sets. The retired-child-ask-user fact pass has already removed the key
 *  from each recorded binding snapshot. A recorded binding hash that equals
 *  that snapshot with `ask_user` set in its tool scope, and with or without the
 *  earlier retired `selfReview`, names the same binding, so the session adopts
 *  the snapshot's hash. A store that skipped the release that retired
 *  `selfReview` still holds hashes over both keys, and the self-review pass
 *  cannot prove them, so this pass covers both. A recorded spec handoff entry
 *  at revision 5 with the revision 5 rules adopts revision 6, whose only
 *  change is that rule. Any other difference is real drift and stays for the
 *  resume check to report.
 *  Remove this conversion after 2027-04-03. */
export function migrateWorkflowDefinitionIdentityRetiredChildAskUser(dbFile: string): WorkflowDefinitionIdentityRetiredChildAskUserMigration {
  if (!fs.existsSync(dbFile)) return NOTHING
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    if (!tableExists(db, "event")) return NOTHING
    // Nothing appended since the pass last looked: no scan, no write lock.
    if (headPosition(db) <= checkedThrough(db, DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_ID)) return NOTHING
    return adoptUnderWriteLock(db)
  } finally {
    db.close()
  }
}

/** Every hash a binding with this snapshot could have recorded while its tool
 *  scope stated `ask_user`. A binding with no tool scope never stated it. */
function hashesWithRetiredKey(definition: { readonly [key: string]: unknown }): ReadonlySet<string> {
  const { toolScoping } = definition
  if (!isRecord(toolScoping)) return new Set()
  const selfReviews = [{}, { selfReview: true }, { selfReview: false }]
  return new Set([true, false].flatMap((askUser) => selfReviews.map((selfReview) =>
    hashDefinition({ ...definition, ...selfReview, toolScoping: { ...toolScoping, ask_user: askUser } }).sha256)))
}

/** Binding snapshots recorded since the pass last looked, keyed by workflow
 *  aggregate and binding id. Every workflow records its bindings when it
 *  launches, so these name every aggregate the pass can have to adopt. */
function snapshotsByAggregate(db: Database, watermark: number): ReadonlyMap<string, AggregateSnapshots> {
  const rows = db.query<SnapshotRow, { $watermark: number }>(`
    select aggregate_id as aggregateId, session_id as sessionId, payload from event
    where aggregate_id glob 'workflow:*'
      and type = 'definition.loaded'
      and version = 6
      and position > $watermark
      and json_valid(payload)
      and json_extract(payload, '$.kind') = 'binding'
    order by position
  `).all({ $watermark: watermark })
  const byAggregate = new Map<string, AggregateSnapshots>()
  for (const row of rows) {
    const payload: unknown = JSON.parse(row.payload)
    if (!isRecord(payload) || typeof payload.id !== "string" || !isRecord(payload.definition)) continue
    const { definition } = payload
    const snapshots = byAggregate.get(row.aggregateId) ?? { sessionId: row.sessionId, bindings: new Map() }
    snapshots.bindings.set(payload.id, { withRetiredKey: hashesWithRetiredKey(definition), current: hashDefinition(definition).sha256 })
    byAggregate.set(row.aggregateId, snapshots)
  }
  return byAggregate
}

function planAdoption(db: Database, aggregateId: string, { sessionId, bindings: hashes }: AggregateSnapshots): PlannedAdoption | null {
  if (!recordsRetiredHash(db, aggregateId, hashes)) return null
  const recorded = db.query<{ present: number }, { $aggregateId: string; $migrationId: string }>(`
    select 1 as present from event where aggregate_id = $aggregateId
      and type = '${MIGRATED_FACT_TYPE}' and json_valid(payload)
      and json_extract(payload, '$.migrationId') = $migrationId limit 1
  `).get({ $aggregateId: aggregateId, $migrationId: DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_ID })
  if (recorded) return null
  // Replay is the authority for the identity the session holds now: the
  // adoption fact must name exactly that identity as its prior.
  const control = replayWorkflowControl(createSqliteEventReadSurface(db).readTolerant({ aggregateId }))
  const prior = control.definitionIdentity
  const adopted = adoptedIdentity(prior, hashes)
  if (adopted === null) return null
  const sequence = db.query<{ seq: number }, { $aggregateId: string }>(
    "select seq from event_sequence where aggregate_id = $aggregateId",
  ).get({ $aggregateId: aggregateId })
  if (!sequence) throw new Error(`workflow control aggregate ${aggregateId} has no aggregate sequence row`)
  return {
    aggregateId,
    sessionId,
    expectedSeq: sequence.seq + 1,
    fact: buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_ID, prior, adopted),
  }
}

/** Whether any identity the aggregate ever recorded names a binding hash taken
 *  over the retired key or the revision 5 spec rules. A workflow recorded
 *  after the retirement never does, so it costs one indexed read and no
 *  replay. */
function recordsRetiredHash(db: Database, aggregateId: string, hashes: ReadonlyMap<string, RetiredBindingHashes>): boolean {
  const types = IDENTITY_FACT_TYPES.map((type) => `'${type}'`).join(", ")
  const payloads = db.query<{ payload: string }, { $aggregateId: string }>(
    `select payload from event where aggregate_id = $aggregateId and type in (${types})`,
  ).all({ $aggregateId: aggregateId })
  const retired = [SPEC_REVISION_5_RULES_SHA256, ...[...hashes.values()].flatMap(({ withRetiredKey }) => [...withRetiredKey])]
  return payloads.some(({ payload }) => retired.some((hash) => payload.includes(hash)))
}

function adoptedIdentity(prior: DefinitionIdentity, hashes: ReadonlyMap<string, RetiredBindingHashes>): DefinitionIdentity | null {
  // A step-content identity names no binding or handoff type to adopt.
  if (!isLegacyDefinitionIdentity(prior)) return null
  let changed = false
  const bindings = prior.bindings.map((binding) => {
    const snapshot = hashes.get(binding.bindingId)
    if (!snapshot?.withRetiredKey.has(binding.sha256)) return binding
    changed = true
    return { ...binding, sha256: snapshot.current }
  })
  const handoffRegistry = prior.handoffRegistry.map((entry) => {
    if (entry.name !== SPEC_HANDOFF || entry.contractRevision !== 5 || entry.rulesSha256 !== SPEC_REVISION_5_RULES_SHA256) return entry
    changed = true
    return { ...entry, contractRevision: 6, rulesSha256: SPEC_REVISION_6_RULES_SHA256 }
  })
  return changed ? { ...prior, bindings, handoffRegistry } : null
}

/** Scan, plan, append, and move the watermark under one write lock, so no
 *  snapshot lands between the scan and the watermark that passes it. A
 *  workflow this build cannot replay keeps its identity and is recorded as
 *  skipped; its resume then reports drift as it would have. */
function adoptUnderWriteLock(db: Database): WorkflowDefinitionIdentityRetiredChildAskUserMigration {
  const inserter = createSqliteEventInserter(db)
  const adopted: string[] = []
  db.exec("BEGIN IMMEDIATE")
  try {
    const watermark = checkedThrough(db, DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_ID)
    for (const [aggregateId, snapshots] of snapshotsByAggregate(db, watermark)) {
      let plan: PlannedAdoption | null
      try {
        plan = planAdoption(db, aggregateId, snapshots)
      } catch {
        recordSkippedWorkflowMigrationCandidate(DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_ID, {
          aggregateId,
          sessionId: snapshots.sessionId,
          position: watermark,
        })
        continue
      }
      if (plan === null) continue
      inserter.insertEventRows([{
        id: crypto.randomUUID(), aggregateId: plan.aggregateId, sessionId: plan.sessionId,
        timestamp: Date.now(), type: plan.fact.type, version: plan.fact.version,
        actor: plan.fact.actor, payload: plan.fact.payload, expectedSeq: plan.expectedSeq,
      }])
      adopted.push(plan.aggregateId)
    }
    recordChecked(db, DEFINITION_IDENTITY_RETIRED_CHILD_ASK_USER_MIGRATION_ID)
    db.exec("COMMIT")
    return adopted.length === 0 ? NOTHING : { adopted }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
