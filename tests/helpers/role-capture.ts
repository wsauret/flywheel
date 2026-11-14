import { captureProviderConnection } from "../../src/infra/auth/auth-context.js"
import type { ProviderConnectionCapture } from "../../src/orchestration/agent-runtime/factory.js"
import type { FlywheelConfig } from "../../src/orchestration/config/schema.js"
import { testAuthContext } from "./auth-context.js"
import { modelInfo } from "./model-tier-fixtures.js"
import { testProviderRegistry } from "./provider-authority.js"
import { testRuntimeConfigCapture } from "./request-tool-surface.js"

/** Exact-capture fixture for saved-setting and workflow intent tests. */
export function roleCapture(models: readonly string[], profileRoles: FlywheelConfig["profiles"][string]["roles"] = {}, pending = false): ProviderConnectionCapture {
  const auth = testAuthContext({ apiKeys: { openai_api: "key", anthropic_api: "key" } })
  return {
    connection: captureProviderConnection({ profileId: "default", authDir: "/scratch/auth", auth }),
    providers: testProviderRegistry(),
    eligibility: {
      modelIds: new Set(models),
      modelUnavailableReason: () => undefined,
      candidateOffering(candidate, model) {
        const family = model.startsWith("claude") ? "anthropic" : "openai"
        if (!models.includes(model) || candidate.providerId !== `${family}_api`) return undefined
        return {
          candidate, wireModelId: model, dataUse: "standard",
          transport: family === "openai" ? "openai-responses" : "anthropic-messages",
          resolvedModelMetadata: { ...modelInfo(family, model, "fixture", 2, 8, "2026-10-01"), reasoningEfforts: ["low", "medium", "high"] },
        }
      },
      accessPending: () => pending,
    },
    runtimeConfig: { ...testRuntimeConfigCapture(), profileRoles },
    requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }), standing: async () => ({ kind: "serves" as const }), admit: () => { throw new Error("Role selection fixture does not construct clients") },
  }
}
