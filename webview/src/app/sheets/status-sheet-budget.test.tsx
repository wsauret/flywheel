import assert from "node:assert/strict"
import { test } from "node:test"

import { loadBudgetRenderFixture } from "../budget-render-test-loader.js"

test("Status Session and Spend follow the reactive selected budget", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusBudget()
  try {
    await mounted.settle()
    const stable = mounted.stableControl()
    assert.equal(mounted.sessionDetail()?.properties["aria-busy"], true)
    assert.match(mounted.sessionDetailText(), /totals loading/)
    assert.equal(mounted.spendValue()?.properties["aria-busy"], true)
    assert.equal(mounted.spendValueText(), "totals loading")
    mounted.setReady()
    assert.equal(mounted.sessionDetail()?.properties["aria-busy"], undefined)
    assert.match(mounted.sessionDetailText(), /12,345 tokens/)
    assert.equal(mounted.spendValue()?.properties["aria-busy"], undefined)
    assert.match(mounted.spendValueText(), /12,345 tokens/)
    assert.equal(mounted.stableControl(), stable)
  } finally {
    mounted.dispose()
  }
})

test("a nullable retained detail budget suppresses only scoped budget copy", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusBudget(true)
  try {
    await mounted.settle()
    assert.match(mounted.sessionDetailText(), /loaded from history · conversation/)
    assert.doesNotMatch(mounted.sessionDetailText(), /totals loading|tokens|usage unavailable/)
  } finally {
    mounted.dispose()
  }
})

test("Status calls a live chat open between turns and working while a turn runs", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusBudget(false, "live")
  try {
    await mounted.settle()
    assert.match(mounted.sessionDetailText(), /^open · conversation/)
    mounted.setBusy(true)
    assert.match(mounted.sessionDetailText(), /^working · conversation/)
  } finally {
    mounted.dispose()
  }
})

test("Status Spend preserves ready unavailable and zero-usage copy", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountStatusBudget()
  try {
    await mounted.settle()
    mounted.setBudget({
      totalsLoading: false,
      totalTokens: 10,
      contextPromptTokens: 5,
      cost: 1,
      billedCost: 0,
      priceUnavailable: true,
      contextPercent: 5,
      compactionThreshold: 100_000,
    })
    assert.match(mounted.spendValueText(), /10 tokens · price unavailable/)

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
    assert.match(mounted.spendValueText(), /0 tokens · no usage/)
  } finally {
    mounted.dispose()
  }
})
