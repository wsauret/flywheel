import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { migrateRetiredChildAskUser } from "../../../../src/orchestration/modules/workflows/migrations/retired-child-ask-user.js"
import { migrateRetiredSelfReview } from "../../../../src/orchestration/modules/workflows/migrations/retired-self-review.js"
import { migrateWorkflowDefinitionIdentityRetiredBlocked } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-retired-blocked.js"
import { migrateWorkflowDefinitionIdentityRetiredChildAskUser } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-retired-child-ask-user.js"
import { migrateWorkflowDefinitionIdentityRetiredSelfReview } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-retired-self-review.js"
import { hashDefinition } from "../../../../src/workflows/definition-hash.js"
import { parseDefinitionProvenanceFact } from "../../../../src/workflows/definition-provenance-facts.js"
import { parseWorkflowQueueFact } from "../../../../src/workflows/view/view-facts.js"
import { definitionIdentityMismatches } from "../../../../src/workflows/vm/definition-identity.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { buildWorkflowControlInitializedFact, workflowAggregateId } from "../../../../src/workflows/vm/session-facts.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { compilePreCutover, preCutoverBindingRecord } from "./_pre-cutover-control.js"

const temporary = temporaryDirectories()
const SESSION = "paused-session"

/** A step's tool scope as the build before the retirement recorded it. */
const SCOPE = { read: true, bash: false, search: false, list: false, write: false, edit: false, subagent: false }
const RECORDED_SCOPE = { ...SCOPE, ask_user: true }

/** One queue step as the build before the retirement recorded it. */
const STEP = {
  id: "flow:node:1:attempt:1",
  definitionId: "work",
  skillId: "work",
  workflowDefinitionId: "flow",
  name: "Work",
  status: "completed",
  writes: [],
  resumeRevertCount: 0,
  toolScoping: SCOPE,
}
const RECORDED_STEP = { ...STEP, toolScoping: RECORDED_SCOPE }

/** The same step at the current queue version, which names the seat by
 *  `contentId`. */
const { skillId: recordedSeat, ...STEP_FIELDS } = STEP
const CURRENT_STEP = { ...STEP_FIELDS, contentId: recordedSeat }

/** The spec handoff rules of revision 5, as the build before the retirement
 *  recorded them in a workflow's identity. */
const SPEC_REVISION_5_RULES = [
  "Resolve newly discovered uncertainty inside the current spec step through repository inspection, focused research, or experiments before handing work to an implementer.",
  "Use ask_user only as a rare fallback for a narrow user-owned choice that repository evidence cannot answer and that does not invalidate the approved design.",
  "Use outcome.state: blocked only when evidence fundamentally contradicts the approved design and the design must be rewritten in chat. Never use a blocker for ordinary implementation uncertainty.",
  "A completed spec omits outcome and contains no open questions, discovery phases, experiments, spikes, proof-of-concept tasks, or choices deferred to the implementer.",
]

/** The spec handoff field hash of revisions 5 and 6, which share their fields. */
const SPEC_REVISION_5_FIELDS_SHA256 = "48df21b9fb7401a3210dcef8faa320e97bb56d2f6c61fb9b6ab08943f675946b"

interface SeededRow {
  readonly type: string
  readonly version: number
  readonly payload: EventPayload
}

