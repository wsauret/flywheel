import assert from "node:assert/strict"
import { test } from "node:test"

import { loadBudgetRenderFixture } from "../../test-support/budget-render-test-loader.js"
import { textContent } from "../../test-support/render-ownership-host-fixture.js"

test("session metadata shows only loading totals and restores prior metadata gating", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountSessionListBudget()
  try {
    const stable = mounted.stableControl()
    assert.equal(mounted.meta()?.properties["aria-busy"], true)
    assert.equal(mounted.metaText(), "totals loadingquestion+1~2-3")
    assert.deepEqual(mounted.badge()?.properties.classList, { waiting: true, stopped: false, error: false })
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

test("a search shows title matches at once and chats found by their messages below them, without moving or replacing a row", async () => {
  const answers: Array<PromiseWithResolvers<{ chats: { sessionId: string; entryId: string; snippet: string; excerpt?: { source: "checkpoint"; text: string } }[] }>> = []
  const signals: AbortSignal[] = []
  const mounted = (await loadBudgetRenderFixture()).mountSessionListSearch((_query, signal) => {
    const answer = Promise.withResolvers<{ chats: { sessionId: string; entryId: string; snippet: string; excerpt?: { source: "checkpoint"; text: string } }[] }>()
    answers.push(answer)
    signals.push(signal)
    return answer.promise
  })
  const pause = () => new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  try {
    // The list brings the message index current as it opens.
    assert.equal(mounted.prepared(), 1)
    mounted.setFilter("kafk")
    assert.deepEqual(mounted.rowOrder(), ["kafka"])
    const titleRow = mounted.row("kafka")
    await pause()
    mounted.setFilter("kafka")
    await pause()
    assert.equal(answers.length, 2)
    assert.equal(signals[0]!.aborted, true, "a replaced search is withdrawn")
    assert.equal(signals[1]!.aborted, false)
    answers[1]!.resolve({ chats: [{ sessionId: "other", entryId: "e7", snippet: "the [kafka] lag", excerpt: { source: "checkpoint", text: "PR open" } }, { sessionId: "kafka", entryId: "e1", snippet: "[kafka]" }] })
    await pause()
    // A replaced query's late answer never shows.
    answers[0]!.resolve({ chats: [{ sessionId: "third", entryId: "e9", snippet: "[kafk]" }] })
    await pause()

    assert.deepEqual(mounted.rowOrder(), ["kafka", "other"])
    assert.equal(mounted.row("kafka"), titleRow, "an answer must not replace a title match")
    assert.match(mounted.text(), /In messages/)
    assert.match(mounted.text(), /the kafka lag/)
    assert.match(mounted.text(), /PR open/)
    mounted.click("other")
    assert.deepEqual(mounted.opened, ["other@e7"])

    // A new query keeps the last answer's rows, less the chats that match by title now, until its own answer
    // replaces them in place. "kafka" no longer matches by title, so its found row shows.
    mounted.setFilter("lag")
    assert.deepEqual(mounted.rowOrder(), ["other", "kafka"])
    const foundRow = mounted.row("other")
    assert.doesNotMatch(mounted.text(), /Searching messages/)
    await pause()
    answers[2]!.resolve({ chats: [{ sessionId: "other", entryId: "e8", snippet: "the [lag]" }, { sessionId: "third", entryId: "e9", snippet: "[lag] again" }] })
    await pause()
    assert.deepEqual(mounted.rowOrder(), ["other", "third"])
    assert.equal(mounted.row("other"), foundRow, "a new answer must not replace a row it keeps")

    // A failed search clears the rows; with nothing to show, a pending query says it searches, not that nothing matches.
    mounted.setFilter("lags")
    await pause()
    answers[3]!.reject(new Error("index closed"))
    await pause()
    assert.deepEqual(mounted.rowOrder(), [])
    assert.match(mounted.text(), /No chats match/)
    mounted.setFilter("lagsx")
    assert.match(mounted.text(), /Searching messages/)
    assert.doesNotMatch(mounted.text(), /No chats match/)

    mounted.setFilter("")
    assert.deepEqual(mounted.rowOrder(), ["kafka", "other", "third"])
  } finally { mounted.dispose() }
})

test("a title matches when each typed word starts one of its words, and a word too short to search the messages asks nothing", async () => {
  const queries: string[] = []
  const mounted = (await loadBudgetRenderFixture()).mountSessionListSearch((query) => {
    queries.push(query)
    return Promise.resolve({ chats: [] })
  })
  const pause = () => new Promise<void>((resolve) => { setTimeout(resolve, 1) })
  try {
    mounted.setFilter("pipe kaf")
    assert.deepEqual(mounted.rowOrder(), ["kafka"])
    mounted.setFilter("afka")
    assert.deepEqual(mounted.rowOrder(), [], "a word inside a title word is not a match")
    mounted.setFilter("ot")
    assert.deepEqual(mounted.rowOrder(), ["other"])
    await pause()
    assert.ok(!queries.includes("ot"), "a two-letter word does not search the messages")
    assert.doesNotMatch(mounted.text(), /Searching messages/)
  } finally { mounted.dispose() }
})

test("a stopped unread chat lists under Needs you after a question and moves to Recent in its own row once read", async () => {
  const now = Date.now()
  const chat = (id: string, overrides: { readonly awaitingAnswer?: true; readonly working?: true } = {}) => ({ id, title: id, subtitle: `${id} description`, kind: "chat" as const, lifecycleState: "inactive" as const, active: false, working: false, lastUpdated: new Date(now).toISOString(), totalsLoading: false, ...overrides })
  const mounted = (await loadBudgetRenderFixture()).mountSessionListUnread([chat("asked", { awaitingAnswer: true }), chat("done"), chat("failed"), chat("busy", { working: true })])
  try {
    mounted.setWaiting([{ sessionId: "asked", openedAt: now }])
    mounted.setUnread({
      stopped: [
        { sessionId: "done", ending: { kind: "completed" }, firstLine: "The fix is in place", stoppedAt: now - 3 * 3_600_000, stopKey: "entry-done" },
        { sessionId: "failed", ending: { kind: "failed", failure: "api_overloaded" }, stoppedAt: now - 4 * 3_600_000, stopKey: "stop-failed" },
      ],
      unread: ["busy"], turns: {},
    })
    assert.deepEqual(mounted.rowOrder(), ["asked", "done", "failed", "busy"])
    assert.deepEqual(mounted.headings(), ["Needs you", "Working"])
    assert.match(mounted.rowText("done"), /The fix is in place/)
    assert.match(mounted.rowText("done"), /3h/)
    assert.doesNotMatch(mounted.rowText("done"), /done description/)
    assert.deepEqual(mounted.badges("done").map((badge) => [textContent(badge), badge.properties.classList]), [["stopped", { waiting: false, stopped: true, error: false }]])
    assert.match(mounted.rowText("failed"), /the provider is overloaded/)
    assert.deepEqual(mounted.badges("failed").map((badge) => [textContent(badge), badge.properties.classList]), [["error", { waiting: false, stopped: false, error: true }]])
    // A working chat with unread messages keeps its place under Working.
    assert.deepEqual(mounted.badges("busy").map((badge) => [textContent(badge), badge.properties.classList]), [["unread", { hidden: false }]])
    const unreadMark = mounted.badges("busy")[0]

    // The marks that apply to each row: a question is answered, not read.
    assert.ok(mounted.action("done", "Mark read"))
    assert.equal(mounted.action("done", "Mark unread"), undefined)
    assert.ok(mounted.action("busy", "Mark read"))
    assert.equal(mounted.action("asked", "Mark read"), undefined)
    assert.equal(mounted.action("asked", "Mark unread"), undefined)
    const markButton = mounted.action("done", "Mark read")
    const markRead = markButton?.properties.onClick
    if (typeof markRead === "function") markRead({ stopPropagation() {} })
    assert.deepEqual(mounted.marked, ["read:done"])

    // An equal set published again keeps every row and its marks.
    const row = mounted.row("done")
    const badge = mounted.badges("done")[0]
    mounted.setUnread({ stopped: [{ sessionId: "done", ending: { kind: "completed" }, firstLine: "The fix is in place", stoppedAt: now - 3 * 3_600_000, stopKey: "entry-done" }], unread: [], turns: {} })
    assert.equal(mounted.row("done"), row)
    assert.equal(mounted.badges("done")[0], badge)
    // A working row keeps the slot of its mark once read, so its height stays.
    assert.equal(mounted.badges("busy")[0], unreadMark)
    assert.deepEqual(unreadMark?.properties.classList, { hidden: true })

    // Read: the same row moves to Recent and shows its own line again.
    mounted.setUnread({ stopped: [], unread: [], turns: {} })
    assert.equal(mounted.row("done"), row, "reading a chat must not replace its row")
    assert.deepEqual(mounted.rowOrder(), ["asked", "busy", "done", "failed"])
    assert.match(mounted.rowText("done"), /done description/)
    assert.deepEqual(mounted.badges("done"), [])
    // One mark button changes its words, so a focused button stays focused.
    assert.equal(mounted.action("done", "Mark unread"), markButton)
    assert.equal(mounted.action("done", "Mark read"), undefined)
    const markUnread = mounted.action("done", "Mark unread")?.properties.onClick
    if (typeof markUnread === "function") markUnread({ stopPropagation() {} })
    assert.deepEqual(mounted.marked, ["read:done", "unread:done"])
  } finally { mounted.dispose() }
})
