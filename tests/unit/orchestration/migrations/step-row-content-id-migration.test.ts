import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { migrateStepRowContentId } from "../../../../src/orchestration/modules/workflows/migrations/step-row-content-id.js"
import { parseDefinitionProvenanceFact } from "../../../../src/workflows/definition-provenance-facts.js"
import { parseWorkflowQueueFact } from "../../../../src/workflows/view/view-facts.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const temporary = temporaryDirectories()
const SESSION = "paused-session"

/** One step row as the build before the rename recorded it: the seat is
 *  `skillId`. */
const RECORDED_STEP = {
  id: "flow:node:1:attempt:1",
  definitionId: "implement",
  skillId: "fly.implement",
  workflowDefinitionId: "flow",
  name: "Implement",
  status: "completed" as const,
  writes: ["implementation"],
  resumeRevertCount: 0,
}

/** The same row at the current version: the value moves to `contentId` byte for
 *  byte. */
const { skillId: recordedSeat, ...STEP_FIELDS } = RECORDED_STEP
const CURRENT_STEP = { ...STEP_FIELDS, contentId: recordedSeat }

/** An inserted while step row also records its loop body in the `do` and
 *  `then` form of its build, which the loop-body-rows rebuild that this pass
 *  hands its rows to makes one list. */
const INSERTED_STEP = {
  ...RECORDED_STEP,
  id: "flow:node:2:attempt:1",
  definitionId: "verify",
  skillId: "debug.verify",
  name: "Verify",
  status: "pending",
  writes: [],
  loop: { field: "findings", body: { do: { step: "verify" }, then: { step: "implement" } }, maxIterations: 2, detectStuck: false, iteration: 1 },
}

const RECORDED_PLANNED = { id: "flow:node:2:attempt:1:planned:1", after: "flow:node:2:attempt:1", definitionId: "review", skillId: "fly.review", name: "Review", status: "conditional" }

const MUTATION = { timestamp: 1, action: "insert", actor: "authored", reason: "insert", stepIds: [INSERTED_STEP.id] }

interface SeededRow {
  readonly type: string
  readonly version: number
  readonly payload: EventPayload
}

describe("migrateStepRowContentId", () => {
  it("names the seat of every recorded step row by its content id and advances each family to its current version", () => {
    const dbFile = seed([
      { type: "queue.created", version: 7, payload: { queue: { steps: [RECORDED_STEP], cursor: 1, status: "paused", mutationLog: [] } } },
      { type: "queue.mutated", version: 7, payload: { mutation: MUTATION, insertedSteps: [INSERTED_STEP], insertIndex: 1 } },
      { type: "queue.mutated", version: 7, payload: { mutation: { ...MUTATION, action: "status-change" } } },
      { type: "queue.plan.changed", version: 1, payload: { plan: { conditionalStepIds: [], steps: [RECORDED_PLANNED] } } },
      { type: "workflow.compiled", version: 6, payload: compiledPayload([RECORDED_STEP]) },
    ])

    expect(migrateStepRowContentId(dbFile)).toEqual({ repaired: 5 })

    const rows = readRows(dbFile)
    expect(rows.map(({ type, version }) => `${type}@${version}`)).toEqual([
      "queue.created@9", "queue.mutated@9", "queue.mutated@9", "queue.plan.changed@2", "workflow.compiled@8",
    ])
    expect(rows.some(({ payload }) => payload.includes(`"skillId"`))).toBe(false)
    const [created, inserted, statusChange, plan, compiled] = rows
    expect(parseWorkflowQueueFact(fact(created)).payload).toEqual({ queue: { steps: [CURRENT_STEP], cursor: 1, status: "paused", mutationLog: [] } })
    expect(parseWorkflowQueueFact(fact(inserted)).payload).toMatchObject({ insertedSteps: [{
      ...CURRENT_STEP,
      id: INSERTED_STEP.id,
      definitionId: "verify",
      contentId: "debug.verify",
      name: "Verify",
      status: "pending",
      writes: [],
      loop: { ...INSERTED_STEP.loop, body: [{ step: "verify" }, { step: "implement" }] },
    }] })
    expect(JSON.parse(statusChange?.payload ?? "null")).toEqual({ mutation: { ...MUTATION, action: "status-change" } })
    const { skillId: plannedSeat, ...plannedFields } = RECORDED_PLANNED
    expect(parseWorkflowQueueFact(fact(plan)).payload).toEqual({ plan: { conditionalStepIds: [], steps: [{ ...plannedFields, contentId: plannedSeat }] } })
    expect(parseDefinitionProvenanceFact(fact(compiled)).payload).toEqual(compiledPayload([CURRENT_STEP]))
  })

  it("leaves a row it cannot convert unchanged and still converts the rest", () => {
    const { skillId: _absent, ...withoutSeat } = RECORDED_STEP
    const refused = { queue: { steps: [withoutSeat], cursor: 0, status: "paused", mutationLog: [] } }
    const dbFile = seed([
      { type: "queue.created", version: 7, payload: refused },
      { type: "queue.created", version: 7, payload: { queue: { steps: [RECORDED_STEP], cursor: 0, status: "paused", mutationLog: [] } } },
    ])

    expect(migrateStepRowContentId(dbFile)).toEqual({ repaired: 1 })

    const [kept, converted] = readRows(dbFile)
    expect(kept?.version).toBe(7)
    expect(JSON.parse(kept?.payload ?? "null")).toEqual(refused)
    expect(converted?.version).toBe(9)
  })

  it("is a no-op on a second run", () => {
    const dbFile = seed([
      { type: "queue.created", version: 7, payload: { queue: { steps: [RECORDED_STEP], cursor: 0, status: "paused", mutationLog: [] } } },
      { type: "workflow.compiled", version: 6, payload: compiledPayload([RECORDED_STEP]) },
    ])
    migrateStepRowContentId(dbFile)
    const migrated = readRows(dbFile)

    expect(migrateStepRowContentId(dbFile)).toEqual({ repaired: 0 })
    expect(readRows(dbFile)).toEqual(migrated)
  })
})

function compiledPayload<Step>(steps: readonly Step[]) {
  return {
    workflowDefinitionId: "flow",
    workflowName: "Flow",
    userRequestArtifactId: "user-request" as const,
    userRequestSha256: "a".repeat(64),
    stepIds: ["implement"],
    skillIds: ["implementation"],
    steps,
  }
}

function seed(rows: readonly SeededRow[]): string {
  const dbFile = join(temporary("flywheel-step-row-content-id-"), "flywheel.sqlite")
  const store = createSqliteEventStore(dbFile)
  try {
    for (const [index, row] of rows.entries()) {
      store.append({
        aggregateId: `workflow:${SESSION}`,
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
