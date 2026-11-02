import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { migrateContextRecipientStepId } from "../../../../src/orchestration/modules/workflows/migrations/context-recipient-step-id.js"
import { parseWorkflowContextFact } from "../../../../src/workflows/context-bundle/context-facts.js"

const tmpRoot = path.join(os.tmpdir(), `flywheel-context-recipient-${process.pid}-${Date.now()}`)
const LEGACY_ENTRY = {
  stepId: "step-1",
  stepName: "Create plan",
  definitionId: "flywheel.plan-create",
  workflowDefinitionId: "flywheel-core",
  writes: [],
  timestamp: 1,
  handoff: { summary: "Plan written" },
}

interface Row {
  readonly version: number
  readonly actor: string
  readonly payload: string
}

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("migrateContextRecipientStepId", () => {
  it("addresses an ordinary historical handoff to no specific attempt", () => {
    const dbFile = seed({ entry: LEGACY_ENTRY })
    expect(() => parse(readRow(dbFile))).toThrow("Expected 4, got 3")

    expect(migrateContextRecipientStepId(dbFile)).toEqual({ repaired: 1 })

    const fact = parse(readRow(dbFile))
    if (fact.type !== "context.accumulated") throw new Error("Migrated fact is not accumulated context")
    expect(fact.payload.entry).toEqual({ ...LEGACY_ENTRY, recipientStepId: null })
  })

  it("does nothing on a second run", () => {
    const dbFile = seed({ entry: LEGACY_ENTRY })
    migrateContextRecipientStepId(dbFile)
    const migrated = readRow(dbFile)

    expect(migrateContextRecipientStepId(dbFile)).toEqual({ repaired: 0 })
    expect(readRow(dbFile)).toEqual(migrated)
  })

  it("rejects targeted delivery that version 3 could not express", () => {
    for (const recipientStepId of [42, "attempt-2"]) {
      const dbFile = seed({ entry: { ...LEGACY_ENTRY, recipientStepId } })
      const staged = readRow(dbFile)

      expect(() => migrateContextRecipientStepId(dbFile)).toThrow("cannot record a recipient step id")
      expect(readRow(dbFile)).toEqual(staged)
    }
  })
})

function parse(row: Row) {
  return parseWorkflowContextFact({
    type: "context.accumulated",
    version: row.version,
    actor: row.actor,
    payload: JSON.parse(row.payload),
  })
}

function seed(payload: EventPayload): string {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  const dbFile = path.join(dir, "flywheel.sqlite")
  const store = createSqliteEventStore(dbFile)
  try {
    store.append({
      aggregateId: "workflow:legacy-session",
      type: "context.accumulated",
      version: 3,
      timestamp: 1,
      actor: "flywheel",
      sessionId: "legacy-session",
      payload,
    })
  } finally {
    store.close()
  }
  return dbFile
}

function readRow(dbFile: string): Row {
  const db = new Database(dbFile, { readonly: true })
  try {
    const row = db.query<Row, []>("select version, actor, payload from event where type = 'context.accumulated'").get()
    if (!row) throw new Error("Test fixture recorded no context fact")
    return row
  } finally {
    db.close()
  }
}
