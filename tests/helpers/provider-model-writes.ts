import type { ProviderModelPreferenceServiceDeps } from "../../src/orchestration/app-service/provider-model-preference-service.js"

/** The preference writes and the recheck of a provider-model preference
 *  service that a test never reaches: each one rejects, naming itself. A test
 *  spreads this first and states the writes it asserts on after it. */
export function unusedProviderModelWrites(): Pick<ProviderModelPreferenceServiceDeps, "persistAutoEnableNewModels" | "persistFreeRoutes" | "recheckAccount"> {
  return {
    persistAutoEnableNewModels: async () => { throw new Error("automatic model enablement is not written in this test") },
    persistFreeRoutes: async () => { throw new Error("free routes are not written in this test") },
    recheckAccount: () => { throw new Error("no provider account is rechecked in this test") },
  }
}
