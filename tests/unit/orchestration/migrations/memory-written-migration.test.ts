import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { parseSessionFact } from "../../../../src/orchestration/session/session-fact-registry.js"
import { prepareWorkspaceState } from "../../../../src/orchestration/workspace-state.js"
import { testDirectories } from "../../../helpers/directories.js"
import {
  MEMORY_WRITTEN_MIGRATION_ID,
  migrateMemoryWrittenFacts,
} from "../../../../src/orchestration/modules/learning/migrations/memory-written.js"
interface UnknownObject {
  [key: string]: unknown
}

const tmpRoot = path.join(os.tmpdir(), `flywheel-memory-written-migration-${process.pid}-${Date.now()}`)

afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))

describe("migrateMemoryWrittenFacts", () => {
  it("adopts the reach vocabulary and the explicit identity, advancing only the fact version", () => {
    const dbFile = makeDbFile()
    seedWrite(dbFile, "legacy-project", 1, legacyV1Payload("memory"))
    seedWrite(dbFile, "legacy-global", 1, legacyV1Payload("user"))
    seedWrite(dbFile, "current", 3, currentPayload())
    const before = memoryRows(dbFile)

    expect(migrateMemoryWrittenFacts(dbFile)).toEqual({ repaired: 2 })

    const after = memoryRows(dbFile)
    expect(withoutVersionAndPayload(after[0]!)).toEqual(withoutVersionAndPayload(before[0]!))
    expect(after[0]?.version).toBe(3)
    expect(JSON.parse(after[0]?.payload ?? "{}")).toEqual(adoptedV1Payload("project"))
    expect(JSON.parse(after[1]?.payload ?? "{}")).toEqual(adoptedV1Payload("global"))
    expect(after[2]).toEqual(before[2]!)
    expect(migrationFacts(dbFile)).toEqual([{
      migrationId: MEMORY_WRITTEN_MIGRATION_ID,
      factTypes: ["memory.written"],
      repaired: 2,
    }])
  })

  it("keeps a version-2 prepared identity and states the adopted case for the rest", () => {
    const dbFile = makeDbFile()
    seedWrite(dbFile, "journalled", 2, { ...legacyV2Payload(), mutationId: "mutation-1" })
    seedWrite(dbFile, "pre-journal", 2, legacyV2Payload())

    expect(migrateMemoryWrittenFacts(dbFile)).toEqual({ repaired: 2 })

    const after = memoryRows(dbFile)
    expect(after.map(({ version }) => version)).toEqual([3, 3])
    expect(JSON.parse(after[0]?.payload ?? "{}")).toEqual({
      ...legacyV2Payload(),
      identity: { kind: "recorded", mutationId: "mutation-1" },
    })
    expect(JSON.parse(after[1]?.payload ?? "{}")).toEqual({
      ...legacyV2Payload(),
      identity: { kind: "adopted_v1" },
    })
  })

  it("is idempotent", () => {
    const dbFile = makeDbFile()
    seedWrite(dbFile, "legacy", 1, legacyV1Payload("memory"))
    migrateMemoryWrittenFacts(dbFile)
    const afterFirst = eventRows(dbFile)

    expect(migrateMemoryWrittenFacts(dbFile)).toEqual({ repaired: 0 })
    expect(eventRows(dbFile)).toEqual(afterFirst)
  })

  it("rolls back all rows and the migration fact when one legacy payload is malformed", () => {
    const dbFile = makeDbFile()
    seedWrite(dbFile, "valid", 1, legacyV1Payload("memory"))
    seedWrite(dbFile, "malformed", 1, { ...legacyV1Payload("memory"), target: "workspace" })
    const before = eventRows(dbFile)

    expect(() => migrateMemoryWrittenFacts(dbFile)).toThrow()
    expect(eventRows(dbFile)).toEqual(before)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("rejects a legacy envelope whose actor contradicts its origin", () => {
    const dbFile = makeDbFile()
    seedWrite(dbFile, "legacy", 1, legacyV1Payload("memory"), "user")
    const before = eventRows(dbFile)

    expect(() => migrateMemoryWrittenFacts(dbFile)).toThrow()
    expect(eventRows(dbFile)).toEqual(before)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("makes the migrated fact readable by the strict session fact parser", () => {
    const directories = testDirectories(path.join(tmpRoot, crypto.randomUUID()))
    const seeded = prepareWorkspaceState(directories)
    const dbFile = seeded.dbFile
    const store = createSqliteEventStore(dbFile)
    try {
      store.append({
        aggregateId: "session:legacy",
        type: "memory.written",
        version: 1,
        timestamp: 1,
        actor: "agent",
        sessionId: "legacy",
        payload: legacyV1Payload("user"),
      })
    } finally {
      store.close()
      seeded.generation.release()
    }

    const migrated = prepareWorkspaceState(directories)
    const reopened = createSqliteEventStore(dbFile)
    try {
      const [event] = reopened.read({ aggregateId: "session:legacy" })
      const fact = parseSessionFact({
        type: event?.type,
        version: event?.version,
        actor: event?.actor,
        payload: event?.payload,
      })
      expect(fact.type).toBe("memory.written")
      expect(fact.payload).toMatchObject({ target: "global", identity: { kind: "adopted_v1" } })
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

function legacyV1Payload(target: "memory" | "user"): UnknownObject {
  return {
    target,
    action: "add",
    origin: { kind: "agent", sessionId: "sess-1" },
    contentHash: "a".repeat(64),
  }
}

function legacyV2Payload(): UnknownObject {
  return {
    target: "project",
    action: "add",
    origin: { kind: "agent", sessionId: "sess-1" },
    contentHash: "a".repeat(64),
  }
}

function currentPayload(): UnknownObject {
  return {
    ...legacyV2Payload(),
    identity: { kind: "recorded", mutationId: "mutation-current" },
  }
}

/** The version-1 write as the upgrade records it: the legacy store name becomes
 *  the reach it named, and the fact states that it predates journalled write
 *  identities. */
function adoptedV1Payload(target: "project" | "global"): UnknownObject {
  const { target: _legacy, ...rest } = legacyV1Payload(target === "global" ? "user" : "memory")
  return { ...rest, target, identity: { kind: "adopted_v1" } }
}

function makeDbFile(): string {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "flywheel.sqlite")
}

function seedWrite(dbFile: string, sessionId: string, version: number, payload: EventPayload, actor = "agent"): void {
  const store = createSqliteEventStore(dbFile)
  try {
    store.append({
      aggregateId: `session:${sessionId}`,
      type: "memory.written",
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

function memoryRows(dbFile: string): EventRow[] {
  return eventRows(dbFile).filter(({ type }) => type === "memory.written")
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
