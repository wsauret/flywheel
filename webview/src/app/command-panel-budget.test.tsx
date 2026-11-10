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
    // The reading follows the trigger that the runtime published, not the configured count.
    mounted.setPublishedTrigger(8_000)
    assert.equal(mounted.compactValueText(), "50% left")
    mounted.setPublishedTrigger(0)
    assert.match(mounted.compactValueText() ?? "", /% of window used$/)
  } finally {
    mounted.dispose()
  }
})
