import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { loadSubagentRunsFromEvents } from "../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"
import { testDirectories } from "../../../helpers/directories.js"
import {
  migrateSubagentPromptTaskInstructions,
  SUBAGENT_PROMPT_MIGRATION_ID,
} from "../../../../src/orchestration/modules/subagents/migrations/subagent-prompt.js"

const tmpRoot = path.join(os.tmpdir(), `flywheel-subagent-prompt-migration-${process.pid}-${Date.now()}`)

afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))

describe("migrateSubagentPromptTaskInstructions", () => {
  it("adopts every earlier prompt shape into version 3 and leaves current rows alone", () => {
    const dbFile = makeDbFile()
    seedPrompt(dbFile, "legacy", 1, {
      childRunId: "child-1",
      prompt: "review this",
      systemPrompt: "persona and delegated task",
      toolNames: ["read", "search"],
    })
    // Written between 2026-08-06 and 2026-08-16, before the field was renamed
    // without a version bump.
    seedPrompt(dbFile, "renamed", 2, {
      childRunId: "child-2",
      prompt: "review that",
      taskInstructions: "instructions under the old name",
      toolNames: ["read"],
    })
    seedPrompt(dbFile, "ambiguous-v2", 2, {
      childRunId: "child-3",
      prompt: "review those",
      task: "instructions under the new name",
      toolNames: ["read"],
    })
    seedPrompt(dbFile, "current", 3, {
      childRunId: "child-4",
      prompt: "review it",
      task: "current instructions",
      toolNames: ["read"],
    })
    const before = eventRows(dbFile)

    expect(migrateSubagentPromptTaskInstructions(dbFile)).toEqual({ repaired: 3 })

    const after = eventRows(dbFile)
    for (const index of [0, 1, 2]) {
      expect(withoutVersionAndPayload(after[index]!)).toEqual(withoutVersionAndPayload(before[index]!))
      expect(after[index]?.version).toBe(3)
    }
    expect(JSON.parse(after[0]?.payload ?? "{}")).toEqual({
      childRunId: "child-1",
      prompt: "review this",
      task: "persona and delegated task",
      toolNames: ["read", "search"],
    })
    expect(JSON.parse(after[1]?.payload ?? "{}")).toEqual({
      childRunId: "child-2",
      prompt: "review that",
      task: "instructions under the old name",
      toolNames: ["read"],
    })
    expect(JSON.parse(after[2]?.payload ?? "{}")).toEqual({
      childRunId: "child-3",
      prompt: "review those",
      task: "instructions under the new name",
      toolNames: ["read"],
    })
    expect(after[3]).toEqual(before[3])
    expect(migrationFacts(dbFile)).toEqual([{
      migrationId: SUBAGENT_PROMPT_MIGRATION_ID,
      factTypes: ["subagent.prompted"],
      repaired: 3,
    }])
  })

  it("refuses a version-2 row that carries both names or neither", () => {
    for (const payload of [
      { childRunId: "c", prompt: "p", task: "a", taskInstructions: "b", toolNames: [] },
      { childRunId: "c", prompt: "p", toolNames: [] },
    ]) {
      const dbFile = makeDbFile()
      seedPrompt(dbFile, "bad", 2, payload)
      const before = eventRows(dbFile)
      expect(() => migrateSubagentPromptTaskInstructions(dbFile)).toThrow()
      expect(eventRows(dbFile)).toEqual(before)
    }
  })

  it("is idempotent", () => {
    const dbFile = makeDbFile()
    seedPrompt(dbFile, "legacy", 1, legacyPayload())
    migrateSubagentPromptTaskInstructions(dbFile)
    const afterFirst = eventRows(dbFile)

    expect(migrateSubagentPromptTaskInstructions(dbFile)).toEqual({ repaired: 0 })
    expect(eventRows(dbFile)).toEqual(afterFirst)
  })

  it("rolls back all rows and the migration fact when one legacy payload is malformed", () => {
    const dbFile = makeDbFile()
    seedPrompt(dbFile, "valid", 1, legacyPayload())
    seedPrompt(dbFile, "malformed", 1, { ...legacyPayload(), systemPrompt: 42 })
    const before = eventRows(dbFile)

    expect(() => migrateSubagentPromptTaskInstructions(dbFile)).toThrow()
    expect(eventRows(dbFile)).toEqual(before)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("rejects a legacy envelope with a non-flywheel actor", () => {
    const dbFile = makeDbFile()
    seedPrompt(dbFile, "legacy", 1, legacyPayload(), "worker")
    const before = eventRows(dbFile)

    expect(() => migrateSubagentPromptTaskInstructions(dbFile)).toThrow()
    expect(eventRows(dbFile)).toEqual(before)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("repairs a late legacy row and records a second pass", () => {
    const dbFile = makeDbFile()
    seedPrompt(dbFile, "legacy", 1, legacyPayload())
    migrateSubagentPromptTaskInstructions(dbFile)
    seedPrompt(dbFile, "late", 1, legacyPayload())

    expect(migrateSubagentPromptTaskInstructions(dbFile)).toEqual({ repaired: 1 })
    expect(eventRows(dbFile).filter(({ type, version }) => type === "subagent.prompted" && version !== 3)).toEqual([])
    expect(migrationFacts(dbFile).map(({ migrationId }) => migrationId))
      .toEqual([SUBAGENT_PROMPT_MIGRATION_ID, SUBAGENT_PROMPT_MIGRATION_ID])
  })

  it("retires the side-table migration ledger earlier binaries recorded into", () => {
    const dbFile = makeDbFile()
    seedPrompt(dbFile, "legacy", 1, legacyPayload())
    seedLegacyLedger(dbFile)

    migrateSubagentPromptTaskInstructions(dbFile)

    const db = new Database(dbFile, { readonly: true })
    try {
      expect(db.query("select name from sqlite_master where type = 'table' and name = 'workspace_migration'").get()).toBeNull()
    } finally {
      db.close()
    }
  })

  it("makes the migrated prompt readable by the strict subagent projection", () => {
    const directories = testDirectories(path.join(tmpRoot, crypto.randomUUID()))
    const seeded = prepareWorkspaceState(directories)
    const dbFile = seeded.dbFile
    const store = createSqliteEventStore(dbFile)
    try {
      store.append({
        aggregateId: "session:legacy",
        type: "child_run.created",
        version: 1,
        timestamp: 1,
        actor: "flywheel",
        sessionId: "legacy",
        payload: {
          childRunId: "child-1",
          kind: "subagent",
          agentType: "explorer",
          description: "Inspect",
          model: "test-model",
          maxTurns: 2,
          tools: ["read"],
        },
      })
      store.append({
        aggregateId: "session:legacy",
        type: "subagent.prompted",
        version: 1,
        timestamp: 2,
        actor: "flywheel",
        sessionId: "legacy",
        payload: legacyPayload(),
      })
    } finally {
      store.close()
      seeded.generation.release()
    }

    const migrated = prepareWorkspaceState(directories)
    const reopened = createSqliteEventStore(dbFile)
    try {
      const runs = loadSubagentRunsFromEvents(reopened.read({ aggregateId: "session:legacy" }))
      expect(runs).toHaveLength(1)
      expect(runs[0]?.task).toBe("persona and delegated task")
    } finally {
      reopened.close()
      migrated.generation.release()
    }
  })
})

interface JsonObject {
  [key: string]: unknown
}

interface EventRow {
  position: number
  id: string
  aggregateId: string
  seq: number
  type: string
  version: number
  payload: string
}

function legacyPayload(): JsonObject {
  return {
    childRunId: "child-1",
    prompt: "review this",
    systemPrompt: "persona and delegated task",
    toolNames: ["read", "search"],
  }
}

function makeDbFile(): string {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "flywheel.sqlite")
}

function seedPrompt(dbFile: string, sessionId: string, version: number, payload: EventPayload, actor = "flywheel"): void {
  const store = createSqliteEventStore(dbFile)
  try {
    store.append({
      aggregateId: `session:${sessionId}`,
      type: "subagent.prompted",
      version,
      timestamp: 1,
      actor,
      sessionId,
      payload,
    })
  } finally {
    store.close()
  }
}

function eventRows(dbFile: string): EventRow[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<EventRow, []>(`
      select position, id, aggregate_id as aggregateId, seq, type, version, payload
      from event order by position
    `).all()
  } finally {
    db.close()
  }
}

function withoutVersionAndPayload(row: EventRow): Omit<EventRow, "version" | "payload"> {
  const { version: _version, payload: _payload, ...identity } = row
  return identity
}

function migrationFacts(dbFile: string): JsonObject[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<{ payload: string }, []>(
      "select payload from event where type = 'workspace.facts.migrated' order by position",
    ).all().map(({ payload }) => JSON.parse(payload))
  } finally {
    db.close()
  }
}

/** The retired side table an earlier binary recorded its passes into. */
function seedLegacyLedger(dbFile: string): void {
  const db = new Database(dbFile)
  try {
    db.exec("create table workspace_migration (migration_id text primary key, applied_at integer not null)")
    db.exec("insert into workspace_migration (migration_id, applied_at) values ('some-earlier-pass', 1)")
  } finally {
    db.close()
  }
}
