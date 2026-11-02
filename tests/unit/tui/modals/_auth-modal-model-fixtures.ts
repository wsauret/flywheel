import type { RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"

export const providerModelView = {
  profileId: "default",
  eligibilityRevision: 7,
  target: { kind: "singleton", providerId: "anthropic_api" },
  providerDisplayName: "Anthropic API Key",
  catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
  rows: [{ modelId: "claude-opus-4-1", checked: false, optInAvailable: true, configured: true }, { modelId: "claude-sonnet-4", checked: true, optInAvailable: true, configured: true, unavailableReason: "Allow training routes" }],
  preferenceAvailable: true,
} as const

export const openRouterAuthView = {
  autoEnableNewModels: { enabled: true, eligibilityRevision: 7 },
  providers: [{ providerId: "openrouter", kind: "singleton", source: "stored_key", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 40, group: "model", displayName: "OpenRouter API Key", accounts: [], freeRoutes: { enabled: false, eligibilityRevision: 7 } }],
  warnings: [],
  profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
  subscriptionSpendConsent: { kind: "available", profileId: "default", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
} satisfies RuntimeAuthView
