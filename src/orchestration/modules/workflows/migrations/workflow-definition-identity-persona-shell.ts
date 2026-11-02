import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import { admitPrivateDatabaseFiles } from "../../../../infra/private-path.js"
import { createSqliteEventInserter } from "../../../../infra/sqlite-event-store-core.js"
import { createSqliteEventReadSurface } from "../../../../infra/sqlite-event-read-surface.js"
import { replayWorkflowControl } from "../../../../workflows/vm/fact-fold.js"
import {
  DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_ID,
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

/** One persona hash step this pass proves: the hash a build without the shell
 *  in the persona baseline recorded, and the hash the restoring build records
 *  for the same persona with `bash` in its tool list. Only the tool list
 *  changed. A source run installs the development module, which adds tools to
 *  the baseline personas, so each realm records its own hash for one persona.
 *  Both realms write to one project store, so every realm's step is fixed here
 *  as that realm's builds produced it. */
interface PersonaHashStep {
  readonly name: string
  readonly from: string
  readonly to: string
}

const PERSONA_STEPS: readonly PersonaHashStep[] = [
  // The release realm.
  { name: "explorer", from: "38c58f5f8ed49d014358437d7cfd760ec4c6c273f59712ef48d80251d83e1d21", to: "7b716012e3c9c29e2bc88c4880b3299807cfffc296a72e19823e85f1611639c6" },
  { name: "implementer", from: "929c7a95f2460fbbd824d9ae4a1b2fc8f8fe44a6d0b9d34990f416d7728c50ff", to: "cf4ff5cb359aa20043ffdedd9b5fff7ca147f7c8336d67104b9a79999e58c640" },
  { name: "reviewer-code-data-integrity", from: "bae15852a15efcad797bf38f9738765027ea2aae78120a857a6b314efb708522", to: "641793cf9d427292988bf3c4662c5df93d2f3d4dbf0c25ce6493bdf8afd02b20" },
  { name: "reviewer-code-design", from: "984b9f08ad243f10b3aa774f7854a7f44e91c6e60be686e12655f60bb380ea2c", to: "21a790fbd48484e6419972b9a049a6cbcab06b8c4eecba54e0cddaf261e62808" },
  { name: "reviewer-code-elegance", from: "79f954d6dc5df8c2f566d4f8ffc8ffa625b78e1be2682c1fe3114478458d45d7", to: "6e6b5e2824ad2323adc28279d085ddfcb54224a942ee048ff8e18070cc44b64b" },
  { name: "reviewer-code-performance", from: "1456575a945e206505affc315855116f273940fe09a66c421b6e337f55cbd255", to: "7eb6366d77ca47a9f12ff04d1df3e3682333cc85c5f26d9f175d8882064e7b2b" },
  { name: "reviewer-code-quality", from: "175866e4b6665e227ce736512d4669fe0d4c4366558a62e130171f041ef2a358", to: "f3e40fa4b11f343f8389818ca348f636c65547836610e255bf67db4d28b8454b" },
  { name: "reviewer-code-security", from: "52e14403b3b742787ec8fd432f0cdd7698a530ae5f44372598fc5e25b1712172", to: "280339f7deead3ac5309153b155c24cbaa10c2e99b925514a1c334c7e458ae27" },
  { name: "reviewer-mechanism", from: "7307b4f573fa05f917ca3acda98c7cbed0c1b48de554f4fac2a8db2ff158d6f4", to: "dd660d54d5f7273724e08edd637d1c923dc7c56713b0c11fa5c4fe974efaf709" },
  { name: "reviewer-plan-data-integrity", from: "dbe3d3ec2b62781347db7b91a94b7cc6dd9268a0d4d6313127a58f9b4f5359ee", to: "0fbdadf400631b1109ff005b624792d3859f5efac641795786856ea6ba8404c9" },
  { name: "reviewer-plan-design", from: "0ec7b4a17a246b9d799dfc61fc2fc4859b4009a7a789ac2886f2f7880c0614d2", to: "7a8fe67c2fa81094314289a8d574b75992003889d76364411578f0491a22fbe3" },
  { name: "reviewer-plan-elegance", from: "c219c019184d07f68f31b1c276b91b43f56fbce0eb89b52a9f2e82378a67da59", to: "3685bfbd50278ceb6c15d8c48a6ef0968dfa7fc659e5fe9656f969db2b36910a" },
  { name: "reviewer-plan-performance", from: "f47025a36514caecc6bfb287fe36fc604fcfbfae39e53ac486e07e7d5afbde4e", to: "2254146531a43ef5e9225f612c2e15ef5c1b81cb4066ddfeace24fd1152d830c" },
  { name: "reviewer-plan-quality", from: "4c881dc9ce9102e02c54933c26ea58f3b5901de9a354e645cddba5e1a8ef948a", to: "a677ac5749046ba3b92b843e3bde14c38c9e8fe498e84e0b116e328915c4837b" },
  { name: "reviewer-plan-security", from: "5d2dfbc848fe56051ded7943971ba8cbe50d616b43e06a126b44e9f9bf5d5d20", to: "53713c2e794887a0c8bb37ac2f87eb1418722566b43c02aa846d30c9e8e5b563" },
  { name: "reviewer-uat", from: "69398517e05f344879898bf37997ac8499cfd8ffe738ba09a7f36520035ce737", to: "a042b91633513b24c7a1187ce7dc8749401f79550b0d71f38c87d6422df57505" },
  // The source realm, where the development module adds `ios_simulator`.
  { name: "explorer", from: "6ad6703be300d9553942a19e407e2bd68d9bf0fd5e56bf61d27d0d71968bd3a4", to: "9d3b7ac337eb4dd763a79da9d0a78204536cda3f076b30f62f28b8ac1cbb1e5a" },
  { name: "implementer", from: "e7180cbf32deb0f580186d361d6622bbac3bb2c6c445bfd8af3bef816fcfe93a", to: "6bff45d476013b847f5d9f04c70ffeb2d874edf71260813f24970c6ab9b2b844" },
  { name: "reviewer-code-data-integrity", from: "ca2c0afb63b1b34dd66318ed2189798ee62d21a9d9b48a682ddc2610f8921963", to: "c1ff93d1af3f9382080ec07c1248671a88c0c6bd1cdcefdc786d7197f4ad7b81" },
  { name: "reviewer-code-design", from: "7ce648a740947d2d2db5320e612262c039d1f6740be1b721e8b4a75bc5be2d79", to: "f6372ba960fa0dc742e9f5fd28d63238ee9c8ee25dc05dc16eb4b7bb79be0c6e" },
  { name: "reviewer-code-elegance", from: "5c63f6dde6e794f44133001451a0fc7dd09caf9c74c271d741ebc9732dda4251", to: "4a4eb2a5257b775042e54adc489ac3d067a37ec0bf2aab5aba7d484ff169d13a" },
  { name: "reviewer-code-performance", from: "508928e275a6a647c216e0a2efacfe0824ac03c38b3378d473e173bad9ba68c7", to: "b19532d1d79108d25bd5fc9183fe56a7212ef1e5a0700439c46adac380f75312" },
  { name: "reviewer-code-quality", from: "6da5381f2b33dd48ce3974ff17f950a7cf77360360755b1519a81373b76cf59b", to: "951a5f7c81d3794ee936c5a4c18430ce0f5806f9f641e897eb99cbd95063cd28" },
  { name: "reviewer-code-security", from: "d4708b7513ddd0578379481e993444ded01a137832bd93a0a142dead206771f7", to: "c86a78c3ce2f406ba7707ee218e2ae5ab8b36d905653932125c31abdb3f44532" },
  { name: "reviewer-mechanism", from: "0b8048f8abe2a969331ea6f47d3673b6a8f1b2cb060a1d6b0d9f85e0bff55dfe", to: "11703252c304f177e9c634796307c3b7e454606b50bb84ab82af566be84acd1e" },
  { name: "reviewer-plan-data-integrity", from: "a7f490f69a4e540fbb08c64c3a2f3ef3ea8087a6cbd897caaf7436da3741f60b", to: "79826a329fac1f35daaeb64d33c3b1b4666cbf9f96dd534d48b49a8d9b2bc7b5" },
  { name: "reviewer-plan-design", from: "90c893f72922b1c1168de402fc3ef5a0108bc4628d9fec2a45378cc2b01dd1c3", to: "a8b15a27c1311b01c05df47d9e43910ffff86bd31a1181af6a88d6c7b7557520" },
  { name: "reviewer-plan-elegance", from: "5ba55e8102ba210211294b7b083633bb9876175a776f16db4e0c0b7688b598de", to: "ef7ca0091c3640d4e1cfd99431cb57e067889fd13509be746df23abb04fbd4c5" },
  { name: "reviewer-plan-performance", from: "88b2e2c46602b0330fcb91b022264680ab22344e74b2d6a4e1c8501497365ff0", to: "10e824e69bf2dec19b27b30da55ad88216bc73c59402cebe0c8887489e4012c1" },
  { name: "reviewer-plan-quality", from: "0cb8c7b5ed0bafe00542a2d4e68b9cb989279662c5d6bd2eef1e9bfddd1a7a11", to: "83d4afdb24a0c0c87aea3cf260883738395e072b6338f04f0f239bab2b1192f8" },
  { name: "reviewer-plan-security", from: "40462134535d4c932573e8b2dae845ff2eb59f564dfda6da29ebec6630febb68", to: "0d35ca2e4c41f05e2812431b57ba1e7c7cb12307a4d6076b3a743481753f205f" },
  { name: "reviewer-uat", from: "7f3b2d87d9bcf4b6cf95377f34d2e7f670f000221f11e58a67e5d3a5c51076cc", to: "aae66626fbbee4f6a030eca9a3a3a91b62f2979595d2506b9f22139ce9aff1bb" },
]

/** The pre-restoration hashes an identity fact must contain to need adoption.
 *  A workflow whose identity facts hold none of them costs no replay. */
const RETIRED_MARKERS = PERSONA_STEPS.map(({ from }) => from)

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

export interface WorkflowDefinitionIdentityPersonaShellMigration {
  readonly adopted: readonly string[]
}

const NOTHING: WorkflowDefinitionIdentityPersonaShellMigration = { adopted: [] }

/** Let a workflow that recorded personas without the shell adopt the same
 *  personas with `bash` restored to their tool list, so a paused workflow
 *  resumes instead of reporting definition drift.
 *
 *  The opt-in exec shell variant shares the `bash` identity and carried no
 *  persona grant, so from 2026-09-12 it erased `bash` from every persona
 *  baseline. A recorded persona hash adopts the restoring build's hash in the
 *  same realm only when it equals that realm's fixed pre-restoration hash. Any
 *  other difference, such as a persona the project overrides, is real drift
 *  and stays for the resume check to report.
 *  Remove this conversion after 2027-04-05. */
export function migrateWorkflowDefinitionIdentityPersonaShell(dbFile: string): WorkflowDefinitionIdentityPersonaShellMigration {
  if (!fs.existsSync(dbFile)) return NOTHING
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    if (!tableExists(db, "event")) return NOTHING
    // Nothing appended since the pass last looked: no scan, no write lock.
    if (headPosition(db) <= checkedThrough(db, DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_ID)) return NOTHING
    return adoptUnderWriteLock(db)
  } finally {
    db.close()
  }
}

