import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import { admitPrivateDatabaseFiles } from "../../../../infra/private-path.js"
import { createSqliteEventInserter } from "../../../../infra/sqlite-event-store-core.js"
import { createSqliteEventReadSurface } from "../../../../infra/sqlite-event-read-surface.js"
import { replayWorkflowControl } from "../../../../workflows/vm/fact-fold.js"
import {
  DEFINITION_IDENTITY_COMMAND_CITATION_MIGRATION_ID,
  DEFINITION_IDENTITY_RUNTIME_WORDING_MIGRATION_ID,
  isLegacyDefinitionIdentity,
  type DefinitionIdentity,
  type DefinitionIdentityMigrationId,
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

interface HandoffContractHashes {
  readonly contractRevision: number
  readonly fieldsSha256: string
  readonly rulesSha256: string
}

/** One handoff revision step a pass proves: the recorded revision and its
 *  hashes, and the revision that replaced them. The hashes are history, fixed
 *  as the two builds produced them, so a later revision does not move them.
 *  Handoff types carry no tools, so both realms record the same hashes. */
interface HandoffRevisionStep {
  readonly name: string
  readonly from: HandoffContractHashes
  readonly to: HandoffContractHashes
}

/** One release's handoff text change: a recorded entry adopts the next
 *  revision only when its revision and its field and rule hashes equal the
 *  fixed hashes of the earlier revision. Any other difference is real drift and
 *  stays for the resume check to report. */
export interface HandoffRevisionMigration {
  readonly id: DefinitionIdentityMigrationId
  readonly steps: readonly HandoffRevisionStep[]
}

/** The earlier revision of each type told the step to copy the command of
 *  every cited call; the later one records the command from the call.
 *  Remove this conversion after 2027-04-07. */
const COMMAND_CITATION: HandoffRevisionMigration = {
  id: DEFINITION_IDENTITY_COMMAND_CITATION_MIGRATION_ID,
  steps: [
    {
      name: "work-handoff",
      from: { contractRevision: 4, fieldsSha256: "99080537482028c5f302967da5047b69b5da446b693cd4f3bddad3138a58d4e1", rulesSha256: "268f7e652b4d9357f6f1eb20f30b6e4eca7fcbff29777c50a789fb65e83f56fd" },
      to: { contractRevision: 5, fieldsSha256: "c2cc741afe6335c5c2a0ec7aa1740ae287305f69460f06f5e429053a522e8452", rulesSha256: "3d082bd670526dd5e0e3c54f71557b011e432d5f96004232aa2b1835b216f8ea" },
    },
    {
      name: "review-handoff",
      from: { contractRevision: 2, fieldsSha256: "69e449cd2429dfd040da495d525ad1070fdf101674c94fa9f40b23c6752179b5", rulesSha256: "c01a8a8f488fedd7a702ffad82cb7d940af51e76f6f0b32ff7c8b5731ad0383a" },
      to: { contractRevision: 3, fieldsSha256: "8f12480a83167b2dd69a7f97998485f7c02a9a026a6a75a364f25973c434381a", rulesSha256: "5d2530be054681e61f81ba9175c3e519ca018d119f5669ada2418a8a04b65bb2" },
    },
    {
      name: "debug-handoff",
      from: { contractRevision: 3, fieldsSha256: "5d0bc06c05ebb622ef7aa1071c32062daf66fbcef40f1e24a1502a4927447525", rulesSha256: "c01a8a8f488fedd7a702ffad82cb7d940af51e76f6f0b32ff7c8b5731ad0383a" },
      to: { contractRevision: 4, fieldsSha256: "b0f208e568e097723893f6a802775b66c308c35f1c7b39387524f4d1123b96d4", rulesSha256: "5d2530be054681e61f81ba9175c3e519ca018d119f5669ada2418a8a04b65bb2" },
    },
    {
      name: "qa-findings-handoff",
      from: { contractRevision: 2, fieldsSha256: "6a6ce849d747a304eee911fbe092d1c356abb204901ad1b97bac2ce869f58caa", rulesSha256: "c01a8a8f488fedd7a702ffad82cb7d940af51e76f6f0b32ff7c8b5731ad0383a" },
      to: { contractRevision: 3, fieldsSha256: "ecc783119ce068ab0f4c118339c7f71e23ab1c86d3285641cf206fe5490a0347", rulesSha256: "5d2530be054681e61f81ba9175c3e519ca018d119f5669ada2418a8a04b65bb2" },
    },
    {
      name: "qa-contest-handoff",
      from: { contractRevision: 2, fieldsSha256: "3e7b7086a9fe8bd94b7ead2963b83ec126681d59ccafc22962e810b8b267df35", rulesSha256: "c01a8a8f488fedd7a702ffad82cb7d940af51e76f6f0b32ff7c8b5731ad0383a" },
      to: { contractRevision: 3, fieldsSha256: "0a69d800c56970dbf06c0188b8d7f6a1792133baad28f39811cf759b43c9b9b4", rulesSha256: "5d2530be054681e61f81ba9175c3e519ca018d119f5669ada2418a8a04b65bb2" },
    },
  ],
}

/** The earlier revision of each type named the product in its field and rule
 *  text; the later one says "the runtime" or rephrases, and nothing else
 *  changed. Remove this conversion after 2027-04-09. */
const RUNTIME_WORDING: HandoffRevisionMigration = {
  id: DEFINITION_IDENTITY_RUNTIME_WORDING_MIGRATION_ID,
  steps: [
    {
      name: "work-handoff",
      from: { contractRevision: 5, fieldsSha256: "c2cc741afe6335c5c2a0ec7aa1740ae287305f69460f06f5e429053a522e8452", rulesSha256: "3d082bd670526dd5e0e3c54f71557b011e432d5f96004232aa2b1835b216f8ea" },
      to: { contractRevision: 6, fieldsSha256: "deeb67d82fc0459d03fac36aac8ca4331ea93f0fe51e74adc9f3ac22372581b8", rulesSha256: "6926183f9debac3ad3dedaf097cdd8e067cb66b257050f08090ace75eb10555c" },
    },
    {
      name: "review-handoff",
      from: { contractRevision: 3, fieldsSha256: "8f12480a83167b2dd69a7f97998485f7c02a9a026a6a75a364f25973c434381a", rulesSha256: "5d2530be054681e61f81ba9175c3e519ca018d119f5669ada2418a8a04b65bb2" },
      to: { contractRevision: 4, fieldsSha256: "b57842cba555ea283c29b61fccaba0597bb66ea5a4ea3acbf965f12a59afa5ba", rulesSha256: "05efe24f241a28b2f92080c690f18d3721c17ca3287d555c88cbfbec657a8cd7" },
    },
    {
      name: "debug-handoff",
      from: { contractRevision: 4, fieldsSha256: "b0f208e568e097723893f6a802775b66c308c35f1c7b39387524f4d1123b96d4", rulesSha256: "5d2530be054681e61f81ba9175c3e519ca018d119f5669ada2418a8a04b65bb2" },
      to: { contractRevision: 5, fieldsSha256: "bec99e132a9843232e538ff55be9dab78e2faed71cf7e2f75b266b9f10ef1208", rulesSha256: "05efe24f241a28b2f92080c690f18d3721c17ca3287d555c88cbfbec657a8cd7" },
    },
    {
      name: "qa-findings-handoff",
      from: { contractRevision: 3, fieldsSha256: "ecc783119ce068ab0f4c118339c7f71e23ab1c86d3285641cf206fe5490a0347", rulesSha256: "5d2530be054681e61f81ba9175c3e519ca018d119f5669ada2418a8a04b65bb2" },
      to: { contractRevision: 4, fieldsSha256: "b70c377fcb719156133341b9477a13ab16251a35680d0cb03f0f545d4b9223d8", rulesSha256: "05efe24f241a28b2f92080c690f18d3721c17ca3287d555c88cbfbec657a8cd7" },
    },
    {
      name: "qa-contest-handoff",
      from: { contractRevision: 3, fieldsSha256: "0a69d800c56970dbf06c0188b8d7f6a1792133baad28f39811cf759b43c9b9b4", rulesSha256: "5d2530be054681e61f81ba9175c3e519ca018d119f5669ada2418a8a04b65bb2" },
      to: { contractRevision: 4, fieldsSha256: "c64efdd9a659e45d3d490129e1e6f890d9a79e795b2f08f1a2e26c356fd1e656", rulesSha256: "05efe24f241a28b2f92080c690f18d3721c17ca3287d555c88cbfbec657a8cd7" },
    },
    {
      name: "definition-improvement-proposal",
      from: { contractRevision: 1, fieldsSha256: "c266d33037ae5065d360c91ad53c82e628670e0ce2a0108eb94fc2d9c5242a1b", rulesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
      to: { contractRevision: 2, fieldsSha256: "70f9b61bb42d7ef89186975d74e177c9a6356a38a8165a3ebe81db5aab758198", rulesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" },
    },
  ],
}

/** Every handoff text change in definition-identity chain order. A workflow
 *  recorded before several of them adopts each in turn. */
export const HANDOFF_REVISION_MIGRATIONS: readonly HandoffRevisionMigration[] = [COMMAND_CITATION, RUNTIME_WORDING]

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

export interface HandoffRevisionAdoption {
  readonly adopted: readonly string[]
}

const NOTHING: HandoffRevisionAdoption = { adopted: [] }

/** Let a workflow that recorded the earlier handoff revisions of one text
 *  change adopt the later ones, so a paused workflow resumes instead of
 *  reporting definition drift. Run the migrations of
 *  `HANDOFF_REVISION_MIGRATIONS` in their order: each adopts from the
 *  revisions the one before it produced. */
export function migrateHandoffRevisions(dbFile: string, migration: HandoffRevisionMigration): HandoffRevisionAdoption {
  if (!fs.existsSync(dbFile)) return NOTHING
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    if (!tableExists(db, "event")) return NOTHING
    // Nothing appended since the pass last looked: no scan, no write lock.
    if (headPosition(db) <= checkedThrough(db, migration.id)) return NOTHING
    return adoptUnderWriteLock(db, migration)
  } finally {
    db.close()
  }
}

/** Workflow aggregates with an identity fact recorded since the pass last
 *  looked that holds a retired handoff revision. Each type's field hash is
 *  distinct, so a workflow whose identity facts hold none of them costs no
 *  replay. */
function candidateAggregates(db: Database, migration: HandoffRevisionMigration, watermark: number): ReadonlyMap<string, string> {
  const types = IDENTITY_FACT_TYPES.map((type) => `'${type}'`).join(", ")
  const rows = db.query<IdentityRow, { $watermark: number }>(`
    select aggregate_id as aggregateId, session_id as sessionId, payload from event
    where aggregate_id glob 'workflow:*'
      and type in (${types})
      and position > $watermark
    order by position
  `).all({ $watermark: watermark })
  const markers = migration.steps.map(({ from }) => from.fieldsSha256)
  const candidates = new Map<string, string>()
  for (const row of rows) {
    if (markers.some((marker) => row.payload.includes(marker))) candidates.set(row.aggregateId, row.sessionId)
  }
  return candidates
}

function adoptedIdentity(prior: DefinitionIdentity, migration: HandoffRevisionMigration): DefinitionIdentity | null {
  // A step-content identity names no binding or handoff type to adopt.
  if (!isLegacyDefinitionIdentity(prior)) return null
  let changed = false
  const handoffRegistry = prior.handoffRegistry.map((entry) => {
    const step = migration.steps.find(({ name, from }) => name === entry.name
      && from.contractRevision === entry.contractRevision
      && from.fieldsSha256 === entry.fieldsSha256
      && from.rulesSha256 === entry.rulesSha256)
    if (!step) return entry
    changed = true
    return { ...entry, ...step.to }
  })
  return changed ? { ...prior, handoffRegistry } : null
}

function planAdoption(db: Database, migration: HandoffRevisionMigration, aggregateId: string, sessionId: string): PlannedAdoption | null {
  const recorded = db.query<{ present: number }, { $aggregateId: string; $migrationId: string }>(`
    select 1 as present from event where aggregate_id = $aggregateId
      and type = '${MIGRATED_FACT_TYPE}' and json_valid(payload)
      and json_extract(payload, '$.migrationId') = $migrationId limit 1
  `).get({ $aggregateId: aggregateId, $migrationId: migration.id })
  if (recorded) return null
  // Replay is the authority for the identity the session holds now: the
  // adoption fact must name exactly that identity as its prior.
  const prior = replayWorkflowControl(createSqliteEventReadSurface(db).readTolerant({ aggregateId })).definitionIdentity
  const adopted = adoptedIdentity(prior, migration)
  if (adopted === null) return null
  const sequence = db.query<{ seq: number }, { $aggregateId: string }>(
    "select seq from event_sequence where aggregate_id = $aggregateId",
  ).get({ $aggregateId: aggregateId })
  if (!sequence) throw new Error(`workflow control aggregate ${aggregateId} has no aggregate sequence row`)
  return {
    aggregateId,
    sessionId,
    expectedSeq: sequence.seq + 1,
    fact: buildDefinitionIdentityMigratedFact(migration.id, prior, adopted),
  }
}

/** Scan, plan, append, and move the watermark under one write lock, so no
 *  identity fact lands between the scan and the watermark that passes it. A
 *  workflow this build cannot replay keeps its identity and is recorded as
 *  skipped; its resume then reports drift as it would have. */
function adoptUnderWriteLock(db: Database, migration: HandoffRevisionMigration): HandoffRevisionAdoption {
  const inserter = createSqliteEventInserter(db)
  const adopted: string[] = []
  db.exec("BEGIN IMMEDIATE")
  try {
    const watermark = checkedThrough(db, migration.id)
    for (const [aggregateId, sessionId] of candidateAggregates(db, migration, watermark)) {
      let plan: PlannedAdoption | null
      try {
        plan = planAdoption(db, migration, aggregateId, sessionId)
      } catch {
        recordSkippedWorkflowMigrationCandidate(migration.id, { aggregateId, sessionId, position: watermark })
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
    recordChecked(db, migration.id)
    db.exec("COMMIT")
    return adopted.length === 0 ? NOTHING : { adopted }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
