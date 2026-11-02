import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { migrateDefinitionLoadedHandoffFilename } from "../../../../src/orchestration/modules/workflows/migrations/definition-loaded-handoff-filename.js"
import { parseDefinitionProvenanceFact } from "../../../../src/workflows/definition-provenance-facts.js"

const tmpRoot = path.join(os.tmpdir(), `flywheel-definition-loaded-migration-${process.pid}-${Date.now()}`)

const STEP_RECORD = {
  id: "debug.investigate",
  name: "Investigate",
  handoff: "debug-handoff",
  writes: [],
  promptBody: "Investigate.",
  "user-invocable": false,
  "disable-model-invocation": false,
}

const WORKFLOW_RECORD = {
  id: "debug",
  name: "Debug",
  confirmation_template: "debug",
  "user-invocable": true,
  "disable-model-invocation": false,
  steps: [{ step: "debug.investigate" }],
}

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("migrateDefinitionLoadedHandoffFilename", () => {
  it("drops the retired field from step snapshots and advances only the fact version", () => {
    const dbFile = seed([
      { kind: "step", id: STEP_RECORD.id, definition: { ...STEP_RECORD, handoffFilename: "investigation.json" } },
      { kind: "workflow", id: WORKFLOW_RECORD.id, definition: WORKFLOW_RECORD },
    ])

    expect(migrateDefinitionLoadedHandoffFilename(dbFile)).toEqual({ repaired: 2 })

    const rows = readRows(dbFile)
    expect(rows.map(({ version }) => version)).toEqual([3, 3])
    expect(JSON.parse(rows[0]?.payload ?? "{}")).toEqual({ kind: "step", id: STEP_RECORD.id, definition: STEP_RECORD })
    expect(JSON.parse(rows[1]?.payload ?? "{}")).toEqual({ kind: "workflow", id: WORKFLOW_RECORD.id, definition: WORKFLOW_RECORD })
  })

  it("makes the migrated snapshot readable by the strict provenance parser", () => {
    const dbFile = seed([
      { kind: "step", id: STEP_RECORD.id, definition: { ...STEP_RECORD, handoffFilename: "investigation.json" } },
    ])
    const before = readRows(dbFile)[0]
    expect(() => parseDefinitionProvenanceFact({
      type: "definition.loaded", version: before?.version, actor: "flywheel", payload: JSON.parse(before?.payload ?? "{}"),
    })).toThrow("unknown fact definition.loaded@2")

    migrateDefinitionLoadedHandoffFilename(dbFile)

    const after = readRows(dbFile)[0]
    const fact = parseDefinitionProvenanceFact({
      type: "definition.loaded", version: after?.version, actor: "flywheel", payload: JSON.parse(after?.payload ?? "{}"),
    })
    if (fact.type !== "definition.loaded" || fact.payload.kind !== "step") throw new Error("Migrated fact is not a step snapshot")
    expect(fact.payload.definition).toEqual(STEP_RECORD)
  })

  it("is idempotent", () => {
    const dbFile = seed([
      { kind: "step", id: STEP_RECORD.id, definition: { ...STEP_RECORD, handoffFilename: "investigation.json" } },
    ])
    migrateDefinitionLoadedHandoffFilename(dbFile)
    const migrated = readRows(dbFile)

    expect(migrateDefinitionLoadedHandoffFilename(dbFile)).toEqual({ repaired: 0 })
    expect(readRows(dbFile)).toEqual(migrated)
  })

  it("rolls back every row when one legacy payload is malformed", () => {
    const dbFile = seed([
      { kind: "step", id: STEP_RECORD.id, definition: { ...STEP_RECORD, handoffFilename: "investigation.json" } },
      { kind: "step", id: "broken", definition: "not a definition record" },
    ])
    const staged = readRows(dbFile)

    expect(() => migrateDefinitionLoadedHandoffFilename(dbFile)).toThrow()
    expect(readRows(dbFile)).toEqual(staged)
  })
})

function seed(payloads: readonly EventPayload[]): string {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  const dbFile = path.join(dir, "flywheel.sqlite")
  const store = createSqliteEventStore(dbFile)
  try {
    for (const [index, payload] of payloads.entries()) {
      store.append({
        aggregateId: "workflow:legacy-session",
        type: "definition.loaded",
        version: 2,
        timestamp: index + 1,
        actor: "flywheel",
        sessionId: "legacy-session",
        payload,
      })
    }
  } finally {
    store.close()
  }
  return dbFile
}

function readRows(dbFile: string): { version: number; payload: string }[] {
  const db = new Database(dbFile)
  try {
    return db.query<{ version: number; payload: string }, []>(
      "select version, payload from event where type = 'definition.loaded' order by position",
    ).all()
  } finally {
    db.close()
  }
}
