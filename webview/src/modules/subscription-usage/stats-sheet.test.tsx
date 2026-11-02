import assert from "node:assert/strict"
import { test } from "node:test"

import type { UsageSessionStats, UsageAccountsResult } from "../../../../src/protocol/modules/subscription-usage.js"
import { loadStatsRenderFixture } from "./stats-render-test-loader.js"
import { loadSemanticRowsFixture } from "../../app/semantic-rows-loader-fixture.js"

function stats(sessionId: string): UsageSessionStats {
  const summary = { attempts: 2, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150 }, estimatedBilledUsd: 0.25, includedValueUsd: 0, priceUnavailable: false }
  const totals = { outputTokens: 100, durationMs: 5000, measuredRequests: 2, unmeasuredRequests: 1, measuredBlocks: 2, excludedBlocks: 1, averageTokensPerSecond: 20 }
  return {
    sessionId, asOf: 1, partial: false, descendantCount: 1,
    direct: summary, descendants: summary, totals: summary, models: [{ ...summary, model: "reported-model" }], tools: [{ name: "read", calls: 1, errors: 0, blocked: 0, cancelled: 0, interrupted: 0, stopped: 0 }],
    generation: { basis: "O200kBase", totals, coverageComplete: false, models: [
      { ...totals, model: "comparison-model", reasoningEffort: "medium", averageTokensPerSecond: 18.24 },
      { ...totals, model: "comparison-model", reasoningEffort: "high", averageTokensPerSecond: 24.56 },
    ] },
  }
}

test("Stats renders model and effort generation readings and retains them through failed refresh", async () => {
  const fixture = await loadStatsRenderFixture()
  let fail = false
  let speedValue = 18.24
  let counters = 100
  const requested: string[] = []
  const mounted = fixture.mountStatsBudget(async (sessionId) => {
    requested.push(sessionId)
    if (fail) throw new Error("Stats read failed")
    const value = stats(sessionId)
    return { ...value, totals: { ...value.totals, tokens: { ...value.totals.tokens, input: counters } }, models: value.models.map(model => ({ ...model, tokens: { ...model.tokens, input: counters } })), tools: value.tools.map(tool => ({ ...tool, calls: counters })), generation: { ...value.generation, models: value.generation.models.map((row, index) => index === 0 ? { ...row, averageTokensPerSecond: speedValue } : row) } }
  })
  try {
    await mounted.settle()
    assert.deepEqual(requested, ["session-a"])
    assert.match(mounted.text(), /This session, including descendant work/)
    assert.equal(mounted.rowText("comparison-model · medium"), "comparison-model · medium18.2 avg tok/s")
    assert.equal(mounted.rowText("comparison-model · high"), "comparison-model · high24.6 avg tok/s")
    assert.match(mounted.text(), /2 measured requests · 1 known unmeasured requests · 1 excluded output blocks/)
    assert.match(mounted.text(), /Some output has no measurement\. Historical request coverage can be unknown\./)
    assert.match(mounted.text(), /O200kBase local comparison tokens\. Assistant text and streamed tool arguments only\. Not billed provider tokens\./)
    assert.match(mounted.text(), /Reported usage/)
    assert.match(mounted.text(), /Cost by session/)
    const details = mounted.elements().find(node => node.tag === "details")
    const speed = mounted.row("comparison-model · medium")
    const input = mounted.row("Input tokens")
    const text = (node: ReturnType<typeof mounted.elements>[number]): string => `${node.text ?? ""}${node.children.map(text).join("")}`
    const model = mounted.elements().find(node => node.properties.class === "usage-detail-group" && text(node).startsWith("reported-model"))
    const tool = mounted.row("Calls")?.parent
    const modelInput = model?.children.find(node => node.properties.class === "sheet-row" && text(node).startsWith("Input tokens"))
    const calls = mounted.row("Calls")
    assert.ok(details && speed && input && model && tool && modelInput && calls)
    details.properties.open = true
    fail = true
    mounted.refresh()
    await mounted.settle()
    assert.match(mounted.text(), /Could not read stats: Stats read failed/)
    assert.match(mounted.text(), /Retry/)
    assert.equal(mounted.rowText("comparison-model · medium"), "comparison-model · medium18.2 avg tok/s")
    fail = false
    speedValue = 30
    counters = 250
    mounted.refresh()
    await mounted.settle()
    assert.equal(requested.length, 3)
    assert.doesNotMatch(mounted.text(), /Could not read stats/)
    assert.ok(mounted.elements().includes(details))
    assert.equal(mounted.row("comparison-model · medium"), speed)
    assert.equal(mounted.rowText("comparison-model · medium"), "comparison-model · medium30.0 avg tok/s")
    assert.equal(details.properties.open, true)
    for (const node of [input, model, tool, modelInput, calls]) assert.ok(mounted.elements().includes(node))
    assert.equal(mounted.rowText("Input tokens"), "Input tokens250")
    assert.equal(mounted.rowText("Calls"), "Calls250")
    assert.match(text(modelInput), /250/)
  } finally { mounted.dispose() }
})