describe("migrateRetiredChildAskUser", () => {
  it("drops the retired scope from every family that recorded it and advances each to its current version", () => {
    const dbFile = seed([
      { type: "queue.created", version: 6, payload: { queue: { steps: [RECORDED_STEP], cursor: 0, status: "paused", mutationLog: [] } } },
      { type: "queue.mutated", version: 6, payload: { mutation: { timestamp: 1, action: "insert", actor: "authored", reason: "insert", stepIds: [STEP.id] }, insertedSteps: [RECORDED_STEP], insertIndex: 0 } },
      { type: "workflow.compiled", version: 4, payload: compiledPayload([RECORDED_STEP]) },
      { type: "definition.loaded", version: 5, payload: { kind: "workflow", id: "flow", definition: workflowRecord({ skill: "work", writes: [], toolScoping: RECORDED_SCOPE }) } },
      { type: "definition.loaded", version: 5, payload: { kind: "binding", id: "work", definition: { bindingId: "work", skill: "work", writes: [], toolScoping: RECORDED_SCOPE } } },
    ])

    expect(migrateRetiredChildAskUser(dbFile)).toEqual({ repaired: 5 })

    const rows = readRows(dbFile)
    expect(rows.map(({ type, version }) => `${type}@${version}`)).toEqual([
      "queue.created@9", "queue.mutated@9", "workflow.compiled@5", "definition.loaded@6", "definition.loaded@6",
    ])
    expect(rows.some(({ payload }) => payload.includes("ask_user"))).toBe(false)
    const [created, mutated, compiled, workflow, binding] = rows
    expect(parseWorkflowQueueFact(fact(created)).payload).toEqual({ queue: { steps: [CURRENT_STEP], cursor: 0, status: "paused", mutationLog: [] } })
    expect(parseWorkflowQueueFact(fact(mutated)).payload).toMatchObject({ insertedSteps: [CURRENT_STEP] })
    expect(parseDefinitionProvenanceFact(fact(compiled)).payload).toMatchObject({ steps: [STEP] })
    expect(parseDefinitionProvenanceFact(fact(workflow)).payload).toMatchObject({ definition: { bindings: { work: { toolScoping: SCOPE } } } })
    expect(parseDefinitionProvenanceFact(fact(binding)).payload).toEqual({ kind: "binding", id: "work", definition: { bindingId: "work", skill: "work", writes: [], toolScoping: SCOPE } })
  })

  it("brings a row that also states the earlier retired key to the current version through the earlier pass", () => {
    const dbFile = seed([{ type: "queue.created", version: 5, payload: { queue: { steps: [{ ...RECORDED_STEP, selfReview: true }], cursor: 0, status: "paused", mutationLog: [] } } }])

    migrateRetiredSelfReview(dbFile)
    migrateRetiredChildAskUser(dbFile)

    const [created] = readRows(dbFile)
    expect(created?.version).toBe(9)
    expect(parseWorkflowQueueFact(fact(created)).payload).toEqual({ queue: { steps: [CURRENT_STEP], cursor: 0, status: "paused", mutationLog: [] } })
  })

  it("is a no-op on a second run", () => {
    const dbFile = seed([{ type: "queue.created", version: 6, payload: { queue: { steps: [RECORDED_STEP], cursor: 0, status: "paused", mutationLog: [] } } }])
    migrateRetiredChildAskUser(dbFile)
    const migrated = readRows(dbFile)

    expect(migrateRetiredChildAskUser(dbFile)).toEqual({ repaired: 0 })
    expect(readRows(dbFile)).toEqual(migrated)
  })
})

describe("migrateWorkflowDefinitionIdentityRetiredChildAskUser", () => {
  it("lets a paused workflow with the old scope and spec handoff revision resume with no drift, and keeps real drift", () => {
    const { dbFile, compiled } = seedPausedWorkflow({ driftedOn: "follow" })

    expect(migrateWorkflowDefinitionIdentityRetiredChildAskUser(dbFile)).toEqual({ adopted: [workflowAggregateId(SESSION)] })
    // The spec handoff revision 6 it adopts is itself retired; the next pass
    // in the chain carries it to the current revision.
    expect(migrateWorkflowDefinitionIdentityRetiredBlocked(dbFile)).toEqual({ adopted: [workflowAggregateId(SESSION)] })

    const changes = definitionIdentityMismatches(replay(dbFile).definitionIdentity, compiled.definitionIdentity)
    expect(changes.map((change) => change.component === "binding" ? change.bindingId : change.component)).toEqual(["follow"])
    expect(migrateWorkflowDefinitionIdentityRetiredChildAskUser(dbFile)).toEqual({ adopted: [] })
  })

  it("adopts hashes that also named the earlier retired self-review key", () => {
    const { dbFile, compiled } = seedPausedWorkflow({ withSelfReview: true })

    expect(migrateWorkflowDefinitionIdentityRetiredSelfReview(dbFile)).toEqual({ adopted: [] })
    expect(migrateWorkflowDefinitionIdentityRetiredChildAskUser(dbFile)).toEqual({ adopted: [workflowAggregateId(SESSION)] })
    migrateWorkflowDefinitionIdentityRetiredBlocked(dbFile)

    expect(definitionIdentityMismatches(replay(dbFile).definitionIdentity, compiled.definitionIdentity)).toEqual([])
  })

  it("adopts nothing for a workflow recorded after the retirement", () => {
    const { dbFile } = seedPausedWorkflow({ current: true })

    expect(migrateWorkflowDefinitionIdentityRetiredChildAskUser(dbFile)).toEqual({ adopted: [] })
    expect(readRows(dbFile).some(({ type }) => type === "workflow.definition_identity.migrated")).toBe(false)
  })
})

