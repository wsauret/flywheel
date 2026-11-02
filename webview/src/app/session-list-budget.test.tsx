import assert from "node:assert/strict"
import { test } from "node:test"

import { loadBudgetRenderFixture } from "./budget-render-test-loader.js"

test("session metadata shows only loading totals and restores prior metadata gating", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountSessionListBudget()
  try {
    const stable = mounted.stableControl()
    assert.equal(mounted.meta()?.properties["aria-busy"], true)
    assert.equal(mounted.metaText(), "totals loadingquestion+1~2-3")
    assert.deepEqual(mounted.badge()?.properties.classList, { waiting: true, error: false })
    mounted.setReady()
    assert.equal(mounted.meta()?.properties["aria-busy"], undefined)
    assert.equal(mounted.metaText(), "question+1~2-3")
    assert.equal(mounted.stableControl(), stable)
    for (const [diffStats, expected] of [
      [{ added: 1, modified: 0, removed: 0 }, "question+1"],
      [{ added: 0, modified: 2, removed: 0 }, "question~2"],
      [{ added: 0, modified: 0, removed: 3 }, "question-3"],
      [{ added: 0, modified: 0, removed: 0 }, "question"],
    ] as const) {
      mounted.setReady(diffStats)
      assert.equal(mounted.metaText(), expected)
    }
  } finally {
    mounted.dispose()
  }
})

test("the list reveals its selected row on first show, not on updates or later shows", async () => {
  const mounted = (await loadBudgetRenderFixture()).mountSessionListBudget()
  try {
    const row = mounted.selectedRow()
    assert.ok(row)
    assert.equal(row.properties.scrolledIntoView, undefined)
    mounted.show()
    assert.deepEqual(row.properties.scrolledIntoView, { block: "nearest", behavior: "instant" })
    delete row.properties.scrolledIntoView
    mounted.setReady()
    assert.equal(row.properties.scrolledIntoView, undefined)
    // An interrupted chat blocks nothing on the person, so its row carries no badge.
    mounted.setNeed({ awaitingAnswer: false, admittedActions: ["chat.resume"] })
    assert.equal(mounted.badge(), undefined)
  } finally { mounted.dispose() }
})