/** Workflow aggregates with an identity fact recorded since the pass last
 *  looked that holds a pre-restoration persona hash. */
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
  let changed = false
  const personas = prior.personas.map((entry) => {
    const step = PERSONA_STEPS.find(({ name, from }) => name === entry.personaName && from === entry.sha256)
    if (!step) return entry
    changed = true
    return { ...entry, sha256: step.to }
  })
  return changed ? { ...prior, personas } : null
}

function planAdoption(db: Database, aggregateId: string, sessionId: string): PlannedAdoption | null {
  const recorded = db.query<{ present: number }, { $aggregateId: string; $migrationId: string }>(`
    select 1 as present from event where aggregate_id = $aggregateId
      and type = '${MIGRATED_FACT_TYPE}' and json_valid(payload)
      and json_extract(payload, '$.migrationId') = $migrationId limit 1
  `).get({ $aggregateId: aggregateId, $migrationId: DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_ID })
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
    fact: buildDefinitionIdentityMigratedFact(DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_ID, prior, adopted),
  }
}

/** Scan, plan, append, and move the watermark under one write lock, so no
 *  identity fact lands between the scan and the watermark that passes it. A
 *  workflow this build cannot replay keeps its identity and is recorded as
 *  skipped; its resume then reports drift as it would have. */
function adoptUnderWriteLock(db: Database): WorkflowDefinitionIdentityPersonaShellMigration {
  const inserter = createSqliteEventInserter(db)
  const adopted: string[] = []
  db.exec("BEGIN IMMEDIATE")
  try {
    const watermark = checkedThrough(db, DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_ID)
    for (const [aggregateId, sessionId] of candidateAggregates(db, watermark)) {
      let plan: PlannedAdoption | null
      try {
        plan = planAdoption(db, aggregateId, sessionId)
      } catch {
        recordSkippedWorkflowMigrationCandidate(DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_ID, { aggregateId, sessionId, position: watermark })
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
    recordChecked(db, DEFINITION_IDENTITY_PERSONA_SHELL_MIGRATION_ID)
    db.exec("COMMIT")
    return adopted.length === 0 ? NOTHING : { adopted }
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}
