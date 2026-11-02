import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import * as path from "node:path"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { migrateResumeRevertAttemptId } from "../../../../src/orchestration/modules/workflows/migrations/resume-revert-attempt-id.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const temporaryDirectory = temporaryDirectories()
const AGGREGATE = "workflow:legacy-session"

interface Row {
  readonly version: number
  readonly payload: string
}

/** Resume-revert counters that a build before 2026-10-16 wrote name their
 *  attempt `stepId`. Remove with the pass after 2027-04-30. */
describe("migrateResumeRevertAttemptId", () => {
  it("names each version 1 counter's attempt `attemptId`, so retention keeps the newest counter of every attempt", () => {
    const dbFile = seed([
      { version: 1, payload: { stepId: "attempt-1", count: 1 } },
      { version: 1, payload: { stepId: "attempt-2", count: 1 } },
      { version: 1, payload: { stepId: "attempt-1", count: 2 } },
      { version: 2, payload: { attemptId: "attempt-2", count: 2 } },
    ])

    expect(migrateResumeRevertAttemptId(dbFile)).toEqual({ repaired: 3 })
    expect(rows(dbFile)).toEqual([
      { version: 2, payload: JSON.stringify({ attemptId: "attempt-1", count: 1 }) },
      { version: 2, payload: JSON.stringify({ attemptId: "attempt-2", count: 1 }) },
      { version: 2, payload: JSON.stringify({ attemptId: "attempt-1", count: 2 }) },
      { version: 2, payload: JSON.stringify({ attemptId: "attempt-2", count: 2 }) },
    ])

    const store = createSqliteEventStore(dbFile)
    try {
      expect(store.pruneSupersededKeyedEvents(AGGREGATE, "step.resume_revert.recorded", "$.attemptId")).toBe(2)
    } finally {
      store.close()
    }
    expect(rows(dbFile).map(({ payload }) => JSON.parse(payload))).toEqual([
      { attemptId: "attempt-1", count: 2 },
      { attemptId: "attempt-2", count: 2 },
    ])
  })

  it("keeps a version 1 row that it cannot read as it is, and does nothing on a second run", () => {
    const dbFile = seed([
      { version: 1, payload: { stepId: "attempt-1", count: -1 } },
      { version: 1, payload: { stepId: "attempt-2", count: 3 } },
    ])

    expect(migrateResumeRevertAttemptId(dbFile)).toEqual({ repaired: 1 })
    const migrated = rows(dbFile)
    expect(migrated).toEqual([
      { version: 1, payload: JSON.stringify({ stepId: "attempt-1", count: -1 }) },
      { version: 2, payload: JSON.stringify({ attemptId: "attempt-2", count: 3 }) },
    ])
    expect(migrateResumeRevertAttemptId(dbFile)).toEqual({ repaired: 0 })
    expect(rows(dbFile)).toEqual(migrated)
  })
})

function seed(facts: readonly { readonly version: number; readonly payload: EventPayload }[]): string {
  const dbFile = path.join(temporaryDirectory("flywheel-resume-revert-attempt-id-"), "flywheel.sqlite")
  const store = createSqliteEventStore(dbFile)
  try {
    for (const [index, { version, payload }] of facts.entries()) {
      store.append({ aggregateId: AGGREGATE, type: "step.resume_revert.recorded", version, timestamp: index + 1, actor: "flywheel", sessionId: "legacy-session", payload })
    }
  } finally {
    store.close()
  }
  return dbFile
}

function rows(dbFile: string): Row[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<Row, []>("SELECT version, payload FROM event WHERE type = 'step.resume_revert.recorded' ORDER BY position").all()
  } finally {
    db.close()
  }
}
