import type { AccessProviderDefinition } from "../../../infra/llm/access-provider.js"
import type { UsageAuthority, UsageQuotaAccounting } from "../../../infra/llm/usage-authority.js"
import { localMonthBounds } from "../../../infra/llm/usage-authority-codec.js"
import type { SubscriptionUsageService } from "../../auth/provider-observations/subscription-usage-service.js"
import type { SubscriptionUsageServiceLease } from "../../auth/provider-observations/subscription-usage-service-pool.js"
import type { RuntimeAuthStatusScope } from "../../../protocol/auth-status-protocol-types.js"
import type { UsageAccountsResult, UsageHistoryRange, UsageHistoryResult, UsageMutationResult, UsageProtocolMetadata, UsageSpendResult } from "../../../protocol/modules/subscription-usage.js"
import { subscriptionSpendAccountCorrelationId } from "../../../protocol/subscription-spend-consent-protocol-types.js"
import { projectUsageAccounts, projectUsageHistory, projectUsageSpend, type CurrentUsageAccount, type CurrentUsageObservationSet, type MeteredUsageSource, type UsageHistoryObservation } from "./usage-projection.js"
import { historyAccount } from "./usage-history.js"
import type { RuntimeConfigProjection } from "../../app-service/runtime-config-projection.js"

export interface UnifiedUsageDeps {
  readonly subscriptionUsage?: {
    acquireScope(scope: RuntimeAuthStatusScope): Promise<SubscriptionUsageServiceLease>
  }
  readonly meteredUsageSources?: (profile: SubscriptionUsageServiceLease["profile"]) => readonly MeteredUsageSource[]
  readonly usageProviderDisplayName?: (providerId: string) => string
  /** The enabled provider definitions, for each provider's own reading of its usage. */
  readonly providerDefinitions?: () => readonly AccessProviderDefinition[]
  readonly usageIncomplete?: (profileId: string) => Promise<boolean>
  readonly refreshSubscriptionSpendConsent?: (scope: RuntimeAuthStatusScope, service: SubscriptionUsageService) => Promise<void>
  readonly now?: () => number
  readonly config: Pick<RuntimeConfigProjection, "view">
}

/** The unified Usage reads and mutations the app service serves (ARCH-PROVIDERS-050, ARCH-PROTOCOL-041):
 *  one lease per scoped call, current observations reconciled against the
 *  generation, and the spend, accounts, and history projections over the
 *  profile ledger. */
