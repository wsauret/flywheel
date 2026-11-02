/** @jsxImportSource @opentui/solid */

import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import { BOLD } from "@tui/utils/text-attributes"
import { createEffect, createMemo, For, type JSX, on, onCleanup, Show } from "solid-js"
import type { SubscriptionUsageMetric } from "../../../infra/llm/subscription-usage.js"
import { USAGE_HISTORY_RANGES, type UsageAccountSource, type UsageAccountsResult, type UsageHistoryRange, type UsageHistoryResult, type UsageModelSummary, type UsageSpendResult, type UsageSpendSource, type UsageSubscriptionObservation, historySeries, prepaidBalances, spendSeries, type HistorySeries, isDetailWindow, sumUsageCoverage, sumUsageTokens, usageCoverageText, USAGE_COMMAND_NAME } from "../../../protocol/modules/subscription-usage.js"

import { progressBar } from "../../components/progress-bar.js"
import { sparkline } from "../../components/sparkline.js"

import { ModalFrame } from "../../components/modal-frame.js"
import { computeModalWidth } from "../../components/modal-layout.js"
import { usageFooterRows } from "./footer.js"
import { Section } from "../../components/modal-section.js"
import { Button } from "../../components/button.js"
import type { UsageModalView, UsageResetAttempt, UsageResetOutcome } from "./use-usage-modal.js"
import type { ModalScrollController } from "../../components/modal-scroll-controller.js"
import { UsageTokenLines } from "./token-lines.js"

interface UsageModalProps {
  view: UsageModalView
  accounts?: UsageAccountsResult
  spend?: UsageSpendResult
  history?: UsageHistoryResult
  loading: boolean
  error?: string
  selectedSourceId?: string
  historyRange: UsageHistoryRange
  spendRange: UsageHistoryRange
  showDetailMetrics: boolean
  currentScroll: ModalScrollController
  spendScroll: ModalScrollController
  onClose: () => void
  onRefresh: () => void
  onViewChange: (view: UsageModalView) => void
  onSourceChange: (sourceId: string) => void
  onSpendRangeChange: (range: UsageHistoryRange) => void
  onHistoryRangeChange: (range: UsageHistoryRange) => void
  resetAttempt?: UsageResetAttempt
  onBeginReset?: () => void
  onConfirmReset?: () => void
  onCancelReset?: () => void
}

const MODAL_HORIZONTAL_CHROME = 6
const MAX_USAGE_MODAL_WIDTH = 98
const MODAL_CHROME_ROWS = 11
/** Rows the body below the tabs occupies whenever the terminal allows. Every view fills the same body, so the frame
 *  holds still while the selected account or the tab changes; only a short terminal shrinks it. */
const USAGE_BODY_ROWS = 20
const MIN_USAGE_BODY_ROWS = 6
/** Rows one account occupies in the rail: label, summary, and the blank line that separates it from the next. */
const RAIL_ITEM_ROWS = 3
const MIN_ACCOUNT_RAIL_WIDTH = 24
const ACCOUNT_PANE_GAP = 2
const MIN_ACCOUNT_DETAIL_WIDTH = 34

export interface UsageModalLayout { readonly modalWidth: number; readonly contentWidth: number; readonly splitAccounts: boolean }
export function computeUsageModalLayout(termWidth: number): UsageModalLayout {
  const modalWidth = computeModalWidth(Math.max(1, Math.floor(termWidth)), MAX_USAGE_MODAL_WIDTH)
  const contentWidth = Math.max(1, modalWidth - MODAL_HORIZONTAL_CHROME)
  return { modalWidth, contentWidth, splitAccounts: contentWidth >= MIN_ACCOUNT_RAIL_WIDTH + ACCOUNT_PANE_GAP + MIN_ACCOUNT_DETAIL_WIDTH }
}
function usageBodyHeight(termHeight: number): number {
  return Math.max(MIN_USAGE_BODY_ROWS, Math.min(USAGE_BODY_ROWS, Math.floor(termHeight) - MODAL_CHROME_ROWS))
}
/** Rows a view spends outside its scrolling region, so the region takes the rest of the body. */
function usageReservedRows(view: UsageModalView, accountCount: number): number {
  if (view === "accounts") return accountCount > 0 ? 1 : 0
  return 1
}

