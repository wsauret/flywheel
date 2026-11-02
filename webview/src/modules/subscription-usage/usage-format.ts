import type { RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { formatUsd, isDetailWindow, prepaidBalances, sumUsageCoverage, sumUsageTokens, USAGE_CACHE_UNAVAILABLE_REASON, usageCoverageText, usageFraction, usageTokenBreakdown, type UsageAccountSource, type UsageCoverageCounts, type UsageHistorySource, type UsageSpendResult, type UsageTokens } from "../../../../src/protocol/modules/subscription-usage.js"


/** Usage, in words a sheet can show.
 *
 *  Providers report what is left in their own vocabulary (different metric
 *  names, different units, some with a limit and some only with a fraction),
 *  so the rendering says what the provider said rather than normalising it
 *  into a shape that would misreport at least one of them. Everything here is
 *  a pure projection of protocol results, so it is testable without a sheet.
 *
 *  The sheet follows the terminal's usage modal: one compact reading per
 *  account in the list, and the open account's allowance, banked reset, and
 *  Flywheel activity beneath it. */

/** The metric wire shape, named off the protocol result that carries it. */
type UsageMetric = UsageHistorySource["latest"][number]
type Value = NonNullable<UsageMetric["used"]>
type Subscription = Extract<UsageAccountSource, { kind: "subscription" }>

type UsageTone = "warn" | "error"

/** One fact as a row: a short reading sits in the value column; a long one
 *  goes under the label as detail, where it can wrap. */
export interface UsageLine {
  readonly label: string
  readonly value?: string
  readonly detail?: string
  readonly tone?: UsageTone
}

/** A metric reported the way the provider reported it. A used/limit pair reads
 *  as a fraction; a bare `usedFraction` reads as a percentage; anything else
 *  reads as whatever single value arrived. Inventing the missing half of a pair
 *  would put a number in front of someone that no provider ever sent. */
export function describeMetric(metric: UsageMetric): string {
  if (metric.used !== undefined && metric.limit !== undefined) return `${metric.label} ${formatValue(metric.used)}/${formatValue(metric.limit)}`
  if (metric.usedFraction !== undefined) return `${metric.label} ${Math.round(metric.usedFraction * 100)}%`
  if (metric.remaining !== undefined) return `${metric.label} ${formatValue(metric.remaining)} left`
  if (metric.used !== undefined) return `${metric.label} ${formatValue(metric.used)} used`
  return metric.label
}

function formatValue(value: Value): string {
  switch (value.kind) {
    case "percentage":
      return `${Math.round(value.value * 100)}%`
    case "money":
      return value.value.toLocaleString(undefined, { style: "currency", currency: value.currency })
    case "count":
      return `${value.value.toLocaleString()} ${value.unit}`
  }
}

function sameUnit(left: Value | undefined, right: Value | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return false
  if (left.kind === "count" && right.kind === "count") return left.unit === right.unit
  if (left.kind === "money" && right.kind === "money") return left.currency === right.currency
  return true
}

/** Flywheel's own cap on a pooled allowance metric, when the source carries one for it. */
function capFor(source: UsageAccountSource, metric: UsageMetric): number | undefined {
  return source.kind === "subscription" && source.allowanceCap?.metricKey === metric.metricKey ? source.allowanceCap.value : undefined
}

/** A metric's reading against its total: the provider's limit in the same
 *  unit, else Flywheel's cap, else whatever the provider said. */
function metricReading(metric: UsageMetric, cap: number | undefined): string {
  if (metric.used?.kind === "count") {
    const total = sameUnit(metric.used, metric.limit) && metric.limit ? metric.limit.value : cap
    if (total !== undefined) return `${metric.used.value.toLocaleString()} of ${total.toLocaleString()}`
  }
  return describeMetric(metric).slice(metric.label.length).trim()
}

/** The one-line form of a reading for a list row: a percentage whenever a
 *  total is known, since the row has no room for raw counts. */
function compactReading(metric: UsageMetric, cap: number | undefined): string {
  const fraction = usageFraction(metric, cap)
  if (fraction !== undefined) return `${Math.round(fraction * 100)}% used`
  const reading = metricReading(metric, cap)
  return reading.length > 0 ? `${reading} used` : "No reading"
}

/** When a metric's window resets, as the person will read it. */
function resetText(metric: UsageMetric, now: number): string | undefined {
  const resetAtMs = metric.timing.kind === "exact" ? metric.timing.endMs : metric.timing.resetAtMs
  if (resetAtMs === undefined) return metric.timing.kind === "unavailable" && metric.timing.resetId ? `Reset: ${metric.timing.resetId}` : undefined
  if (resetAtMs <= now) return "Reset due"
  const hours = Math.ceil((resetAtMs - now) / 3_600_000)
  if (hours < 48) return `Resets in ${hours} hour${hours === 1 ? "" : "s"}`
  const days = Math.ceil(hours / 24)
  return `Resets in ${days} days`
}

export function shortDate(value: number): string {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function shortTime(value: number): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

/** A window as a person says it: one day shows its hours, a longer span its dates. */
function shortDateRange(startMs: number, endMs: number): string {
  const start = new Date(startMs)
  const end = new Date(endMs)
  const sameDate = start.toDateString() === end.toDateString()
  if (endMs - startMs < 86_400_000 || sameDate) return `${shortDate(startMs)} ${shortTime(startMs)} to ${sameDate ? shortTime(endMs) : `${shortDate(endMs)} ${shortTime(endMs)}`}`
  const sameMonth = start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()
  return `${shortDate(startMs)} to ${sameMonth ? end.getDate() : shortDate(endMs)}`
}

/** Whether paid use is allowed, declined, or waiting for review on an account. */
export function consentStatus(auth: RuntimeAuthView | undefined, providerId: string, sourceId: string): string | undefined {
  const consent = auth?.subscriptionSpendConsent
  if (consent?.kind !== "available") return undefined
  const decisions = new Set(consent.accounts
    .filter((account) => account.providerId === providerId && account.accountCorrelationId === sourceId)
    .flatMap((account) => account.modes.map((mode) => mode.decision)))
  if (decisions.has("unreviewed")) return "Review required"
  if (decisions.has("accepted")) return "Paid use allowed"
  if (decisions.has("declined")) return "Paid use declined"
  return undefined
}

function observedMetrics(source: UsageAccountSource): readonly UsageMetric[] {
  return source.kind === "subscription" && "metrics" in source.observation ? source.observation.metrics.toSorted((left, right) => left.rank - right.rank) : []
}

/** How many of a provider's windows are detail windows, which hide until asked for. */
export function detailWindowCount(metrics: readonly UsageMetric[]): number {
  return metrics.filter((metric) => isDetailWindow(metric)).length
}

export function detailMetricCount(source: UsageAccountSource): number {
  return detailWindowCount(observedMetrics(source))
}

function joined(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join(" · ")
}

export interface AccountStatus {
  readonly text: string
  readonly tone?: UsageTone
}

/** Why an account has no reading, in two or three words for a list row. */
function stateStatus(observation: Subscription["observation"]): AccountStatus {
  switch (observation.state) {
    case "pending": return { text: "Reading…" }
    case "unsupported": return { text: "Not reported" }
    case "identity-unavailable": return { text: "Account unknown" }
    case "expired-auth": return { text: "Signed out", tone: "warn" }
    case "failure": return { text: "Reading failed", tone: "error" }
    default: return { text: "No reading" }
  }
}

function observedTone(observation: Extract<Subscription["observation"], { metrics: unknown }>): UsageTone | undefined {
  return observation.providerStatus === "exhausted" ? "error" : observation.providerStatus === "warning" || observation.state !== "supported" ? "warn" : undefined
}

/** The one reading a list row carries: how much of the first window is
 *  used, else why there is no reading. A banked reset is the open account's
 *  business, so every subscription row reads the same way. A metered key has
 *  no allowance: its reading is the balance its provider reports, if any. */
export function accountStatus(source: UsageAccountSource): AccountStatus {
  if (source.kind === "metered") {
    const observation = source.observation
    if (observation === undefined) return { text: "Metered" }
    if (!("metrics" in observation)) return stateStatus(observation)
    const tone = observedTone(observation)
    return { text: prepaidBalances(observation)[0] ?? "No reading", ...(tone === undefined ? {} : { tone }) }
  }
  const observation = source.observation
  const [first] = observedMetrics(source)
  if (!("metrics" in observation) || first === undefined) return stateStatus(observation)
  const tone = observedTone(observation)
  return { text: compactReading(first, capFor(source, first)), ...(tone === undefined ? {} : { tone }) }
}

/** What sits under an account's name: its plan, who it is signed in as, and
 *  whether paid use is allowed. Never an internal account id. */
export function accountSubtitle(source: UsageAccountSource, auth: RuntimeAuthView | undefined): string | undefined {
  if (source.kind === "metered") return source.spendMode === "direct_api" ? "Direct API" : "Aggregator"
  const observation = source.observation
  const plan = "plan" in observation ? [observation.plan, observation.tier].filter(Boolean).join(" ") : ""
  return joined([plan, source.identity, consentStatus(auth, source.providerId, source.sourceId)]) || undefined
}

/** The provider's own words for a reading that is stale or failed, shown
 *  above the allowance or the balance so it is read with that in mind. */
export function providerNotice(source: UsageAccountSource): UsageLine | undefined {
  const observation = source.observation
  if (observation === undefined || observation.state === "supported") return undefined
  if (observation.state === "stale") return { label: "Stale reading", ...(observation.message === undefined ? {} : { detail: observation.message }), tone: "warn" }
  if (observation.state === "failure") return { label: "Reading failed", detail: observation.message, tone: "error" }
  const status = stateStatus(observation)
  return { label: status.text, ...("message" in observation && observation.message !== undefined ? { detail: observation.message } : {}), ...(status.tone === undefined ? {} : { tone: status.tone }) }
}

/** Every prepaid balance a metered key's provider reports, one line each, in
 *  the provider's colour. Empty for a key whose provider reports none. */
export function prepaidBalanceLines(source: UsageAccountSource): readonly UsageLine[] {
  if (source.kind !== "metered" || source.observation === undefined || !("metrics" in source.observation)) return []
  const tone = observedTone(source.observation)
  return prepaidBalances(source.observation).map((label) => ({ label, ...(tone === undefined ? {} : { tone }) }))
}

/** One metric as a bar: its reading, how full it is, when it resets, and the cap it reads against. */
export interface MetricBar {
  readonly label: string
  readonly reading: string
  readonly fraction?: number
  readonly note?: string
  readonly tone?: UsageTone
}

type ProviderStatus = UsageHistorySource["providerStatus"]

function barFor(metric: UsageMetric, cap: number | undefined, now: number, status: ProviderStatus): MetricBar {
  const fraction = usageFraction(metric, cap)
  const capNote = cap !== undefined && !(sameUnit(metric.used, metric.limit) && metric.limit) ? "Flywheel cap" : undefined
  const note = joined([resetText(metric, now), capNote])
  const tone = metric.providerStatus === "exhausted" || status === "exhausted" || fraction === 1 ? "error" : metric.providerStatus === "warning" || status === "warning" ? "warn" : undefined
  return {
    label: metric.label,
    reading: fraction !== undefined ? `${Math.round(fraction * 100)}% used` : metricReading(metric, cap) || "No reading",
    ...(fraction === undefined ? {} : { fraction }),
    ...(note.length === 0 ? {} : { note }),
    ...(tone === undefined ? {} : { tone }),
  }
}

export function metricBars(source: UsageAccountSource, now: number, showDetail: boolean): readonly MetricBar[] {
  if (source.kind !== "subscription" || !("metrics" in source.observation)) return []
  const status = source.observation.providerStatus
  return observedMetrics(source)
    .filter((metric) => showDetail || !isDetailWindow(metric))
    .map((metric) => barFor(metric, capFor(source, metric), now, status))
}

/** What Flywheel tracked for this account this local calendar month and in each current provider window. */
export function activityLines(source: UsageAccountSource): readonly UsageLine[] {
  const activity = source.activity
  if (activity.state === "ledger-unavailable") return [{ label: "This month" }, { label: "Usage ledger unavailable", tone: "warn" }, ...currentWindowLines(source)]
  const tokens = activity.tokens
  return [
    { label: "This month", value: shortDateRange(activity.startMs, activity.endMs) },
    ...(activity.partial ? [{ label: `Tracked from ${shortDate(activity.trackingStartMs)} · partial month`, tone: "warn" as const }] : []),
    { label: "Estimated billed", value: formatUsd(activity.estimatedBilledUsd) },
    coverageLine("Included value", formatUsd(activity.includedValueUsd), activity),
    { label: "Tokens", value: tokens.total.toLocaleString(), detail: `cache read ${activity.cacheComplete ? tokens.cacheRead.toLocaleString() : "unavailable"} · cache write ${tokens.cacheWrite.toLocaleString()} · reasoning ${tokens.reasoning.toLocaleString()}` },
    ...(activity.incomplete ? [{ label: "Activity ledger is incomplete", tone: "warn" as const }] : []),
    ...(activity.priceUnavailable ? [{ label: "Some model prices are unavailable", tone: "warn" as const }] : []),
    ...currentWindowLines(source),
  ]
}

function currentWindowLines(source: UsageAccountSource): readonly UsageLine[] {
  if (source.kind !== "subscription") return []
  const heading = { label: "Current usage windows" }
  const accounting = source.quotaAccounting
  if (accounting.state === "window-unavailable") return [heading, { label: "Window usage unavailable" }]
  if (accounting.state === "ledger-unavailable") return [heading, { label: "Usage ledger unavailable", tone: "warn" }]
  return [heading, ...accounting.windows.flatMap((window): UsageLine[] => {
    const label = observedMetrics(source).find((metric) => metric.metricKey === window.metricKey)?.label ?? window.metricKey
    if (window.state === "window-unavailable") return [{ label, value: "Window unavailable" }]
    return [
      { label, value: shortDateRange(window.startMs, window.endMs) },
      ...(window.partial ? [{ label: `Tracked from ${shortDate(window.trackingStartMs)} · partial window`, tone: "warn" as const }] : []),
      coverageLine(`${label} included`, formatUsd(window.includedValueUsd), window),
      { label: `${label} tokens`, value: window.tokens.total.toLocaleString() },
      ...(window.priceUnavailable ? [{ label: "Some model prices are unavailable", tone: "warn" as const }] : []),
    ]
  })]
}

export interface SpendGroup {
  readonly title: string
  /** The group's one-line reading under its title. */
  readonly summary?: string
  readonly tone?: UsageTone
  readonly lines: readonly UsageLine[]
}

/** A reading whose detail states the coverage of its requests, in warning tone when some reported no usage. */
function coverageLine(label: string, value: string, coverage: UsageCoverageCounts): UsageLine {
  return { label, value, detail: usageCoverageText(coverage), ...(coverage.unmeasuredAttempts > 0 ? { tone: "warn" as const } : {}) }
}

/** The cache hit rate of reported input, or why it is unknown. */
function cacheHitRate(tokens: UsageTokens, coverage: UsageCoverageCounts): string {
  if (!coverage.cacheComplete) return "unavailable"
  const rate = usageTokenBreakdown(tokens).cacheHitRate
  return rate === null ? "No usage yet" : `${(rate * 100).toFixed(1)}%`
}

export function tokenLines(tokens: UsageTokens, coverage: UsageCoverageCounts): readonly UsageLine[] {
  const counts = usageTokenBreakdown(tokens)
  const cached = (value: number) => coverage.cacheComplete ? value.toLocaleString() : "Unavailable"
  return [
    coverage.cacheComplete
      ? { label: "Reported cache hit rate", value: cacheHitRate(tokens, coverage) }
      : { label: "Reported cache hit rate", value: "Unavailable", detail: USAGE_CACHE_UNAVAILABLE_REASON },
    { label: "Input tokens", value: counts.input.toLocaleString() },
    { label: "Cached input", value: cached(counts.cached) },
    { label: "Uncached input", value: cached(counts.uncached) },
    { label: "Cache writes", value: cached(counts.cacheWrite) },
    { label: "Output tokens", value: counts.output.toLocaleString() },
    coverageLine("Requests", (coverage.attempts + coverage.unmeasuredAttempts).toLocaleString(), coverage),
  ]
}

export function spendGroups(spend: UsageSpendResult): readonly SpendGroup[] {
  const total: SpendGroup = {
    title: "Totals",
    lines: [
      { label: "Estimated billed spend", value: formatUsd(spend.estimatedBilledUsd) },
      { label: "Subscription-equivalent value", value: formatUsd(spend.includedValueUsd) },
      ...tokenLines(sumUsageTokens(spend.sources.map((source) => source.tokens)), sumUsageCoverage(spend.sources)),
      { label: `Tracking since ${shortDate(spend.trackingStartMs)}${spend.partial ? " · partial range" : ""}`, ...(spend.incomplete ? { detail: "Usage incomplete", tone: "warn" as const } : {}) },
    ],
  }
  const sources = spend.sources.map((source): SpendGroup => ({
    title: `${source.label}${source.active ? "" : " · inactive"}`,
    summary: `${formatUsd(source.estimatedBilledUsd)} billed · ${formatUsd(source.includedValueUsd)} subscription-equivalent value · ${source.tokens.total.toLocaleString()} tokens`,
    ...(source.priceUnavailable ? { tone: "warn" as const } : {}),
    lines: [...tokenLines(source.tokens, source), ...source.models.map((model): UsageLine => {
      const counts = usageTokenBreakdown(model.tokens)
      const cache = model.cacheComplete
        ? `${cacheHitRate(model.tokens, model)} reported cache hit · ${counts.input.toLocaleString()} input (${counts.cached.toLocaleString()} cached, ${counts.uncached.toLocaleString()} uncached, ${counts.cacheWrite.toLocaleString()} writes)`
        : `cache detail ${USAGE_CACHE_UNAVAILABLE_REASON} · ${counts.input.toLocaleString()} input`
      return {
        label: model.model,
        value: `${model.tokens.total.toLocaleString()} tokens`,
        detail: `${usageCoverageText(model)} · ${formatUsd(model.estimatedBilledUsd)} billed · ${formatUsd(model.includedValueUsd)} subscription-equivalent value · ${cache} · ${counts.output.toLocaleString()} output${model.priceUnavailable ? " · price unavailable" : ""}`,
        ...(model.priceUnavailable || model.unmeasuredAttempts > 0 ? { tone: "warn" as const } : {}),
      }
    })],
  }))
  return [total, ...sources]
}
