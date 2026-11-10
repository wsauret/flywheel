/** @jsxImportSource @opentui/solid */
import { describe, expect, it, mock } from "bun:test"
import { Renderable, ScrollBoxRenderable } from "@opentui/core"
import flywheelTheme from "../../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../../src/tui/context/theme/resolve.js"
const [{ testRender }, { createComponent }, { createStore }, { ThemeProvider }, { UsageModal, computeUsageModalLayout }, { createModalScrollController }, fixtures] = await Promise.all([import("@opentui/solid"), import("solid-js/web"), import("solid-js/store"), import("../../../../../src/tui/context/theme.js"), import("../../../../../src/tui/modules/subscription-usage/modal.js"), import("../../../../../src/tui/components/modal-scroll-controller.js"), import("../../usage-fixtures.js")])
type Props = Parameters<typeof UsageModal>[0]
const noop = () => {}
const defaults: Props = { view: "accounts", accounts: fixtures.usageAccounts, loading: false, spendRange: "Month", historyRange: "24h", showDetailMetrics: false, selectedSourceId: "chatgpt:work", currentScroll: createModalScrollController(), spendScroll: createModalScrollController(), onClose: noop, onRefresh: noop, onViewChange: noop, onSourceChange: noop, onSpendRangeChange: noop, onHistoryRangeChange: noop, onBeginReset: noop, onConfirmReset: noop, onCancelReset: noop }
const reviewing = { kind: "reviewing", sourceId: "chatgpt:work", authorityIncarnation: "authority", revision: 4, scope: { kind: "defaults" }, profileId: "profile", selected: { title: "Weekly reset" }, logicalKey: "key", modalGeneration: 1 } as const
const busy = { ...reviewing, kind: "busy" } as const
function accountsWithNoExpiry(): NonNullable<Props["accounts"]> {
  const source = fixtures.usageAccounts.sources[0]
  if (source?.kind !== "subscription") throw new Error("Expected the first Usage fixture to be a subscription")
  return { ...fixtures.usageAccounts, sources: [{ ...source, bankedResets: { availableCount: 1, credits: [{ expiresAtMs: null }] } }] }
}
async function renderUsage(overrides: Partial<Props> = {}, width = 120, height = 40) {
  const [props, setProps] = createStore<Props>({ ...defaults, ...overrides })
  const result = await testRender(() => createComponent(ThemeProvider, { mode: "dark", get children() { return createComponent(UsageModal, props) } }), { width, height })
  await result.renderOnce(); await Promise.resolve(); await result.renderOnce()
  return { result, setProps }
}
async function frame(overrides: Partial<Props> = {}, width = 120, height = 40): Promise<string> {
  const { result } = await renderUsage(overrides, width, height)
  try { return result.captureCharFrame() } finally { result.renderer.destroy() }
}
async function clickText(result: Awaited<ReturnType<typeof testRender>>, text: string): Promise<void> {
  const lines = result.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  const x = y < 0 ? -1 : lines[y]?.indexOf(text) ?? -1
  if (x < 0 || y < 0) throw new Error(`Missing mouse target: ${text}`)
  await result.mockMouse.click(x, y)
}
describe("Usage account browser", () => {
  it("uses a wide rail and ordered flat detail sections", async () => {
    const currentScroll = createModalScrollController()
    const { result, setProps } = await renderUsage({ currentScroll })
    try {
      const rendered = result.captureCharFrame()
      expect(rendered).toContain("ChatGPT Work  work@example.com")
      expect(rendered.indexOf("PROVIDER ALLOWANCE")).toBeLessThan(rendered.indexOf("BANKED RESET"))
      expect(rendered.indexOf("BANKED RESET")).toBeLessThan(rendered.indexOf("THIS MONTH"))
      expect(rendered).toContain("Estimated billed $0.00")
      expect(rendered).toContain("Included $42.00")
      expect(rendered).toContain("Apply reset")
      currentScroll.pageBy(1)
      await result.renderOnce()
      const scrolled = result.captureCharFrame()
      expect(scrolled).toContain("CURRENT USAGE WINDOWS")
      expect(scrolled).toContain("Included $21.00")
      setProps("accounts", structuredClone(fixtures.usageAccounts))
      await result.renderOnce(); await Promise.resolve(); await result.renderOnce()
      expect(result.captureCharFrame()).toBe(scrolled)
    } finally { result.renderer.destroy() }
  })
  it("shows partial month coverage without an unsettled-ledger warning", async () => {
    const source = fixtures.usageAccounts.sources[0]
    if (!source || source.activity.state !== "available") throw new Error("Expected activity fixture")
    const accounts = { ...fixtures.usageAccounts, sources: [{ ...source, activity: { ...source.activity, partial: true, incomplete: false, trackingStartMs: new Date(2026, 8, 5).getTime() } }] }
    const rendered = await frame({ accounts })
    expect(rendered).toContain("Tracked from Sep 5 · partial month")
    expect(rendered).not.toContain("Activity ledger is incomplete")
  })
  it("names an account window whose exact dates are unavailable", async () => {
    const source = fixtures.usageAccounts.sources[0]
    if (source?.kind !== "subscription") throw new Error("Expected subscription fixture")
    const accounts = { ...fixtures.usageAccounts, sources: [{ ...source, quotaAccounting: { state: "available", windows: [{ state: "window-unavailable", metricKey: "unknown_window" }] } as const }] }
    expect(await frame({ accounts })).toContain("unknown_window  Window unavailable")
  })
  it("shows an expired sign-in as a short rail status and its recovery step in detail", async () => {
    const rendered = await frame({ selectedSourceId: "anthropic:old" })
    const rail = rendered.split("\n").map((line) => line.slice(0, 32)).join("\n")
    expect(rail).toContain("Sign-in expired")
    expect(rendered).toContain("Sign in again")
  })
  it("uses a bounded narrow account indicator without hiding detail", async () => {
    const rendered = await frame({}, 36)
    expect(rendered).toContain("1/4 ChatGPT Work")
    expect(rendered).toContain("↓ next")
    expect(rendered).toContain("PROVIDER ALLOWANCE")
    expect(rendered.split("\n").every((line) => line.length <= 36)).toBe(true)
  })
  it("shows metered API money as this-month account activity", async () => {
    const rendered = await frame({ selectedSourceId: "api:openai" })
    expect(rendered).toContain("Estimated billed $4.60")
    expect(rendered).not.toContain("CURRENT USAGE WINDOWS")
  })
  it("reads a metered key's reported balance in its rail row, or that none is left", async () => {
    const metered = fixtures.usageAccounts.sources.find((source) => source.sourceId === "api:openai")
    if (metered?.kind !== "metered") throw new Error("Expected metered fixture")
    const funded = { ...metered, observation: { state: "supported" as const, providerStatus: "ok" as const, observedAtMs: 0, metrics: [], spendSources: [{ kind: "prepaid" as const, availability: "funded" as const, remaining: { kind: "money" as const, value: 20, currency: "USD", provenance: "provider" as const, precision: "exact" as const } }] } }
    expect(await frame({ accounts: { ...fixtures.usageAccounts, sources: [funded] }, selectedSourceId: "api:openai" })).toContain("$20.00 left")
    const empty = { ...funded, observation: { ...funded.observation, providerStatus: "exhausted" as const, spendSources: [{ kind: "prepaid" as const, availability: "empty" as const }] } }
    expect(await frame({ accounts: { ...fixtures.usageAccounts, sources: [empty] }, selectedSourceId: "api:openai" })).toContain("No balance left")
    const rail = (rendered: string) => rendered.split("\n").map((line) => line.slice(0, 32)).join("\n")
    expect(rail(await frame({ selectedSourceId: "api:openai" }))).toContain("Metered")
  })
  it("lists a metered key's balance in its detail, where a narrow layout without a rail still shows it", async () => {
    const metered = fixtures.usageAccounts.sources.find((source) => source.sourceId === "api:openai")
    if (metered?.kind !== "metered") throw new Error("Expected metered fixture")
    const balance = (value: number, currency: string) => ({ kind: "prepaid" as const, availability: "funded" as const, remaining: { kind: "money" as const, value, currency, provenance: "provider" as const, precision: "exact" as const } })
    const funded = { ...metered, observation: { state: "supported" as const, providerStatus: "ok" as const, observedAtMs: 0, metrics: [], spendSources: [balance(20, "USD"), balance(5, "CNY")] } }
    const narrow = await frame({ accounts: { ...fixtures.usageAccounts, sources: [funded] }, selectedSourceId: "api:openai" }, 50)
    expect(narrow).toContain("PREPAID BALANCE")
    expect(narrow).toContain("$20.00 left")
    expect(narrow).toContain("CN¥5.00 left")
    expect(narrow).not.toContain("no provider quota")
    const stale = { ...funded, observation: { ...funded.observation, state: "stale" as const, message: "Balance from an earlier reading" } }
    const rendered = await frame({ accounts: { ...fixtures.usageAccounts, sources: [stale] }, selectedSourceId: "api:openai" })
    expect(rendered).toContain("Balance from an earlier reading")
    expect(rendered).toContain("$20.00 left")
  })
  it("renders expiration variants, disabled, busy, and success states", async () => {
    const source = fixtures.usageAccounts.sources[0]
    if (source?.kind !== "subscription") throw new Error("Expected subscription fixture")
    for (const count of [1, 2, 5]) {
      const credits = Array.from({ length: count }, (_, index) => ({ title: "Full reset", expiresAtMs: new Date(2026, 9, 22 + 7 * index, 12).getTime() }))
      const accounts = { ...fixtures.usageAccounts, sources: [{ ...source, bankedResets: { availableCount: count, credits } }] }
      const rendered = await frame({ accounts })
      const lines = rendered.split("\n").filter((line) => line.includes("Full reset expires"))
      expect(lines).toHaveLength(count)
      expect(lines[0]).toContain(`${count > 1 ? "• " : ""}Full reset expires October 22, 2026`)
      if (count > 1) expect(lines[1]).toContain("• Full reset expires October 29, 2026")
      else expect(lines[0]).not.toContain("•")
      expect(rendered.match(/Apply reset/g)).toHaveLength(1)
      expect(rendered).not.toContain(`${count} available`)
    }
    expect(await frame({ accounts: accountsWithNoExpiry() })).toContain("does not expire")
    expect(await frame({ resetAttempt: busy })).toContain("Applying reset...")
    expect(await frame({ resetAttempt: { kind: "idle", outcome: { sourceId: "chatgpt:work", message: "Banked reset applied · usage refreshed", applied: true } } })).toContain("Banked reset applied")
    expect(await frame({ resetAttempt: { kind: "idle", outcome: { sourceId: "copilot:personal", message: "Banked reset applied · usage refreshed", applied: true } } })).not.toContain("Banked reset applied")
  })
  it("keeps the reading and the whole tab switch beside every status, and warns only for a failed refresh", async () => {
    const time = new Date(fixtures.usageAccounts.asOf).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    const tabs = "[Accounts]  Spend  History"
    const statusSpan = (result: Awaited<ReturnType<typeof renderUsage>>["result"]) => result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("As of"))
    const { result, setProps } = await renderUsage()
    try {
      expect(result.captureCharFrame().split("\n").find((line) => line.includes(tabs))).toContain(`As of ${time}`)
      setProps("failure", { kind: "delayed" }); await result.renderOnce()
      expect(result.captureCharFrame()).toContain(`As of ${time} · update delayed`)
      expect(statusSpan(result)?.fg.equals(resolveTheme(flywheelTheme, "dark").textMuted)).toBe(true)
      setProps("failure", { kind: "failed", cause: "provider check failed" }); await result.renderOnce()
      expect(result.captureCharFrame()).toContain(`As of ${time} · refresh failed`)
      expect(result.captureCharFrame()).toContain("PROVIDER ALLOWANCE")
      expect(result.captureCharFrame()).not.toContain("provider check failed")
      expect(statusSpan(result)?.fg.equals(resolveTheme(flywheelTheme, "dark").warning)).toBe(true)
    } finally { result.renderer.destroy() }
    const narrow = await frame({ failure: { kind: "failed", cause: "provider check failed" } }, 40)
    expect(narrow.split("\n").find((line) => line.includes(tabs))).toMatch(/\[Accounts\] {2}Spend {2}History +As o[^·]*\.\.\. +│$/)
  })
  it("shows a failed first read as a short status and the cause's first line in the body", async () => {
    const rendered = await frame({ accounts: undefined, failure: { kind: "failed", cause: "Usage ledger is locked\n    at read (ledger.ts:1)" } })
    expect(rendered.split("\n").find((line) => line.includes("[Accounts]  Spend  History"))).toContain("Could not read usage")
    expect(rendered).toContain("Usage ledger is locked")
    expect(rendered).not.toContain("ledger.ts")
    expect(rendered).not.toContain("No active usage sources")
    expect(await frame({ accounts: undefined, failure: { kind: "delayed" } })).toContain("Fetching usage...")
  })
  it("dispatches both reset confirmation mouse choices", async () => {
    const onConfirmReset = mock(noop); const onCancelReset = mock(noop)
    const { result } = await renderUsage({ resetAttempt: reviewing, onConfirmReset, onCancelReset })
    try {
      expect(result.captureCharFrame()).not.toContain("PROVIDER ALLOWANCE")
      await clickText(result, "Apply reset")
      await clickText(result, "Keep reset")
      expect(onConfirmReset).toHaveBeenCalledTimes(1)
      expect(onCancelReset).toHaveBeenCalledTimes(1)
    } finally { result.renderer.destroy() }
  })
  it("disables the close hit target while a reset is busy", async () => {
    const onClose = mock(noop)
    const { result } = await renderUsage({ resetAttempt: busy, onClose })
    try {
      const lines = result.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes("Usage") && line.includes("x"))
      const x = y < 0 ? -1 : lines[y]?.lastIndexOf("x") ?? -1
      if (x < 0 || y < 0) throw new Error("Missing close affordance")
      await result.mockMouse.click(x, y)
      expect(onClose).not.toHaveBeenCalled()
    } finally { result.renderer.destroy() }
  })
  it("updates the mounted detail when the selected source changes", async () => {
    const { result, setProps } = await renderUsage()
    try {
      expect(result.captureCharFrame()).toContain("Primary Window")
      setProps("selectedSourceId", "copilot:personal")
      await result.renderOnce(); await Promise.resolve(); await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Provider data is stale")
      expect(result.captureCharFrame()).toContain("AI Credits  70 of 3,900 used")
      expect(result.captureCharFrame()).toContain("Flywheel cap")
      expect(result.captureCharFrame()).toContain("2% used")
    } finally { result.renderer.destroy() }
  })
  it("keeps clicked account rows in place and reveals offscreen selections", async () => {
    const source = fixtures.usageAccounts.sources[0]!
    const accounts = { ...fixtures.usageAccounts, sources: Array.from({ length: 20 }, (_, index) => ({ ...source, sourceId: `account:${index}`, label: `Account ${String(index).padStart(2, "0")}` })) }
    const { result, setProps } = await renderUsage({ accounts, selectedSourceId: "account:0", onSourceChange: (id) => setProps("selectedSourceId", id) }, 120, 24)
    const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
    try {
      const rail = descendants(result.renderer.root).find((node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable)!
      rail.scrollTo(18)
      await result.renderOnce()
      const row = () => result.captureCharFrame().split("\n").findIndex((line) => line.slice(0, rail.x + rail.width).includes("Account 08"))
      const before = row()
      await clickText(result, "Account 08")
      await result.renderOnce()
      expect(rail.scrollTop).toBe(18)
      expect(row()).toBe(before)
      expect(result.captureCharFrame().split("\n")[before]).toContain("▌ Account 08")
      rail.scrollTo(19)
      await result.renderOnce()
      await clickText(result, "Account 10")
      await result.renderOnce()
      expect(rail.scrollTop).toBe(19)
      expect(result.captureCharFrame()).toContain("▌ Account 10")
      setProps("accounts", { ...accounts, sources: accounts.sources.map((account) => ({ ...account })) })
      await result.renderOnce()
      expect(rail.scrollTop).toBe(19)
      setProps("selectedSourceId", "account:12")
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("▌ Account 12")
      expect(rail.scrollTop).toBeGreaterThan(18)
      setProps("selectedSourceId", "account:5")
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("▌ Account 05")
      expect(rail.scrollTop).toBeLessThan(18)
    } finally { result.renderer.destroy() }
  })
  it("stacks metric fields whenever their rendered text cannot fit", async () => {
    const accounts = { ...fixtures.usageAccounts, asOf: fixtures.usageNow - 3 * 86_400_000 }
    for (const width of [60, 66]) {
      const rendered = await frame({ accounts }, width)
      const metricLine = rendered.split("\n").find((line) => line.includes("Primary Window"))
      expect(metricLine).toBeDefined()
      expect(metricLine).not.toContain("Reset")
    }
  })
  it("keeps the stacked view below and split browser above the usable breakpoint", () => {
    expect(computeUsageModalLayout(65).splitAccounts).toBe(false)
    expect(computeUsageModalLayout(66).splitAccounts).toBe(true)
    expect(computeUsageModalLayout(120).modalWidth).toBe(98)
  })
})