function money(value: number): string { return value.toLocaleString("en-US", { style: "currency", currency: "USD" }) }
function tokens(value: number): string { return value.toLocaleString("en-US") }
function shortDate(value: number): string { return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" }) }
function shortTime(value: number): string { return new Date(value).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }) }
function shortDateRange(startMs: number, endMs: number): string {
  const start = new Date(startMs)
  const end = new Date(endMs)
  const sameDate = start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth() && start.getDate() === end.getDate()
  if (endMs - startMs < 86_400_000 || sameDate) {
    return `${shortDate(startMs)} ${shortTime(startMs)}–${sameDate ? shortTime(endMs) : `${shortDate(endMs)} ${shortTime(endMs)}`}`
  }
  const sameMonth = start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()
  return `${shortDate(startMs)}–${sameMonth ? end.getDate() : shortDate(endMs)}`
}
function valueText(value: SubscriptionUsageMetric["used"]): string | undefined {
  if (!value) return undefined
  if (value.kind === "percentage") return `${Math.round(value.value * 100)}%`
  if (value.kind === "money") return `${value.currency} ${value.value}`
  return `${value.value.toLocaleString("en-US")} ${value.unit}`
}
function isMatchingUnit(left: SubscriptionUsageMetric["used"], right: SubscriptionUsageMetric["limit"]): boolean {
  if (!left || !right || left.kind !== right.kind) return false
  if (left.kind === "count" && right.kind === "count") return left.unit === right.unit
  if (left.kind === "money" && right.kind === "money") return left.currency === right.currency
  return left.kind === "percentage" && right.kind === "percentage"
}
function usageFraction(metric: SubscriptionUsageMetric): number | undefined {
  if (metric.usedFraction !== undefined) return metric.usedFraction
  if (isMatchingUnit(metric.used, metric.limit) && metric.used && metric.limit && metric.limit.value > 0) return metric.used.value / metric.limit.value
  if (isMatchingUnit(metric.remaining, metric.limit) && metric.remaining && metric.limit && metric.limit.value > 0) return 1 - metric.remaining.value / metric.limit.value
  return undefined
}
function clampedFraction(metric: SubscriptionUsageMetric): number | undefined {
  const fraction = usageFraction(metric)
  return fraction === undefined ? undefined : Math.max(0, Math.min(1, fraction))
}
/** The total a count metric reads against: the provider's limit in the same unit, else Flywheel's cap. */
function metricTotal(metric: SubscriptionUsageMetric, cap: number | undefined): number | undefined {
  if (metric.used?.kind !== "count") return undefined
  return isMatchingUnit(metric.used, metric.limit) && metric.limit ? metric.limit.value : cap
}
function capFor(source: UsageAccountSource, metric: SubscriptionUsageMetric): number | undefined {
  return source.kind === "subscription" && source.allowanceCap?.metricKey === metric.metricKey ? source.allowanceCap.value : undefined
}
function metricText(metric: SubscriptionUsageMetric, cap?: number): string {
  const fraction = clampedFraction(metric)
  if (fraction !== undefined) return `${Math.round(fraction * 100)}% used`
  const total = metricTotal(metric, cap)
  // The label already names the unit for a metric such as "AI Credits", so the text does not repeat it.
  if (metric.used?.kind === "count" && total !== undefined) return `${metric.used.value.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}${metric.used.unit === metric.label ? "" : ` ${metric.used.unit}`} used`
  return valueText(metric.used) ? `${valueText(metric.used)} used` : "Usage unavailable"
}
/** The rail's one-line form of the same fact: a percentage whenever a total is known, since the rail has no room for
 *  raw counts and the detail pane shows them. */
