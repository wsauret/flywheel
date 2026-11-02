import assert from "node:assert/strict"
import { test } from "node:test"

import { loadBudgetRenderFixture } from "./budget-render-test-loader.js"

test("command panel keeps Compact conversation loading copy without adding a Spend row", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountCommandPanelBudget()
  try {
    const stable = mounted.compactRow()
    assert.notEqual(stable, undefined)
    assert.equal(mounted.spendRow(), undefined)
    assert.equal(mounted.compactValue()?.properties["aria-busy"], true)
    assert.equal(mounted.compactValueText(), "totals loading")
    mounted.setReady()
    assert.equal(mounted.spendRow(), undefined)
    assert.equal(mounted.compactValue()?.properties["aria-busy"], undefined)
    assert.equal(mounted.compactValueText(), "96% left")
    assert.equal(mounted.compactRow(), stable)
  } finally {
    mounted.dispose()
  }
})
