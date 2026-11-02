import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { migrateLoopBodyRows } from "../../../../src/orchestration/modules/workflows/migrations/loop-body-rows.js"
import { parseDefinitionProvenanceFact } from "../../../../src/workflows/definition-provenance-facts.js"
import { parseWorkflowQueueFact } from "../../../../src/workflows/view/view-facts.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const temporary = temporaryDirectories()
const SESSION = "paused-session"

const STEP = {
  id: "flow:node:1:attempt:1",
  definitionId: "review",
  contentId: "fly.review",
  workflowDefinitionId: "flow",
  name: "Review",
  status: "completed" as const,
  writes: ["review"],
  resumeRevertCount: 0,
}

const LOOP = { field: "findings", maxIterations: 3, detectStuck: true, iteration: 1 }

/** A while step row as the build before loop chains recorded it: the body
 *  names its steps as `do` and an optional `then`. */
const RECORDED_PAIR = { ...STEP, loop: { ...LOOP, body: { do: { step: "review" }, then: { step: "fix" } } } }
const RECORDED_SINGLE = { ...STEP, id: "flow:node:2:attempt:1", loop: { ...LOOP, body: { do: { step: "review" } } } }

/** The same rows at the current version: the body is one list in run order. */
const CURRENT_PAIR = { ...STEP, loop: { ...LOOP, body: [{ step: "review" }, { step: "fix" }] as const } }
const CURRENT_SINGLE = { ...STEP, id: RECORDED_SINGLE.id, loop: { ...LOOP, body: [{ step: "review" }] as const } }

const PLAIN_STEP = { ...STEP, id: "flow:node:3:attempt:1", definitionId: "ship", contentId: "fly.ship", name: "Ship", status: "pending" as const, writes: [] }

const MUTATION = { timestamp: 1, action: "insert", actor: "authored", reason: "insert", stepIds: [RECORDED_SINGLE.id] }

interface SeededRow {
  readonly type: string
  readonly version: number
  readonly payload: EventPayload
}

describe("migrateLoopBodyRows", () => {
  it("records every while body as one ordered list and advances each family to its current version", () => {
    const dbFile = seed([
      { type: "queue.created", version: 8, payload: { queue: { steps: [RECORDED_PAIR, PLAIN_STEP], cursor: 1, status: "paused", mutationLog: [] } } },
      { type: "queue.mutated", version: 8, payload: { mutation: MUTATION, insertedSteps: [RECORDED_SINGLE], insertIndex: 1 } },
      { type: "queue.mutated", version: 8, payload: { mutation: { ...MUTATION, action: "status-change" } } },
      { type: "workflow.compiled", version: 7, payload: compiledPayload([RECORDED_PAIR, PLAIN_STEP]) },
    ])

    expect(migrateLoopBodyRows(dbFile)).toEqual({ repaired: 4 })

    const rows = readRows(dbFile)
    expect(rows.map(({ type, version }) => `${type}@${version}`)).toEqual([
      "queue.created@9", "queue.mutated@9", "queue.mutated@9", "workflow.compiled@8",
    ])
    const [created, inserted, statusChange, compiled] = rows
    expect(parseWorkflowQueueFact(fact(created)).payload).toEqual({ queue: { steps: [CURRENT_PAIR, PLAIN_STEP], cursor: 1, status: "paused", mutationLog: [] } })
    expect(parseWorkflowQueueFact(fact(inserted)).payload).toEqual({ mutation: MUTATION, insertedSteps: [CURRENT_SINGLE], insertIndex: 1 })
    expect(JSON.parse(statusChange?.payload ?? "null")).toEqual({ mutation: { ...MUTATION, action: "status-change" } })
    expect(parseDefinitionProvenanceFact(fact(compiled)).payload).toEqual(compiledPayload([CURRENT_PAIR, PLAIN_STEP]))
  })

  it("leaves a row it cannot convert unchanged and still converts the rest", () => {
    const refused = { queue: { steps: [{ ...STEP, loop: { ...LOOP, body: "review" } }], cursor: 0, status: "paused", mutationLog: [] } }
    const dbFile = seed([
      { type: "queue.created", version: 8, payload: refused },
      { type: "queue.created", version: 8, payload: { queue: { steps: [RECORDED_PAIR], cursor: 0, status: "paused", mutationLog: [] } } },
    ])

    expect(migrateLoopBodyRows(dbFile)).toEqual({ repaired: 1 })

    const [kept, converted] = readRows(dbFile)
    expect(kept?.version).toBe(8)
    expect(JSON.parse(kept?.payload ?? "null")).toEqual(refused)
    expect(converted?.version).toBe(9)
  })

  it("is a no-op on a second run", () => {
    const dbFile = seed([
      { type: "queue.created", version: 8, payload: { queue: { steps: [RECORDED_PAIR], cursor: 0, status: "paused", mutationLog: [] } } },
      { type: "workflow.compiled", version: 7, payload: compiledPayload([RECORDED_SINGLE]) },
    ])
    migrateLoopBodyRows(dbFile)
    const migrated = readRows(dbFile)

    expect(migrateLoopBodyRows(dbFile)).toEqual({ repaired: 0 })
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
  const dbFile = join(temporary("flywheel-loop-body-rows-"), "flywheel.sqlite")
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
