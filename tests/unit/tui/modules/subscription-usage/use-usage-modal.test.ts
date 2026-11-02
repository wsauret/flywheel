import { describe, expect, it, mock, spyOn } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { UsageAccountsResult, UsageHistoryResult, UsageSpendResult, UsageMetadataResult } from "../../../../../src/protocol/modules/subscription-usage.js"
import type { RuntimeAuthStatusScope } from "../../../../../src/protocol/auth-status-protocol-types.js"
import { createModalStack } from "../../../../../src/tui/components/modal-stack.js"
import { useUsageModal, type UsageModalView } from "../../../../../src/tui/modules/subscription-usage/use-usage-modal.js"
import { usageAccounts, usageHistory, usageOpenResult, usageRefreshResult, usageSpend } from "../../usage-fixtures.js"
import { fakeFrameHookHost } from "../../../../helpers/scroll-frame-hook.js"

const defaultsScope = { kind: "defaults" } as const
const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }
type Query =
  | { readonly type: "usage.metadata"; readonly scope: RuntimeAuthStatusScope }
  | { readonly type: "usage.accounts"; readonly scope: RuntimeAuthStatusScope; readonly freshnessMs?: number }
  | { readonly type: "usage.spend"; readonly scope: RuntimeAuthStatusScope; readonly range?: "24h" | "7d" | "Month" | "All" }
  | { readonly type: "usage.history"; readonly scope: RuntimeAuthStatusScope; readonly range: "24h" | "7d" | "Month" | "All" }
type Result = UsageAccountsResult | UsageSpendResult | UsageHistoryResult | UsageMetadataResult
const usageMetadata: UsageMetadataResult = { ...usageOpenResult.usage, kind: "usage.metadata" }
type Mutation =
  | { readonly type: "usage.open"; readonly scope: RuntimeAuthStatusScope; readonly freshnessMs?: number }
  | { readonly type: "usage.refresh"; readonly scope: RuntimeAuthStatusScope }
  | { readonly type: "usage.apply_reset"; readonly scope: RuntimeAuthStatusScope; readonly sourceId: string; readonly authorityIncarnation: string; readonly revision: number; readonly redeemRequestId: string }

function harness(initialView?: UsageModalView) {
  const modal = createModalStack()
  const [foregroundId, setForegroundId] = createSignal<string>()
  const [profileId, setProfileId] = createSignal<string | undefined>("profile")
  const dispatch = mock(async (mutation: Mutation): Promise<typeof usageOpenResult | typeof usageRefreshResult | { kind: "reset" }> => mutation.type === "usage.open" ? usageOpenResult : mutation.type === "usage.apply_reset" ? { kind: "reset" } : usageRefreshResult)
  const query = mock(async (request: Query): Promise<Result> => request.type === "usage.metadata" ? usageMetadata : request.type === "usage.accounts" ? usageAccounts : request.type === "usage.spend" ? usageSpend : usageHistory)
  let hook: ReturnType<typeof useUsageModal> | undefined
  let dispose = () => {}
  createRoot((rootDispose) => {
    dispose = rootDispose
    hook = useUsageModal({ initialView, modal, renderModal: () => "usage", appService: { dispatch, query }, foregroundId, effectiveProfileId: profileId })
  })
  if (!hook) throw new Error("usage hook was not created")
  return { hook, modal, dispatch, query, setForegroundId, setProfileId, dispose }
}

