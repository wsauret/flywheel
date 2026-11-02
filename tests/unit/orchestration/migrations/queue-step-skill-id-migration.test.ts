import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { migrateQueueStepSkillId } from "../../../../src/orchestration/modules/workflows/migrations/queue-step-skill-id.js"
import { parseWorkflowQueueFact } from "../../../../src/workflows/view/view-facts.js"

const tmpRoot = path.join(os.tmpdir(), `flywheel-queue-step-skill-id-${process.pid}-${Date.now()}`)

/** One queue step as a pre-unification build recorded it: `definitionId` is the
 *  step definition id, no skill id exists yet, and the retired `selfReview`
 *  policy is still present. */
const LEGACY_STEP = {
  id: "flywheel-core:node:1:attempt:1",
  definitionId: "flywheel.plan-create",
  workflowDefinitionId: "flywheel-core",
  name: "Create Implementation Spec",
  status: "completed" as const,
  writes: ["plan"],
  resumeRevertCount: 0,
  selfReview: false,
}

const { selfReview: _retired, ...CURRENT_FIELDS } = LEGACY_STEP

/** The same step at the current version: the seat filled in from the
 *  definition id, named by `contentId`, and the retired key gone. */
const MIGRATED_STEP = { ...CURRENT_FIELDS, contentId: LEGACY_STEP.definitionId }

const LEGACY_QUEUE = {
  steps: [LEGACY_STEP],
  cursor: 0,
  status: "running",
  mutationLog: [],
}

const MUTATION = {
  timestamp: 1,
  action: "insert",
  actor: "authored",
  reason: "Workflow control inserted authored attempts",
  stepIds: [LEGACY_STEP.id],
}

interface Row {
  readonly type: string
  readonly version: number
  readonly actor: string
  readonly payload: string
}

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("migrateQueueStepSkillId", () => {
  it("gives a recorded queue step the skill id its definition id already named", () => {
    const dbFile = seed([{ type: "queue.created", payload: { queue: LEGACY_QUEUE } }])
    expect(() => parseFact(readRows(dbFile)[0])).toThrow("unknown fact queue.created@4")

    expect(migrateQueueStepSkillId(dbFile)).toEqual({ repaired: 1 })

    const fact = parseFact(readRows(dbFile)[0])
    if (fact.type !== "queue.created" || fact.version !== 9) throw new Error("Migrated fact is not a version-9 queue creation")
    expect(readRows(dbFile)[0]?.version).toBe(9)
    expect(fact.payload.queue.steps).toEqual([MIGRATED_STEP])
  })

  it("keeps the recorded skill id of a row written after the member was added", () => {
    const recorded = { ...LEGACY_STEP, definitionId: "plan-create", skillId: "flywheel.plan-create" }
    const dbFile = seed([{ type: "queue.created", payload: { queue: { ...LEGACY_QUEUE, steps: [recorded] } } }])

    expect(migrateQueueStepSkillId(dbFile)).toEqual({ repaired: 1 })

    const fact = parseFact(readRows(dbFile)[0])
    if (fact.type !== "queue.created" || fact.version !== 9) throw new Error("Migrated fact is not a version-9 queue creation")
    expect(readRows(dbFile)[0]?.version).toBe(9)
    expect(fact.payload.queue.steps).toEqual([{ ...CURRENT_FIELDS, definitionId: "plan-create", contentId: "flywheel.plan-create" }])
  })

  it("migrates the steps a mutation inserted", () => {
    const dbFile = seed([
      { type: "queue.created", payload: { queue: LEGACY_QUEUE } },
      { type: "queue.mutated", payload: { mutation: MUTATION, insertedSteps: [LEGACY_STEP], insertIndex: 0 } },
      { type: "queue.mutated", payload: { mutation: { ...MUTATION, action: "status-change" } } },
    ])

    expect(migrateQueueStepSkillId(dbFile)).toEqual({ repaired: 3 })

    const rows = readRows(dbFile)
    expect(rows.map(({ version }) => version)).toEqual([9, 9, 9])
    const inserted = parseFact(rows[1])
    if (inserted.type !== "queue.mutated" || inserted.version !== 9) throw new Error("Migrated fact is not a version-9 queue mutation")
    expect(inserted.payload.insertedSteps).toEqual([MIGRATED_STEP])
    expect(JSON.parse(rows[2]?.payload ?? "{}")).toEqual({ mutation: { ...MUTATION, action: "status-change" } })
  })

  it("is a no-op on a second run", () => {
    const dbFile = seed([
      { type: "queue.created", payload: { queue: LEGACY_QUEUE } },
      { type: "queue.mutated", payload: { mutation: MUTATION, insertedSteps: [LEGACY_STEP], insertIndex: 0 } },
    ])
    migrateQueueStepSkillId(dbFile)
    const migrated = readRows(dbFile)

    expect(migrateQueueStepSkillId(dbFile)).toEqual({ repaired: 0 })
    expect(readRows(dbFile)).toEqual(migrated)
  })

  it("rolls back every row when one recorded step names no definition", () => {
    const { definitionId: _absent, ...withoutDefinition } = LEGACY_STEP
    const dbFile = seed([
      { type: "queue.created", payload: { queue: LEGACY_QUEUE } },
      { type: "queue.mutated", payload: { mutation: MUTATION, insertedSteps: [withoutDefinition], insertIndex: 0 } },
    ])
    const staged = readRows(dbFile)

    expect(() => migrateQueueStepSkillId(dbFile)).toThrow(/no definition id/)
    expect(readRows(dbFile)).toEqual(staged)
  })
})

function parseFact(row: Row | undefined) {
  if (!row) throw new Error("Test fixture recorded no queue fact")
  return parseWorkflowQueueFact({
    type: row.type,
    version: row.version,
    actor: row.actor,
    payload: JSON.parse(row.payload),
  })
}

function seed(facts: readonly { readonly type: string; readonly payload: EventPayload }[]): string {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  const dbFile = path.join(dir, "flywheel.sqlite")
  const store = createSqliteEventStore(dbFile)
  try {
    for (const [index, fact] of facts.entries()) {
      store.append({
        aggregateId: "workflow:legacy-session",
        type: fact.type,
        version: 4,
        timestamp: index + 1,
        actor: "flywheel",
        sessionId: "legacy-session",
        payload: fact.payload,
      })
    }
  } finally {
    store.close()
  }
  return dbFile
}

function readRows(dbFile: string): Row[] {
  const db = new Database(dbFile)
  try {
    return db.query<Row, []>(
      "select type, version, actor, payload from event where type like 'queue.%' order by position",
    ).all()
  } finally {
    db.close()
  }
}
