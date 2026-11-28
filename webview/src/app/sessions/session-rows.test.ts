import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { SessionSummary } from "../../client/session/view-state.js"
import { selectNeedsYou } from "../../../../src/protocol/client/session/needs-you.js"
import type { StoppedChat, UnreadChatsView } from "../../../../src/protocol/session/unread-protocol-types.js"
import { layoutSessionRows, type SessionRow } from "./session-rows.js"
import { loadBudgetRenderFixture } from "../../test-support/budget-render-test-loader.js"

const HOUR = 3_600_000
const NOW = Date.parse("2026-09-18T12:00:00.000Z")
function summary(id: string, ageMs: number, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: id, kind: "chat", lifecycleState: "inactive", active: false, working: false, lastUpdated: new Date(NOW - ageMs).toISOString(), totalsLoading: true, ...overrides }
}

/** Lays out `sessions` as the list does, with the waiting set that their
 *  waiting marks come from and the project's unread set. */
function layout(sessions: readonly SessionSummary[], grouped: boolean, previous: readonly SessionRow[], unread?: UnreadChatsView): SessionRow[] {
  const waiting = { sessions: sessions.flatMap((session) => session.awaitingAnswer ? [{ sessionId: session.id, openedAt: Date.parse(session.lastUpdated) }] : []) }
  return layoutSessionRows(sessions, selectNeedsYou({ waiting, unread, listed: sessions }), unread?.turns, grouped, previous)
}

function stop(sessionId: string, ageMs: number, overrides: Partial<StoppedChat> = {}): StoppedChat {
  return { sessionId, ending: { kind: "completed" }, firstLine: `${sessionId} is done`, stoppedAt: NOW - ageMs, stopKey: `entry-${sessionId}`, ...overrides }
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
    const rows = layout([
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

  test("a stopped unread chat needs the person after the questions, newest stop first, closed or not", () => {
    const sessions = [
      summary("question", 4 * HOUR, { awaitingAnswer: true }),
      summary("stopped-old", 0, { lifecycleState: "inactive" }),
      summary("stopped-new", 3 * HOUR, { lifecycleState: "active", active: true }),
      summary("recent", 1 * HOUR),
    ]
    const rows = layout(sessions, true, [], { stopped: [stop("stopped-new", 1 * HOUR), stop("stopped-old", 2 * HOUR, { ending: { kind: "failed", failure: "api_error" } })], unread: [], turns: {} })
    assert.deepEqual(rows.map((row) => [row.session.id, row.heading, row.need]), [
      ["question", "Needs you", "question"],
      ["stopped-new", undefined, "stopped"],
      ["stopped-old", undefined, "stopped"],
      ["recent", "Recent", undefined],
    ])
    assert.equal(rows[1]?.stopped?.firstLine, "stopped-new is done")
    assert.deepEqual(rows[2]?.stopped?.ending, { kind: "failed", failure: "api_error" })
  })

  test("a working chat with unread messages keeps its place and carries the mark", () => {
    const sessions = [summary("newer", 0, { working: true }), summary("unread", 1 * HOUR, { working: true })]
    const before = layout(sessions, true, [])
    const rows = layout(sessions, true, before, { stopped: [], unread: ["unread"], turns: {} })
    assert.deepEqual(rows.map((row) => [row.session.id, row.group, row.unread]), [["newer", "Working", false], ["unread", "Working", true]])
    assert.equal(rows[0], before[0])
  })

  test("a set republished with equal stops keeps every row", () => {
    const sessions = [summary("stopped", 0)]
    const first = layout(sessions, true, [], { stopped: [stop("stopped", 0)], unread: [], turns: {} })
    const second = layout(sessions, true, first, { stopped: [stop("stopped", 0)], unread: [], turns: {} })
    assert.equal(second[0], first[0])
    const read = layout(sessions, true, second, { stopped: [], unread: [], turns: {} })
    assert.deepEqual(read.map((row) => [row.group, row.need]), [["Recent", undefined]])
  })

  test("the Working group follows the same working reading as the row's dot, and a warning needs no one", () => {
    for (const working of [true, false]) {
      const [row] = layout([summary("session", 0, { working })], true, [])
      assert.equal(row?.group, working ? "Working" : "Recent")
    }
    const [warning] = layout([summary("warning", 0, { notices: [{ id: "warning", scope: "session", presentation: "provider.status_alert", severity: "warning", title: "Warning", message: "Warning", startedAt: 1, updatedAt: 1 }] })], true, [])
    assert.equal(warning?.group, "Recent")
  })

  test("Working and Recent order by the latest turn, which the row's time shows, and an opened chat keeps its place", () => {
    const sessions = [summary("opened", 0), summary("worked", 5 * HOUR), summary("busy", 6 * HOUR, { working: true })]
    const turns = { opened: NOW - 3 * HOUR, worked: NOW - HOUR, busy: NOW - 2 * HOUR }
    const first = layout(sessions, true, [], { stopped: [], unread: [], turns })
    assert.deepEqual(first.map((row) => [row.session.id, row.group, row.lastActiveAt]), [["busy", "Working", turns.busy], ["worked", "Recent", turns.worked], ["opened", "Recent", turns.opened]])
    // Opening a chat writes its last change and no turn: nothing moves, and
    // the rows that did not change keep their identity.
    const opened = layout([summary("opened", 0, { active: true, lifecycleState: "active" }), sessions[1]!, sessions[2]!], true, first, { stopped: [], unread: [], turns })
    assert.deepEqual(opened.map((row) => row.session.id), ["busy", "worked", "opened"])
    assert.equal(opened[0], first[0])
    assert.equal(opened[1], first[1])
    // A new turn moves its chat and its time only.
    const turned = layout(sessions, true, opened, { stopped: [], unread: [], turns: { ...turns, opened: NOW } })
    assert.deepEqual(turned.map((row) => [row.session.id, row.lastActiveAt]), [["busy", turns.busy], ["opened", NOW], ["worked", turns.worked]])
    assert.equal(turned[0], first[0])
  })

  test("filtered lists omit empty groups and preserve priority", () => {
    const rows = layout([
      summary("recent", 0),
      summary("question", HOUR, { awaitingAnswer: true }),
    ], true, [])
    assert.deepEqual(rows.map((row) => row.heading), ["Needs you", "Recent"])
    assert.deepEqual(layout([summary("recent", 0)], true, rows).map((row) => row.heading), ["Recent"])
  })

  test("keeps a row's identity while its session, place, and heading hold", () => {
    const a = summary("a", 0)
    const b = summary("b", 1 * HOUR)
    const first = layout([a, b], true, [])
    const second = layout([a, { ...b, title: "renamed" }], true, first)
    assert.equal(second[0], first[0])
    assert.notEqual(second[1], first[1])
  })

  test("re-mints a row that moved or gained a heading", () => {
    const a = summary("a", 0)
    const b = summary("b", 1 * HOUR)
    const first = layout([a, b], true, [])
    assert.equal(first[1]?.heading, undefined)
    const without = layout([b], true, first)
    assert.notEqual(without[0], first[1])
    assert.equal(without[0]?.heading, "Recent")
    const ungrouped = layout([a, b], false, first)
    assert.equal(ungrouped[0]?.heading, undefined)
    assert.notEqual(ungrouped[0], first[0])
  })
})
