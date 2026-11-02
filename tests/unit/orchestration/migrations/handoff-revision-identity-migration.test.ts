import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { HANDOFF_REVISION_MIGRATIONS, migrateHandoffRevisions } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-handoff-revisions.js"
import { definitionIdentityMismatches } from "../../../../src/workflows/vm/definition-identity.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { buildWorkflowControlInitializedFact, workflowAggregateId } from "../../../../src/workflows/vm/session-facts.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { compilePreCutover } from "./_pre-cutover-control.js"

const temporary = temporaryDirectories()
const SESSION = "paused-session"

type RecordedHandoffs = ReadonlyMap<string, { readonly contractRevision: number; readonly fieldsSha256: string; readonly rulesSha256: string }>

/** The identity hashes the build before command citation recorded for each
 *  handoff type that carries command evidence. */
const BEFORE_COMMAND_CITATION: RecordedHandoffs = new Map([
  ["work-handoff", { contractRevision: 4, fieldsSha256: "99080537482028c5f302967da5047b69b5da446b693cd4f3bddad3138a58d4e1", rulesSha256: "268f7e652b4d9357f6f1eb20f30b6e4eca7fcbff29777c50a789fb65e83f56fd" }],
  ["review-handoff", { contractRevision: 2, fieldsSha256: "69e449cd2429dfd040da495d525ad1070fdf101674c94fa9f40b23c6752179b5", rulesSha256: "c01a8a8f488fedd7a702ffad82cb7d940af51e76f6f0b32ff7c8b5731ad0383a" }],
  ["debug-handoff", { contractRevision: 3, fieldsSha256: "5d0bc06c05ebb622ef7aa1071c32062daf66fbcef40f1e24a1502a4927447525", rulesSha256: "c01a8a8f488fedd7a702ffad82cb7d940af51e76f6f0b32ff7c8b5731ad0383a" }],
  ["qa-findings-handoff", { contractRevision: 2, fieldsSha256: "6a6ce849d747a304eee911fbe092d1c356abb204901ad1b97bac2ce869f58caa", rulesSha256: "c01a8a8f488fedd7a702ffad82cb7d940af51e76f6f0b32ff7c8b5731ad0383a" }],
  ["qa-contest-handoff", { contractRevision: 2, fieldsSha256: "3e7b7086a9fe8bd94b7ead2963b83ec126681d59ccafc22962e810b8b267df35", rulesSha256: "c01a8a8f488fedd7a702ffad82cb7d940af51e76f6f0b32ff7c8b5731ad0383a" }],
])

/** The identity hashes the build before the runtime wording recorded for each
 *  handoff type whose text named the product. */
