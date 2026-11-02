import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { migrateRetiredSelfReview } from "../../../../src/orchestration/modules/workflows/migrations/retired-self-review.js"
import { migrateWorkflowDefinitionIdentityRetiredSelfReview } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-retired-self-review.js"
import { hashDefinition } from "../../../../src/workflows/definition-hash.js"
import { parseDefinitionProvenanceFact } from "../../../../src/workflows/definition-provenance-facts.js"
import { parseWorkflowQueueFact } from "../../../../src/workflows/view/view-facts.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { isLegacyDefinitionIdentity } from "../../../../src/workflows/vm/definition-identity.js"
import { buildWorkflowControlInitializedFact, workflowAggregateId } from "../../../../src/workflows/vm/session-facts.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { compilePreCutover, preCutoverBindingRecord } from "./_pre-cutover-control.js"

const temporary = temporaryDirectories()
const SESSION = "paused-session"

/** One queue step as the build before the removal recorded it. */
const STEP = {
  id: "flow:node:1:attempt:1",
  definitionId: "work",
  skillId: "work",
  workflowDefinitionId: "flow",
  name: "Work",
  status: "completed",
  writes: [],
  resumeRevertCount: 0,
}

/** The same step at the current queue version, which names the seat by
 *  `contentId`. */
const { skillId: recordedSeat, ...STEP_FIELDS } = STEP
const CURRENT_STEP = { ...STEP_FIELDS, contentId: recordedSeat }

interface SeededRow {
  /** The workflow aggregate of the seeded session unless named. */
  readonly aggregateId?: string
  readonly type: string
  readonly version: number
  readonly payload: EventPayload
}

describe("migrateRetiredSelfReview", () => {
  it("drops the retired key from every family that recorded it and advances each to its current version", () => {
    const dbFile = seed([
      { type: "queue.created", version: 5, payload: { queue: { steps: [{ ...STEP, selfReview: false }], cursor: 0, status: "paused", mutationLog: [] } } },
      { type: "queue.mutated", version: 5, payload: { mutation: { timestamp: 1, action: "insert", actor: "authored", reason: "insert", stepIds: [STEP.id] }, insertedSteps: [{ ...STEP, selfReview: true }], insertIndex: 0 } },
      { type: "workflow.compiled", version: 3, payload: compiledPayload([{ ...STEP, selfReview: true }]) },
      { type: "definition.loaded", version: 4, payload: { kind: "workflow", id: "flow", definition: workflowRecord({ skill: "work", writes: [], selfReview: true }) } },
      { type: "definition.loaded", version: 4, payload: { kind: "binding", id: "work", definition: { bindingId: "work", skill: "work", writes: [], selfReview: false } } },
    ])

    expect(migrateRetiredSelfReview(dbFile)).toEqual({ repaired: 5 })

    const rows = readRows(dbFile)
    expect(rows.map(({ type, version }) => `${type}@${version}`)).toEqual([
      "queue.created@9", "queue.mutated@9", "workflow.compiled@5", "definition.loaded@6", "definition.loaded@6",
    ])
    expect(rows.some(({ payload }) => payload.includes("selfReview"))).toBe(false)
    const [created, mutated, compiled, workflow, binding] = rows
    expect(parseWorkflowQueueFact(fact(created)).payload).toEqual({ queue: { steps: [CURRENT_STEP], cursor: 0, status: "paused", mutationLog: [] } })
    expect(parseWorkflowQueueFact(fact(mutated)).payload).toMatchObject({ insertedSteps: [CURRENT_STEP] })
    expect(parseDefinitionProvenanceFact(fact(compiled)).payload).toMatchObject({ steps: [STEP] })
    expect(parseDefinitionProvenanceFact(fact(workflow)).payload).toMatchObject({ definition: { bindings: { work: { skill: "work", writes: [] } } } })
    expect(parseDefinitionProvenanceFact(fact(binding)).payload).toEqual({ kind: "binding", id: "work", definition: { bindingId: "work", skill: "work", writes: [] } })
  })

  it("leaves a row the strict reader already refused unchanged and still converts the rest", () => {
    // A binding snapshot is loose history now, so a queue step, which current
    // readers still parse strictly, carries the unreadable key.
    const refused = { queue: { steps: [{ ...STEP, selfReview: true, toolScoping: { read: true, replace: false } }], cursor: 0, status: "paused", mutationLog: [] } }
    const dbFile = seed([
      { type: "queue.created", version: 5, payload: refused },
      { type: "queue.created", version: 5, payload: { queue: { steps: [{ ...STEP, selfReview: false }], cursor: 0, status: "paused", mutationLog: [] } } },
    ])

    expect(migrateRetiredSelfReview(dbFile)).toEqual({ repaired: 1 })

    const [kept, converted] = readRows(dbFile)
    expect(kept?.version).toBe(5)
    expect(JSON.parse(kept?.payload ?? "null")).toEqual(refused)
    expect(converted?.version).toBe(9)
  })

  it("converts a binding snapshot that an earlier run of the pass refused and left below its watermark", () => {
    // Builds of 2026-10-03 refused binding snapshots like this one, kept them
    // at version 4, and recorded the first pass id's watermark above them.
    const binding = {
      bindingId: "work",
      skill: "work",
      handoff: "work-handoff",
      writes: [],
      selfReview: true,
      toolScoping: { read: true, bash: false, search: true, list: true, write: false, edit: false, replace: false, subagent: true, ask_user: true },
    }
    const dbFile = seed([
      { type: "definition.loaded", version: 4, payload: { kind: "binding", id: "work", definition: binding } },
      { aggregateId: "workspace", type: "workspace.facts.checked", version: 1, payload: { migrationId: "retired-self-review-v1" } },
    ])

    expect(migrateRetiredSelfReview(dbFile)).toEqual({ repaired: 1 })

    const [converted] = readRows(dbFile)
    expect(converted?.version).toBe(6)
    expect(converted?.payload.includes("selfReview")).toBe(false)
    expect(parseDefinitionProvenanceFact(fact(converted)).type).toBe("definition.loaded")
  })

  it("is a no-op on a second run", () => {
    const dbFile = seed([{ type: "queue.created", version: 5, payload: { queue: { steps: [{ ...STEP, selfReview: false }], cursor: 0, status: "paused", mutationLog: [] } } }])
    migrateRetiredSelfReview(dbFile)
    const migrated = readRows(dbFile)

    expect(migrateRetiredSelfReview(dbFile)).toEqual({ repaired: 0 })
    expect(readRows(dbFile)).toEqual(migrated)
  })
})

