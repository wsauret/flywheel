import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { parseSessionFact } from "../../../../src/orchestration/session/session-fact-registry.js"
import { collectSkillWriteRecords } from "../../../../src/orchestration/modules/learning/skill-load-stats.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"
import { testDirectories } from "../../../helpers/directories.js"
import {
  SKILL_REACH_MIGRATION_ID,
  migrateSkillFactReach,
} from "../../../../src/orchestration/modules/learning/migrations/skill-scope.js"
interface UnknownObject {
  [key: string]: unknown
}

const tmpRoot = path.join(os.tmpdir(), `flywheel-skill-scope-migration-${process.pid}-${Date.now()}`)

afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))

describe("migrateSkillFactReach", () => {
  it("adopts the reach vocabulary in skill.written and advances only the fact version", () => {
    const dbFile = makeDbFile()
    seed(dbFile, "skill.written", 1, legacyWrite("project"))
    seed(dbFile, "skill.written", 1, legacyWrite("user"))
    seed(dbFile, "skill.written", 2, currentWrite())
    const before = eventRows(dbFile)

    expect(migrateSkillFactReach(dbFile)).toEqual({ repaired: 2 })

    const after = eventRows(dbFile)
    expect(withoutVersionAndPayload(after[0]!)).toEqual(withoutVersionAndPayload(before[0]!))
    expect(after[0]?.version).toBe(2)
    expect(JSON.parse(after[0]?.payload ?? "{}")).toEqual(adoptedWrite("project"))
    expect(JSON.parse(after[1]?.payload ?? "{}")).toEqual(adoptedWrite("global"))
    expect(after[2]).toEqual(before[2]!)
    expect(migrationFacts(dbFile)).toEqual([{
      migrationId: SKILL_REACH_MIGRATION_ID,
      factTypes: ["skill.written"],
      repaired: 2,
    }])
  })

  it("adds no identity the version-1 writer never prepared", () => {
    const dbFile = makeDbFile()
    seed(dbFile, "skill.written", 1, legacyWrite("user"))

    migrateSkillFactReach(dbFile)

    const migrated: unknown = JSON.parse(eventRows(dbFile)[0]?.payload ?? "{}")
    expect(migrated).toHaveProperty("identity", { kind: "adopted_v1" })
    expect(migrated).not.toHaveProperty("mutationId")
    expect(migrated).not.toHaveProperty("packageIdentity")
  })

  it("recovers each review action's reach from the legacy memory target and records no recommendation", () => {
    const dbFile = makeDbFile()
    seed(dbFile, "skill.review.completed", 1, legacyReview())

    expect(migrateSkillFactReach(dbFile)).toEqual({ repaired: 1 })

    const payload: unknown = JSON.parse(eventRows(dbFile)[0]?.payload ?? "{}")
    expect(payload).toHaveProperty("actions", [
      { surface: "memory", name: "project", action: "add", reach: "project" },
      { surface: "memory", name: "global", action: "replace", reach: "global" },
      // Version 1 recorded no reach for a skill action, and none can be
      // recovered, so the migrated action states the adopted case.
      { surface: "skill", name: "planning", action: "patch", reach: "adopted_v1" },
    ])
    expect(payload).toHaveProperty("recommendations", [])
  })

  it("is idempotent", () => {
    const dbFile = makeDbFile()
    seed(dbFile, "skill.written", 1, legacyWrite("project"))
    migrateSkillFactReach(dbFile)
    const afterFirst = eventRows(dbFile)

    expect(migrateSkillFactReach(dbFile)).toEqual({ repaired: 0 })
    expect(eventRows(dbFile)).toEqual(afterFirst)
  })

  it("rolls back all rows and the migration fact when one legacy payload is malformed", () => {
    const dbFile = makeDbFile()
    seed(dbFile, "skill.written", 1, legacyWrite("project"))
    seed(dbFile, "skill.written", 1, { ...legacyWrite("project"), root: "workspace" })
    const before = eventRows(dbFile)

    expect(() => migrateSkillFactReach(dbFile)).toThrow()
    expect(eventRows(dbFile)).toEqual(before)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("rejects a legacy envelope whose actor contradicts its origin", () => {
    const dbFile = makeDbFile()
    seed(dbFile, "skill.written", 1, legacyWrite("project"), "user")
    const before = eventRows(dbFile)

    expect(() => migrateSkillFactReach(dbFile)).toThrow()
    expect(eventRows(dbFile)).toEqual(before)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("makes migrated facts readable by the strict parser and by skills:why telemetry", async () => {
    const directories = testDirectories(path.join(tmpRoot, crypto.randomUUID()))
    const seeded = prepareWorkspaceState(directories)
    const dbFile = seeded.dbFile
    const store = createSqliteEventStore(dbFile)
    try {
      store.append({ aggregateId: "session:legacy", type: "skill.written", version: 1, timestamp: 1, actor: "agent", sessionId: "legacy", payload: legacyWrite("user") })
      store.append({ aggregateId: "session:legacy", type: "skill.review.completed", version: 1, timestamp: 2, actor: "agent", sessionId: "legacy", payload: legacyReview() })
    } finally {
      store.close()
      seeded.generation.release()
    }

    const migrated = prepareWorkspaceState(directories)
    const reopened = createSqliteEventStore(dbFile)
    try {
      const events = reopened.read({ aggregateId: "session:legacy" })
      for (const event of events) {
        const fact = parseSessionFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
        expect(fact.type).toBe(event.type)
      }
      expect(await collectSkillWriteRecords(asAsyncEventReadSurface(reopened), "planning")).toEqual([{
        sessionId: "legacy",
        timestamp: 1,
        action: "created",
        reach: "global",
        origin: "session:sess-1",
        contentHash: "a".repeat(64),
      }])
    } finally {
      reopened.close()
      migrated.generation.release()
    }
  })
})

interface EventRow {
  position: number
  id: string
  aggregateId: string
  seq: number
  type: string
  version: number
  payload: string
}

function legacyWrite(root: "project" | "user"): UnknownObject {
  return {
    name: "planning",
    action: "created",
    root,
    origin: { kind: "agent", sessionId: "sess-1" },
    contentHash: "a".repeat(64),
    description: "Use when planning work.",
  }
}

function currentWrite(): UnknownObject {
  return {
    name: "planning",
    action: "updated",
    reach: "project",
    origin: { kind: "agent", sessionId: "sess-2" },
    identity: {
      kind: "recorded",
      mutationId: "b".repeat(64),
      packageIdentity: { sha256: "d".repeat(64), bytes: 42 },
    },
    contentHash: "c".repeat(64),
    description: "Use when planning work.",
  }
}

function legacyReview(): UnknownObject {
  return {
    reviewRunId: "rev-1",
    sessionId: "sess-1",
    trigger: "iterations",
    halves: ["memory", "skill"],
    model: "gpt-5.5",
    actions: [
      { surface: "memory", name: "memory", action: "add" },
      { surface: "memory", name: "user", action: "replace" },
      { surface: "skill", name: "planning", action: "patch" },
    ],
    durationMs: 1200,
    outcome: "acted",
  }
}

/** The version-1 write as the upgrade records it: the physical root becomes the
 *  reach it named, and the fact states that it predates prepared identities. */
function adoptedWrite(reach: "project" | "global"): UnknownObject {
  const { root: _root, ...rest } = legacyWrite(reach === "global" ? "user" : "project")
  return { ...rest, reach, identity: { kind: "adopted_v1" } }
}

function makeDbFile(): string {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "flywheel.sqlite")
}

function seed(dbFile: string, type: string, version: number, payload: EventPayload, actor = "agent"): void {
  const store = createSqliteEventStore(dbFile)
  try {
    store.append({ aggregateId: "session:s-1", type, version, timestamp: 1, actor, sessionId: "s-1", payload })
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

function migrationFacts(dbFile: string): UnknownObject[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<{ payload: string }, []>(
      "select payload from event where type = 'workspace.facts.migrated' order by position",
    ).all().map(({ payload }) => JSON.parse(payload))
  } finally {
    db.close()
  }
}