test("Stats removes previous scope readings while a new session loads and explains unavailable speed", async () => {
  const fixture = await loadStatsRenderFixture()
  const pending = Promise.withResolvers<UsageSessionStats>()
  const mounted = fixture.mountStatsBudget((sessionId) => sessionId === "session-a" ? Promise.resolve(stats(sessionId)) : pending.promise)
  try {
    await mounted.settle()
    assert.match(mounted.text(), /18\.2 avg tok\/s/)
    mounted.setSession("session-b")
    assert.doesNotMatch(mounted.text(), /comparison-model|18\.2 avg tok\/s/)
    pending.resolve({ ...stats("session-b"), generation: {
      basis: "O200kBase", coverageComplete: false, models: [],
      totals: { outputTokens: 0, durationMs: 0, measuredRequests: 0, unmeasuredRequests: 2, measuredBlocks: 0, excludedBlocks: 1, averageTokensPerSecond: null },
    } })
    await mounted.settle()
    assert.equal(mounted.rowText("Generation speed"), "Generation speedNot measured")
    assert.match(mounted.text(), /Single-chunk output has no measurable streaming duration\. Historical requests are not backfilled\./)
    assert.doesNotMatch(mounted.text(), /0\.0 avg tok\/s|comparison-model/)
  } finally { mounted.dispose() }
})

test("usage refresh keeps the open account and its focused control while reading its new label", async () => {
  const { mountSemanticRows } = await loadSemanticRowsFixture<typeof import("./semantic-rows-fixture.js")>(new URL("semantic-rows-fixture.tsx", import.meta.url))
  const initial: UsageAccountsResult = { kind: "usage.accounts", profileId: "personal", authorityIncarnation: "authority", revision: 1, generation: 1, asOf: 1, sources: [{ sourceId: "account", providerId: "openai_api", label: "Account", active: true, kind: "metered", spendMode: "direct_api", activity: { state: "ledger-unavailable" } }] }
  let current = initial
  const metadata = () => ({ ok: true, usage: { profileId: current.profileId, authorityIncarnation: current.authorityIncarnation, revision: current.revision, generation: current.generation, asOf: current.asOf } }) as const
  const mounted = mountSemanticRows("accounts", {}, { queries: { "usage.accounts": () => current }, mutations: { "usage.open": metadata, "usage.refresh": metadata } })
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }
  try {
    await settle()
    const account = mounted.elements().find(node => node.properties.class === "sheet-row sheet-row-button")
    assert.ok(account)
    const open = account.properties.onClick
    if (typeof open === "function") open()
    account.focus()
    const detail = mounted.elements().find(node => node.properties.class === "usage-detail")
    assert.ok(detail)
    current = { ...initial, asOf: 2, sources: current.sources.map(source => ({ ...source, label: "Current account", activity: { state: "available", startMs: 0, endMs: 100, trackingStartMs: 0, partial: false, incomplete: false, attempts: 7, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 250 }, estimatedBilledUsd: 3, includedValueUsd: 0, priceUnavailable: false } })) }
    const refresh = mounted.button("Refresh")?.properties.onClick
    if (typeof refresh === "function") refresh()
    await settle()
    assert.ok(mounted.elements().includes(account))
    assert.ok(mounted.elements().includes(detail))
    assert.equal(account.ownerDocument.activeElement, account)
    assert.match(mounted.text(), /Current account/)
    assert.doesNotMatch(mounted.text(), /Usage ledger unavailable/)
    assert.match(mounted.text(), /3\.00/)
  } finally { mounted.dispose() }
})
