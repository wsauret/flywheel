import type { UsageHourlySpend, UsageLedgerGroup, UsageQuotaAccounting as AuthorityQuotaAccounting, UsageRangeEntries } from "../../../infra/llm/usage-authority.js"
import { availableSubscriptionUsageResetCredits } from "../../../infra/llm/subscription-usage.js"
import type { SubscriptionUsageHistoryEntry } from "../../../infra/llm/subscription-usage-store.js"
import { subscriptionSpendAccountCorrelationId } from "../../../protocol/subscription-spend-consent-protocol-types.js"
import type { SubscriptionUsageMetric, SubscriptionUsageSpendSource } from "../../../infra/llm/subscription-usage.js"
import type { UsageAccountSource, UsageAccountsResult, UsageHistoryResult, UsageHistorySource, UsageModelSummary, UsageProtocolMetadata, UsageQuotaAccounting, UsageSpendPoint, UsageSpendResult, UsageSpendSource, UsageSubscriptionObservation, UsageTokens } from "../../../protocol/modules/subscription-usage.js"

interface CurrentUsageAccountBase {
  readonly providerId: string
  readonly instanceId: string
  readonly identity?: string
  readonly label?: string
}

interface CurrentUsageObservation {
  readonly plan?: string
  readonly tier?: string
  readonly providerStatus: "ok" | "warning" | "exhausted" | "unknown"
  readonly observedAtMs: number
  readonly readerGeneration: number
  readonly metrics: readonly SubscriptionUsageMetric[]
  readonly spendSources: readonly SubscriptionUsageSpendSource[]
  readonly resetCredits?: import("../../../infra/llm/subscription-usage.js").SubscriptionUsageResetCredits
  readonly crossedThresholds: readonly { readonly metricName: string; readonly threshold: number }[]
}

type ObservedCurrentUsageAccount = CurrentUsageAccountBase & CurrentUsageObservation
export type CurrentUsageAccount =
  | (ObservedCurrentUsageAccount & { readonly state: "supported" })
  | (ObservedCurrentUsageAccount & { readonly state: "stale"; readonly message?: string })
  | (ObservedCurrentUsageAccount & { readonly state: "failure"; readonly observation: "retained"; readonly message: string })
  | (CurrentUsageAccountBase & { readonly state: "failure"; readonly observation: "absent"; readonly message: string })
  | (CurrentUsageAccountBase & { readonly state: "pending" })
  | (CurrentUsageAccountBase & { readonly state: "unsupported"; readonly message?: string })
  | (CurrentUsageAccountBase & { readonly state: "identity-unavailable"; readonly message?: string })
  | (CurrentUsageAccountBase & { readonly state: "expired-auth"; readonly message: string })

export interface CurrentUsageObservationSet extends UsageProtocolMetadata {
  readonly accounts: readonly CurrentUsageAccount[]
}

export interface UsageHistoryObservation {
  readonly range: UsageHistoryResult["range"]
  readonly startMs: number
  readonly endMs: number
  readonly accounts: ReadonlyArray<Omit<UsageHistoryResult["sources"][number], "sourceId" | "kind" | "label" | "samples" | "spend"> & {
    readonly instanceId: string
    readonly identity?: string
    readonly label?: string
    readonly samples: readonly SubscriptionUsageHistoryEntry[]
  }>
}

export interface MeteredUsageSource {
  readonly kind: "metered"
  readonly sourceId: string
  readonly providerId: string
  readonly label: string
  readonly spendMode: "direct_api" | "aggregator"
  /** Masked key hint, so the Usage view names which key a profile holds. */
  readonly identity?: string
}

interface ActiveSubscriptionSource {
  readonly kind: "subscription"
  readonly sourceId: string
  readonly providerId: string
  readonly instanceId: string
  readonly label: string
  readonly account: CurrentUsageAccount
}

type ActiveUsageSource = ActiveSubscriptionSource | MeteredUsageSource

interface MutableSummary {
  attempts: number
  unmeasuredAttempts: number
  partialAttempts: number
  cacheComplete: boolean
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  estimatedBilledUsd: number
  includedValueUsd: number
  priceUnavailable: boolean
}