function compactMetricText(metric: SubscriptionUsageMetric, cap?: number): string {
  const total = metricTotal(metric, cap)
  if (metric.used?.kind === "count" && total !== undefined && total > 0) return `${Math.round(Math.min(1, metric.used.value / total) * 100)}% used`
  return metricText(metric, cap)
}
function resetText(metric: SubscriptionUsageMetric, now: number): string | undefined {
  const resetAtMs = metric.timing.kind === "exact" ? metric.timing.endMs : metric.timing.resetAtMs
  if (resetAtMs === undefined) return metric.timing.kind === "unavailable" && metric.timing.resetId ? `Reset: ${metric.timing.resetId}` : undefined
  if (resetAtMs <= now) return "Reset due"
  const hours = Math.ceil((resetAtMs - now) / 3_600_000)
  if (hours === 1) return "Resets in 1 hour"
  if (hours < 48) return `Resets in ${hours} hours`
  const days = Math.ceil(hours / 24)
  return `Resets in ${days} ${days === 1 ? "day" : "days"}`
}
function visibleAccountMetrics(metrics: readonly SubscriptionUsageMetric[], showDetailMetrics: boolean): readonly SubscriptionUsageMetric[] {
  const visible = showDetailMetrics ? metrics : metrics.filter((metric) => !isDetailWindow(metric))
  return visible.toSorted((left, right) => left.rank - right.rank)
}
interface MetricColumns { readonly label: number; readonly used: number }
function metricColumns(source: UsageAccountSource, metrics: readonly SubscriptionUsageMetric[]): MetricColumns {
  return { label: Math.max(0, ...metrics.map((metric) => metric.label.length)), used: Math.max(0, ...metrics.map((metric) => metricText(metric, capFor(source, metric)).length)) }
}
function Metric(props: { metric: SubscriptionUsageMetric; width: number; now: number; columns: MetricColumns; cap: number | undefined }) {
  const { theme } = useTheme(); const fraction = () => clampedFraction(props.metric); const reset = () => resetText(props.metric, props.now)
  const text = () => metricText(props.metric, props.cap)
  const capNote = () => props.cap !== undefined && metricTotal(props.metric, props.cap) === props.cap && !(isMatchingUnit(props.metric.used, props.metric.limit) && props.metric.limit) ? "Flywheel cap" : undefined
  const lead = () => `${props.metric.label.padEnd(props.columns.label)}  ${text().padEnd(props.columns.used)}`
  const color = () => props.metric.providerStatus === "exhausted" || fraction() === 1 ? theme.error : props.metric.providerStatus === "warning" ? theme.warning : fraction() === undefined ? theme.text : theme.success
  const inlineBarWidth = () => Math.max(4, Math.min(18, Math.floor(props.width / 3)))
  const inline = () => {
    const lengths = [lead().length]
    if (fraction() !== undefined && props.width >= 4) lengths.push(inlineBarWidth())
    const resetValue = reset(); const note = capNote()
    if (resetValue !== undefined) lengths.push(resetValue.length)
    if (note !== undefined) lengths.push(note.length)
    return lengths.reduce((total, length) => total + length, 0) + lengths.length - 1 <= props.width
  }
  return <box flexDirection={inline() ? "row" : "column"} gap={inline() ? 1 : 0}>
    <text fg={color()}>{inline() ? lead() : `${props.metric.label}  ${text()}`}</text>
    <Show when={fraction() !== undefined && props.width >= 4}><text fg={color()} overflow="hidden" wrapMode="none">{progressBar(fraction() ?? 0, inline() ? inlineBarWidth() : props.width)}</text></Show>
    <Show when={reset()}>{(value) => <text fg={theme.textMuted}>{value()}</text>}</Show>
    <Show when={capNote()}>{(note) => <text fg={theme.textMuted}>{note()}</text>}</Show>
  </box>
}
function QuotaAccounting(props: { source: Extract<UsageAccountSource, { kind: "subscription" }> }) {
  const { theme } = useTheme(); const available = () => props.source.quotaAccounting.state === "available" ? props.source.quotaAccounting.windows : undefined
  const metricLabel = (metricKey: string) => accountObservation(props.source)?.metrics.find((metric) => metric.metricKey === metricKey)?.label ?? metricKey
  return <box flexDirection="column">
    <Show when={props.source.quotaAccounting.state === "window-unavailable"}><text fg={theme.textMuted}>Window usage unavailable</text></Show>
    <Show when={props.source.quotaAccounting.state === "ledger-unavailable"}><text fg={theme.warning} attributes={BOLD}>Usage ledger unavailable</text></Show>
    <For each={available()}>{(usage) => <Show when={usage.state === "available" ? usage : undefined} fallback={<text fg={theme.textMuted}>{`${metricLabel(usage.metricKey)}  Window unavailable`}</text>}>{(value) => <box flexDirection="column"><text fg={theme.text}>{`${metricLabel(value().metricKey)}  ${shortDateRange(value().startMs, value().endMs)}`}</text><Show when={value().partial}><text fg={theme.warning}>{`Tracked from ${shortDate(value().trackingStartMs)} · partial window`}</text></Show><text fg={value().unmeasuredAttempts > 0 ? theme.warning : theme.text}>{`Included ${money(value().includedValueUsd)} · ${usageCoverageText(value())}`}</text><text fg={theme.textMuted}>{`${tokens(value().tokens.total)} tokens · cache read ${value().cacheComplete ? tokens(value().tokens.cacheRead) : "unavailable"} · cache write ${tokens(value().tokens.cacheWrite)} · reasoning ${tokens(value().tokens.reasoning)}`}</text><Show when={value().priceUnavailable}><text fg={theme.warning}>Some model prices are unavailable</text></Show></box>}</Show>}</For>
  </box>
}
function AccountActivity(props: { activity: UsageAccountSource["activity"] }) {
  const { theme } = useTheme()
  return <box flexDirection="column">
    <Show when={props.activity.state === "ledger-unavailable"}><text fg={theme.warning} attributes={BOLD}>Usage ledger unavailable</text></Show>
    <Show when={props.activity.state === "available" ? props.activity : undefined}>{(activity) => <>
      <text fg={theme.text}>{`Tracked range  ${shortDateRange(activity().startMs, activity().endMs)}`}</text>
      <Show when={activity().partial}><text fg={theme.warning}>{`Tracked from ${shortDate(activity().trackingStartMs)} · partial month`}</text></Show>
      <text fg={activity().unmeasuredAttempts > 0 ? theme.warning : theme.text}>{`Estimated billed ${money(activity().estimatedBilledUsd)} · Included ${money(activity().includedValueUsd)} · ${usageCoverageText(activity())}`}</text>
      <text fg={theme.textMuted}>{`${tokens(activity().tokens.total)} tokens · cache read ${activity().cacheComplete ? tokens(activity().tokens.cacheRead) : "unavailable"} · cache write ${tokens(activity().tokens.cacheWrite)} · reasoning ${tokens(activity().tokens.reasoning)}`}</text>
      <Show when={activity().incomplete}><text fg={theme.warning}>Activity ledger is incomplete</text></Show>
      <Show when={activity().priceUnavailable}><text fg={theme.warning}>Some model prices are unavailable</text></Show>
    </>}</Show>
  </box>
}
function accountObservation(source: UsageAccountSource) { return source.kind === "subscription" && "metrics" in source.observation ? source.observation : undefined }
function accountStateMessage(observation: UsageSubscriptionObservation): string { return observation.state === "pending" ? "Loading usage..." : "message" in observation ? observation.message ?? "Usage unavailable" : "Usage unavailable" }
function expiryPhrase(value: number | null | undefined): string { return value === null ? "does not expire" : value === undefined ? "expiration unavailable" : `expires ${new Date(value).toLocaleDateString("en-US", { dateStyle: "long" })}` }
/** The status a view reports while it loads or after a fetch fails. Empty while idle, so the row it occupies stays put. */
function statusText(loading: boolean, error: string | undefined, present: boolean, fetching: string): string {
  return loading ? (present ? "Refreshing..." : fetching) : error === undefined ? "" : `Fetch failed: ${error}`
}
/** The tabs row: the view choices on the left and the active view's status on the right. Always one row tall, so a
 *  refresh or a failure changes text in place and never inserts a row. */