export function createUnifiedUsage(deps: UnifiedUsageDeps) {
  const usageNow = deps.now ?? Date.now
  const usageAuthority = deps.subscriptionUsage

  async function withUsage<T>(scope: RuntimeAuthStatusScope, operation: (service: SubscriptionUsageService, profile: SubscriptionUsageServiceLease["profile"]) => Promise<T> | T): Promise<T> {
    if (!usageAuthority) throw new Error("Subscription usage is unavailable")
    const lease = await usageAuthority.acquireScope(scope)
    try {
      return await operation(lease.service, lease.profile)
    } finally {
      await lease.release()
    }
  }

  function usageGeneration(service: SubscriptionUsageService) {
    return service.generation()
  }

  function storeRevision(store: UsageAuthority): number {
    return store.revision()
  }
  function usageMetadata(service: SubscriptionUsageService, asOf: number, generation = usageGeneration(service), fallbackProfileId = "unavailable"): UsageProtocolMetadata {
    const profileId = service.snapshot()?.profileId ?? generation?.profileId ?? fallbackProfileId
    const store = openUsageStore(service)
    return { profileId, authorityIncarnation: store?.incarnation() ?? "unavailable", revision: store ? storeRevision(store) : 0, generation: generation?.generation ?? 0, asOf }
  }

  function openUsageStore(service: SubscriptionUsageService): UsageAuthority | undefined {
    return service.store()
  }

  const USAGE_CURRENT_FRESHNESS_MS = 15 * 60_000
  function currentUsageResult(service: SubscriptionUsageService, freshnessMs = USAGE_CURRENT_FRESHNESS_MS, asOf = usageNow(), profileId?: string): CurrentUsageObservationSet {
    const generation = usageGeneration(service)
    const published = service.snapshot()
    const currentPublished = published?.generation === generation?.generation ? published : undefined
    const store = openUsageStore(service)
    const accounts = currentPublished !== undefined
      ? currentPublished.accounts
      : generation?.accounts.map((account) => {
          const snapshot = store && account.identity !== undefined ? store.current({ providerId: account.providerId, instanceId: account.instanceId, identity: account.identity }) : undefined
          return snapshot !== undefined && asOf - snapshot.observedAtMs > freshnessMs
            ? { kind: "stale" as const, account, snapshot }
            : { kind: "pending" as const, account }
        }) ?? []
    return {
      ...usageMetadata(service, currentPublished?.checkedAtMs ?? asOf, generation, profileId),
      accounts: accounts.map((entry): CurrentUsageAccount => {
        const account = entry.account
        switch (entry.kind) {
          case "supported": {
            const snapshot = entry.snapshot
            return { ...account, state: "supported", ...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }), ...(snapshot.tier === undefined ? {} : { tier: snapshot.tier }), providerStatus: snapshot.providerStatus, observedAtMs: snapshot.observedAtMs, readerGeneration: snapshot.readerGeneration, metrics: snapshot.metrics, spendSources: snapshot.spendSources, ...(snapshot.resetCredits === undefined ? {} : { resetCredits: snapshot.resetCredits }), crossedThresholds: store ? store.crossedThresholds(snapshot) : [] }
          }
          case "stale": {
            const snapshot = entry.snapshot
            return { ...account, state: "stale", ...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }), ...(snapshot.tier === undefined ? {} : { tier: snapshot.tier }), providerStatus: snapshot.providerStatus, observedAtMs: snapshot.observedAtMs, readerGeneration: snapshot.readerGeneration, metrics: snapshot.metrics, spendSources: snapshot.spendSources, crossedThresholds: store ? store.crossedThresholds(snapshot) : [], ...("message" in entry && typeof entry.message === "string" ? { message: entry.message } : {}) }
          }
          case "failure": {
            const snapshot = entry.snapshot
            if (snapshot === undefined) return { ...account, state: "failure", observation: "absent", message: entry.message }
            return { ...account, state: "failure", observation: "retained", ...(snapshot.plan === undefined ? {} : { plan: snapshot.plan }), ...(snapshot.tier === undefined ? {} : { tier: snapshot.tier }), providerStatus: snapshot.providerStatus, observedAtMs: snapshot.observedAtMs, readerGeneration: snapshot.readerGeneration, metrics: snapshot.metrics, spendSources: snapshot.spendSources, crossedThresholds: store ? store.crossedThresholds(snapshot) : [], message: entry.message }
          }
          case "pending":
            return { ...account, state: "pending" }
          case "unsupported":
            return { ...account, state: "unsupported", ...("message" in entry && typeof entry.message === "string" ? { message: entry.message } : {}) }
          case "identity-unavailable":
            return { ...account, state: "identity-unavailable", ...("message" in entry && typeof entry.message === "string" ? { message: entry.message } : {}) }
          case "expired-auth":
            return { ...account, state: "expired-auth", message: entry.message }
        }
        return entry satisfies never
      }),
    }
  }

  function historyUsageResult(service: SubscriptionUsageService, range: UsageHistoryRange, asOf = usageNow()): UsageHistoryObservation {
    const generation = usageGeneration(service)
    const monthStart = localMonthBounds(asOf).startMs
    const requestedStart = range === "24h" ? asOf - 24 * 60 * 60_000 : range === "7d" ? asOf - 7 * 24 * 60 * 60_000 : range === "Month" ? monthStart : 0
    const store = openUsageStore(service)
    const histories = generation?.accounts.map((account) => ({ account, entries: store && account.identity !== undefined ? store.history({ providerId: account.providerId, instanceId: account.instanceId, identity: account.identity }, { startMs: requestedStart, endMs: asOf }) : [] })) ?? []
    const startMs = range === "All" ? Math.min(asOf, ...histories.flatMap(({ entries }) => entries.map((entry) => entry.hourStartMs))) : requestedStart
    const accounts = histories.map(({ account, entries }) => historyAccount(account, entries, startMs, asOf))
    return { range, startMs, endMs: asOf, accounts }
  }

  function providerDisplayName(providerId: string): string {
    return deps.usageProviderDisplayName?.(providerId) ?? providerId
  }

  function providerDefinition(providerId: string): AccessProviderDefinition | undefined {
    return deps.providerDefinitions?.().find((definition) => definition.id === providerId)
  }

  /** Whether a metric is provider detail readers hide until asked; the provider classifies its own metrics. */
  function metricDetail(providerId: string, metricKey: string): boolean {
    return providerDefinition(providerId)?.usage?.metricDetail?.(metricKey) ?? false
  }

  async function unifiedUsageSpend(service: SubscriptionUsageService, profile: SubscriptionUsageServiceLease["profile"], range: UsageHistoryRange = "Month", asOf = usageNow(), current = currentUsageResult(service, USAGE_CURRENT_FRESHNESS_MS, asOf, profile.id)): Promise<UsageSpendResult> {
    const store = openUsageStore(service)
    if (!store) throw new Error("Usage authority is unavailable")
    const monthStart = localMonthBounds(asOf).startMs
    const startMs = range === "24h" ? asOf - 24 * 60 * 60_000 : range === "7d" ? asOf - 7 * 24 * 60 * 60_000 : range === "Month" ? monthStart : Math.min(asOf, Date.parse(store.trackingStart))
    const entries = startMs === asOf
      ? { start: new Date(asOf).toISOString(), end: new Date(asOf).toISOString(), groups: [] }
      : store.rangeEntries({ startMs, endMs: asOf })
    const metadata = usageMetadata(service, asOf, undefined, profile.id)
    if (metadata.profileId !== profile.id || store.profileId !== profile.id) throw new Error("Usage authority does not match the resolved profile")
    return projectUsageSpend({ metadata, range, entries, trackingStart: store.trackingStart, incomplete: (await deps.usageIncomplete?.(profile.id)) ?? false, current, metered: deps.meteredUsageSources?.(profile) ?? [], providerDisplayName })
  }

  async function unifiedUsageAccounts(service: SubscriptionUsageService, profile: SubscriptionUsageServiceLease["profile"], asOf = usageNow(), freshnessMs = USAGE_CURRENT_FRESHNESS_MS): Promise<UsageAccountsResult> {
    const current = currentUsageResult(service, freshnessMs, asOf, profile.id)
    const store = openUsageStore(service)
    if (store && store.profileId !== profile.id) throw new Error("Usage authority does not match the resolved profile")
    const identified = current.accounts.flatMap((account) => account.identity === undefined ? [] : [{ sourceId: subscriptionSpendAccountCorrelationId(profile.id, account.providerId, account.instanceId), providerId: account.providerId, instanceId: account.instanceId, identity: account.identity }])
    const captured = store?.accountsQuotaAccounting({ accounts: identified, asOf })
    const quotaBySource = new Map<string, UsageQuotaAccounting>(captured?.results.map((result) => [result.sourceId, result.quotaAccounting]))
    for (const account of current.accounts) {
      const sourceId = subscriptionSpendAccountCorrelationId(profile.id, account.providerId, account.instanceId)
      if (account.identity === undefined) quotaBySource.set(sourceId, { state: "window-unavailable" })
      else if (!store) quotaBySource.set(sourceId, { state: "ledger-unavailable" })
    }
    // Each provider reads its own cap from its settings for this profile; the
    // config view already carries every declared key with its default.
    const providerSettings = deps.config.view().values.profiles[profile.id]?.providers ?? {}
    const allowanceCaps = new Map<string, number>((deps.providerDefinitions?.() ?? []).flatMap((definition) => {
      const cap = definition.usage?.allowanceCap?.(providerSettings[definition.id] ?? {})
      return cap === undefined ? [] : [[definition.id, cap] as const]
    }))
    const projectedCurrent = captured === undefined ? current : { ...current, revision: captured.revision, asOf: captured.asOf }
    const activity = store ? await unifiedUsageSpend(service, profile, "Month", asOf, projectedCurrent) : undefined
    return projectUsageAccounts({ current: projectedCurrent, metered: deps.meteredUsageSources?.(profile) ?? [], quotaBySource, providerDisplayName, metricDetail, allowanceCaps, activity })
  }

  function unifiedUsageHistory(service: SubscriptionUsageService, profile: SubscriptionUsageServiceLease["profile"], range: UsageHistoryRange, asOf = usageNow()): UsageHistoryResult {
    const metadata = usageMetadata(service, asOf, undefined, profile.id)
    if (metadata.profileId !== profile.id) throw new Error("Usage authority does not match the resolved profile")
    const store = openUsageStore(service)
    const observed = historyUsageResult(service, range, asOf)
    // The All range reaches back to the ledger's first entry as well as the first sample, so spend and samples share one axis.
    const history = store && range === "All" ? { ...observed, startMs: Math.min(observed.startMs, Date.parse(store.trackingStart)) } : observed
    return projectUsageHistory({ metadata, history, spend: store && history.startMs < asOf ? store.hourlySpend({ startMs: history.startMs, endMs: asOf }) : undefined, current: currentUsageResult(service, USAGE_CURRENT_FRESHNESS_MS, asOf, profile.id), metered: deps.meteredUsageSources?.(profile) ?? [], providerDisplayName, metricDetail })
  }

  async function openUnifiedUsage(scope: RuntimeAuthStatusScope, freshnessMs = 15 * 60_000, forceRefresh = false): Promise<UsageMutationResult> {
    if (!usageAuthority) return { ok: false, error: "Usage is unavailable" }
    return withUsage(scope, async (service, profile) => {
      const current = service.snapshot()
      if (forceRefresh || current === undefined || usageNow() - current.checkedAtMs > freshnessMs) await service.check({ forceRefresh })
      await deps.refreshSubscriptionSpendConsent?.(scope, service)
      const metadata = usageMetadata(service, usageNow(), undefined, profile.id)
      if (metadata.profileId !== profile.id) throw new Error("Usage authority does not match the resolved profile")
      return { ok: true, usage: metadata }
    })
  }

  return { withUsage, usageMetadata, currentUsageResult, usageNow, USAGE_CURRENT_FRESHNESS_MS, unifiedUsageAccounts, unifiedUsageSpend, unifiedUsageHistory, openUnifiedUsage }
}
