import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { RuntimeQueryResult, SessionCatalogRow } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { sessionCursor, type RuntimeUiPatch } from "../../../src/protocol/runtime-ui-protocol-types.js"
import { fakeRuntimeConnection } from "./runtime-connection-fixture.js"
import { createSessionCatalog } from "./session-catalog.js"

/** Catalog snapshots and patches replace rows as complete protocol values. */

type ReadyRow = Extract<SessionCatalogRow, { readonly totalsLoading: false; readonly kind: "chat" }>

function row(id: string, overrides: Partial<ReadyRow> = {}): ReadyRow {
  return {
    id, kind: "chat", title: id, lifecycleState: "inactive", notices: [], inputMode: { kind: "chat" },
    lastUpdated: "2026-09-06T00:00:00.000Z", executionCwd: "/tmp/project", totalsLoading: false,
    totalCost: 0, totalBilledCost: 0, priceUnavailable: false, totalTokens: 0, contextPercent: 0,
    contextPromptTokens: 0, durationMs: 0, ...overrides,
  }
}

function loadingRow(id: string): Extract<SessionCatalogRow, { readonly totalsLoading: true }> {
  return {
    id, kind: "chat", title: id, lifecycleState: "inactive", notices: [], inputMode: { kind: "chat" },
    lastUpdated: "2026-09-06T00:00:00.000Z", executionCwd: "/tmp/project", totalsLoading: true,
  }
}

type CatalogSnapshot = RuntimeQueryResult<{ readonly type: "snapshot" }>
type Snapshot = Pick<CatalogSnapshot, "rows" | "snapshotPosition"> & Partial<Pick<CatalogSnapshot, "service">>

function connection(answer: () => Snapshot | Promise<Snapshot>): RuntimeConnection & { readonly reads: () => number } {
  let reads = 0
  const link = fakeRuntimeConnection({ queries: {
    snapshot: async () => {
      reads += 1
      return {
        activeRuntimeCount: 0, errors: [], projectRoot: "/tmp/project", runtimeVersion: "test", runtimeBuildId: null, chatDefault: { kind: "none" },
        executor: { kind: "serving" }, service: { kind: "serving" }, ...await answer(),
      }
    },
  } })
  return { ...link, reads: () => reads }
}

function updated(id: string, position: number, prevPosition: number, next: SessionCatalogRow): RuntimeUiPatch {
  return { cursor: sessionCursor(id), position, prevPosition, payload: { kind: "session.updated", row: next } }
}