interface MutableSourceSummary extends MutableSummary {
  readonly sourceId: string
  readonly kind: UsageSpendSource["kind"]
  readonly providerId: string | undefined
  readonly label: string
  readonly active: boolean
  readonly spendModes: Set<UsageLedgerGroup["spendMode"]>
  readonly models: Map<string, MutableSummary>
}

const emptySummary = (): MutableSummary => ({ attempts: 0, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimatedBilledUsd: 0, includedValueUsd: 0, priceUnavailable: false })

function tokens(summary: Pick<MutableSummary, "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning">): UsageTokens {
  return { input: summary.input, output: summary.output, cacheRead: summary.cacheRead, cacheWrite: summary.cacheWrite, reasoning: summary.reasoning, total: summary.input + summary.output + summary.cacheRead + summary.cacheWrite + summary.reasoning }
}

function addGroup(summary: MutableSummary, group: UsageLedgerGroup): void {
  summary.attempts += group.attempts
  summary.unmeasuredAttempts += group.unmeasuredAttempts
  summary.partialAttempts += group.partialAttempts
  summary.cacheComplete &&= group.cacheComplete
  summary.input += group.inputTokens
  summary.output += group.outputTokens
  summary.cacheRead += group.cacheReadTokens
  summary.cacheWrite += group.cacheWriteTokens
  summary.reasoning += group.reasoningTokens
  summary.priceUnavailable ||= group.priceUnavailable
  if (group.classification === "real_spend") summary.estimatedBilledUsd += group.estimatedUsd
  else summary.includedValueUsd += group.estimatedUsd
}

function modelSummary(model: string, summary: MutableSummary): UsageModelSummary {
  return { model, attempts: summary.attempts, unmeasuredAttempts: summary.unmeasuredAttempts, partialAttempts: summary.partialAttempts, cacheComplete: summary.cacheComplete, tokens: tokens(summary), estimatedBilledUsd: summary.estimatedBilledUsd, includedValueUsd: summary.includedValueUsd, priceUnavailable: summary.priceUnavailable }
}

function sortModels(models: Iterable<[string, MutableSummary]>): UsageModelSummary[] {
  return [...models].map(([model, summary]) => modelSummary(model, summary)).toSorted((left, right) =>
    (right.estimatedBilledUsd + right.includedValueUsd) - (left.estimatedBilledUsd + left.includedValueUsd)
    || right.tokens.total - left.tokens.total
    || left.model.localeCompare(right.model))
}

/** Whether a usage account is this metered key's balance reading: the
 *  service names that account by the key's lineage, which is the source id. */
function readsKey(source: MeteredUsageSource, account: Pick<CurrentUsageAccount, "providerId" | "instanceId">): boolean {
  return source.providerId === account.providerId && source.sourceId === account.instanceId
}

function isMeteredAccount(account: Pick<CurrentUsageAccount, "providerId" | "instanceId">, metered: readonly MeteredUsageSource[]): boolean {
  return metered.some((source) => readsKey(source, account))
}

function activeSubscriptions(profileId: string, current: CurrentUsageObservationSet, metered: readonly MeteredUsageSource[], providerDisplayName: (providerId: string) => string): ActiveSubscriptionSource[] {
  return current.accounts.filter((account) => !isMeteredAccount(account, metered)).map((account) => ({
    kind: "subscription" as const,
    sourceId: subscriptionSpendAccountCorrelationId(profileId, account.providerId, account.instanceId),
    providerId: account.providerId,
    instanceId: account.instanceId,
    label: account.label || providerDisplayName(account.providerId),
    account,
  }))
}

function entrySource(entry: UsageLedgerGroup, profileId: string, active: ReadonlyMap<string, ActiveUsageSource>, providerDisplayName: (providerId: string) => string): Pick<MutableSourceSummary, "sourceId" | "kind" | "providerId" | "label" | "active"> {
  if (entry.attributionKind === "unattributed") {
    const activeSource = active.get(entry.credentialLineage)
    return activeSource?.kind === "metered"
      ? { sourceId: activeSource.sourceId, kind: "metered", providerId: activeSource.providerId, label: activeSource.label, active: true }
      : { sourceId: entry.credentialLineage, kind: "unattributed", providerId: undefined, label: "Unattributed usage", active: false }
  }
  const providerId = entry.providerId
  if (providerId === undefined) throw new Error("Candidate Usage group requires a provider")
  if (entry.instanceId !== undefined) {
    const sourceId = subscriptionSpendAccountCorrelationId(profileId, providerId, entry.instanceId)
    const activeSource = active.get(sourceId)
    return { sourceId, kind: activeSource?.kind ?? "subscription", providerId, label: activeSource?.label ?? providerDisplayName(providerId), active: activeSource !== undefined }
  }
  const activeSource = active.get(entry.credentialLineage)
  return { sourceId: entry.credentialLineage, kind: "metered", providerId, label: activeSource?.label ?? providerDisplayName(providerId), active: activeSource !== undefined }
}

