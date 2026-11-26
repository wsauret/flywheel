import type { RuntimeAuthStatusScope } from "./auth-status-protocol-types.js"

/** Model selection resolves its defaults or session profile. Provider controls
 * retain the exact profile from the account view they opened. */
export type RuntimeModelCatalogRefreshScope = RuntimeAuthStatusScope | { readonly kind: "profile"; readonly profileId: string }

/** An exact provider account target. Subscription correlation ids are opaque and profile-bound. */
export type ProviderModelTarget =
  | { readonly kind: "singleton"; readonly providerId: string }
  | { readonly kind: "subscription"; readonly providerId: string; readonly accountCorrelationId: string }

/** How a provider's model catalog was obtained, or why it could not be. Wire
 *  data: pickers explain provenance and failures from this, so the type lives
 *  with the protocol and the eligibility engine imports it. */
export type ProviderCatalogDiscovery =
  | { readonly kind: "available"; readonly provenance: "first-party" | "first-party-cached" | "models-dev-live" | "models-dev-archive" | "models-dev-bundled" | "static"; readonly liveOutcome: "valid" | "authentication-invalid" | "discovery-failed" | "empty" | "unusable" }
  | { readonly kind: "unavailable"; readonly reason: "authentication-absent" | "authentication-invalid" | "discovery-pending" | "discovery-failed" | "empty" | "unusable"; readonly discoveryReason?: "timeout" | "oversized" | "malformed" | "transport" | "http" }

/** Retry a settled discovery problem on explicit model-control entry, not absent credentials or an in-flight discovery. */
export function providerCatalogNeedsRetry(catalog: ProviderCatalogDiscovery | undefined): boolean {
  return catalog?.kind === "available"
    ? catalog.liveOutcome === "discovery-failed" || catalog.liveOutcome === "empty" || catalog.liveOutcome === "unusable"
    : catalog?.reason === "discovery-failed" || catalog?.reason === "empty" || catalog?.reason === "unusable"
}

export const TRAINING_ROUTES_REQUIRED = "Allow training routes"

export interface ProviderModelRow {
  readonly modelId: string
  readonly checked: boolean
  readonly optInAvailable: boolean
  readonly configured: boolean
  readonly unavailableReason?: string
  /** Only on an audited subscription: `pending` rows are editable but never routed until the account's Responses probe completes. */
  readonly accessState?: "pending" | "verified"
}
export interface ProviderModelView {
  readonly profileId: string
  readonly eligibilityRevision: number
  readonly target: ProviderModelTarget
  readonly providerDisplayName: string
  readonly catalog: ProviderCatalogDiscovery
  readonly rows: readonly ProviderModelRow[]
  readonly preferenceAvailable?: boolean
  readonly freeRoutes?: { readonly enabled: boolean }
  /** Present and true for an audited subscription account, including one with nothing pending or refused. */
  readonly recheckAvailable?: boolean
  /** Durable pending checks and current access refusals, not an indication that a request is running. */
  readonly audit?: { readonly remaining: number; readonly refused: number }
}

export interface RuntimeProviderModelsQuery {
  readonly profileId: string
  readonly target: ProviderModelTarget
}

export interface RuntimeSetProviderModelMutation {
  readonly queriedProfileId: string
  readonly queriedEligibilityRevision: number
  readonly target: ProviderModelTarget
  readonly modelId: string
  readonly checked: boolean
}

export interface RuntimeProviderModelHiddenResult {
  readonly profileId: string
  readonly eligibilityRevision: number
  readonly target: ProviderModelTarget
  readonly hidden: true
}

export type RuntimeSetProviderModelResult =
  | { readonly profileId: string; readonly eligibilityRevision: number; readonly target: ProviderModelTarget; readonly row: ProviderModelRow }
  | RuntimeProviderModelHiddenResult

export interface RuntimeDeselectAllProviderModelsMutation {
  readonly queriedProfileId: string
  readonly queriedEligibilityRevision: number
  readonly target: ProviderModelTarget
}

/** Asks to probe every current candidate of one audited subscription account again. */
export interface RuntimeRecheckProviderModelsMutation {
  readonly queriedProfileId: string
  readonly queriedEligibilityRevision: number
  readonly target: ProviderModelTarget
}

export interface RuntimeSetProviderFreeRoutesMutation {
  readonly queriedProfileId: string
  readonly queriedEligibilityRevision: number
  readonly target: ProviderModelTarget
  readonly enabled: boolean
}

export interface RuntimeSetProviderAutoEnableNewModelsMutation {
  readonly queriedProfileId: string
  readonly queriedEligibilityRevision: number
  readonly enabled: boolean
}
export interface RuntimeSetProviderAutoEnableNewModelsResult {
  readonly profileId: string
  readonly eligibilityRevision: number
  readonly autoEnableNewModels: boolean
}
