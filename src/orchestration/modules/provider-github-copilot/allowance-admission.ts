import type { AccessProviderCandidate } from "../../../infra/llm/access-provider.js"
import type { SubscriptionAllowanceAdmission, SubscriptionAllowanceResolver } from "../../agent-runtime/llm/provider-availability-types.js"
import type { SubscriptionUsageService } from "../../auth/provider-observations/subscription-usage-service.js"

interface CaptureCopilotAllowanceAdmissionInput {
  readonly candidates: readonly AccessProviderCandidate[]
  readonly service: Pick<SubscriptionUsageService, "metric" | "checkAccounts">
  /** Flywheel's own monthly ceiling on pooled AI Credits; undefined is no ceiling. */
  readonly monthlyCreditCap: number | undefined
}

const PROVIDER_ID = "github_copilot"
const UNKNOWN_ALLOWANCE = Object.freeze({ allowance: "unknown" } as const)

function allowanceMetric(service: Pick<SubscriptionUsageService, "metric">, instanceId: string) {
  const credits = service.metric(PROVIDER_ID, instanceId, "ai_credits")
  return credits.kind === "unknown" ? service.metric(PROVIDER_ID, instanceId, "premium_interactions") : credits
}

/** Captures one immutable, secret-free Copilot allowance resolver for included
 *  admission. Unknown or stale allowance is the provider's decision
 *  (PI-MODEL-011), so such a candidate is dispatched. Only the profile's own
 *  monthly cap refuses before any adapter is built: when pooled usage has
 *  reached it, or when a cap is set and current usage cannot show that it
 *  has not. A finite seat's remaining allowance is left for affordability to
 *  price against. Paid modes do not read or apply included-allowance policy. */
export async function captureCopilotAllowanceAdmission(input: CaptureCopilotAllowanceAdmissionInput): Promise<SubscriptionAllowanceResolver> {
  const instanceIds = [...new Set(input.candidates.flatMap((candidate) => candidate.kind === "subscription" && candidate.providerId === PROVIDER_ID && candidate.spendMode === "included" ? [candidate.instanceId] : []))]
  if (instanceIds.length === 0) return Object.freeze(() => UNKNOWN_ALLOWANCE)
  // Pooled usage changes with every request, so each admission reads it again,
  // also after a failed read. Other evidence is read only when the usage
  // service judges it out of date, which spaces out repeated reads of an
  // account whose reads fail.
  const outOfDate: string[] = []
  const pooled: string[] = []
  for (const instanceId of instanceIds) {
    const evidence = allowanceMetric(input.service, instanceId)
    if (evidence.kind !== "unknown" && evidence.metric.metricKey === "ai_credits" && evidence.metric.allowanceMode !== "finite") pooled.push(instanceId)
    else if (evidence.kind !== "fresh") outOfDate.push(instanceId)
  }
  const accounts = (ids: readonly string[]) => ids.map((instanceId) => ({ providerId: PROVIDER_ID, instanceId }))
  await Promise.all([
    outOfDate.length === 0 ? undefined : input.service.checkAccounts(accounts(outOfDate)),
    pooled.length === 0 ? undefined : input.service.checkAccounts(accounts(pooled), { forceRefresh: true }),
  ])

  const allowances = new Map<string, SubscriptionAllowanceAdmission>()
  for (const instanceId of instanceIds) {
    const evidence = allowanceMetric(input.service, instanceId)
    if (evidence.kind === "unknown") continue
    const freshness = evidence.kind === "fresh" ? "fresh" : "stale"
    const remaining = evidence.metric.remaining
    if ((evidence.metric.metricKey === "premium_interactions" || evidence.metric.allowanceMode === "finite")
      && remaining?.kind === "count" && Number.isFinite(remaining.value)) {
      allowances.set(instanceId, Object.freeze({
        freshness,
        allowance: "finite",
        metric: evidence.metric.metricKey === "premium_interactions" ? "premium_interactions" : "ai_credits",
        remaining: remaining.value,
      }))
      continue
    }
    const used = evidence.metric.used
    if (evidence.metric.allowanceMode !== "pooled" || used?.kind !== "count" || !Number.isFinite(used.value)) continue
    if (freshness !== "fresh" && input.monthlyCreditCap !== undefined) continue
    if (input.monthlyCreditCap !== undefined && used.value >= input.monthlyCreditCap) {
      allowances.set(instanceId, Object.freeze({ allowance: "refused", detail: `the local monthly cap of ${input.monthlyCreditCap} credits has been reached.` }))
    } else {
      allowances.set(instanceId, Object.freeze({ freshness, allowance: "pooled", usedCredits: used.value }))
    }
  }
  const unverified = input.monthlyCreditCap === undefined
    ? UNKNOWN_ALLOWANCE
    : Object.freeze({ allowance: "refused", detail: `the local monthly cap of ${input.monthlyCreditCap} credits cannot be checked, because the current Copilot usage cannot be verified.` } as const)
  return Object.freeze((candidate: AccessProviderCandidate): SubscriptionAllowanceAdmission => candidate.kind === "subscription" && candidate.providerId === PROVIDER_ID && candidate.spendMode === "included"
    ? allowances.get(candidate.instanceId) ?? unverified
    : UNKNOWN_ALLOWANCE)
}
