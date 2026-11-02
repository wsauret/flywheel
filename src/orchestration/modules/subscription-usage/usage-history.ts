import type { SubscriptionUsageHistoryEntry } from "../../../infra/llm/subscription-usage-store.js"
import type { SubscriptionUsageMetric } from "../../../infra/llm/subscription-usage.js"
import type { UsageHistoryObservation } from "./usage-projection.js"

function metricValue(metric: SubscriptionUsageMetric): number {
  if (metric.usedFraction !== undefined) return metric.usedFraction
  const sameUnit = (left: SubscriptionUsageMetric["used"], right: SubscriptionUsageMetric["limit"]): boolean => {
    if (!left || !right || left.kind !== right.kind) return false
    if (left.kind === "count" && right.kind === "count") return left.unit === right.unit
    if (left.kind === "money" && right.kind === "money") return left.currency === right.currency
    return left.kind === "percentage" && right.kind === "percentage"
  }
  if (sameUnit(metric.used, metric.limit) && metric.used && metric.limit && metric.limit.value > 0) return metric.used.value / metric.limit.value
  if (sameUnit(metric.remaining, metric.limit) && metric.remaining && metric.limit && metric.limit.value > 0) return 1 - metric.remaining.value / metric.limit.value
  return Number.NEGATIVE_INFINITY
}

export function historyAccount(account: { readonly providerId: string; readonly instanceId: string; readonly identity?: string; readonly label?: string }, entries: readonly SubscriptionUsageHistoryEntry[], startMs: number, endMs: number): UsageHistoryObservation["accounts"][number] {
  const samples = entries.filter((entry) => entry.hourStartMs >= startMs && entry.hourStartMs < endMs).toSorted((left, right) => left.hourStartMs - right.hourStartMs)
  const latestByMetric = new Map<string, SubscriptionUsageMetric>()
  const peakByMetric = new Map<string, SubscriptionUsageMetric>()
  // A reset is one event, however many hourly samples still name its id, so
  // the marker is recorded at the first sample that carries it.
  const resetMarkers = new Map<string, UsageHistoryObservation["accounts"][number]["resetMarkers"][number]>()
  for (const sample of samples) {
    for (const metric of sample.metrics) {
      latestByMetric.set(metric.metricKey, metric)
      const previous = peakByMetric.get(metric.metricKey)
      if (previous === undefined || metricValue(metric) > metricValue(previous)) peakByMetric.set(metric.metricKey, metric)
      if (metric.timing.kind !== "unavailable" || metric.timing.resetId === undefined) continue
      if (metric.timing.resetAtMs !== undefined && (metric.timing.resetAtMs < startMs || metric.timing.resetAtMs >= endMs)) continue
      const key = `${metric.metricKey}\u0000${metric.timing.resetId}`
      if (!resetMarkers.has(key)) resetMarkers.set(key, { metricName: metric.metricKey, resetId: metric.timing.resetId, ...(metric.timing.resetAtMs === undefined ? {} : { resetAtMs: metric.timing.resetAtMs }), observedAtMs: sample.observedAtMs })
    }
  }
  const latestSample = samples.at(-1)
  return {
    ...account,
    ...(latestSample?.plan === undefined ? {} : { plan: latestSample.plan }),
    ...(latestSample?.tier === undefined ? {} : { tier: latestSample.tier }),
    ...(latestSample === undefined ? {} : { providerStatus: latestSample.providerStatus }),
    spendSources: latestSample?.spendSources ?? [],
    count: samples.length,
    samples,
    latest: [...latestByMetric.values()],
    peak: [...peakByMetric.values()],
    resetMarkers: [...resetMarkers.values()].slice(-256),
  }
}