function TabsRow(props: { status: string; error: boolean; children: JSX.Element }) {
  const { theme } = useTheme()
  return <box flexDirection="row" justifyContent="space-between" height={1}>{props.children}<text fg={props.error ? theme.error : theme.textMuted} overflow="hidden" wrapMode="none" truncate>{props.status}</text></box>
}
/** One row of exclusive choices. Tabs, ranges, and pickers all read the same way: the active item is bracketed and bold. */
function Choices<T extends string>(props: { items: readonly T[]; active: T | undefined; label?: (item: T) => string; disabled?: boolean; onSelect: (item: T) => void }) {
  const { theme } = useTheme()
  const label = (item: T) => props.label?.(item) ?? item
  return <box flexDirection="row" gap={2}><For each={props.items}>{(item) => <box onMouseDown={() => !props.disabled && props.onSelect(item)}><text fg={item === props.active ? theme.primary : theme.textMuted} attributes={item === props.active ? BOLD : undefined}>{item === props.active ? `[${label(item)}]` : label(item)}</text></box>}</For></box>
}
/** A rail row is one line, so an expired sign-in reads as a short status there; the detail pane carries the full recovery step. */
function primaryStatus(source: UsageAccountSource): string { const observed = accountObservation(source); const metric = observed?.metrics.toSorted((a, b) => a.rank - b.rank)[0]; return metric ? compactMetricText(metric, capFor(source, metric)) : source.kind === "metered" ? meteredStatus(source.observation) : observationStatus(source.observation) }
/** A metered key has no allowance: its reading is the balance its provider reports, else why there is none. */
function meteredStatus(observation: UsageSubscriptionObservation | undefined): string { return observation === undefined ? "Metered" : "metrics" in observation ? prepaidBalances(observation)[0] ?? "No reading" : observationStatus(observation) }
function observationStatus(observation: UsageSubscriptionObservation): string { return observation.state === "expired-auth" ? "Sign-in expired" : accountStateMessage(observation) }
/** An observation's colour: a failed or expired reading is an error, a stale one a warning, else the provider's own status. */
function observationColor(theme: ReturnType<typeof useTheme>["theme"], observation: UsageSubscriptionObservation | undefined) {
  if (observation === undefined) return theme.textMuted
  if (observation.state === "failure" || observation.state === "expired-auth") return theme.error
  if (observation.state === "stale") return theme.warning
  const status = "providerStatus" in observation ? observation.providerStatus : undefined
  return status === "exhausted" ? theme.error : status === "warning" ? theme.warning : theme.textMuted
}
/** A metered key's prepaid balance: every balance its provider reports, beneath why the reading is not current. */
function PrepaidBalance(props: { observation: UsageSubscriptionObservation }) {
  const { theme } = useTheme(); const color = () => observationColor(theme, props.observation)
  return <box flexDirection="column">
    <Show when={props.observation.state !== "supported"}><text fg={color()}>{accountStateMessage(props.observation)}</text></Show>
    <For each={prepaidBalances(props.observation)} fallback={<Show when={"metrics" in props.observation}><text fg={theme.textMuted}>Prepaid balance unavailable</text></Show>}>{(line) => <text fg={color()}>{line}</text>}</For>
  </box>
}
function BankedReset(props: { source: Extract<UsageAccountSource, { kind: "subscription" }>; now: number; onApply: () => void; busy: boolean; outcome?: UsageResetOutcome }) {
  const { theme } = useTheme(); const resets = () => props.source.bankedResets
  const outcome = () => props.outcome?.sourceId === props.source.sourceId ? props.outcome : undefined
  return <Show when={resets()}>{(value) => <Section title="BANKED RESET">
    <Show when={outcome()}>{(result) => <text fg={result().applied ? theme.success : theme.warning}>{result().message}</text>}</Show>
    <Show when={value().credits.length > 0} fallback={<text fg={theme.textMuted}>{value().availableCount > 0 ? `${value().availableCount} available · details unavailable` : "None available"}</text>}>
      <For each={value().credits}>{(item) => {
        const remaining = () => typeof item.expiresAtMs === "number" ? item.expiresAtMs - props.now : Number.POSITIVE_INFINITY
        return <text fg={remaining() <= 7 * 86_400_000 ? theme.warning : theme.text} attributes={remaining() <= 86_400_000 ? BOLD : undefined}>{`${value().credits.length > 1 ? "• " : ""}${item.title ?? "Full reset"} ${expiryPhrase(item.expiresAtMs)}`}</text>
      }}</For>
      <Show when={!props.busy} fallback={<text fg={theme.textMuted}>Applying reset...</text>}><Button label="Apply reset" hotkey="enter" onPress={props.onApply} /></Show>
    </Show>
  </Section>}</Show>
}
function AccountDetail(props: { source: () => UsageAccountSource; width: number; maxHeight: number; now: number; showDetailMetrics: boolean; currentScroll: ModalScrollController; onApply: () => void; busy: boolean; outcome?: UsageResetOutcome }) {
  const { theme } = useTheme(); const observed = () => accountObservation(props.source()); const subscription = () => { const source = props.source(); return source.kind === "subscription" ? source : undefined }; let scrollbox: ScrollBoxRenderable | undefined
  const sync = () => { if (scrollbox) props.currentScroll.attach(scrollbox) }; createEffect(sync); onCleanup(() => props.currentScroll.detach())
  const meteredObservation = () => { const source = props.source(); return source.kind === "metered" ? source.observation : undefined }
  return <scrollbox ref={(element: ScrollBoxRenderable) => { scrollbox = element; sync() }} maxHeight={props.maxHeight} contentOptions={{ minHeight: 0 }} viewportCulling={true}><box flexDirection="column"><box flexDirection="row" gap={2}><text fg={theme.primary} attributes={BOLD}>{props.source().label}</text><Show when={props.source().identity}>{(identity) => <text fg={theme.textMuted} overflow="hidden" wrapMode="none" truncate>{identity()}</text>}</Show></box><Show when={meteredObservation()} fallback={<Section title="PROVIDER ALLOWANCE"><Show when={subscription()} fallback={<text fg={theme.textMuted}>Metered account · no provider quota</text>}>{(source) => <><Show when={source().observation.state !== "supported"}><text fg={observationColor(theme, source().observation)}>{accountStateMessage(source().observation)}</text></Show><Show when={observed()}>{(current) => { const visible = () => visibleAccountMetrics(current().metrics, props.showDetailMetrics); return <box flexDirection="column" gap={1}><For each={visible()} fallback={<text fg={theme.textMuted}>Provider allowance unavailable</text>}>{(metric) => <Metric metric={metric} width={props.width} now={props.now} columns={metricColumns(props.source(), visible())} cap={capFor(props.source(), metric)} />}</For></box> }}</Show></>}</Show></Section>}>{(observation) => <Section title="PREPAID BALANCE"><PrepaidBalance observation={observation()} /></Section>}</Show><Show when={subscription()}>{(source) => <BankedReset source={source()} now={props.now} onApply={props.onApply} busy={props.busy} outcome={props.outcome} />}</Show><Section title="THIS MONTH"><AccountActivity activity={props.source().activity} /></Section><Show when={subscription()}>{(source) => <Section title="CURRENT USAGE WINDOWS"><QuotaAccounting source={source()} /></Section>}</Show></box></scrollbox>
}
function AccountsView(props: Pick<UsageModalProps, "accounts" | "loading" | "error" | "selectedSourceId" | "showDetailMetrics" | "currentScroll" | "onSourceChange" | "onBeginReset" | "resetAttempt"> & { width: number; maxHeight: number; split: boolean }) {
  const { theme } = useTheme()
  const sources = () => props.accounts?.sources ?? []
  const selectedIndex = () => Math.max(0, sources().findIndex((source) => source.sourceId === props.selectedSourceId))
  const selected = () => sources()[selectedIndex()]
  const previous = () => sources()[selectedIndex() - 1]
  const nextSource = () => sources()[selectedIndex() + 1]
  const now = () => props.accounts?.asOf ?? Date.now()
  let rail: ScrollBoxRenderable | undefined
  const sourceElements = new Map<string, Renderable>()
  createEffect(on(() => props.selectedSourceId, (id) => {
    const element = id === undefined ? undefined : sourceElements.get(id)
    if (!element || !rail) return
    if (element.y < rail.viewport.y + rail.viewport.height && element.y + element.height > rail.viewport.y) return
    rail.scrollChildIntoView(element.id)
  }))
  const selectPrevious = (): void => { const source = previous(); if (source) props.onSourceChange(source.sourceId) }
  const selectNext = (): void => { const source = nextSource(); if (source) props.onSourceChange(source.sourceId) }
  const Detail = () => <Show when={selected()}>{(source) => <AccountDetail source={source} width={props.split ? Math.max(1, props.width - MIN_ACCOUNT_RAIL_WIDTH - ACCOUNT_PANE_GAP) : props.width} maxHeight={props.split ? props.maxHeight : Math.max(1, props.maxHeight - 1)} now={now()} showDetailMetrics={props.showDetailMetrics} currentScroll={props.currentScroll} onApply={() => props.onBeginReset?.()} busy={props.resetAttempt?.kind === "busy"} outcome={props.resetAttempt?.kind === "idle" ? props.resetAttempt.outcome : undefined} />}</Show>
  // Every row reads the same way: the first window's use, in the provider's colour when it is short or gone. A banked
  // reset is the detail pane's. Only the selected account carries a marker: an unselected account draws nothing there.
  const RailItem = (item: { source: UsageAccountSource }) => {
    const current = () => item.source.sourceId === selected()?.sourceId
    onCleanup(() => sourceElements.delete(item.source.sourceId))
    return <box ref={(element: Renderable) => sourceElements.set(item.source.sourceId, element)} onMouseDown={() => props.onSourceChange(item.source.sourceId)} flexDirection="row" width={MIN_ACCOUNT_RAIL_WIDTH}>
      <text fg={theme.primary}>{current() ? "▌ " : "  "}</text>
      <box flexDirection="column" width={MIN_ACCOUNT_RAIL_WIDTH - 2}>
        <text fg={current() ? theme.primary : theme.text} attributes={current() ? BOLD : undefined} overflow="hidden" wrapMode="none" truncate>{item.source.label}</text>
        <text fg={observationColor(theme, item.source.observation)} overflow="hidden" wrapMode="none" truncate>{primaryStatus(item.source)}</text>
      </box>
    </box>
  }
  return <box flexDirection="column">
    <Show when={selected()} fallback={<Show when={!props.loading}><text fg={theme.textMuted}>No active usage sources</text></Show>}>
      <Show when={!props.split} fallback={<box flexDirection="row" gap={ACCOUNT_PANE_GAP}>
        <scrollbox ref={(element: ScrollBoxRenderable) => { rail = element; element.scrollTo(selectedIndex() * RAIL_ITEM_ROWS) }} width={MIN_ACCOUNT_RAIL_WIDTH} maxHeight={props.maxHeight} viewportCulling={true}><box width={MIN_ACCOUNT_RAIL_WIDTH} flexDirection="column" gap={1}><For each={sources()}>{(source) => <RailItem source={source} />}</For></box></scrollbox>
        <Detail />
      </box>}>
        <box flexDirection="column"><box flexDirection="row" justifyContent="space-between"><box onMouseDown={selectPrevious}><text fg={theme.textMuted} overflow="hidden" wrapMode="none" truncate>{previous() ? "↑ previous" : ""}</text></box><text fg={theme.primary} attributes={BOLD} overflow="hidden" wrapMode="none" truncate>{`${selectedIndex() + 1}/${sources().length} ${selected()?.label ?? ""}`}</text><box onMouseDown={selectNext}><text fg={theme.textMuted} overflow="hidden" wrapMode="none" truncate>{nextSource() ? "↓ next" : ""}</text></box></box><Detail /></box>
      </Show>
    </Show>
  </box>
}

