import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { createFrontendProjection, type SessionChange } from "../../../../src/orchestration/app-service/frontend-projection.js"
import type { DurableSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-types.js"
import { chatEntry, durableRow, durableSessionFromCatalogRow, fakeManager, fakeSessionStore } from "./_frontend-projection-fixtures.js"

describe("frontend projection metadata invalidation", () => {
  test("retains metadata signals received during a read and suppresses disposed publications", async () => {
    const first = Promise.withResolvers<{ sessions: DurableSessionCatalogRow[]; errors: [] }>()
    const second = Promise.withResolvers<{ sessions: DurableSessionCatalogRow[]; errors: [] }>()
    const started = Promise.withResolvers<void>()
    const restarted = Promise.withResolvers<void>()
    let reads = 0
    const manager = fakeManager({
      listForIds: async () => {
        reads++
        if (reads === 1) { started.resolve(); return first.promise }
        restarted.resolve()
        return second.promise
      },
    })
    const batches: SessionChange[][] = []
    const projection = createFrontendProjection({ sessionStore: fakeSessionStore(new Map()), manager, projectRoot: tmpdir(), maxSnapshotHz: 1000 })
    projection.subscribe((changes) => { batches.push([...changes]) })
    manager.emitChange(["cold"])
    await started.promise
    manager.emitChange(["cold"])
    first.resolve({ sessions: [durableRow("cold", { label: "first" })], errors: [] })
    await restarted.promise
    expect(batches).toHaveLength(0)
    projection.dispose()
    second.resolve({ sessions: [durableRow("cold", { label: "second" })], errors: [] })
    await Bun.sleep(0)
    expect(reads).toBe(2)
    expect(batches).toHaveLength(0)
  })
  test.each(["label", "role", "lifecycle"] as const)("%s changes leave unrelated durable and live rows untouched", async (field) => {
    let unrelatedAccesses = 0
    const rows = new Map<string, DurableSessionCatalogRow>(Array.from({ length: 1000 }, (_, i) => {
      const row = durableRow(`cold-${i}`, { executionCwd: tmpdir() })
      Object.defineProperty(row, "label", { get() { unrelatedAccesses++; return row.id } })
      return [row.id, row] as const
    }))
    rows.set("changed", durableRow("changed", { executionCwd: tmpdir() }))
    rows.set("live", durableRow("live", { executionCwd: tmpdir() }))
    rows.set("other-live", durableRow("other-live", { executionCwd: tmpdir() }))
    Object.defineProperty(rows.get("live")!, "lastUpdated", {
      get() { unrelatedAccesses++; return "2026-01-01T00:00:00.000Z" },
    })
    const live = chatEntry()
    Object.defineProperty(live, "description", { get() { unrelatedAccesses++; return "Live" } })
    let fullReads = 0
    const metadataReads: string[] = []
    const statReads: string[][] = []
    let roleChanged = false
    const manager = fakeManager({
      listMetadata: async () => { fullReads++; return { sessions: [...rows.values()], errors: [] } },
      read: async (id) => {
        metadataReads.push(id)
        const session = durableSessionFromCatalogRow(rows.get(id))
        return session && roleChanged ? { ...session, roles: {} } : session
      },
      listForIds: async (ids) => {
        statReads.push([...ids])
        return { sessions: ids.flatMap((id) => rows.has(id) ? [rows.get(id)!] : []), errors: [] }
      },
    })
    const projection = createFrontendProjection({
      sessionStore: fakeSessionStore(new Map([["live", live], ["other-live", chatEntry()]])), manager,
      projectRoot: tmpdir(), maxSnapshotHz: 1000,
    })
    expect((await projection.snapshot()).rows).toHaveLength(1003)
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })
    // Key every durable row first, so a later sweep cannot hide behind a cold baseline.
    manager.emitChange([...rows.keys()])
    await Bun.sleep(5)
    batches.length = 0
    fullReads = 0
    metadataReads.length = 0
    statReads.length = 0
    unrelatedAccesses = 0
    roleChanged = field === "role"
    rows.set("changed", durableRow("changed", {
      executionCwd: tmpdir(), lastUpdated: "2026-01-02T00:00:00.000Z",
      ...(field === "label" ? { label: "Renamed" } : {}),
      ...(field === "lifecycle" ? { lifecycleState: "active" } : {}),
    }))
    manager.emitChange(["changed"])
    await Bun.sleep(5)
    unsubscribe()
    expect(fullReads).toBe(0)
    expect(metadataReads).toEqual([])
    expect(statReads).toEqual([["changed"]])
    expect(unrelatedAccesses).toBe(0)
    expect(batches).toEqual([[{ kind: "updated", row: expect.objectContaining({
      id: "changed", lastUpdated: "2026-01-02T00:00:00.000Z",
      title: field === "label" ? "Renamed" : "changed",
      lifecycleState: field === "lifecycle" ? "active" : "inactive",
    }) }]])
    const change = batches[0]![0]!
    if (change.kind !== "removed") {
      expect(change.row.totalTokens).toBeUndefined()
      expect(change.row.totalCost).toBeUndefined()
      expect(change.row.diffStats).toBeUndefined()
    }
  })

  test("coalesced live metadata IDs refresh only that row, even without lastUpdated movement", async () => {
    const reads: string[][] = []
    let changed = false
    const manager = fakeManager({
      listForIds: async (ids) => {
        reads.push([...ids])
        return { sessions: ids.map((id) => durableRow(id, changed && id === "changed" ? { childSessionIds: ["child"] } : {})), errors: [] }
      },
      listMetadata: () => { throw new Error("unexpected whole catalog read") },
      read: () => { throw new Error("unexpected metadata-only read for a live row") },
    })
    const projection = createFrontendProjection({
      sessionStore: fakeSessionStore(new Map([["changed", chatEntry()], ["stable", chatEntry()]])), manager,
      projectRoot: tmpdir(), maxSnapshotHz: 1000,
    })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })
    reads.length = 0
    changed = true
    manager.emitChange(["changed"])
    manager.emitChange(["changed"])
    await Bun.sleep(5)
    unsubscribe()
    expect(reads).toEqual([["changed"]])
    expect(batches).toEqual([[{ kind: "updated", row: expect.objectContaining({ id: "changed", childSessionIds: ["child"] }) }]])
  })

  test("coalesced IDs, deletion and live departure refresh only their own metadata", async () => {
    const rows = new Map(["first", "second", "deleted", "departing", "stable"].map((id) => [id, durableRow(id)]))
    const entries = new Map([["departing", chatEntry()], ["stable", chatEntry()]])
    const store = fakeSessionStore(entries)
    const metadataReads: string[] = []
    const statReads: string[][] = []
    let fullReads = 0
    const manager = fakeManager({
      listMetadata: async () => { fullReads++; return { sessions: [...rows.values()], errors: [] } },
      read: async (id) => { metadataReads.push(id); return durableSessionFromCatalogRow(rows.get(id)) },
      listForIds: async (ids) => { statReads.push([...ids]); return { sessions: ids.flatMap((id) => rows.has(id) ? [rows.get(id)!] : []), errors: [] } },
    })
    const projection = createFrontendProjection({ sessionStore: store, manager, projectRoot: tmpdir(), maxSnapshotHz: 1000 })
    await projection.snapshot()
    fullReads = 0
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })
    statReads.length = 0
    manager.emitChange(["first", "deleted"])
    manager.emitChange(["first", "second"])
    rows.delete("deleted")
    manager.emitDeleted("deleted")
    entries.delete("departing")
    store.emitChange()
    expect(batches).toEqual([])
    await Bun.sleep(5)
    unsubscribe()
    expect(fullReads).toBe(0)
    expect(metadataReads).toEqual([])
    expect(statReads).toEqual([["departing", "first", "second"]])
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(4)
    expect(batches[0]).toEqual(expect.arrayContaining([
      { kind: "added", row: expect.objectContaining({ id: "first" }) },
      { kind: "added", row: expect.objectContaining({ id: "second" }) },
      { kind: "updated", row: expect.objectContaining({ id: "departing", activity: "absent" }) },
      { kind: "removed", sessionId: "deleted" },
    ]))
  })

  test("a deleted live row stays until its store entry departs, then is removed once", async () => {
    const rows = new Map([["live", durableRow("live")]])
    const entries = new Map([["live", chatEntry()]])
    const store = fakeSessionStore(entries)
    const manager = fakeManager({
      read: async (id) => durableSessionFromCatalogRow(rows.get(id)),
      listForIds: async (ids) => ({ sessions: ids.flatMap((id) => rows.has(id) ? [rows.get(id)!] : []), errors: [] }),
    })
    const projection = createFrontendProjection({ sessionStore: store, manager, projectRoot: tmpdir(), maxSnapshotHz: 1000 })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })
    rows.delete("live")
    manager.emitDeleted("live")
    await Bun.sleep(5)
    expect(batches).toEqual([])
    entries.delete("live")
    store.emitChange()
    await Bun.sleep(5)
    store.emitChange()
    await Bun.sleep(5)
    unsubscribe()
    expect(batches).toEqual([[{ kind: "removed", sessionId: "live" }]])
  })
})