describe("session catalog", () => {
  test("the account service's report comes from the snapshot and follows each service patch", async () => {
    const link = connection(() => ({ rows: [], snapshotPosition: 2, service: { kind: "crash_loop", cause: "the hub stopped" } }))
    const catalog = createSessionCatalog({ connection: link })
    await catalog.resnapshot()
    assert.deepEqual(catalog.service, { kind: "crash_loop", cause: "the hub stopped" })
    catalog.accept({ cursor: { scope: "workspace", domain: "service" }, position: 3, prevPosition: 2, payload: { kind: "service.changed", service: { kind: "serving" } } })
    assert.deepEqual(catalog.service, { kind: "serving" })
    catalog.dispose()
  })

  test("a deferred resnapshot buffers creation, removal, and updates without blanking visible rows", async () => {
    const pending = Promise.withResolvers<Snapshot>()
    let answer: Snapshot | Promise<Snapshot> = { rows: [row("a"), row("removed")], snapshotPosition: 2 }
    const link = connection(() => answer)
    const catalog = createSessionCatalog({ connection: link })
    await catalog.resnapshot()
    answer = pending.promise
    const read = catalog.resnapshot()
    await Promise.resolve()
    catalog.accept(updated("a", 3, 1, row("a", { title: "new title" })))
    catalog.accept({ cursor: sessionCursor("new"), position: 4, prevPosition: 0, payload: { kind: "session.added", row: row("new") } })
    catalog.accept({ cursor: sessionCursor("removed"), position: 5, prevPosition: 2, payload: { kind: "session.removed" } })
    assert.deepEqual(catalog.rows.map((entry) => [entry.id, entry.title]), [["a", "a"], ["removed", "removed"]])
    pending.resolve({ rows: [row("a"), row("removed")], snapshotPosition: 2 })
    await read
    assert.deepEqual(catalog.rows.map((entry) => [entry.id, entry.title]), [["a", "new title"], ["new", "new"]])
    assert.equal(link.reads(), 2)
    catalog.dispose()
  })

  test("a cursor absent from captured rows replays creation and removal during the read", async () => {
    const pending = Promise.withResolvers<Snapshot>()
    let answer: Snapshot | Promise<Snapshot> = { rows: [], snapshotPosition: 2 }
    const link = connection(() => answer)
    const catalog = createSessionCatalog({ connection: link })
    await catalog.resnapshot()
    catalog.accept(updated("old", 3, 0, row("old")))
    catalog.accept({ cursor: sessionCursor("old"), position: 4, prevPosition: 3, payload: { kind: "session.removed" } })
    answer = pending.promise
    const read = catalog.resnapshot()
    await Promise.resolve()
    catalog.accept(updated("old", 5, 4, row("old")))
    catalog.accept(updated("temporary", 6, 0, row("temporary")))
    catalog.accept({ cursor: sessionCursor("temporary"), position: 7, prevPosition: 6, payload: { kind: "session.removed" } })
    pending.resolve({ rows: [], snapshotPosition: 4 })
    await read
    assert.deepEqual(catalog.rows.map((entry) => entry.id), ["old"])
    assert.equal(link.reads(), 2)
    catalog.dispose()
  })

  test("resnapshot bursts join the read in flight; the patch behind a mutation lands on top of it", async () => {
    const first = Promise.withResolvers<Snapshot>()
    let read = 0
    const link = connection(() => {
      read += 1
      if (read === 1) return first.promise
      throw new Error("unexpected session catalog read")
    })
    const catalog = createSessionCatalog({ connection: link })

    const initial = catalog.resnapshot()
    await Promise.resolve()
    const joined = [catalog.resnapshot(), catalog.resnapshot(), catalog.resnapshot()]
    // The mutation's own patch carries a position past the read's watermark.
    catalog.accept({ cursor: sessionCursor("fresh"), position: 2, prevPosition: 0, payload: { kind: "session.added", row: row("fresh") } })
    first.resolve({ rows: [row("stale")], snapshotPosition: 1 })
    await Promise.all([initial, ...joined])

    assert.equal(link.reads(), 1)
    assert.deepEqual(catalog.rows.map((entry) => entry.id), ["stale", "fresh"])
    catalog.dispose()
  })

  test("a loading snapshot keeps a warmed row's aggregates beside its fresh metadata", async () => {
    let snapshotPosition = 10
    let rows: SessionCatalogRow[] = [row("a")]
    const link = connection(() => ({ rows, snapshotPosition }))
    const catalog = createSessionCatalog({ connection: link })
    await catalog.resnapshot()
    assert.equal(catalog.rows[0]?.diffStats, undefined)

    const warmed = row("a", { totalCost: 1.25, durationMs: 9000, contextPercent: 15, diffStats: { added: 3, modified: 1, removed: 2 } })
    catalog.accept(updated("a", 11, 10, warmed))
    assert.deepEqual(catalog.rows[0]?.diffStats, { added: 3, modified: 1, removed: 2 })

    snapshotPosition = 12
    rows = [{ ...loadingRow("a"), lifecycleState: "active" }]
    await catalog.resnapshot()
    assert.deepEqual(catalog.rows[0], { ...warmed, lifecycleState: "active" })
    catalog.dispose()
  })

  test("a session that appears after the snapshot anchors at the snapshot and lands at once", async () => {
    const link = connection(() => ({ rows: [row("a")], snapshotPosition: 10 }))
    const catalog = createSessionCatalog({ connection: link })
    await catalog.resnapshot()
    catalog.accept({ cursor: sessionCursor("b"), position: 11, prevPosition: 10, payload: { kind: "session.added", row: row("b") } })
    assert.deepEqual(catalog.rows.map((entry) => entry.id), ["a", "b"])
    catalog.dispose()
  })

  test("a removal drops the row without a read", async () => {
    const link = connection(() => ({ rows: [row("a"), row("b")], snapshotPosition: 10 }))
    const catalog = createSessionCatalog({ connection: link })
    await catalog.resnapshot()
    catalog.accept({ cursor: sessionCursor("b"), position: 11, prevPosition: 10, payload: { kind: "session.removed" } })
    assert.deepEqual(catalog.rows.map((entry) => entry.id), ["a"])
    assert.equal(link.reads(), 1)
    catalog.dispose()
  })

  test("a stale patch is ignored and an invalidated cursor reads again", async () => {
    const recovery = Promise.withResolvers<Snapshot>()
    const recoveryStarted = Promise.withResolvers<void>()
    let read = 0
    const link = connection(() => {
      read += 1
      if (read === 1) return { rows: [row("a", { title: "fresh" })], snapshotPosition: 10 }
      recoveryStarted.resolve()
      return recovery.promise
    })
    const catalog = createSessionCatalog({ connection: link })
    await catalog.resnapshot()
    catalog.accept(updated("a", 9, 8, row("a", { title: "old" })))
    assert.equal(catalog.rows[0]?.title, "fresh")

    const recovered = Promise.withResolvers<void>()
    catalog.onChange(() => { recovered.resolve() })
    catalog.accept({ cursor: sessionCursor("a"), position: 11, prevPosition: 10, payload: { kind: "runtime.invalidate", reason: "overflow" } })
    await recoveryStarted.promise
    recovery.resolve({ rows: [row("a", { title: "recovered" })], snapshotPosition: 11 })
    await recovered.promise
    assert.equal(link.reads(), 2)
    assert.equal(catalog.rows[0]?.title, "recovered")
    catalog.dispose()
  })
})
