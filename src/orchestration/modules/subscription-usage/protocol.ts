import { subscriptionUsageProtocol } from "../../../protocol/modules/subscription-usage.js"
import { subscriptionSpendAccountCorrelationId } from "../../../protocol/subscription-spend-consent-protocol-types.js"
import type { ModuleProtocolRuntime, ModuleProtocolServices } from "../../app-service/module-protocol-host.js"
import { subscriptionUsageService } from "./service.js"
import { createSessionStatsReader } from "./session-stats.js"

/** Registry routing for the module's scoped queries and lossless mutations.
 *  A live toggle refuses new operations before they acquire a profile lease. */
export function createSubscriptionUsageProtocol(services: Pick<ModuleProtocolServices, "projectionReader" | "enabled" | "modules">): ModuleProtocolRuntime<typeof subscriptionUsageProtocol> {
  const stats = createSessionStatsReader(services.projectionReader)
  const current = () => services.enabled() ? services.modules.get(subscriptionUsageService)?.queries : undefined
  const requireQueries = () => {
    const queries = current()
    if (!queries) throw new Error("Usage is off")
    return queries
  }
  return {
    serve: {
      "usage.metadata": async (request) => { const q = requireQueries(); return q.withUsage(request.scope, (service, profile) => ({ ...q.usageMetadata(service, q.usageNow(), undefined, profile.id), kind: "usage.metadata" as const })) },
      "usage.stats": async ({ sessionId }) => {
        if (!services.enabled()) throw new Error("Usage is off")
        return stats(sessionId)
      },
      "usage.accounts": async (request) => { const q = requireQueries(); return q.withUsage(request.scope, (service, profile) => q.unifiedUsageAccounts(service, profile, request.asOf, request.freshnessMs)) },
      "usage.spend": async (request) => { const q = requireQueries(); return q.withUsage(request.scope, (service, profile) => q.unifiedUsageSpend(service, profile, request.range ?? "Month", request.asOf)) },
      "usage.history": async (request) => { const q = requireQueries(); return q.withUsage(request.scope, (service, profile) => q.unifiedUsageHistory(service, profile, request.range, request.asOf)) },
    },
    mutate: {
      "usage.open": async (request) => current()?.openUnifiedUsage(request.scope, request.freshnessMs) ?? { ok: false, error: "Usage is off" },
      "usage.refresh": async (request) => current()?.openUnifiedUsage(request.scope, 0, true) ?? { ok: false, error: "Usage is off" },
      "usage.apply_reset": async (request) => {
        const q = current()
        if (!q) return { kind: "stale" }
        return q.withUsage(request.scope, async (service, profile) => {
          const account = q.currentUsageResult(service, q.USAGE_CURRENT_FRESHNESS_MS, q.usageNow(), profile.id).accounts.find((candidate) => subscriptionSpendAccountCorrelationId(profile.id, candidate.providerId, candidate.instanceId) === request.sourceId)
          if (!account) { await service.refresh(); await service.check({ forceRefresh: true }); return { kind: "stale" } }
          return service.applyReset({ providerId: account.providerId, instanceId: account.instanceId, authorityIncarnation: request.authorityIncarnation, revision: request.revision, actionId: request.redeemRequestId })
        })
      },
    },
    dispose() {},
  }
}