const BEFORE_RUNTIME_WORDING: RecordedHandoffs = new Map([
  ["work-handoff", { contractRevision: 5, fieldsSha256: "c2cc741afe6335c5c2a0ec7aa1740ae287305f69460f06f5e429053a522e8452", rulesSha256: "3d082bd670526dd5e0e3c54f71557b011e432d5f96004232aa2b1835b216f8ea" }],
  ["review-handoff", { contractRevision: 3, fieldsSha256: "8f12480a83167b2dd69a7f97998485f7c02a9a026a6a75a364f25973c434381a", rulesSha256: "5d2530be054681e61f81ba9175c3e519ca018d119f5669ada2418a8a04b65bb2" }],
  ["debug-handoff", { contractRevision: 4, fieldsSha256: "b0f208e568e097723893f6a802775b66c308c35f1c7b39387524f4d1123b96d4", rulesSha256: "5d2530be054681e61f81ba9175c3e519ca018d119f5669ada2418a8a04b65bb2" }],
  ["qa-findings-handoff", { contractRevision: 3, fieldsSha256: "ecc783119ce068ab0f4c118339c7f71e23ab1c86d3285641cf206fe5490a0347", rulesSha256: "5d2530be054681e61f81ba9175c3e519ca018d119f5669ada2418a8a04b65bb2" }],
  ["qa-contest-handoff", { contractRevision: 3, fieldsSha256: "0a69d800c56970dbf06c0188b8d7f6a1792133baad28f39811cf759b43c9b9b4", rulesSha256: "5d2530be054681e61f81ba9175c3e519ca018d119f5669ada2418a8a04b65bb2" }],
  ["definition-improvement-proposal", { contractRevision: 1, fieldsSha256: "c266d33037ae5065d360c91ad53c82e628670e0ce2a0108eb94fc2d9c5242a1b", rulesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" }],
])

function migrateAll(dbFile: string): readonly (readonly string[])[] {
  return HANDOFF_REVISION_MIGRATIONS.map((migration) => migrateHandoffRevisions(dbFile, migration).adopted)
}

describe("migrateHandoffRevisions", () => {
  it("lets a workflow paused before command citation adopt every later revision and resume with no drift", () => {
    const { dbFile, compiled } = seedPausedWorkflow(BEFORE_COMMAND_CITATION, {})

    expect(migrateAll(dbFile)).toEqual([[workflowAggregateId(SESSION)], [workflowAggregateId(SESSION)]])

    expect(definitionIdentityMismatches(replay(dbFile).definitionIdentity, compiled.definitionIdentity)).toEqual([])
    expect(migrateAll(dbFile)).toEqual([[], []])
  })

  it("lets a workflow paused before the runtime wording resume with no drift", () => {
    const { dbFile, compiled } = seedPausedWorkflow(BEFORE_RUNTIME_WORDING, {})

    expect(migrateAll(dbFile)).toEqual([[], [workflowAggregateId(SESSION)]])

    expect(definitionIdentityMismatches(replay(dbFile).definitionIdentity, compiled.definitionIdentity)).toEqual([])
  })

  it("adopts nothing for a workflow recorded with the current revisions", () => {
    const { dbFile } = seedPausedWorkflow(BEFORE_RUNTIME_WORDING, { current: true })

    expect(migrateAll(dbFile)).toEqual([[], []])
  })

  it("keeps a handoff entry that differs by more than its retired revision as drift", () => {
    const { dbFile, compiled } = seedPausedWorkflow(BEFORE_COMMAND_CITATION, { driftedOn: "review-handoff" })

    migrateAll(dbFile)

    const changes = definitionIdentityMismatches(replay(dbFile).definitionIdentity, compiled.definitionIdentity)
    expect(changes.map((change) => change.component === "registry" ? change.handoffType : change.component)).toEqual(["review-handoff"])
  })
})

/** A paused workflow as an earlier build launched it: its identity records
 *  each handoff type of `recorded` at that build's revision. `driftedOn` also
 *  changes the rules of one recorded entry, which is real drift. */
function seedPausedWorkflow(recorded: RecordedHandoffs, options: { readonly current?: boolean; readonly driftedOn?: string }) {
  const repo = repoDefinitions().captureRevision()
  const handoffs = [...recorded.keys()]
  const skills = testSkillRevision([...repo.skills.skills.values(), ...handoffs.map((handoff) => testSkill(handoff))])
  const compiled = compilePreCutover(
    Object.fromEntries(handoffs.map((handoff) => [handoff, { skill: handoff, handoff }])),
    skills,
    repo.personas,
  )
  expect(compiled.definitionIdentity.handoffRegistry.map(({ name }) => name).toSorted()).toEqual(handoffs.toSorted())
  const control = {
    ...compiled,
    status: "paused" as const,
    // The root's builder counts itself, so this is the sequence before it.
    aggregateSeq: 0,
    definitionIdentity: {
      ...compiled.definitionIdentity,
      handoffRegistry: compiled.definitionIdentity.handoffRegistry.map((entry) => {
        const prior = recorded.get(entry.name)
        if (options.current || !prior) return entry
        return entry.name === options.driftedOn
          ? { ...entry, ...prior, rulesSha256: "0".repeat(64) }
          : { ...entry, ...prior }
      }),
    },
  }
  const root = buildWorkflowControlInitializedFact(control)
  const dbFile = join(temporary("handoff-revisions-"), "flywheel.sqlite")
  const store = createSqliteEventStore(dbFile)
  try {
    store.append({ aggregateId: workflowAggregateId(SESSION), sessionId: SESSION, type: root.type, version: root.version, timestamp: 1, actor: "flywheel", payload: root.payload })
  } finally {
    store.close()
  }
  return { dbFile, compiled }
}

function replay(dbFile: string) {
  const store = createSqliteEventStore(dbFile)
  try {
    return replayWorkflowControl(store.readTolerant({ aggregateId: workflowAggregateId(SESSION) }))
  } finally {
    store.close()
  }
}
