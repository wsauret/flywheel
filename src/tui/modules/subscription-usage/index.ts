import { USAGE_SURFACE, USAGE_SPEND_SURFACE, USAGE_STATS_SURFACE, subscriptionUsageStatusRows, usageStatsStatusRow } from "../../../protocol/modules/subscription-usage.js"
import type { TuiModule } from "../../tui-module.js"

export const subscriptionUsageTui = {
  id: "subscription-usage",
  surfaces: [
    { id: USAGE_SURFACE, loadController: async () => (await import("./surface.js")).createUsageSurface },
    { id: USAGE_SPEND_SURFACE, loadController: async () => {
      const { createUsageSurface } = await import("./surface.js")
      return (host) => createUsageSurface(host, "spend")
    } },
    { id: USAGE_STATS_SURFACE, loadController: async () => (await import("./stats-surface.js")).createStatsSurface },
  ],
  status: async ({ client, foregroundId }) => {
    const sessionId = foregroundId()
    const [result, stats] = await Promise.all([
      client.query({ type: "usage.spend", scope: sessionId === undefined ? { kind: "defaults" } : { kind: "session", sessionId }, range: "Month" }),
      sessionId === undefined ? undefined : client.query({ type: "usage.stats", sessionId }).catch(() => undefined),
    ])
    return [
      ...subscriptionUsageStatusRows(result),
      ...(sessionId === undefined ? [] : [usageStatsStatusRow(stats)]),
    ]
  },
} as const satisfies TuiModule
