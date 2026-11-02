import { tmpdir } from "node:os"
import { describe, expect, test } from "bun:test"
import { createFrontendProjection, type SessionChange } from "../../../../src/orchestration/app-service/frontend-projection.js"
import type { RuntimeSummaryView } from "../../../../src/orchestration/app-service/runtime-summary-projection.js"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { chatEntry, durableRow, fakeSessionStore, managerWithSessions } from "./_frontend-projection-fixtures.js"

function readyRow(tokens: number): Extract<SessionCatalogRow, { readonly totalsLoading: false }> {
  return {
    id: "live", kind: "chat", title: "live", lifecycleState: "inactive", notices: [], inputMode: { kind: "chat" },
    lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/workspace", totalsLoading: false,
    totalCost: 2, totalBilledCost: 1, priceUnavailable: false, totalTokens: tokens,
    contextPercent: 44, contextPromptTokens: 55, durationMs: 100,
  }
}

function summaries() {
  const views = new Map<string, RuntimeSummaryView>()
  const listeners = new Set<(ids: readonly string[]) => void>()
  return {
    projection: {
      admit: async () => {},
      view: (id: string) => views.get(id) ?? { totalsLoading: true as const },
      subscribe: (listener: (ids: readonly string[]) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      settled: async () => {}, dispose() {},
    },
    replace(id: string, view: RuntimeSummaryView) { views.set(id, view); for (const listener of listeners) listener([id]) },
  }
}

describe("frontend projection summary totals", () => {
  test("snapshot returns metadata with loading totals and never asks the manager for stat rows", async () => {
    let fullReads = 0
    const manager = managerWithSessions([durableRow("live")], { listForIds: async () => { fullReads++; throw new Error("stat read forbidden") } })
    const summary = summaries()
    const projection = createFrontendProjection({ sessionStore: fakeSessionStore(new Map([["live", chatEntry()]])), manager, projectRoot: tmpdir(), summaries: summary.projection })

    const snapshot = await projection.snapshot()
    expect(snapshot.rows).toEqual([expect.objectContaining({ id: "live", totalsLoading: true })])
    expect(snapshot.rows[0]?.totalTokens).toBeUndefined()
    expect(fullReads).toBe(0)
    projection.dispose()
  })

  test("summary settlement publishes a complete exact row replacement", async () => {
    const manager = managerWithSessions([durableRow("live")])
    const summary = summaries()
    const projection = createFrontendProjection({ sessionStore: fakeSessionStore(new Map([["live", chatEntry()]])), manager, projectRoot: tmpdir(), summaries: summary.projection, maxSnapshotHz: 1000 })
    const batches: SessionChange[][] = []
    const unsubscribe = projection.subscribe((changes) => { batches.push([...changes]) })
    await Bun.sleep(0)

    summary.replace("live", { totalsLoading: false, row: readyRow(99) })
    await Bun.sleep(5)

    expect(batches.flat()).toContainEqual({ kind: "updated", row: expect.objectContaining({
      id: "live", totalsLoading: false, totalCost: 2, totalBilledCost: 1, totalTokens: 99, contextPercent: 44, contextPromptTokens: 55, durationMs: 100,
    }) })
    unsubscribe()
  })
})