function ModelLine(props: { model: UsageModelSummary }) {
  const { theme } = useTheme()
  return <box flexDirection="column">
    <text fg={theme.text}>{props.model.model}</text>
    <text fg={theme.textMuted}>{`${money(props.model.estimatedBilledUsd)} billed · ${money(props.model.includedValueUsd)} subscription-equivalent value`}</text>
    <UsageTokenLines tokens={props.model.tokens} coverage={props.model} />
    <Show when={props.model.priceUnavailable}><text fg={theme.warning}>price unavailable</text></Show>
  </box>
}
function SpendGroup(props: { source: UsageSpendSource; selected: boolean; onSelect: () => void; onElement: (element: Renderable) => void }) {
  const { theme } = useTheme()
  return <box ref={props.onElement} flexDirection="column" border={["left"]} borderColor={props.selected ? theme.primary : theme.borderSubtle} paddingLeft={1} marginBottom={1} onMouseDown={() => props.onSelect()}>
    <text fg={props.selected ? theme.primary : props.source.active ? theme.text : theme.textMuted} attributes={props.selected ? BOLD : undefined} overflow="hidden" wrapMode="none">{`${props.source.label}${props.source.active ? "" : " · inactive"}`}</text>
    <text fg={theme.textMuted}>{`${money(props.source.estimatedBilledUsd)} billed · ${money(props.source.includedValueUsd)} subscription-equivalent value · ${tokens(props.source.tokens.total)} tokens`}</text>
    <UsageTokenLines tokens={props.source.tokens} coverage={props.source} />
    <Show when={props.source.priceUnavailable}><text fg={theme.warning} overflow="hidden" wrapMode="none">Price unavailable for some models</text></Show>
    <For each={props.source.models}>{(model) => <ModelLine model={model} />}</For>
  </box>
}

