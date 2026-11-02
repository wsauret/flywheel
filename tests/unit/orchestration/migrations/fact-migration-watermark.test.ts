import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { migrateFactVersions, type FactUpgrade } from "../../../../src/orchestration/migrations/engine.js"

const tmpRoot = path.join(os.tmpdir(), `flywheel-fact-migration-watermark-${process.pid}-${Date.now()}`)
afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))

const MIGRATION_ID = "probe-fact-v2"
const upgrade: FactUpgrade = {
  type: "probe.fact",
  fromVersion: 1,
  rebuild: (payload, actor) => ({ version: 2, actor, payload: { ...payload, upgraded: true } }),
}

function makeDbFile(): string {
  fs.mkdirSync(tmpRoot, { recursive: true })
  return path.join(tmpRoot, `${crypto.randomUUID()}.sqlite`)
}

async function appendProbe(dbFile: string, version: number, n: number): Promise<number> {
  const store = createSqliteEventStore(dbFile)
  try {
    const stored = await store.append({ aggregateId: "session:probe", type: "probe.fact", version, timestamp: n, actor: "agent", sessionId: "probe", payload: { n } })
    return stored.position
  } finally {
    store.close()
  }
}

interface Row { position: number; version: number; payload: string }
function rows(dbFile: string, type: string): Row[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<Row, { $type: string }>("select position, version, payload from event where type = $type order by position").all({ $type: type })
  } finally {
    db.close()
  }
}
function headPosition(dbFile: string): number {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<{ position: number }, []>("select max(position) as position from event").get()!.position
  } finally {
    db.close()
  }
}
/** The live watermark rows: their own position is how far the pass has looked. */
const checked = (dbFile: string) => rows(dbFile, "workspace.facts.checked").map((row) => {
  const payload: { migrationId: string } = JSON.parse(row.payload)
  return { position: row.position, migrationId: payload.migrationId }
})

describe("fact migration watermark", () => {
  it("records how far a pass has looked and only scans facts above that on later opens", async () => {
    const dbFile = makeDbFile()
    const first = await appendProbe(dbFile, 1, 1)

    expect(migrateFactVersions(dbFile, MIGRATION_ID, [upgrade])).toEqual({ repaired: 1 })
    expect(rows(dbFile, "probe.fact")[0]?.version).toBe(2)
    const afterFirst = checked(dbFile)
    expect(afterFirst).toEqual([{ position: headPosition(dbFile), migrationId: MIGRATION_ID }])
    expect(afterFirst[0]!.position).toBeGreaterThan(first)

    // Nothing appended since: the pass writes nothing at all.
    expect(migrateFactVersions(dbFile, MIGRATION_ID, [upgrade])).toEqual({ repaired: 0 })
    expect(checked(dbFile)).toEqual(afterFirst)

    // Facts appended above the watermark move it to the head once looked at,
    // one live row per pass, without claiming a repair.
    const noise = await appendProbe(dbFile, 2, 2)
    expect(migrateFactVersions(dbFile, MIGRATION_ID, [upgrade])).toEqual({ repaired: 0 })
    expect(checked(dbFile)).toEqual([{ position: headPosition(dbFile), migrationId: MIGRATION_ID }])
    expect(checked(dbFile)[0]!.position).toBeGreaterThan(noise)
    expect(rows(dbFile, "workspace.facts.migrated")).toHaveLength(1)

    // A legacy fact appended above the watermark is still repaired.
    await appendProbe(dbFile, 1, 3)
    expect(migrateFactVersions(dbFile, MIGRATION_ID, [upgrade])).toEqual({ repaired: 1 })
    expect(rows(dbFile, "probe.fact").map((row) => row.version)).toEqual([2, 2, 2])

    // Below the watermark the store is trusted as already looked at: a row
    // reverted in place there is not rescanned, which is what keeps the pass
    // proportional to new facts instead of to the whole store.
    const db = new Database(dbFile)
    db.query("update event set version = 1 where position = $position").run({ $position: first })
    db.close()
    expect(migrateFactVersions(dbFile, MIGRATION_ID, [upgrade])).toEqual({ repaired: 0 })
    expect(rows(dbFile, "probe.fact")[0]?.version).toBe(1)
    expect(checked(dbFile)).toEqual([{ position: headPosition(dbFile), migrationId: MIGRATION_ID }])
  })

  it("migrates a store larger than one page in pages instead of refusing it", async () => {
    // A workspace with more legacy facts than one transaction rewrites used
    // to throw on the project open path. Each page is its own transaction
    // with its own proof; the watermark lands once, after the last page.
    const dbFile = makeDbFile()
    for (let n = 1; n <= 7; n++) await appendProbe(dbFile, 1, n)

    expect(migrateFactVersions(dbFile, MIGRATION_ID, [upgrade], 3)).toEqual({ repaired: 7 })
    expect(rows(dbFile, "probe.fact").map((row) => row.version)).toEqual([2, 2, 2, 2, 2, 2, 2])
    expect(rows(dbFile, "workspace.facts.migrated").map((row) => JSON.parse(row.payload).repaired)).toEqual([3, 3, 1])
    expect(checked(dbFile)).toEqual([{ position: headPosition(dbFile), migrationId: MIGRATION_ID }])

    // A store whose legacy count is an exact multiple of the page size needs
    // one empty scan to prove it is done, and that scan moves the watermark.
    const exact = makeDbFile()
    for (let n = 1; n <= 6; n++) await appendProbe(exact, 1, n)
    expect(migrateFactVersions(exact, MIGRATION_ID, [upgrade], 3)).toEqual({ repaired: 6 })
    expect(rows(exact, "probe.fact").map((row) => row.version)).toEqual([2, 2, 2, 2, 2, 2])
    expect(checked(exact)).toEqual([{ position: headPosition(exact), migrationId: MIGRATION_ID }])
    expect(migrateFactVersions(exact, MIGRATION_ID, [upgrade], 3)).toEqual({ repaired: 0 })
  })

  it("examines full unreadable pages once and repairs later candidates without a skip ledger", async () => {
    const dbFile = makeDbFile()
    for (let n = 1; n <= 7; n++) await appendProbe(dbFile, 1, n)
    const before = rows(dbFile, "probe.fact")
    const visited: unknown[] = []
    const selective: FactUpgrade = {
      ...upgrade,
      rebuild: (payload, actor) => {
        visited.push(payload.n)
        if (visited.length > 7) throw new Error("candidate rescanned")
        return payload.n === 7 ? upgrade.rebuild(payload, actor) : { kind: "unreadable" }
      },
    }

    expect(migrateFactVersions(dbFile, MIGRATION_ID, [selective], 3)).toEqual({ repaired: 1 })
    expect(visited).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(rows(dbFile, "probe.fact").slice(0, 6)).toEqual(before.slice(0, 6))
    expect(rows(dbFile, "probe.fact")[6]?.version).toBe(2)
    expect(rows(dbFile, "workspace.facts.migrated").map((row) => JSON.parse(row.payload).repaired)).toEqual([1])
    const head = headPosition(dbFile)
    expect(checked(dbFile)).toEqual([{ position: head, migrationId: MIGRATION_ID }])
    expect(migrateFactVersions(dbFile, MIGRATION_ID, [selective], 3)).toEqual({ repaired: 0 })
    expect(visited).toHaveLength(7)
    expect(headPosition(dbFile)).toBe(head)
  })
})
