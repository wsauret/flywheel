import { USAGE_SPEND_SURFACE, USAGE_STATS_SURFACE, USAGE_SURFACE, subscriptionUsageStatusRows, usageStatsStatusRow } from "../../../../src/protocol/modules/subscription-usage.js"
import type { WebModule } from "../../web-module.js"
import { UsageSheet } from "./sheet.js"
import { StatsSheet } from "./stats-sheet.js"

export const subscriptionUsageWeb = {
  id: "subscription-usage",
  surfaces: [{ id: USAGE_SURFACE, sheet: UsageSheet }, { id: USAGE_SPEND_SURFACE, sheet: () => <UsageSheet initialView="spend" /> }, { id: USAGE_STATS_SURFACE, sheet: StatsSheet }],
  status: async (connection, sessionId) => {
    const usage = await connection.query({ type: "usage.spend", scope: sessionId === undefined ? { kind: "defaults" } : { kind: "session", sessionId }, range: "Month" })
    const rows = subscriptionUsageStatusRows(usage)
    if (sessionId === undefined) return rows
    try {
      const stats = await connection.query({ type: "usage.stats", sessionId })
      return [...rows, usageStatsStatusRow(stats)]
    } catch {
      return [...rows, usageStatsStatusRow(undefined)]
    }
  },
} as const satisfies WebModule