function SpendView(props: Pick<UsageModalProps, "spend" | "spendRange" | "loading" | "error" | "selectedSourceId" | "spendScroll" | "onSpendRangeChange" | "onSourceChange"> & { maxHeight: number }) {
  const { theme } = useTheme()
  const sources = () => props.spend?.sources ?? []
  const sourceElements = new Map<string, Renderable>()
  let scrollbox: ScrollBoxRenderable | undefined
  onCleanup(() => props.spendScroll.detach())
  createEffect(on(() => props.selectedSourceId, (id) => {
    const element = id === undefined ? undefined : sourceElements.get(id)
    if (element) props.spendScroll.scrollIntoView(element)
  }))
  return <box flexDirection="column">
    <Choices items={USAGE_HISTORY_RANGES} active={props.spendRange} onSelect={props.onSpendRangeChange} />
    <Show when={props.spend}>{(result) => <scrollbox ref={(element: ScrollBoxRenderable) => { scrollbox = element; props.spendScroll.attach(element) }} onSizeChange={() => { if (scrollbox) props.spendScroll.attach(scrollbox) }} maxHeight={props.maxHeight} contentOptions={{ minHeight: 0 }} viewportCulling={true} verticalScrollbarOptions={{ visible: props.spendScroll.hasOverflow(), trackOptions: { foregroundColor: theme.primary, backgroundColor: theme.backgroundElement } }}>
      <Section title="TOTALS">
        <text fg={theme.text} overflow="hidden" wrapMode="none">{`Estimated billed  ${money(result().estimatedBilledUsd)}`}</text>
        <text fg={theme.text}>{`Subscription-equivalent value  ${money(result().includedValueUsd)}`}</text>
        <UsageTokenLines tokens={sumUsageTokens(sources().map((source) => source.tokens))} coverage={sumUsageCoverage(sources())} />
        <text fg={theme.textMuted}>Cache hit rate is the share of reported input tokens served from cache.</text>
        <text fg={theme.textMuted} overflow="hidden" wrapMode="none">{`Tracking since ${shortDate(result().trackingStartMs)}${result().partial ? " · partial range" : ""}`}</text>
        <Show when={result().incomplete}><text fg={theme.warning} overflow="hidden" wrapMode="none">Usage incomplete</text></Show>
      </Section>
      <Section title="BY SOURCE">
        <Show when={sources().length > 0} fallback={<text fg={theme.textMuted}>No spend recorded</text>}>
          <For each={sources()}>{(source) => <SpendGroup source={source} selected={source.sourceId === props.selectedSourceId} onSelect={() => props.onSourceChange(source.sourceId)} onElement={(element) => sourceElements.set(source.sourceId, element)} />}</For>
        </Show>
      </Section>
    </scrollbox>}</Show>
  </box>
}