function period(range: UsageHistoryResult["range"], entries: UsageRangeEntries, trackingStart: string, incomplete: boolean) {
  const startMs = Date.parse(entries.start)
  const endMs = Date.parse(entries.end)
  const trackingStartMs = Date.parse(trackingStart)
  return { range, startMs, endMs, trackingStartMs, partial: trackingStartMs > startMs, incomplete }
}

export function projectUsageSpend(input: {
  readonly metadata: UsageProtocolMetadata
  readonly range: UsageHistoryResult["range"]
  readonly entries: UsageRangeEntries
  readonly trackingStart: string
  readonly incomplete: boolean
  readonly current: CurrentUsageObservationSet
  readonly metered: readonly MeteredUsageSource[]
  readonly providerDisplayName: (providerId: string) => string
}): UsageSpendResult {
  const subscriptions = activeSubscriptions(input.metadata.profileId, input.current, input.metered, input.providerDisplayName)
  const active = new Map<string, ActiveUsageSource>([...subscriptions, ...input.metered].map((source) => [source.sourceId, source]))
  const summaries = new Map<string, MutableSourceSummary>()
  for (const entry of input.entries.groups) {
    const source = entrySource(entry, input.metadata.profileId, active, input.providerDisplayName)
    let summary = summaries.get(source.sourceId)
    if (summary === undefined) {
      summary = { ...emptySummary(), ...source, spendModes: new Set(), models: new Map() }
      summaries.set(source.sourceId, summary)
    }
    addGroup(summary, entry)
    summary.spendModes.add(entry.spendMode)
    let model = summary.models.get(entry.model)
    if (model === undefined) { model = emptySummary(); summary.models.set(entry.model, model) }
    addGroup(model, entry)
  }
  const sources: UsageSpendSource[] = [...summaries.values()].map((summary): UsageSpendSource => {
    const common = {
      sourceId: summary.sourceId, label: summary.label, active: summary.active, spendModes: [...summary.spendModes].toSorted(), attempts: summary.attempts,
      unmeasuredAttempts: summary.unmeasuredAttempts, partialAttempts: summary.partialAttempts, cacheComplete: summary.cacheComplete,
      tokens: tokens(summary), estimatedBilledUsd: summary.estimatedBilledUsd, includedValueUsd: summary.includedValueUsd,
      priceUnavailable: summary.priceUnavailable, models: sortModels(summary.models),
    }
    if (summary.kind === "unattributed") return { ...common, kind: "unattributed" }
    if (summary.providerId === undefined) throw new Error("Attributed Usage source requires a provider")
    return { ...common, kind: summary.kind, providerId: summary.providerId }
  }).toSorted((left, right) => Number(right.active) - Number(left.active) || left.label.localeCompare(right.label) || left.sourceId.localeCompare(right.sourceId))
  return {
    kind: "usage.spend", ...input.metadata, ...period(input.range, input.entries, input.trackingStart, input.incomplete),
    estimatedBilledUsd: sources.reduce((total, source) => total + source.estimatedBilledUsd, 0),
    includedValueUsd: sources.reduce((total, source) => total + source.includedValueUsd, 0), sources,
  }
}

function quotaAccounting(value: AuthorityQuotaAccounting | undefined): UsageQuotaAccounting {
  if (value === undefined || value.state !== "available") return value ?? { state: "window-unavailable" }
  return { state: "available", windows: value.windows.map((window) => window.state === "window-unavailable" ? window : ({ state: "available", metricKey: window.metricKey, startMs: window.startMs, endMs: window.endMs, trackingStartMs: window.trackingStartMs, partial: window.partial, attempts: window.attempts, unmeasuredAttempts: window.unmeasuredAttempts, partialAttempts: window.partialAttempts, cacheComplete: window.cacheComplete, tokens: tokens({ input: window.inputTokens, output: window.outputTokens, cacheRead: window.cacheReadTokens, cacheWrite: window.cacheWriteTokens, reasoning: window.reasoningTokens }), includedValueUsd: window.includedValueUsd, priceUnavailable: window.priceUnavailable })) }
}

