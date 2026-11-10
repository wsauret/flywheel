import assert from "node:assert/strict"
import { test } from "node:test"

import type { UsageAccountsResult, UsageMutationResult, UsageSpendResult } from "../../../../src/protocol/modules/subscription-usage.js"
import { usageAccounts, usageSpend } from "../../../../tests/unit/tui/usage-fixtures.js"
import { buildMemoryHostFixture } from "../../app/budget-render-test-loader.js"

const fixture: Promise<typeof import("./usage-render-fixture.js")> = buildMemoryHostFixture(new URL("usage-render-fixture.tsx", import.meta.url))
const time = new Date(usageAccounts.asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

test("Usage keeps its reading through a failed refresh and says how the refresh went", async () => {
  let read: () => Promise<UsageAccountsResult> = async () => usageAccounts
  const { mountUsageSheet, laneLost } = await fixture
  const mounted = mountUsageSheet({ accounts: () => read() })
  try {
    await mounted.settle()
    assert.deepEqual(mounted.status(), { text: `As of ${time}`, warn: false })
    read = async () => { throw new Error("Usage ledger is locked") }
    mounted.refresh(); await mounted.settle()
    assert.deepEqual(mounted.status(), { text: `As of ${time} · refresh failed`, warn: true })
    assert.match(mounted.text(), /ChatGPT Work/)
    read = async () => { throw laneLost() }
    mounted.refresh(); await mounted.settle()
    assert.deepEqual(mounted.status(), { text: `As of ${time} · update delayed`, warn: false })
    read = async () => usageAccounts
    mounted.refresh(); await mounted.settle()
    assert.deepEqual(mounted.status(), { text: `As of ${time}`, warn: false })
  } finally { mounted.dispose() }
})

test("Usage reads a provider check as a refresh, keeps the reading when the check fails or is refused, and recovers on the next lane", async () => {
  const { mountUsageSheet, laneLost, checked } = await fixture
  let answer: () => Promise<UsageMutationResult> = async () => checked
  const mounted = mountUsageSheet({ accounts: async () => usageAccounts, check: () => answer() })
  try {
    await mounted.settle()
    const held = Promise.withResolvers<UsageMutationResult>()
    answer = () => held.promise
    mounted.refresh(); await mounted.settle()
    assert.deepEqual(mounted.status(), { text: "Refreshing…", warn: false })
    held.reject(new Error("Provider check failed")); await mounted.settle()
    assert.deepEqual(mounted.status(), { text: `As of ${time} · refresh failed`, warn: true })
    answer = async () => ({ ok: false, error: "Usage is not available for this profile" })
    mounted.refresh(); await mounted.settle()
    assert.deepEqual(mounted.status(), { text: `As of ${time} · refresh failed`, warn: true })
    assert.match(mounted.text(), /ChatGPT Work/)
    answer = async () => { throw laneLost() }
    mounted.refresh(); await mounted.settle()
    assert.deepEqual(mounted.status(), { text: `As of ${time} · update delayed`, warn: false })
    answer = async () => checked
    mounted.openLane(); await mounted.settle()
    assert.deepEqual(mounted.status(), { text: `As of ${time}`, warn: false })
  } finally { mounted.dispose() }
})

test("Usage keeps the spend reading of the earlier range when a new range fails, names its range, and reads either range again on a tap", async () => {
  const { mountUsageSheet } = await fixture
  let spend: () => Promise<UsageSpendResult> = async () => usageSpend
  let reads = 0
  const mounted = mountUsageSheet({ accounts: async () => usageAccounts, spend: () => { reads += 1; return spend() } })
  try {
    await mounted.settle()
    mounted.choose("Usage view", "Spend"); await mounted.settle()
    assert.match(mounted.text(), /\$5\.85/)
    spend = async () => { throw new Error("Usage ledger is locked") }
    mounted.choose("Spend range", "7d"); await mounted.settle()
    assert.deepEqual(mounted.status(), { text: `As of ${time} · refresh failed`, warn: true })
    assert.match(mounted.text(), /\$5\.85/)
    assert.equal(mounted.chosen("Spend range"), "Month")
    // The range on screen is a choice again while the chosen range failed: a tap on it reads it.
    spend = async () => usageSpend
    const before = reads
    mounted.choose("Spend range", "Month"); await mounted.settle()
    assert.equal(reads, before + 1)
    assert.deepEqual(mounted.status(), { text: `As of ${time}`, warn: false })
    assert.equal(mounted.chosen("Spend range"), "Month")
    spend = async () => { throw new Error("Usage ledger is locked") }
    mounted.choose("Spend range", "7d"); await mounted.settle()
    assert.equal(mounted.chosen("Spend range"), "Month")
    spend = async () => ({ ...usageSpend, range: "7d" })
    mounted.choose("Spend range", "7d"); await mounted.settle()
    assert.deepEqual(mounted.status(), { text: `As of ${time}`, warn: false })
    assert.equal(mounted.chosen("Spend range"), "7d")
  } finally { mounted.dispose() }
})

test("Usage without a reading keeps waiting through a delay, reads again on the next lane, and names a failure's cause in the body", async () => {
  const { mountUsageSheet, laneLost } = await fixture
  let read: () => Promise<UsageAccountsResult> = async () => { throw laneLost() }
  const delayed = mountUsageSheet({ accounts: () => read() })
  try {
    await delayed.settle()
    assert.deepEqual(delayed.status(), { text: "Reading…", warn: false })
    assert.doesNotMatch(delayed.text(), /lane closed/)
    read = async () => usageAccounts
    delayed.openLane(); await delayed.settle()
    assert.deepEqual(delayed.status(), { text: `As of ${time}`, warn: false })
    assert.match(delayed.text(), /ChatGPT Work/)
  } finally { delayed.dispose() }
  const failed = mountUsageSheet({ accounts: async () => { throw new Error("Usage ledger is locked\n    at read (ledger.ts:1)") } })
  try {
    await failed.settle()
    assert.deepEqual(failed.status(), { text: "Could not read usage", warn: true })
    assert.match(failed.text(), /Usage ledger is locked/)
    assert.doesNotMatch(failed.text(), /ledger\.ts/)
  } finally { failed.dispose() }
})