/** One window over the range: its name and readings on a line, the sparkline
 *  beneath, and the range's ends with the reset count between them. */
function HistoryLine(props: { series: HistorySeries; startMs: number; endMs: number; width: number }) {
  const { theme } = useTheme()
  const color = () => props.series.tone === "error" ? theme.error : props.series.tone === "warn" ? theme.warning : theme.text
  const readings = () => [props.series.latest, props.series.peak].filter((part): part is string => part !== undefined).join(" · ")
  const resets = () => props.series.resets.length === 0 ? "" : `${props.series.resets.length} reset${props.series.resets.length === 1 ? "" : "s"}`
  const axis = () => {
    const start = shortDate(props.startMs); const end = shortDate(props.endMs); const middle = resets()
    const gap = Math.max(1, props.width - start.length - end.length - middle.length)
    return `${start}${" ".repeat(Math.floor(gap / 2))}${middle}${" ".repeat(Math.ceil(gap / 2))}${end}`
  }
  return <box flexDirection="column">
    <box flexDirection="row" justifyContent="space-between"><text fg={theme.text} overflow="hidden" wrapMode="none" truncate>{props.series.label}</text><text fg={color()} overflow="hidden" wrapMode="none" truncate>{readings()}</text></box>
    <text fg={props.series.tone === undefined ? theme.primary : color()} overflow="hidden" wrapMode="none">{sparkline(props.series.points, props.series.resets, props.startMs, props.endMs, props.width)}</text>
    <text fg={theme.textMuted} overflow="hidden" wrapMode="none" truncate>{axis()}</text>
  </box>
}
function HistoryView(props: Pick<UsageModalProps, "history" | "historyRange" | "selectedSourceId" | "loading" | "error" | "showDetailMetrics" | "onHistoryRangeChange" | "onSourceChange"> & { width: number; maxHeight: number }) {
  const { theme } = useTheme()
  const sources = () => props.history?.sources ?? []
  const selected = () => sources().find((source) => source.sourceId === props.selectedSourceId) ?? sources()[0]
  const labelOf = (sourceId: string) => sources().find((source) => source.sourceId === sourceId)?.label ?? sourceId
  const startMs = () => props.history?.startMs ?? 0
  const endMs = () => props.history?.endMs ?? Date.now()
  const series = (source: UsageHistoryResult["sources"][number]) => [...historySeries(source, props.showDetailMetrics), ...spendSeries(source, startMs())]
  return <box flexDirection="column">
    <Choices items={USAGE_HISTORY_RANGES} active={props.historyRange} onSelect={props.onHistoryRangeChange} />
    <Show when={sources().length > 0} fallback={<Show when={!props.loading}><text fg={theme.textMuted}>No provider observations</text></Show>}>
      <Section title="SOURCE"><Choices items={sources().map((source) => source.sourceId)} active={selected()?.sourceId} label={labelOf} onSelect={props.onSourceChange} /></Section>
      <Show when={selected()}>{(source) => <Section title={source().kind === "metered" ? "SPEND OVER TIME" : `USE OVER TIME · ${source().count} in range`}>
        <scrollbox maxHeight={Math.max(1, props.maxHeight - 6)} contentOptions={{ minHeight: 0 }} viewportCulling={true}><box flexDirection="column" gap={1}>
          <For each={series(source())} fallback={<text fg={theme.textMuted}>{source().kind === "metered" ? "No spend in this range" : "No readings in this range"}</text>}>{(line) => <HistoryLine series={line} startMs={startMs()} endMs={endMs()} width={props.width} />}</For>
        </box></scrollbox>
      </Section>}</Show>
    </Show>
  </box>
}