type MetricDetail = (providerId: string, metricKey: string) => boolean

/** Stamps the provider's own classification on each metric the wire carries,
 *  so a client hides provider detail without knowing which provider it is. */
function withDetail(metrics: readonly SubscriptionUsageMetric[], providerId: string, metricDetail: MetricDetail): readonly SubscriptionUsageMetric[] {
  return metrics.map((metric) => metricDetail(providerId, metric.metricKey) ? { ...metric, detail: true as const } : metric)
}

function observation(account: CurrentUsageAccount, metricDetail: MetricDetail): UsageSubscriptionObservation {
  if (account.state === "failure" && account.observation === "absent") return { state: "failure", message: account.message }
  if (account.state === "pending") return { state: "pending" }
  if (account.state === "unsupported" || account.state === "identity-unavailable" || account.state === "expired-auth") return { state: account.state, ...("message" in account && account.message !== undefined ? { message: account.message } : {}) }
  const observed = {
    ...(account.plan === undefined ? {} : { plan: account.plan }), ...(account.tier === undefined ? {} : { tier: account.tier }),
    providerStatus: account.providerStatus, observedAtMs: account.observedAtMs, metrics: withDetail(account.metrics, account.providerId, metricDetail), spendSources: account.spendSources,
  }
  if (account.state === "supported") return { ...observed, state: "supported" }
  if (account.state === "stale") return { ...observed, state: "stale", ...(account.message === undefined ? {} : { message: account.message }) }
  return { ...observed, state: "failure", message: account.message }
}

export function projectUsageAccounts(input: {
  readonly current: CurrentUsageObservationSet
  readonly metered: readonly MeteredUsageSource[]
  readonly providerDisplayName: (providerId: string) => string
  readonly metricDetail: MetricDetail
  readonly quotaBySource: ReadonlyMap<string, AuthorityQuotaAccounting>
  /** Flywheel's monthly cap per provider id, applied to that provider's pooled allowance metric. */
  readonly allowanceCaps: ReadonlyMap<string, number>
  readonly activity: UsageSpendResult | undefined
}): UsageAccountsResult {
  const subscriptions = activeSubscriptions(input.current.profileId, input.current, input.metered, input.providerDisplayName)
  const activityBySource = new Map(input.activity?.sources.map((source) => [source.sourceId, source]))
  const activity = (sourceId: string) => {
    if (input.activity === undefined) return { state: "ledger-unavailable" as const }
    const source = activityBySource.get(sourceId)
    return {
      state: "available" as const,
      startMs: input.activity.startMs, endMs: input.activity.endMs, trackingStartMs: input.activity.trackingStartMs,
      partial: input.activity.partial, incomplete: input.activity.incomplete,
      attempts: source?.attempts ?? 0, unmeasuredAttempts: source?.unmeasuredAttempts ?? 0, partialAttempts: source?.partialAttempts ?? 0, cacheComplete: source?.cacheComplete ?? true,
      tokens: source?.tokens ?? tokens(emptySummary()),
      estimatedBilledUsd: source?.estimatedBilledUsd ?? 0, includedValueUsd: source?.includedValueUsd ?? 0,
      priceUnavailable: source?.priceUnavailable ?? false,
    }
  }
  const sources: UsageAccountSource[] = [
    ...subscriptions.map((source) => {
      const resets = "resetCredits" in source.account ? source.account.resetCredits : undefined
      const credits = availableSubscriptionUsageResetCredits(resets).map(({ expiresAtMs, title, description }) => ({
        ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
      }))
      const pooled = ("metrics" in source.account ? source.account.metrics : []).find((metric) => metric.allowanceMode === "pooled")
      const cap = input.allowanceCaps.get(source.providerId)
      return { kind: "subscription" as const, ...(source.account.identity === undefined ? {} : { identity: source.account.identity }), ...(pooled === undefined || cap === undefined ? {} : { allowanceCap: { metricKey: pooled.metricKey, value: cap } }), sourceId: source.sourceId, providerId: source.providerId, label: source.label, active: true as const, activity: activity(source.sourceId), quotaAccounting: quotaAccounting(input.quotaBySource.get(source.sourceId)), observation: observation(source.account, input.metricDetail), ...(resets === undefined ? {} : { bankedResets: { availableCount: resets.availableCount, credits } }) }
    }),
    ...input.metered.map((source) => {
      const balance = input.current.accounts.find((account) => readsKey(source, account))
      return { ...source, active: true as const, activity: activity(source.sourceId), ...(balance === undefined ? {} : { observation: observation(balance, input.metricDetail) }) }
    }),
  ]
  const { accounts: _accounts, ...metadata } = input.current
  return { kind: "usage.accounts", ...metadata, sources }
}

