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