function UsageFooter(props: Pick<UsageModalProps, "view" | "onRefresh">) {
  const { theme } = useTheme()
  const rows = () => usageFooterRows({ view: props.view })
  return <box flexDirection="column" height={2} alignItems="flex-start">
    <text fg={theme.textMuted} overflow="hidden" wrapMode="none" truncate>{rows()[0]}</text>
    <box flexDirection="row" gap={1}><text fg={theme.textMuted} overflow="hidden" wrapMode="none" truncate>{rows()[1]}</text><box onMouseDown={() => props.onRefresh()}><text fg={theme.primary}>r refresh</text></box></box>
  </box>
}

function ResetConfirmation(props: Pick<UsageModalProps, "resetAttempt" | "onConfirmReset" | "onCancelReset">) {
  const { theme } = useTheme(); const attempt = () => props.resetAttempt?.kind === "reviewing" || props.resetAttempt?.kind === "busy" ? props.resetAttempt : undefined
  return <Show when={attempt()}>{(current) => <box flexDirection="column" gap={1}><text fg={theme.text} attributes={BOLD}>Apply banked reset</text><text fg={theme.text}>{`${current().selected?.title ?? "Full reset"} · ${expiryPhrase(current().selected?.expiresAtMs)}`}</text><Show when={current().message}><text fg={theme.warning}>{current().message}</text></Show><text fg={theme.text}>This resets the 5-hour and weekly ChatGPT limits and uses 1 banked reset.</text><Show when={current().kind === "busy"} fallback={<box flexDirection="row" gap={2}><Button label="Apply reset" hotkey="enter" onPress={() => props.onConfirmReset?.()} /><Button label="Keep reset" hotkey="esc" muted onPress={() => props.onCancelReset?.()} /></box>}><text fg={theme.textMuted}>Applying reset...</text></Show></box>}</Show>
}

export function UsageModal(props: UsageModalProps) {
  const { termWidth, termHeight } = useModalDimensions(MAX_USAGE_MODAL_WIDTH, MODAL_CHROME_ROWS, Number.MAX_SAFE_INTEGER)
  const layout = createMemo(() => computeUsageModalLayout(termWidth()))
  const bodyHeight = createMemo(() => usageBodyHeight(termHeight()))
  const contentMaxHeight = createMemo(() => Math.max(1, bodyHeight() - usageReservedRows(props.view, props.accounts?.sources.length ?? 0)))
  const tabs = ["accounts", "spend", "history"] as const
  const confirming = () => props.resetAttempt?.kind === "reviewing" || props.resetAttempt?.kind === "busy"
  const status = () => props.view === "accounts" ? statusText(props.loading, props.error, props.accounts !== undefined, "Fetching usage...")
    : props.view === "spend" ? statusText(props.loading, props.error, props.spend !== undefined, "Loading spend...")
    : statusText(props.loading, props.error, props.history !== undefined, "Fetching provider observations...")
  return <ModalFrame title={USAGE_COMMAND_NAME} width={layout().modalWidth} onClose={props.onClose} closeDisabled={props.resetAttempt?.kind === "busy"} gap={1}>
    <Show when={confirming()} fallback={<><TabsRow status={status()} error={props.error !== undefined}><Choices items={tabs} active={props.view} label={(view) => `${view[0]?.toUpperCase()}${view.slice(1)}`} disabled={props.resetAttempt?.kind === "busy"} onSelect={props.onViewChange} /></TabsRow><box flexDirection="column" height={bodyHeight()}><Show when={props.view === "accounts"}><AccountsView {...props} width={layout().contentWidth} maxHeight={contentMaxHeight()} split={layout().splitAccounts} /></Show><Show when={props.view === "spend"}><SpendView {...props} maxHeight={contentMaxHeight()} /></Show><Show when={props.view === "history"}><HistoryView {...props} width={layout().contentWidth} maxHeight={contentMaxHeight()} /></Show></box><UsageFooter {...props} /></>}><ResetConfirmation {...props} /></Show>
  </ModalFrame>
}