/** A paused workflow as the build before the retirement launched it, after
 *  the fact pass removed the key from its binding snapshots: the snapshots are
 *  current, but the recorded identity still hashes `work` with the key and
 *  records the spec handoff at revision 5, and `driftedOn` carries an
 *  unrelated change. */
function seedPausedWorkflow(options: { readonly driftedOn?: string; readonly withSelfReview?: boolean; readonly current?: boolean }) {
  const skills = testSkillRevision([testSkill("work"), testSkill("follow")])
  const authored = {
    work: { skill: "work", writes: [], toolScoping: SCOPE, handoff: "spec-handoff" },
    follow: { skill: "follow", writes: [] },
  }
  const compiled = compilePreCutover(authored, skills, new Map())
  const records = new Map(Object.entries(authored).map(([id, binding]) => [id, preCutoverBindingRecord(id, binding)]))
  const recordedHash = (bindingId: string, sha256: string): string => {
    const record = records.get(bindingId)
    if (options.current) return sha256
    if (bindingId === "work") return hashDefinition({ ...record, ...(options.withSelfReview ? { selfReview: false } : {}), toolScoping: RECORDED_SCOPE }).sha256
    if (bindingId === options.driftedOn) return hashDefinition({ ...record, name: "Renamed since launch" }).sha256
    return sha256
  }
  const snapshots: SeededRow[] = [...records].map(([id, definition]) => ({ type: "definition.loaded", version: 6, payload: { kind: "binding", id, definition } }))
  const control = {
    ...compiled,
    status: "paused" as const,
    // The root's builder counts itself, so this is the sequence before it.
    aggregateSeq: snapshots.length,
    definitionIdentity: {
      ...compiled.definitionIdentity,
      bindings: compiled.definitionIdentity.bindings.map((binding) => ({ ...binding, sha256: recordedHash(binding.bindingId, binding.sha256) })),
      handoffRegistry: compiled.definitionIdentity.handoffRegistry.map((entry) => options.current || entry.name !== "spec-handoff"
        ? entry
        : { ...entry, contractRevision: 5, fieldsSha256: SPEC_REVISION_5_FIELDS_SHA256, rulesSha256: hashDefinition(SPEC_REVISION_5_RULES).sha256 }),
    },
  }
  const root = buildWorkflowControlInitializedFact(control)
  const dbFile = seed([...snapshots, { type: root.type, version: root.version, payload: root.payload }])
  return { dbFile, compiled }
}

function compiledPayload(steps: readonly unknown[]) {
  return {
    workflowDefinitionId: "flow",
    workflowName: "Flow",
    userRequestArtifactId: "user-request",
    userRequestSha256: "a".repeat(64),
    bindingIds: ["work"],
    skillIds: ["work"],
    steps,
  }
}

function workflowRecord(binding: { readonly [key: string]: unknown }) {
  return { id: "flow", name: "Flow", bindings: { work: binding }, steps: [{ step: "work" }] }
}

function seed(rows: readonly SeededRow[]): string {
  const dbFile = join(temporary("flywheel-retired-child-ask-user-"), "flywheel.sqlite")
  const store = createSqliteEventStore(dbFile)
  try {
    for (const [index, row] of rows.entries()) {
      store.append({
        aggregateId: workflowAggregateId(SESSION),
        sessionId: SESSION,
        type: row.type,
        version: row.version,
        timestamp: index + 1,
        actor: "flywheel",
        payload: row.payload,
      })
    }
  } finally {
    store.close()
  }
  return dbFile
}

function replay(dbFile: string) {
  const store = createSqliteEventStore(dbFile)
  try {
    return replayWorkflowControl(store.readTolerant({ aggregateId: workflowAggregateId(SESSION) }))
  } finally {
    store.close()
  }
}

interface Row {
  readonly type: string
  readonly version: number
  readonly payload: string
}

function readRows(dbFile: string): readonly Row[] {
  const db = new Database(dbFile)
  try {
    return db.query<Row, []>(
      "select type, version, payload from event where aggregate_id != 'workspace' order by position",
    ).all()
  } finally {
    db.close()
  }
}

function fact(row: Row | undefined) {
  if (!row) throw new Error("Test expected a migrated row")
  return { type: row.type, version: row.version, actor: "flywheel", payload: JSON.parse(row.payload) }
}
