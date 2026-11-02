import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store"
import type { EventStoreAppend, LocalSqliteEventStore } from "../../../src/infra/event-store-types"
import { buildSessionContent, type SessionContentNodeRow } from "../../../src/infra/session-content"
import { temporaryDirectories } from "../../helpers/directories"

const temporaryDirectory = temporaryDirectories()
let store: LocalSqliteEventStore
let dbPath: string

beforeEach(() => {
  dbPath = join(temporaryDirectory("session-content-lifetime-"), "events.sqlite")
  store = createSqliteEventStore(dbPath)
})

afterEach(() => { store.close() })

function deletion(sessionId: string): EventStoreAppend {
  return {
    aggregateId: `session:${sessionId}`, sessionId, type: "session.deleted", version: 1,
    actor: "flywheel", timestamp: 1_000, payload: { lastUpdated: new Date(1_000).toISOString() },
    inFlight: [{ op: "clear_session" }],
  }
}

async function seedContent(sessionId: string): Promise<SessionContentNodeRow[]> {
  const nodes: SessionContentNodeRow[] = []
  const referenced = await buildSessionContent("retained patch".repeat(10_000), async rows => { nodes.push(...rows) })
  await buildSessionContent("unreferenced staged patch", async rows => { nodes.push(...rows) })
  store.stageSessionContentNodes(sessionId, nodes)
  const content = "ordinary tool output"
  const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex")
  const bytes = Buffer.byteLength(content)
  store.append({
    aggregateId: `session:${sessionId}`, sessionId, type: "tool.result.recorded", version: 1,
    actor: "flywheel", timestamp: 0, payload: { evidence: referenced, output: { sha256, bytes, preview: content } },
    contentRows: [{ sha256, content, bytes }],
  })
  store.putInFlight(sessionId, "operation", "pending", { status: "pending" })
  return nodes
}

function storedHashes(sessionId: string): string[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.query<{ sha256: string }, [string]>(
      "select sha256 from tool_content where session_id = ?1 order by sha256",
    ).all(sessionId).map(row => row.sha256)
  } finally { db.close() }
}

describe("session content lifetime", () => {
  test("deletion between chunk admissions rejects staging without recreating content", async () => {
    let admissions = 0
    await expect(buildSessionContent("patch".repeat(30_000), async rows => {
      store.stageSessionContentNodes("deleted", rows)
      if (++admissions === 1) store.append(deletion("deleted"))
    })).rejects.toThrow("deleted session")
    expect(storedHashes("deleted")).toEqual([])
    expect(store.read({ sessionId: "deleted", types: ["session.deleted"] })).toHaveLength(1)
    expect(() => store.stageSessionContentNodes("deleted", [])).not.toThrow()
  })
  test("deletion retires all session content with its fact and preserves another session's identical hashes", async () => {
    const nodes = await seedContent("deleted")
    await seedContent("survivor")
    const survivingHashes = storedHashes("survivor")
    expect(survivingHashes).toHaveLength(nodes.length + 1)

    store.append(deletion("deleted"))

    expect(storedHashes("deleted")).toEqual([])
    expect(store.readInFlight("deleted", "operation")).toEqual([])
    expect(store.read({ sessionId: "deleted", types: ["session.deleted"] })).toHaveLength(1)
    expect(storedHashes("survivor")).toEqual(survivingHashes)
    for (const row of nodes) expect(store.readSessionContentNode?.("survivor", row.sha256)).toEqual(row.node)
    expect(store.readInFlight("survivor", "operation")).toHaveLength(1)
  })

  test("a failed deletion append restores content and recovery state without committing a deletion fact", async () => {
    await seedContent("deleted")
    const hashes = storedHashes("deleted")
    const db = new Database(dbPath)
    try {
      db.exec(`create trigger refuse_deletion before insert on event
        when new.type = 'session.deleted'
        begin select raise(abort, 'deletion refused'); end`)
    } finally { db.close() }

    expect(() => store.append(deletion("deleted"))).toThrow("deletion refused")

    expect(storedHashes("deleted")).toEqual(hashes)
    expect(store.readInFlight("deleted", "operation")).toHaveLength(1)
    expect(store.read({ sessionId: "deleted", types: ["session.deleted"] })).toEqual([])
  })
})