/** Spend by hour for every source the ledger attributed in the range, keyed
 *  by source id. Unattributed spend belongs to no source and is not here. */
function spendPointsBySource(spend: UsageHourlySpend, profileId: string, active: ReadonlyMap<string, ActiveUsageSource>, providerDisplayName: (providerId: string) => string): ReadonlyMap<string, readonly UsageSpendPoint[]> {
  const hours = new Map<string, Map<number, { billedUsd: number; includedUsd: number }>>()
  for (const group of spend.groups) {
    const source = entrySource(group, profileId, active, providerDisplayName)
    if (source.kind === "unattributed") continue
    let bySource = hours.get(source.sourceId)
    if (bySource === undefined) { bySource = new Map(); hours.set(source.sourceId, bySource) }
    let hour = bySource.get(group.hourStartMs)
    if (hour === undefined) { hour = { billedUsd: 0, includedUsd: 0 }; bySource.set(group.hourStartMs, hour) }
    if (group.classification === "real_spend") hour.billedUsd += group.estimatedUsd
    else hour.includedUsd += group.estimatedUsd
  }
  return new Map([...hours].map(([sourceId, bySource]) => [sourceId, [...bySource].toSorted(([left], [right]) => left - right).map(([hourStartMs, totals]) => ({ hourStartMs, ...totals }))]))
}

/** The history result: every subscription account's samples, and every
 *  active source's spend by hour, so a metered key has a history too. */
export function projectUsageHistory(input: { readonly metadata: UsageProtocolMetadata; readonly history: UsageHistoryObservation; readonly spend: UsageHourlySpend | undefined; readonly current: CurrentUsageObservationSet; readonly metered: readonly MeteredUsageSource[]; readonly providerDisplayName: (providerId: string) => string; readonly metricDetail: MetricDetail }): UsageHistoryResult {
  const profileId = input.metadata.profileId
  const active = new Map<string, ActiveUsageSource>([...activeSubscriptions(profileId, input.current, input.metered, input.providerDisplayName), ...input.metered].map((source) => [source.sourceId, source]))
  const spend = input.spend === undefined ? new Map<string, readonly UsageSpendPoint[]>() : spendPointsBySource(input.spend, profileId, active, input.providerDisplayName)
  const subscriptions = input.history.accounts.filter((account) => !isMeteredAccount(account, input.metered)).map(({ providerId, instanceId, identity: _identity, label, samples, latest, peak, ...account }): UsageHistorySource => {
    const sourceId = subscriptionSpendAccountCorrelationId(profileId, providerId, instanceId)
    return {
      ...account, sourceId, kind: "subscription", providerId,
      label: label || input.providerDisplayName(providerId),
      samples: samples.map(({ providerId: _providerId, instanceId: _instanceId, readerGeneration: _readerGeneration, ...sample }) => ({ ...sample, metrics: withDetail(sample.metrics, providerId, input.metricDetail) })),
      latest: withDetail(latest, providerId, input.metricDetail),
      peak: withDetail(peak, providerId, input.metricDetail),
      spend: spend.get(sourceId) ?? [],
    }
  })
  const metered = input.metered.map((source): UsageHistorySource => ({ sourceId: source.sourceId, kind: "metered", providerId: source.providerId, label: source.label, spendSources: [], count: 0, samples: [], latest: [], peak: [], resetMarkers: [], spend: spend.get(source.sourceId) ?? [] }))
  return { kind: "usage.history", ...input.metadata, range: input.history.range, startMs: input.history.startMs, endMs: input.history.endMs, sources: [...subscriptions, ...metered] }
}
