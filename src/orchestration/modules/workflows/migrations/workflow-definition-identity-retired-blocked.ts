import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import { admitPrivateDatabaseFiles } from "../../../../infra/private-path.js"
import { createSqliteEventInserter } from "../../../../infra/sqlite-event-store-core.js"
import { createSqliteEventReadSurface } from "../../../../infra/sqlite-event-read-surface.js"
import { replayWorkflowControl } from "../../../../workflows/vm/fact-fold.js"
import {
  DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_ID,
  isLegacyDefinitionIdentity,
  type DefinitionIdentity,
} from "../../../../workflows/vm/definition-identity.js"
import { buildDefinitionIdentityMigratedFact } from "../../../../workflows/vm/session-facts.js"
import { checkedThrough, headPosition, recordChecked, tableExists } from "../../../migrations/engine.js"
import { MIGRATED_FACT_TYPE, recordSkippedWorkflowMigrationCandidate } from "./workflow-identity-chain.js"

const BUSY_TIMEOUT_MS = 5000

/** The facts that can set a workflow's definition identity. */
const IDENTITY_FACT_TYPES = [
  "workflow.control.initialized",
  "workflow.control.recovered",
  MIGRATED_FACT_TYPE,
  "workflow.definition_identity.adopted",
] as const

/** One handoff revision step this pass proves: the recorded revision and its
 *  hashes, and the revision that replaced them. The hashes are history, fixed
 *  as the two builds produced them, so a later revision does not move them. */
interface HandoffRevisionStep {
  readonly name: string
  readonly from: { readonly contractRevision: number; readonly fieldsSha256: string; readonly rulesSha256: string }
  readonly to: { readonly contractRevision: number; readonly fieldsSha256: string; readonly rulesSha256: string }
}

const HANDOFF_STEPS: readonly HandoffRevisionStep[] = [
  {
    // Revision 3 carried `outcome` and `user_steering`; revision 4 drops both
    // and tells the step to message its parent.
    name: "work-handoff",
    from: {
      contractRevision: 3,
      fieldsSha256: "5a666ad8743f6eb7eed5db975eecec7031ab6904fd22ba4346f1c0fedc8c667b",
      rulesSha256: "0e6eda0ae2f4641a27b53f81321802072b6d51dd96cb311d43482ceb058afc34",
    },
    to: {
      contractRevision: 4,
      fieldsSha256: "99080537482028c5f302967da5047b69b5da446b693cd4f3bddad3138a58d4e1",
      rulesSha256: "268f7e652b4d9357f6f1eb20f30b6e4eca7fcbff29777c50a789fb65e83f56fd",
    },
  },
  {
    // Revision 6 let a spec step submit a blocked outcome; revision 7 drops it.
    name: "spec-handoff",
    from: {
      contractRevision: 6,
      fieldsSha256: "48df21b9fb7401a3210dcef8faa320e97bb56d2f6c61fb9b6ab08943f675946b",
      rulesSha256: "6059a436d21ab5b1fa4d51b6304371c0fab64cec848f0175e2e7fd9b51b12605",
    },
    to: {
      contractRevision: 7,
      fieldsSha256: "bbd9a3d9ef50a88fda1e678c02bf76967d1dd228ed9b39c62462ca53109d9597",
      rulesSha256: "6def0f6f815ae463c550cac1ac47541532f40a18d3a352c9e05b12255a2c4d65",
    },
  },
]

/** One persona hash step this pass proves: the hash a build before the
 *  retirement recorded for a persona whose body reported blockers, and the hash
 *  the retiring build records for the same persona with the body that replaced
 *  it. Only the body changed. A persona's hash also covers its tool list, and a
 *  source run installs the development module, which adds tools to the
 *  baseline personas, so the release realm and the source realm record
 *  different hashes for one body. Both realms write to one project store and
 *  the pass reads each fact once, whichever realm opens the store first, so
 *  every realm's step is fixed here as that realm's builds produced it. */
interface PersonaHashStep {
  readonly name: string
  readonly from: string
  readonly to: string
}

const PERSONA_STEPS: readonly PersonaHashStep[] = [
  // The release realm.
  {
    name: "implementer",
    from: "4f49a4ddf0912ef52e2d2ef0e9adbec1afd1dd4cc5cc6dadf665f3789fb3e57c",
    to: "929c7a95f2460fbbd824d9ae4a1b2fc8f8fe44a6d0b9d34990f416d7728c50ff",
  },
  // The source realm, where the development module adds `ios_simulator`.
  {
    name: "implementer",
    from: "45f8e242a87668c611b7d9b5894d39493eb7d6a442bac472c36216378be3f8a6",
    to: "e7180cbf32deb0f580186d361d6622bbac3bb2c6c445bfd8af3bef816fcfe93a",
  },
  // Both realms: the development module adds no tool to `ship`.
  {
    name: "ship",
    from: "0a472c5de92c5621a9a0e7501dc12c0296a76d1e014504ed978f17d79d198805",
    to: "6a0c7cc29a25e0c249247020dbd409ef785920006a1f9771a672ed43b9f2aaa9",
  },
]

/** The retired hashes an identity fact must contain to need adoption. A
 *  workflow whose identity facts hold none of them costs no replay. */
const RETIRED_MARKERS = [
  ...HANDOFF_STEPS.map(({ from }) => from.rulesSha256),
  ...PERSONA_STEPS.map(({ from }) => from),
]

interface IdentityRow {
  readonly aggregateId: string
  readonly sessionId: string
  readonly payload: string
}

interface PlannedAdoption {
  readonly aggregateId: string
  readonly sessionId: string
  readonly expectedSeq: number
  readonly fact: ReturnType<typeof buildDefinitionIdentityMigratedFact>
}

