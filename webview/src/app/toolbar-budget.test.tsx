import assert from "node:assert/strict"
import { test } from "node:test"

import { loadBudgetRenderFixture } from "./budget-render-test-loader.js"

test("every header layout carries the session's live worktree branch and accessible branch label", async () => {
  const fixture = await loadBudgetRenderFixture()
  for (const layout of ["wide", "folded", "phone", "narrow"] as const) {
    const mounted = fixture.mountToolbarBudget(layout)
    try {
      const directories = { "/scratch/project": { branch: "main" }, "/linked/package": { branch: "feature", worktreeRoot: "/linked" } }
      mounted.setLocation("/linked/package", { directories })
      assert.equal(mounted.location()?.properties.title, "/linked/package")
      assert.match(mounted.locationText() ?? "", new RegExp(`^${layout === "phone" ? "Phone project" : "project"} · linked ·\\s*branch\\s+feature$`))
      mounted.setLocation("/linked/package", { directories: { ...directories, "/linked/package": { branch: "switched", worktreeRoot: "/linked" } } })
      assert.match(mounted.text(), /linked ·\s*branch\s+switched/)
    } finally { mounted.dispose() }
  }
})

test("toolbar owns visible and accessible totals loading until complete replacement", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountToolbarBudget()
  try {
    const stable = mounted.stableControl()
    const gauge = mounted.gauge()
    assert.ok(gauge)
    assert.equal(mounted.pill()?.properties["aria-busy"], true)
    assert.equal(mounted.pillText(), "totals loading")
    assert.equal(mounted.generationSpeed(), undefined)
    mounted.setReady()
    assert.equal(mounted.pill()?.properties["aria-busy"], undefined)
    assert.equal(mounted.pillText(), "$0.50")
    assert.equal(mounted.stableControl(), stable)
    assert.equal(mounted.gauge(), gauge)
    const ready = {
      totalsLoading: false as const, totalTokens: 12345, contextPromptTokens: 4000,
      cost: 1.25, billedCost: 0.5, priceUnavailable: false, contextPercent: 25, compactionThreshold: 100_000,
    }
    mounted.setBudget({ ...ready, averageGenerationTokensPerSecond: 18.24 })
    mounted.setBusy(true)
    assert.match(mounted.text(), /\$0\.50.*18\.2 avg tok\/s/)
    assert.equal(mounted.generationSpeed()?.tag, "span")
    assert.equal(mounted.generationSpeed()?.properties.title, "This agent's average generation speed in local comparison tokens. Open Stats for coverage.")
    mounted.setBusy(false)
    assert.match(mounted.text(), /18\.2 avg tok\/s/)
    mounted.setBudget({ ...ready, averageGenerationTokensPerSecond: 24.56 })
    assert.match(mounted.text(), /24\.6 avg tok\/s/)
    assert.equal(mounted.stableControl(), stable)
    assert.equal(mounted.gauge(), gauge)
    mounted.setSession("session-b", ready)
    assert.equal(mounted.generationSpeed(), undefined)
  } finally {
    mounted.dispose()
  }
})

test("the toolbar shows context loading and usage, and compacts only through its explanation", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountToolbarBudget("phone")
  try {
    assert.equal(mounted.contextButton()?.properties["aria-label"], "Context totals loading")
    const budget = {
      totalsLoading: false as const, totalTokens: 12345, contextPromptTokens: 4000,
      cost: 1.25, billedCost: 0.5, priceUnavailable: false, contextPercent: 25, compactionThreshold: 100_000,
    }
    mounted.setBudget(budget)
    assert.equal(mounted.contextText(), "4%")
    assert.equal(mounted.contextButton()?.properties["aria-label"], "Context usage 4%. 96% of context remaining until auto-compact.")
    mounted.setBudget({ ...budget, compactionThreshold: 0 })
    assert.equal(mounted.contextText(), "25%")
    assert.equal(mounted.contextButton()?.properties["aria-label"], "Context usage 25%. 25% of the context window used.")
    mounted.clickContext()
    assert.ok(mounted.contextPopover())
    assert.equal(mounted.contextButton()?.properties.title, undefined, "the hover tooltip must not cover the explanation")
    assert.equal(mounted.compactions(), 0)
    mounted.compactContext()
    assert.equal(mounted.contextPopover(), undefined)
    assert.match(String(mounted.contextButton()?.properties.title), /Click for context details/)
    assert.equal(mounted.compactions(), 1)
    assert.equal(mounted.contextButton()?.properties["aria-busy"], true)
    await mounted.answerCompaction()
    assert.equal(mounted.contextButton()?.properties["aria-busy"], undefined)
  } finally { mounted.dispose() }
})

test("toolbar preserves ready price and subscription wording", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountToolbarBudget()
  try {
    mounted.setBudget({
      totalsLoading: false,
      totalTokens: 1,
      contextPromptTokens: 1,
      cost: 1.25,
      billedCost: 0,
      priceUnavailable: true,
      contextPercent: 1,
      compactionThreshold: 100_000,
    })
    assert.equal(mounted.pillText(), "price unavailable")
    assert.match(String(mounted.pill()?.properties.title), /known model cost.*total is incomplete/)

    mounted.setBudget({
      totalsLoading: false,
      totalTokens: 1,
      contextPromptTokens: 1,
      cost: 1.25,
      billedCost: 0,
      priceUnavailable: false,
      contextPercent: 1,
      compactionThreshold: 100_000,
    })
    assert.equal(mounted.pillText(), "~$1.25")
    assert.match(String(mounted.pill()?.properties.title), /covered by your subscription/)

    mounted.setBudget({
      totalsLoading: false,
      totalTokens: 0,
      contextPromptTokens: 0,
      cost: 0,
      billedCost: 0,
      priceUnavailable: false,
      contextPercent: 0,
      compactionThreshold: 100_000,
    })
    assert.equal(mounted.pillText(), "no usage")
  } finally {
    mounted.dispose()
  }
})
