import { describe, expect, it } from "bun:test"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import type { BudgetView } from "../../../../src/protocol/budget-protocol-types.js"
import { mergeBudgetView, mergeCatalogRow } from "../../../../src/protocol/client/known-totals.js"

function loading(title = "First"): SessionCatalogRow {
  return {
    id: "chat-1", kind: "chat", title, lifecycleState: "inactive", notices: [], inputMode: { kind: "chat" },
    lastUpdated: "2026-09-06T00:00:00.000Z", executionCwd: "/scratch/project", totalsLoading: true,
  }
}

function ready(title = "First"): Extract<SessionCatalogRow, { readonly totalsLoading: false }> {
  return {
    ...loading(title), totalsLoading: false, totalCost: 1.25, totalBilledCost: 0.5, priceUnavailable: false,
    totalTokens: 500, contextPercent: 12, contextPromptTokens: 300, durationMs: 9000,
    diffStats: { added: 1, modified: 2, removed: 3 },
  }
}

describe("mergeCatalogRow", () => {
  it("uses every incoming row as the complete replacement", () => {
    const next = ready()
    expect(mergeCatalogRow(undefined, next)).toBe(next)
    expect(mergeCatalogRow(ready(), ready("Renamed"))).toEqual(ready("Renamed"))
  })

  it("a loading replacement keeps the totals the client knows beside the fresh metadata", () => {
    expect(mergeCatalogRow(ready(), { ...loading("Renamed"), lifecycleState: "active" })).toEqual({ ...ready("Renamed"), lifecycleState: "active" })
    const { diffStats: _unknown, ...withoutDiffStats } = ready()
    expect(mergeCatalogRow(withoutDiffStats, loading("Renamed"))).toEqual({ ...withoutDiffStats, title: "Renamed" })
  })

  it("marks loading only while no total was ever known", () => {
    const next = loading("Renamed")
    expect(mergeCatalogRow(undefined, next)).toBe(next)
    expect(mergeCatalogRow(loading(), next)).toBe(next)
  })

  it("a ready replacement carries exact zeros", () => {
    const zero: SessionCatalogRow = {
      ...ready(), totalCost: 0, totalBilledCost: 0, totalTokens: 0, contextPercent: 0, contextPromptTokens: 0, durationMs: 0,
    }
    expect(mergeCatalogRow(loading(), zero)).toBe(zero)
    expect(mergeCatalogRow(ready(), zero)).toBe(zero)
  })
})

describe("mergeBudgetView", () => {
  const known: BudgetView = { totalsLoading: false, tokens: 500, cost: 1.25, billedCost: 0.5, priceUnavailable: false, contextPercent: 15, contextPromptTokens: 300, averageGenerationTokensPerSecond: 18.24 }
  const loadingBudget: BudgetView = { totalsLoading: true }

  it("keeps a known budget under a loading one, and marks loading only while none was known", () => {
    expect(mergeBudgetView(known, loadingBudget)).toBe(known)
    expect(mergeBudgetView(undefined, loadingBudget)).toBe(loadingBudget)
    expect(mergeBudgetView(loadingBudget, loadingBudget)).toBe(loadingBudget)
  })

  it("uses every ready budget as the complete replacement, zeros included", () => {
    const zero: BudgetView = { ...known, tokens: 0, cost: 0, billedCost: 0, contextPercent: 0, contextPromptTokens: 0 }
    expect(mergeBudgetView(known, zero)).toBe(zero)
    expect(mergeBudgetView(loadingBudget, known)).toBe(known)
  })
})
