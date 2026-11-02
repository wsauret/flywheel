import { createComponent } from "solid-js"

import type { UsageSessionStats } from "../../../../src/protocol/modules/subscription-usage.js"
import { mountClientSheet } from "../../app/budget-render-fixture.js"
import { StatsSheet } from "./stats-sheet.js"

/** Mounts the production Stats sheet with caller-controlled session-scoped responses. */
export function mountStatsBudget(queryStats: (sessionId: string) => Promise<UsageSessionStats>) {
  const mounted = mountClientSheet(() => createComponent(StatsSheet, {}), { queries: { "usage.stats": (request) => queryStats(request.sessionId) } })
  return { ...mounted, refresh: () => mounted.clickButton(["Refresh", "Retry"]) }
}
