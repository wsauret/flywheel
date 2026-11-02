import type { SubscriptionUsageService } from "../../src/orchestration/auth/provider-observations/subscription-usage-service.js";

/** Creates an inert service with fixed generation and authority values; only check invokes the supplied callback. */
export function createInertSubscriptionUsageService(options: {
  readonly generation?: ReturnType<SubscriptionUsageService["generation"]>;
  readonly authority?: ReturnType<SubscriptionUsageService["store"]>;
  readonly onCheck?: () => void;
}) {
  return {
    generation: () => options.generation,
    snapshot: () => undefined,
    store: () => options.authority,
    currentAccounts: () => [],
    metric: () => ({ kind: "unknown" as const }),
    refresh: async () => options.generation,
    replaceThresholds: async () => options.generation,
    check: async () => { options.onCheck?.(); return undefined; },
    checkAccounts: async () => undefined,
    applyReset: async () => ({ kind: "noCredit" as const }),
    onPublished: () => () => {},
    start() {},
    pause() {},
    closeAdmission() {},
    settled: async () => {},
  };
}