export interface WorkflowDefinitionIdentityRetiredBlockedMigration {
  readonly adopted: readonly string[]
}

const NOTHING: WorkflowDefinitionIdentityRetiredBlockedMigration = { adopted: [] }

/** Let a workflow that recorded the work and spec handoff revisions with a
 *  blocked outcome, or the implementer and ship personas that reported
 *  blockers, adopt the revisions and persona bodies that replaced them, so a
 *  paused workflow resumes instead of reporting definition drift.
 *
 *  A recorded handoff entry adopts its next revision only when its revision
 *  and its field and rule hashes equal the fixed hashes of the earlier
 *  revision. A recorded persona hash adopts the hash the retiring build
 *  recorded in the same realm only when it equals that realm's fixed retired
 *  hash. Any other difference, such as a persona the project overrides, is
 *  real drift and stays for the resume check to report.
 *  Remove this conversion after 2027-04-03. */
export function migrateWorkflowDefinitionIdentityRetiredBlocked(dbFile: string): WorkflowDefinitionIdentityRetiredBlockedMigration {
  if (!fs.existsSync(dbFile)) return NOTHING
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    if (!tableExists(db, "event")) return NOTHING
    // Nothing appended since the pass last looked: no scan, no write lock.
    if (headPosition(db) <= checkedThrough(db, DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_ID)) return NOTHING
    return adoptUnderWriteLock(db)
  } finally {
    db.close()
  }
}

/** Workflow aggregates with an identity fact recorded since the pass last
 *  looked that holds a retired handoff revision or a retired persona hash. */
function candidateAggregates(db: Database, watermark: number): ReadonlyMap<string, string> {
  const types = IDENTITY_FACT_TYPES.map((type) => `'${type}'`).join(", ")
  const rows = db.query<IdentityRow, { $watermark: number }>(`
    select aggregate_id as aggregateId, session_id as sessionId, payload from event
    where aggregate_id glob 'workflow:*'
      and type in (${types})
      and position > $watermark
    order by position
  `).all({ $watermark: watermark })
  const candidates = new Map<string, string>()
  for (const row of rows) {
    if (RETIRED_MARKERS.some((marker) => row.payload.includes(marker))) candidates.set(row.aggregateId, row.sessionId)
  }
  return candidates
}

function adoptedIdentity(prior: DefinitionIdentity): DefinitionIdentity | null {
  // A step-content identity names no binding or handoff type to adopt.
  if (!isLegacyDefinitionIdentity(prior)) return null
  let changed = false
  const handoffRegistry = prior.handoffRegistry.map((entry) => {
    const step = HANDOFF_STEPS.find(({ name, from }) => name === entry.name
      && from.contractRevision === entry.contractRevision
      && from.fieldsSha256 === entry.fieldsSha256
      && from.rulesSha256 === entry.rulesSha256)
    if (!step) return entry
    changed = true
    return { ...entry, ...step.to }
  })
  const adoptedPersonas = prior.personas.map((entry) => {
    const step = PERSONA_STEPS.find(({ name, from }) => name === entry.personaName && from === entry.sha256)
    if (!step) return entry
    changed = true
    return { ...entry, sha256: step.to }
  })
  return changed ? { ...prior, handoffRegistry, personas: adoptedPersonas } : null
}

function planAdoption(db: Database, aggregateId: string, sessionId: string): PlannedAdoption | null {
  const recorded = db.query<{ present: number }, { $aggregateId: string; $migrationId: string }>(`
    select 1 as present from event where aggregate_id = $aggregateId
      and type = '${MIGRATED_FACT_TYPE}' and json_valid(payload)
      and json_extract(payload, '$.migrationId') = $migrationId limit 1
  `).get({ $aggregateId: aggregateId, $migrationId: DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_ID })
  if (recorded) return null
  // Replay is the authority for the identity the session holds now: the
  // adoption fact must name exactly that identity as its prior.
  const prior = replayWorkflowControl(createSqliteEventReadSurface(db).readTolerant({ aggregateId })).definitionIdentity
  const adopted = adoptedIdentity(prior)
  if (adopted === null) return null
  const sequence = db.query<{ seq: number }, { $aggregateId: string }>(
    "select seq from event_sequence where aggregate_id = $aggregateId",
  ).get({ $aggregateId: aggregateId })
  if (!sequence) throw new Error(`workflow control aggregate ${aggregateId} has no aggregate sequence row`)
  return {
    aggregateId,
    sessionId,
    expectedSeq: sequence.seq + 1,
    fact: buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_ID, prior, adopted),
  }
}

/** Scan, plan, append, and move the watermark under one write lock, so no
 *  identity fact lands between the scan and the watermark that passes it. A
 *  workflow this build cannot replay keeps its identity and is recorded as
 *  skipped; its resume then reports drift as it would have. */
function adoptUnderWriteLock(db: Database): WorkflowDefinitionIdentityRetiredBlockedMigration {
  const inserter = createSqliteEventInserter(db)
  const adopted: string[] = []
  db.exec("BEGIN IMMEDIATE")
  try {
    const watermark = checkedThrough(db, DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_ID)
    for (const [aggregateId, sessionId] of candidateAggregates(db, watermark)) {
      let plan: PlannedAdoption | null
      try {
        plan = planAdoption(db, aggregateId, sessionId)
      } catch {
        recordSkippedWorkflowMigrationCandidate(DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_ID, { aggregateId, sessionId, position: watermark })
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
    recordChecked(db, DEFINITION_IDENTITY_RETIRED_BLOCKED_MIGRATION_ID)
    db.exec("COMMIT")
    return adopted.length === 0 ? NOTHING : { adopted }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
