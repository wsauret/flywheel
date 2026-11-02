import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { SessionSummary } from "../client/view-state.js"
import { layoutSessionRows } from "./session-rows.js"
import { loadBudgetRenderFixture } from "./budget-render-test-loader.js"

const HOUR = 3_600_000
const NOW = Date.parse("2026-09-18T12:00:00.000Z")
function summary(id: string, ageMs: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: id, kind: "chat", lifecycleState: "inactive", active: false, working: false, lastUpdated: new Date(NOW - ageMs).toISOString(), totalsLoading: true, ...overrides }
}

describe("session row layout", () => {
  test("catalog resnapshots keep an unreadable row and its current delete control", async () => {
    const fixture = await loadBudgetRenderFixture()
    const mounted = fixture.mountSessionListBudget()
    try {
      mounted.setErrors([{ sessionId: "unreadable", scope: "metadata", reason: "First error" }])
      const button = mounted.elements().find(node => node.properties["aria-label"] === "Delete unreadable")
      assert.ok(button)
      button.focus()
      mounted.setErrors([{ sessionId: "unreadable", scope: "metadata", reason: "Current error" }])
      assert.ok(mounted.elements().includes(button))
      const click = button.properties.onClick
      if (typeof click === "function") click()
      assert.deepEqual(mounted.deleted, ["unreadable"])
    } finally { mounted.dispose() }
  })
  test("only a waiting question needs the person; work, then recency, orders the rest", () => {
    const rows = layoutSessionRows([
      summary("old", 50 * HOUR),
      summary("working", 2 * HOUR, { working: true }),
      summary("today", 0),
      summary("question", 4 * HOUR, { awaitingAnswer: true, working: true }),
      // An interrupted turn and an error block nothing on the person.
      summary("interrupted", 3 * HOUR, { admittedActions: ["chat.resume"] }),
      summary("error", 1 * HOUR, { notices: [{ id: "error", scope: "session", presentation: "transcript.unavailable", severity: "error", title: "Error", message: "Failed", startedAt: 1, updatedAt: 1 }] }),
    ], true, [])
    assert.deepEqual(rows.map((row) => [row.session.id, row.heading, row.need]), [
      ["question", "Needs you", "question"],
      ["working", "Working", undefined],
      ["today", "Recent", undefined],
      ["error", undefined, "error"],
      ["interrupted", undefined, undefined],
      ["old", undefined, undefined],
    ])
  })

  test("the Working group follows the same working reading as the row's dot, and a warning needs no one", () => {
    for (const working of [true, false]) {
      const [row] = layoutSessionRows([summary("session", 0, { working })], true, [])
      assert.equal(row?.group, working ? "Working" : "Recent")
    }
    const [warning] = layoutSessionRows([summary("warning", 0, { notices: [{ id: "warning", scope: "session", presentation: "provider.status_alert", severity: "warning", title: "Warning", message: "Warning", startedAt: 1, updatedAt: 1 }] })], true, [])
    assert.equal(warning?.group, "Recent")
  })

  test("filtered lists omit empty groups and preserve priority", () => {
    const rows = layoutSessionRows([
      summary("recent", 0),
      summary("question", HOUR, { awaitingAnswer: true }),
    ], true, [])
    assert.deepEqual(rows.map((row) => row.heading), ["Needs you", "Recent"])
    assert.deepEqual(layoutSessionRows([summary("recent", 0)], true, rows).map((row) => row.heading), ["Recent"])
  })

  test("keeps a row's identity while its session, place, and heading hold", () => {
    const a = summary("a", 0)
    const b = summary("b", 1 * HOUR)
    const first = layoutSessionRows([a, b], true, [])
    const second = layoutSessionRows([a, { ...b, title: "renamed" }], true, first)
    assert.equal(second[0], first[0])
    assert.notEqual(second[1], first[1])
  })

  test("re-mints a row that moved or gained a heading", () => {
    const a = summary("a", 0)
    const b = summary("b", 1 * HOUR)
    const first = layoutSessionRows([a, b], true, [])
    assert.equal(first[1]?.heading, undefined)
    const without = layoutSessionRows([b], true, first)
    assert.notEqual(without[0], first[1])
    assert.equal(without[0]?.heading, "Recent")
    const ungrouped = layoutSessionRows([a, b], false, first)
    assert.equal(ungrouped[0]?.heading, undefined)
    assert.notEqual(ungrouped[0], first[0])
  })
})