describe("migrateWorkflowDefinitionIdentityRetiredSelfReview", () => {
  it("lets a paused workflow adopt binding hashes without the retired key and keeps real drift", () => {
    const { dbFile, compiled } = seedPausedWorkflow({ retiredKeyOn: "work", driftedOn: "follow" })

    expect(migrateWorkflowDefinitionIdentityRetiredSelfReview(dbFile)).toEqual({ adopted: [workflowAggregateId(SESSION)] })

    const replayed = replay(dbFile).definitionIdentity
    if (!isLegacyDefinitionIdentity(replayed)) throw new Error("The pass adopts a pre-cutover identity")
    const adopted = replayed.bindings
    const current = new Map(compiled.definitionIdentity.bindings.map(({ bindingId, sha256 }) => [bindingId, sha256]))
    expect(adopted.find(({ bindingId }) => bindingId === "work")?.sha256).toBe(current.get("work"))
    expect(adopted.find(({ bindingId }) => bindingId === "follow")?.sha256).not.toBe(current.get("follow"))
    expect(migrateWorkflowDefinitionIdentityRetiredSelfReview(dbFile)).toEqual({ adopted: [] })
  })

  it("adopts nothing for a workflow whose recorded hashes never named the retired key", () => {
    const { dbFile } = seedPausedWorkflow({})

    expect(migrateWorkflowDefinitionIdentityRetiredSelfReview(dbFile)).toEqual({ adopted: [] })
    expect(readRows(dbFile).some(({ type }) => type === "workflow.definition_identity.migrated")).toBe(false)
  })
})

/** A paused workflow as the build before the removal launched it, after the
 *  fact pass removed the key from its binding snapshots: the snapshots are
 *  current, but the recorded identity still hashes `retiredKeyOn` with the key
 *  and `driftedOn` with an unrelated change. */
function seedPausedWorkflow(options: { readonly retiredKeyOn?: string; readonly driftedOn?: string }) {
  const skills = testSkillRevision([testSkill("work"), testSkill("follow")])
  const authored = { work: { skill: "work", writes: [] }, follow: { skill: "follow", writes: [] } }
  const compiled = compilePreCutover(authored, skills, new Map())
  const records = new Map(Object.entries(authored).map(([id, binding]) => [id, preCutoverBindingRecord(id, binding)]))
  const recordedHash = (bindingId: string, sha256: string): string => {
    const record = records.get(bindingId)
    if (bindingId === options.retiredKeyOn) return hashDefinition({ ...record, selfReview: false }).sha256
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
  const dbFile = join(temporary("flywheel-retired-self-review-"), "flywheel.sqlite")
  const store = createSqliteEventStore(dbFile)
  try {
    for (const [index, row] of rows.entries()) {
      store.append({
        aggregateId: row.aggregateId ?? workflowAggregateId(SESSION),
        sessionId: row.aggregateId ?? SESSION,
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
