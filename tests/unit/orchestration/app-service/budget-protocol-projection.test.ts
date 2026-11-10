import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { createBudgetProtocolProjection } from "../../../../src/orchestration/app-service/budget-protocol-projection.js"
import { createRuntimeSummaryProjection, type RuntimeSummaryView } from "../../../../src/orchestration/app-service/runtime-summary-projection.js"
import { BudgetPatchPayloadSchema, RuntimeBudgetSnapshotResultSchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { chatEntry, fakeSessionStore } from "./_frontend-projection-fixtures.js"

function row(tokens: number): Extract<SessionCatalogRow, { readonly totalsLoading: false }> {
  return {
    id: "chat-1", kind: "chat", title: "Chat", lifecycleState: "active", notices: [], inputMode: { kind: "chat" },
    lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/workspace", totalsLoading: false,
    totalCost: 1, totalBilledCost: 0.5, priceUnavailable: false, totalTokens: tokens,
    contextPercent: 20, contextPromptTokens: 200, durationMs: 10,
  }
}

function summaries(initial: RuntimeSummaryView) {
  let current = initial
  const listeners = new Set<(ids: readonly string[]) => void>()
  return {
    projection: {
      admit: async () => {},
      view: () => current,
      subscribe: (listener: (ids: readonly string[]) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      settled: async () => {},
      dispose() {},
    },
    replace(next: RuntimeSummaryView) { current = next; for (const listener of listeners) listener(["chat-1"]) },
  }
}

const flush = () => Bun.sleep(0)

describe("budget protocol projection", () => {
  test("publishes loading and then one exact complete replacement", async () => {
    const store = fakeSessionStore(new Map([["chat-1", chatEntry()]]))
    const summary = summaries({ totalsLoading: true })
    const patches: unknown[] = []
    const projection = createBudgetProtocolProjection({
      sessionStore: store,
      summaries: summary.projection,
      publish: (input) => { patches.push(input); return { ...input, position: 1, prevPosition: 0 } },
    })

    expect(await projection.snapshot("chat-1")).toEqual({ totalsLoading: true })
    summary.replace({ totalsLoading: false, row: row(42) })
    await flush()
    const ready = { totalsLoading: false as const, tokens: 42, cost: 1, billedCost: 0.5, priceUnavailable: false, contextPercent: 20, contextPromptTokens: 200 }
    expect(patches).toEqual([expect.objectContaining({ payload: { kind: "budget.updated", budget: ready } })])
    // A trigger that the runtime decides is a change of the budget on its own,
    // and it crosses the published codec.
    summary.replace({ totalsLoading: false, row: { ...row(42), compactionTriggerTokens: 850 } })
    await flush()
    const stated = { kind: "budget.updated" as const, budget: { ...ready, compactionTriggerTokens: 850 } }
    expect(patches.slice(1)).toEqual([expect.objectContaining({ payload: stated })])
    expect(Schema.decodeUnknownSync(BudgetPatchPayloadSchema)(stated)).toEqual(stated)
    projection.dispose()
  })

  test("a session whose runner leaves keeps its stored totals, and a later summary replaces them", async () => {
    const entries = new Map([["chat-1", chatEntry()]])
    const store = fakeSessionStore(entries)
    const summary = summaries({ totalsLoading: false, row: row(42) })
    const patches: unknown[] = []
    const projection = createBudgetProtocolProjection({
      sessionStore: store,
      summaries: summary.projection,
      publish: (input) => { patches.push(input); return { ...input, position: 1, prevPosition: 0 } },
    })
    const budget = (tokens: number) => ({
      totalsLoading: false as const, tokens, cost: 1, billedCost: 0.5, priceUnavailable: false, contextPercent: 20, contextPromptTokens: 200,
    })

    expect(await projection.snapshot("chat-1")).toEqual(budget(42))
    entries.delete("chat-1")
    store.emitChange("chat-1")
    await flush()
    summary.replace({ totalsLoading: false, row: row(50) })
    await flush()

    expect(patches).toEqual([expect.objectContaining({ payload: { kind: "budget.updated", budget: budget(50) } })])
    projection.dispose()
  })

  // bun test fails the running test on an unhandled rejection.
  test("a snapshot whose summary read fails or is interrupted leaves no unhandled rejection", async () => {
    const reads = [new DOMException("Runtime background call interrupted", "AbortError"), new Error("summary index unavailable")]
    const summaryProjection = createRuntimeSummaryProjection({
      background: {
        sessionSummaryImmediate: async () => { throw reads.shift() },
        waitForTotals: async () => { throw new Error("not used in this fixture") },
      },
      sessionPlacements: { placement: async () => null, observe: () => {} },
      onStored: () => () => {},
    })
    const projection = createBudgetProtocolProjection({
      sessionStore: fakeSessionStore(new Map([["chat-1", chatEntry()]])),
      summaries: summaryProjection,
      publish: (input) => ({ ...input, position: 1, prevPosition: 0 }),
    })
    try {
      expect(await projection.snapshot("chat-1")).toEqual({ totalsLoading: true })
      expect(await projection.snapshot("chat-1")).toEqual({ totalsLoading: true })
      await flush()
      expect(reads).toEqual([])
    } finally {
      projection.dispose()
      summaryProjection.dispose()
    }
  })

  test("strict schemas accept only explicit loading or complete ready budgets", () => {
    const loading = { totalsLoading: true } as const
    const ready = { totalsLoading: false, tokens: 12, cost: 0.25, billedCost: 0.1, priceUnavailable: true, contextPercent: 33, contextPromptTokens: 1000 } as const
    expect(Schema.decodeUnknownSync(RuntimeBudgetSnapshotResultSchema)({ snapshotPosition: 1, views: [{ sessionId: "s1", view: loading }] }).views[0]?.view).toEqual(loading)
    expect(Schema.decodeUnknownSync(BudgetPatchPayloadSchema)({ kind: "budget.updated", budget: ready })).toEqual({ kind: "budget.updated", budget: ready })
    const measured = { ...ready, averageGenerationTokensPerSecond: 18.24 }
    expect(Schema.decodeUnknownSync(BudgetPatchPayloadSchema)({ kind: "budget.updated", budget: measured })).toEqual({ kind: "budget.updated", budget: measured })
    expect(() => Schema.decodeUnknownSync(BudgetPatchPayloadSchema)({ kind: "budget.updated", budget: { ...ready, averageGenerationTokensPerSecond: "18" } })).toThrow()
    expect(Schema.decodeUnknownSync(BudgetPatchPayloadSchema)({ kind: "budget.updated", budget: { ...ready, extra: 1 } })).toEqual({ kind: "budget.updated", budget: ready })
    expect(() => Schema.decodeUnknownSync(BudgetPatchPayloadSchema)({ kind: "budget.updated", budget: { totalsLoading: false, tokens: 1 } })).toThrow()
    expect(() => Schema.decodeUnknownSync(BudgetPatchPayloadSchema)({ kind: "budget.updated", budget: { ...ready, totalsLoading: true } }, { onExcessProperty: "error" })).toThrow()
  })
})
