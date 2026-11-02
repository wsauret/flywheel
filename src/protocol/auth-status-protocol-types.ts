import type { CredentialProviderId } from "../infra/auth/auth-store-types.js"
import type { AccessProviderCandidate } from "../infra/llm/access-provider.js"
import type { ProviderCatalogDiscovery } from "./provider-model-preference-protocol-types.js"
import type { RuntimeCursorIdentity, RuntimePosition } from "./runtime-ui-protocol-types.js"
import type { SubscriptionSpendConsentView } from "./subscription-spend-consent-protocol-types.js"

// One id space with the credential store: the wire schema's Codec annotation
// compile-forces the protocol literal union to follow every provider added there.
type AuthProviderId = CredentialProviderId
type AuthProfileSource = "environment" | "project" | "sticky" | "default"
export type RuntimeAuthStatusScope =
  | { readonly kind: "defaults" }
  | { readonly kind: "session"; readonly sessionId: string }

export type AuthProviderSource = "stored_key" | "oauth" | "invalid" | "unconfigured" | "misconfigured"

/** What keeps a whole provider from serving, with the step that repairs it in `message`: stored data that is
 *  malformed. */
export interface AuthProviderAttention {
  readonly kind: "malformed"
  readonly message: string
}

/** What keeps one account from serving, with the step that repairs it in `message`: for an external login, the
 *  provider refused its login at its last request, the program exited while it served one, or the program could not
 *  start for one; for any account, it is a free-plan account beside another account of its provider (PI-MODEL-038). */
export interface AuthAccountAttention {
  readonly kind: "login-rejected" | "program-exited" | "program-cannot-start" | "free-plan"
  readonly message: string
}

export type AuthFileAttention =
  | { readonly kind: "malformed"; readonly path: string; readonly message: string }
  | { readonly kind: "oversized" | "unsafe_path"; readonly path: string; readonly message: string }

export interface AuthProviderAccountStatus {
  readonly instanceId: string
  readonly accountCorrelationId: string
  readonly identity: string
  readonly label?: string
  /** Non-secret Copilot Enterprise host; reconnect must target it, not github.com. */
  readonly enterpriseDomain?: string
  readonly displayLabel: string
  /** The account's plan as its provider names it, such as "Claude Max". */
  readonly plan?: string
  /** True when the account must log in again before it serves. */
  readonly expired: boolean
  readonly source: Extract<AuthProviderSource, "stored_key" | "oauth">
  readonly configured?: true
  readonly catalog?: ProviderCatalogDiscovery
  readonly servingCandidate?: AccessProviderCandidate
  readonly freeRoutes?: { readonly enabled: boolean; readonly eligibilityRevision: number }
  readonly attention?: AuthAccountAttention
}

export interface AuthProviderStatus {
  readonly providerId: AuthProviderId
  readonly kind: "subscription" | "singleton" | "connect"
  readonly source: AuthProviderSource
  readonly expired: boolean
  readonly configured?: boolean
  readonly catalog?: ProviderCatalogDiscovery
  readonly servingCandidate?: AccessProviderCandidate
  readonly freeRoutes?: { readonly enabled: boolean; readonly eligibilityRevision: number }
  readonly modelCapable: boolean
  readonly loginMethod: "api-key" | "browser-auth" | "device-code"
  /** The program that owns the provider's login, as a person reads it, when Flywheel stores no credential for it.
   *  The program names each account by its own identity, such as its email address, so its accounts take no label,
   *  and a disconnect runs the program's own logout on the profile's login only. Absent for a credential that
   *  Flywheel stores. */
  readonly loginProgram?: string
  readonly statusRank: number
  readonly group: "model" | "web"
  readonly accounts: readonly AuthProviderAccountStatus[]
  /** Runtime-resolved display name. The runtime realm holds the live installed
   *  catalog, so the TUI renders this instead of resolving names itself. */
  readonly displayName: string
  /** For a misconfigured [custom_providers] entry: the loader's rejection reason. */
  readonly detail?: string
  /** Masked tail of a stored API key, so the user can tell which key is connected. */
  readonly keyHint?: string
  /** The prefix the provider's API keys carry, for the key entry placeholder. */
  readonly keyPrefix?: string
  readonly attention?: AuthProviderAttention
}

interface RuntimeAuthProfileDescriptor {
  readonly id: string
  readonly displayName: string
}

export interface RuntimeAuthProfileView extends RuntimeAuthProfileDescriptor {
  readonly source: AuthProfileSource
  readonly availableProfiles: readonly RuntimeAuthProfileDescriptor[]
  readonly projectBinding?: string
}

/** The end of one long login. A client that started the login waits for it on
 *  the auth cursor. A `refused` failure is a rule that refused the account, such as the free-plan rule
 *  (PI-MODEL-038): its message states why and what the person can do, so a client adds no repair of its own. */
export type AuthOperationSettlement =
  | { readonly kind: "completed"; readonly operationId: string; readonly providerId: string }
  | { readonly kind: "failed"; readonly operationId: string; readonly providerId: string; readonly message: string; readonly refused?: true }

/** A provider's message while a long login runs, such as a token exchange
 *  after the person approved a device code. */
interface AuthOperationProgress {
  readonly kind: "progress"
  readonly operationId: string
  readonly providerId: string
  readonly message: string
}

/** A question a long login asks after the person signed in and before it stores the account: a paid account that
 *  replaces the free-plan accounts of its provider (PI-MODEL-038). `auth.login.answer` with any answer confirms, and
 *  `auth.login.cancel` declines, which stores nothing. */
export interface AuthOperationConfirmation {
  readonly kind: "confirmation"
  readonly operationId: string
  readonly providerId: string
  readonly message: string
}

/** What one auth publication says about a long login: its progress, a question it asks, or its end. */
export type AuthOperationNotice = AuthOperationSettlement | AuthOperationProgress | AuthOperationConfirmation

/** One project-local account question. Its opaque id is the answer authority; display fields carry no paths or credentials. */
export interface RuntimeAuthLoginQuestion {
  readonly questionId: string
  readonly providerId: string
  readonly instanceId: string
  readonly profileId: string
  readonly profileDisplayName: string
  readonly providerDisplayName: string
  readonly accountDisplayName: string
}

export interface RuntimeAuthView {
  readonly loginQuestions?: readonly RuntimeAuthLoginQuestion[]
  readonly autoEnableNewModels?: { readonly enabled: boolean; readonly eligibilityRevision: number }
  readonly providers: readonly AuthProviderStatus[]
  readonly warnings: readonly string[]
  readonly authFilePath?: string
  readonly fileAttention?: AuthFileAttention
  readonly profile: RuntimeAuthProfileView
  readonly subscriptionSpendConsent: SubscriptionSpendConsentView
  readonly settlement?: AuthOperationSettlement
  readonly progress?: AuthOperationProgress
  readonly confirmation?: AuthOperationConfirmation
}

export interface AuthPatchPayload {
  readonly kind: "auth.changed"
  readonly auth: RuntimeAuthView
}

export interface RuntimeAuthStatusSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly auth: RuntimeAuthView
}

export function authStatusCursor(scope: RuntimeAuthStatusScope = { kind: "defaults" }): RuntimeCursorIdentity & { readonly domain: "auth" } {
  return scope.kind === "session"
    ? { scope: "session", domain: "auth", sessionId: scope.sessionId }
    : { scope: "workspace", domain: "auth" }
}