describe("useUsageModal unified usage protocol", () => {
  it("refreshes recorded activity while open without provider checks or scroll resets", async () => {
    const start = spyOn(globalThis, "setInterval")
    const stop = spyOn(globalThis, "clearInterval")
    const fixture = harness()
    try {
      fixture.hook.openUsageModal(); await tick()
      expect(start).toHaveBeenCalledTimes(1)
      const refresh = start.mock.calls[0]?.[0]
      if (typeof refresh !== "function") throw new Error("Missing refresh callback")
      const updated: UsageAccountsResult = { ...usageAccounts, sources: usageAccounts.sources.map((source) => source.activity.state === "available" ? { ...source, activity: { ...source.activity, attempts: 12, includedValueUsd: 53, tokens: { ...source.activity.tokens, total: 9_000 } } } : source) }
      fixture.query.mockClear()
      refresh(); await tick()
      expect(fixture.query.mock.calls).toEqual([[{ type: "usage.metadata", scope: defaultsScope }]])
      fixture.query.mockResolvedValueOnce({ ...usageMetadata, revision: 5 }).mockResolvedValueOnce(updated)
      fixture.dispatch.mockClear()
      refresh(); await tick()
      expect(fixture.hook.usageAccounts()).toEqual(updated)
      expect(fixture.dispatch).not.toHaveBeenCalled()
      fixture.hook.setUsageView("spend"); await tick()
      const scrollTo = mock((_row: number) => {})
      fixture.hook.spendScroll.attach(Object.assign(Object.create(null), { ...fakeFrameHookHost(), content: {}, scrollTop: 4, scrollHeight: 20, viewport: { height: 4 }, scrollBy: () => {}, scrollTo }))
      scrollTo.mockClear()
      const selected = fixture.hook.selectedSourceId()
      const pending = Promise.withResolvers<Result>()
      fixture.query.mockReturnValueOnce(pending.promise)
      fixture.query.mockClear()
      refresh(); refresh()
      expect(fixture.query).toHaveBeenCalledTimes(1)
      fixture.query.mockResolvedValueOnce({ ...usageSpend, estimatedBilledUsd: 42 })
      pending.resolve({ ...usageMetadata, revision: 5 })
      await tick()
      expect(fixture.hook.usageSpend()?.estimatedBilledUsd).toBe(42)
      expect(fixture.hook.selectedSourceId()).toBe(selected)
      expect(scrollTo).not.toHaveBeenCalled()
      fixture.hook.closeUsageModal()
      expect(stop).toHaveBeenCalledWith(start.mock.results[0]?.value)
      fixture.query.mockClear(); refresh(); await tick()
      expect(fixture.query).not.toHaveBeenCalled()
      fixture.hook.openUsageModal(); await tick()
      const late = Promise.withResolvers<Result>()
      fixture.query.mockReturnValueOnce(late.promise)
      refresh()
      fixture.hook.closeUsageModal()
      fixture.hook.openUsageModal(); await tick()
      late.resolve({ ...usageMetadata, revision: 5 }); await tick()
      expect(fixture.hook.usageAccounts()).toEqual(usageAccounts)
      fixture.query.mockResolvedValueOnce({ ...usageMetadata, revision: 5 }).mockResolvedValueOnce(updated)
      refresh(); await tick()
      expect(fixture.hook.usageAccounts()).toEqual(updated)
    } finally { fixture.dispose(); start.mockRestore(); stop.mockRestore() }
  })

  it("opens Accounts by default through usage.open and usage.accounts", async () => {
    const fixture = harness()
    fixture.hook.openUsageModal()
    await tick()
    expect(fixture.hook.usageView()).toBe("accounts")
    expect(fixture.dispatch.mock.calls[0]?.[0]).toEqual({ type: "usage.open", scope: defaultsScope, freshnessMs: 300_000 })
    expect(fixture.query.mock.calls[0]?.[0]).toEqual({ type: "usage.accounts", scope: defaultsScope, freshnessMs: 300_000 })
    expect(fixture.hook.usageAccounts()).toEqual(usageAccounts)
    expect(fixture.hook.selectedSourceId()).toBe("chatgpt:work")
    fixture.dispose()
  })

  it("shows the recorded reading while usage.open checks providers, then the checked reading", async () => {
    const fixture = harness()
    const checked: UsageAccountsResult = { ...usageAccounts, revision: usageAccounts.revision + 1 }
    const opening = Promise.withResolvers<typeof usageOpenResult>()
    fixture.dispatch.mockReturnValueOnce(opening.promise)
    fixture.query.mockResolvedValueOnce(usageAccounts).mockResolvedValueOnce(checked)
    fixture.hook.openUsageModal(); await tick()
    expect(fixture.hook.usageAccounts()).toEqual(usageAccounts)
    expect(fixture.hook.usageLoading()).toBe(true)
    opening.resolve(usageOpenResult); await tick()
    expect(fixture.hook.usageAccounts()).toEqual(checked)
    expect(fixture.hook.usageLoading()).toBe(false)

    fixture.hook.closeUsageModal()
    const late = Promise.withResolvers<Result>()
    fixture.query.mockReturnValueOnce(late.promise).mockResolvedValueOnce(checked)
    fixture.hook.openUsageModal(); await tick()
    expect(fixture.hook.usageAccounts()).toEqual(checked)
    late.resolve(usageAccounts); await tick()
    expect(fixture.hook.usageAccounts()).toEqual(checked)

    fixture.hook.closeUsageModal()
    fixture.dispatch.mockRejectedValueOnce(new Error("provider check failed"))
    fixture.hook.openUsageModal(); await tick()
    expect(fixture.hook.usageError()).toBe("provider check failed")
    expect(fixture.hook.usageAccounts()).toEqual(usageAccounts)
    fixture.dispose()
  })

  it("shows the checked reading of the view selected while usage.open checks providers", async () => {
    const start = spyOn(globalThis, "setInterval")
    const fixture = harness()
    try {
      const opening = Promise.withResolvers<typeof usageOpenResult>()
      fixture.dispatch.mockReturnValueOnce(opening.promise)
      fixture.hook.openUsageModal(); await tick()
      fixture.hook.setUsageView("spend"); await tick()
      const checking = Promise.withResolvers<Result>()
      fixture.query.mockClear(); fixture.query.mockReturnValueOnce(checking.promise)
      opening.resolve(usageOpenResult); await tick()
      expect(fixture.query.mock.calls).toEqual([[{ type: "usage.spend", scope: defaultsScope, range: "Month" }]])
      expect(fixture.hook.usageLoading()).toBe(true)
      const refresh = start.mock.calls[0]?.[0]
      if (typeof refresh !== "function") throw new Error("Missing refresh callback")
      refresh(); await tick()
      expect(fixture.query).toHaveBeenCalledTimes(1)
      checking.resolve({ ...usageSpend, estimatedBilledUsd: 42 }); await tick()
      expect(fixture.hook.usageSpend()?.estimatedBilledUsd).toBe(42)
      expect(fixture.hook.usageLoading()).toBe(false)
    } finally { fixture.dispose(); start.mockRestore() }
  })

  it("keeps the Spend scroll when the checked reading replaces the recorded one", async () => {
    const fixture = harness("spend")
    const opening = Promise.withResolvers<typeof usageOpenResult>()
    fixture.dispatch.mockReturnValueOnce(opening.promise)
    fixture.hook.openUsageModal(); await tick()
    expect(fixture.hook.usageSpend()).toEqual(usageSpend)
    const scrollTo = mock((_row: number) => {})
    fixture.hook.spendScroll.attach(Object.assign(Object.create(null), { ...fakeFrameHookHost(), content: {}, scrollTop: 4, scrollHeight: 20, viewport: { height: 4 }, scrollBy: () => {}, scrollTo }))
    scrollTo.mockClear()
    fixture.query.mockResolvedValueOnce({ ...usageSpend, estimatedBilledUsd: 42 })
    opening.resolve(usageOpenResult); await tick()
    expect(fixture.hook.usageSpend()?.estimatedBilledUsd).toBe(42)
    expect(scrollTo).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it("closes on Escape", async () => {
    const fixture = harness()
    fixture.hook.openUsageModal(); await tick()
    expect(fixture.modal.stack).toHaveLength(1)
    fixture.modal.input({ name: "escape" })
    expect(fixture.modal.stack).toHaveLength(0)
    fixture.dispose()
  })

  it("switches a/s/h and Tab through strict spend and history queries", async () => {
    const fixture = harness()
    fixture.hook.openUsageModal(); await tick()
    fixture.modal.input({ name: "s" }); await tick()
    expect(fixture.hook.usageView()).toBe("spend")
    expect(fixture.query.mock.calls.at(-1)?.[0]).toEqual({ type: "usage.spend", scope: defaultsScope, range: "Month" })
    fixture.modal.input({ name: "h" }); await tick()
    expect(fixture.query.mock.calls.at(-1)?.[0]).toEqual({ type: "usage.history", scope: defaultsScope, range: "24h" })
    fixture.modal.input({ name: "a" }); await tick()
    fixture.modal.input({ name: "tab" }); await tick()
    expect(fixture.hook.usageView()).toBe("spend")
    fixture.modal.input({ name: "tab" }); await tick()
    expect(fixture.hook.usageView()).toBe("history")
    fixture.modal.input({ name: "tab" }); await tick()
    expect(fixture.hook.usageView()).toBe("accounts")
    fixture.dispose()
  })

  it("rejects stale replies from a previous effective profile for every view", async () => {
    const fixture = harness()
    const pending: Array<(result: Result) => void> = []
    fixture.query.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    fixture.hook.openUsageModal(); await Promise.resolve()
    fixture.setProfileId("other"); await Promise.resolve()
    pending[0]?.(usageAccounts); await Promise.resolve()
    expect(fixture.hook.usageAccounts()).toBeUndefined()
    pending[1]?.({ ...usageAccounts, profileId: "profile" }); await Promise.resolve()
    expect(fixture.hook.usageAccounts()).toBeUndefined()
    fixture.dispose()
  })

  it("rejects mismatched profile replies from Spend and History", async () => {
    const fixture = harness()
    fixture.hook.openUsageModal(); await tick()
    fixture.query.mockImplementation(async (request) => request.type === "usage.spend" ? { ...usageSpend, profileId: "other" } : { ...usageHistory, profileId: "other" })
    fixture.hook.setUsageView("spend"); await tick()
    expect(fixture.hook.usageSpend()).toBeUndefined()
    fixture.hook.setUsageView("history"); await tick()
    expect(fixture.hook.usageHistory()).toBeUndefined()
    fixture.dispose()
  })

  it("moves Spend with up/down and enters Accounts only for active sources", async () => {
    const fixture = harness()
    fixture.hook.openUsageModal(); await tick(); fixture.hook.setUsageView("spend"); await tick()
    fixture.modal.input({ name: "down" })
    expect(fixture.hook.selectedSourceId()).toBe("api:openai")
    fixture.modal.input({ name: "down" })
    expect(fixture.hook.selectedSourceId()).toBe("legacy:inactive")
    fixture.modal.input({ name: "return" }); await tick()
    expect(fixture.hook.usageView()).toBe("spend")
    fixture.modal.input({ name: "up" }); fixture.modal.input({ name: "return" }); await tick()
    expect(fixture.hook.usageView()).toBe("accounts")
    expect(fixture.hook.selectedSourceId()).toBe("api:openai")
    fixture.dispose()
  })

  it("does not wrap source selection at either boundary", async () => {
    const fixture = harness()
    fixture.hook.openUsageModal(); await tick()
    fixture.modal.input({ name: "left" })
    expect(fixture.hook.selectedSourceId()).toBe("chatgpt:work")
    fixture.hook.setSelectedSourceId("anthropic:old")
    fixture.modal.input({ name: "right" })
    expect(fixture.hook.selectedSourceId()).toBe("anthropic:old")
    fixture.dispose()
  })

  it("pages the selected Account without moving the source", async () => {
    const fixture = harness()
    const scrollBy = mock((_rows: number) => {})
    const renderable: Parameters<typeof fixture.hook.currentScroll.attach>[0] = Object.assign(Object.create(null), { ...fakeFrameHookHost(), content: {}, scrollTop: 0, scrollHeight: 20, viewport: { height: 4 }, scrollBy, scrollTo: () => {} })
    fixture.hook.openUsageModal(); await tick(); fixture.hook.currentScroll.attach(renderable)
    fixture.modal.input({ name: "pagedown" }); fixture.modal.input({ name: "pageup" })
    expect(scrollBy.mock.calls).toEqual([[4], [-4]])
    expect(fixture.hook.selectedSourceId()).toBe("chatgpt:work")
    fixture.dispose()
  })

  it("resets the selected Account when detail metrics are toggled", async () => {
    const fixture = harness()
    const scrollTo = mock((_row: number) => {})
    const renderable: Parameters<typeof fixture.hook.currentScroll.attach>[0] = Object.assign(Object.create(null), { ...fakeFrameHookHost(), content: {}, scrollTop: 4, scrollHeight: 20, viewport: { height: 4 }, scrollBy: () => {}, scrollTo })
    fixture.hook.openUsageModal(); await tick(); fixture.hook.currentScroll.attach(renderable); scrollTo.mockClear()
    expect(fixture.hook.usageShowDetailMetrics()).toBe(false)
    fixture.modal.input({ name: "c" })
    expect(fixture.hook.usageShowDetailMetrics()).toBe(true)
    fixture.modal.input({ name: "c" })
    expect(fixture.hook.usageShowDetailMetrics()).toBe(false)
    expect(scrollTo.mock.calls).toEqual([[0], [0]])
    fixture.dispose()
  })

  it("does not toggle or reset when the selected Account is selected again", async () => {
    const fixture = harness()
    const scrollTo = mock((_row: number) => {})
    const renderable: Parameters<typeof fixture.hook.currentScroll.attach>[0] = Object.assign(Object.create(null), { ...fakeFrameHookHost(), content: {}, scrollTop: 0, scrollHeight: 20, viewport: { height: 4 }, scrollBy: () => {}, scrollTo })
    fixture.hook.openUsageModal(); await tick(); fixture.hook.currentScroll.attach(renderable); scrollTo.mockClear()
    fixture.hook.setSelectedSourceId("chatgpt:work")
    expect(scrollTo).not.toHaveBeenCalled()
    expect(fixture.hook.selectedSourceId()).toBe("chatgpt:work")
    fixture.dispose()
  })

  it("keeps Spend and History ranges independent while Accounts use vertical source navigation", async () => {
    const fixture = harness()
    fixture.hook.openUsageModal(); await tick()
    fixture.modal.input({ name: "down" })
    expect(fixture.hook.selectedSourceId()).toBe("copilot:personal")
    expect(fixture.hook.usageSpendRange()).toBe("Month")
    expect(fixture.hook.usageHistoryRange()).toBe("24h")

    fixture.hook.setUsageView("spend"); await tick()
    fixture.modal.input({ name: "right" }); await tick()
    expect(fixture.hook.usageSpendRange()).toBe("All")
    expect(fixture.hook.usageHistoryRange()).toBe("24h")

    fixture.hook.setUsageView("history"); await tick()
    fixture.modal.input({ name: "right" }); await tick()
    expect(fixture.hook.usageSpendRange()).toBe("All")
    expect(fixture.hook.usageHistoryRange()).toBe("7d")
    fixture.dispose()
  })

  it("refreshes the active view and keeps the selected source", async () => {
    const fixture = harness()
    fixture.hook.openUsageModal(); await tick(); fixture.hook.setSelectedSourceId("api:openai"); fixture.hook.setUsageView("spend"); await tick()
    fixture.query.mockClear(); fixture.dispatch.mockClear(); fixture.hook.refreshUsage(); await tick()
    expect(fixture.dispatch.mock.calls).toEqual([[{ type: "usage.refresh", scope: defaultsScope }]])
    expect(fixture.query.mock.calls[0]?.[0]).toEqual({ type: "usage.spend", scope: defaultsScope, range: "Month" })
    expect(fixture.hook.selectedSourceId()).toBe("api:openai")
    fixture.dispose()
  })

  it("moves History source selection with arrows and j/k", async () => {
    const fixture = harness()
    const second = { ...usageHistory.sources[0]!, sourceId: "copilot:personal", label: "Copilot Personal" }
    fixture.query.mockImplementation(async (request) => request.type === "usage.history" ? { ...usageHistory, sources: [...usageHistory.sources, second] } : request.type === "usage.spend" ? usageSpend : usageAccounts)
    fixture.hook.openUsageModal(); await tick(); fixture.hook.setUsageView("history"); await tick()
    fixture.modal.input({ name: "j" })
    expect(fixture.hook.selectedSourceId()).toBe("copilot:personal")
    fixture.modal.input({ name: "up" })
    expect(fixture.hook.selectedSourceId()).toBe("chatgpt:work")
    fixture.dispose()
  })

  it("confirms and applies a banked reset with one attempt key", async () => {
    const fixture = harness(); fixture.hook.openUsageModal(); await tick()
    fixture.modal.input({ name: "enter" }); expect(fixture.hook.resetAttempt().kind).toBe("reviewing")
    fixture.modal.input({ name: "enter" }); expect(fixture.hook.resetAttempt().kind).toBe("busy"); await tick(); await tick()
    const apply = fixture.dispatch.mock.calls.find(([mutation]) => mutation.type === "usage.apply_reset")?.[0]
    expect(apply && "authorityIncarnation" in apply ? apply.authorityIncarnation : undefined).toBe(usageAccounts.authorityIncarnation)
    expect(apply && "redeemRequestId" in apply ? apply.redeemRequestId : "").toMatch(/^[0-9a-f-]{36}$/)
    expect(fixture.hook.resetAttempt()).toEqual({ kind: "idle", outcome: { sourceId: "chatgpt:work", message: "Banked reset applied · usage refreshed", applied: true } })
    fixture.dispose()
  })

  it("keeps the modal open until a busy reset settles", async () => {
    const fixture = harness()
    const pending = Promise.withResolvers<{ kind: "reset" }>()
    fixture.dispatch.mockImplementation((mutation) => mutation.type === "usage.open" ? Promise.resolve(usageOpenResult) : mutation.type === "usage.apply_reset" ? pending.promise : Promise.resolve(usageRefreshResult))
    fixture.hook.openUsageModal(); await tick()
    fixture.modal.input({ name: "enter" }); fixture.modal.input({ name: "enter" })
    expect(fixture.hook.resetAttempt().kind).toBe("busy")
    fixture.hook.closeUsageModal(); fixture.modal.input({ name: "escape" })
    expect(fixture.modal.stack).toHaveLength(1)
    pending.resolve({ kind: "reset" }); await tick(); await tick()
    fixture.hook.closeUsageModal()
    expect(fixture.modal.stack).toHaveLength(0)
    fixture.dispose()
  })

  it("reloads an open modal for a foreground scope change", async () => {
    const fixture = harness()
    fixture.hook.openUsageModal(); await tick(); fixture.query.mockClear()
    fixture.setForegroundId("session-b"); await tick()
    expect(fixture.query.mock.calls[0]?.[0]).toEqual({ type: "usage.accounts", scope: { kind: "session", sessionId: "session-b" }, freshnessMs: 300_000 })
    fixture.dispose()
  })
})