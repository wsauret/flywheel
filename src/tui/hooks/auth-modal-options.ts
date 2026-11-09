import type { CredentialProviderId } from "../../infra/auth/auth-store-types.js"
import type { AuthFileAttention, AuthProviderAccountStatus, AuthProviderAttention, AuthProviderSource, AuthProviderStatus, RuntimeAuthProfileView, RuntimeAuthLoginQuestion } from "../../protocol/auth-status-protocol-types.js"
import type { AuthProfileScopeLabel } from "./auth-profile-selection.js"
import type { RuntimeAuthProfileWriteScope } from "../../protocol/auth-profile-selection-protocol-types.js"
import type { ProviderCatalogDiscovery, ProviderModelRow, ProviderModelTarget, ProviderModelView } from "../../protocol/provider-model-preference-protocol-types.js"
import { authStatusPresentation } from "../auth-status-presentation.js"
import type { RuntimeAuthLoginPrompt } from "../../protocol/auth-login-protocol-types.js"

import type { SubscriptionSpendConsentView } from "../../protocol/subscription-spend-consent-protocol-types.js"

export type SubscriptionCapabilityAccount = Extract<SubscriptionSpendConsentView, { readonly kind: "available" }>["accounts"][number]
export interface ProviderOption {
  id: CredentialProviderId
  label: string
  kind: "subscription" | "singleton" | "connect"
  source: AuthProviderSource
  expired: boolean
  loginMethod: "api-key" | "browser-auth" | "device-code"
  /** The external program that owns the login, as a person reads it; its accounts take no label. Absent for a stored credential. */
  loginProgram?: string
  group: "model" | "web"
  modelSelectionAvailable: boolean
  accounts: readonly AuthProviderAccountStatus[]
  capabilityAccounts: readonly SubscriptionCapabilityAccount[]
  detail?: string
  keyHint?: string
  keyPrefix?: string
  catalog?: ProviderCatalogDiscovery
  attention?: AuthProviderAttention
  freeRoutes?: { readonly enabled: boolean; readonly eligibilityRevision: number }
}

export type AuthRow =
  | { kind: "profile"; profile: RuntimeAuthProfileView; position: number; total: number; scopeLabel: AuthProfileScopeLabel; pending: boolean; saving?: boolean }
  | { kind: "profile-policy"; enabled: boolean; changing: boolean; feedback?: string }
  | { kind: "file-attention"; attention: AuthFileAttention }
  | { kind: "heading"; label: string }
  | { kind: "provider-group"; option: ProviderOption }
  | { kind: "provider"; option: ProviderOption; capabilityAccount?: SubscriptionCapabilityAccount; saving?: boolean }
  | { kind: "account"; option: ProviderOption; account: AuthProviderAccountStatus; capabilityAccount?: SubscriptionCapabilityAccount; saving?: boolean }

export type ProviderSettingsTarget =
  | { readonly kind: "provider"; readonly modelTarget: ProviderModelTarget }
  | { readonly kind: "account"; readonly account: AuthProviderAccountStatus; readonly modelTarget: ProviderModelTarget; readonly capability?: SubscriptionCapabilityAccount }

export type AuthView =
  | { kind: "list" }
  | { kind: "login-question"; question: RuntimeAuthLoginQuestion; choice: "login" | "decline"; submitting?: true }
  | { kind: "provider-models"; profileId?: string; eligibilityRevision?: number; target: ProviderModelTarget; providerTitle: string; catalog?: ProviderCatalogDiscovery; rows: readonly ProviderModelRow[]; preferenceAvailable?: boolean; recheckAvailable?: boolean; audit?: ProviderModelView["audit"]; rechecking?: boolean; notice?: string; query: string; loading: boolean; error?: string; cursor: number; originCursor: number }
  | { kind: "provider-settings"; option: ProviderOption; target: ProviderSettingsTarget; originCursor: number; attentionPath?: string; freeRoutes?: { readonly enabled: boolean; readonly eligibilityRevision: number; readonly changing: boolean; readonly feedback?: string } }
  /** One account's paid-use question: closing it records an answer (PI-MODEL-018). */
  | { kind: "paid-use-question"; option: ProviderOption; account: AuthProviderAccountStatus; capability: SubscriptionCapabilityAccount; originCursor: number; returnTo: "list" | "close" }
  | { kind: "api-key-input"; providerId: CredentialProviderId; label: string; keyPrefix?: string; reconnectInstanceId?: string }
  | { kind: "rename-input"; providerId: CredentialProviderId; instanceId: string; label: string; saving?: boolean; error?: string }
  | { kind: "profile-create-input"; scope: RuntimeAuthProfileWriteScope; saving?: boolean; error?: string }
  | { kind: "profile-rename-input"; id: string; label: string; error?: string; saving?: boolean }
  | ({ kind: "profile-delete-confirmation"; id: string; label: string; choice: "confirm" | "cancel" } & (
    | { phase: "loading"; preview?: never; successorId?: never; error?: never }
    | { phase: "preview-error"; error: string; preview?: never; successorId?: never }
    | { phase: "ready"; preview: import("../../protocol/auth-profile-selection-protocol-types.js").RuntimeAuthProfileDeletionPreview; successorId?: string; error?: string }
  ))
  /** A question the provider's login flow asks before it starts. */
  | { kind: "login-prompt"; providerId: CredentialProviderId; label: string; prompt: RuntimeAuthLoginPrompt }
  /** The runtime asks before a new paid account replaces the free-plan accounts of its provider (PI-MODEL-069). */
  | { kind: "login-confirmation"; providerId: CredentialProviderId; label: string; message: string; choice: "replace" | "keep"; submitting?: true }
  | { kind: "device-code"; providerId: CredentialProviderId; label: string; userCode?: string; url: string; question?: RuntimeAuthLoginQuestion }
  /** A browser login, with the field for the code or address that the provider's page shows; `submitted` once the
   *  person gave one, while the login checks it. */
  | { kind: "browser-auth"; providerId: CredentialProviderId; label: string; url: string; submitted?: true; question?: RuntimeAuthLoginQuestion }

/** The provider a nested view belongs to, so a provider that leaves the
 *  published list takes its view with it. */
export function nestedAuthViewProviderId(view: AuthView): string | undefined {
  switch (view.kind) {
    case "provider-models": return view.target.providerId
    case "provider-settings":
    case "paid-use-question": return view.option.id
    case "api-key-input":
    case "login-prompt":
    case "login-confirmation":
    case "device-code":
    case "browser-auth": return view.providerId
    default: return undefined
  }
}

export function filterProviderModelRows(rows: readonly ProviderModelRow[], query: string): readonly ProviderModelRow[] {
  const normalized = query.trim().toLowerCase()
  return normalized.length === 0 ? rows : rows.filter((row) => row.modelId.toLowerCase().includes(normalized))
}

/** Whether ctrl+d can clear the provider's model list. The model list footer shows the shortcut under the same condition. */
export function providerModelsCanDeselect(view: AuthView): boolean {
  return view.kind === "provider-models"
    && view.catalog?.kind === "available"
    && view.catalog.liveOutcome !== "authentication-invalid"
    && view.rows.length > 0
}


export function buildProviderOptions(statuses: readonly AuthProviderStatus[], consent?: SubscriptionSpendConsentView): ProviderOption[] {
  return statuses.toSorted((left, right) =>
    (left.group === right.group ? 0 : left.group === "model" ? -1 : 1)
    || left.statusRank - right.statusRank
    || left.displayName.localeCompare(right.displayName),
  ).map((status): ProviderOption => ({
    id: status.providerId,
    label: status.displayName,
    kind: status.kind,
    source: status.source,
    expired: status.expired,
    loginMethod: status.loginMethod,
    ...(status.loginProgram === undefined ? {} : { loginProgram: status.loginProgram }),
    group: status.group,
    modelSelectionAvailable: status.modelCapable,
    accounts: status.accounts,
    capabilityAccounts: consent?.kind === "available" ? (consent.accounts ?? []).filter((account) => account.providerId === status.providerId) : [],
    ...(status.detail === undefined ? {} : { detail: status.detail }),
    ...(status.keyHint === undefined ? {} : { keyHint: status.keyHint }),
    ...(status.keyPrefix === undefined ? {} : { keyPrefix: status.keyPrefix }),
    ...(status.catalog === undefined ? {} : { catalog: status.catalog }),
    ...(status.attention === undefined ? {} : { attention: status.attention }),
    ...(status.freeRoutes === undefined ? {} : { freeRoutes: status.freeRoutes }),
  }))
}

export function buildAuthRows(providers: readonly ProviderOption[], profile?: RuntimeAuthProfileView, scopeLabel: AuthProfileScopeLabel = "New Session Defaults", pending = false, consent?: SubscriptionSpendConsentView, fileAttention?: AuthFileAttention, policy?: { readonly enabled: boolean; readonly changing: boolean; readonly feedback?: string }): AuthRow[] {
  const profileIndex = profile?.availableProfiles.findIndex((candidate) => candidate.id === profile.id) ?? -1
  const profileRow: AuthRow[] = profile === undefined ? [] : [{
    kind: "profile",
    profile,
    position: Math.max(0, profileIndex) + 1,
    total: Math.max(1, profile.availableProfiles.length),
    scopeLabel,
    pending,
  }, { kind: "profile-policy", enabled: policy?.enabled ?? true, changing: policy?.changing ?? false, ...(policy?.feedback === undefined ? {} : { feedback: policy.feedback }) }]
  const groups: readonly { group: ProviderOption["group"]; label: string }[] = [
    { group: "model", label: "Model Providers" },
    { group: "web", label: "Web Search" },
  ]
  const groupedRows = groups.flatMap(({ group, label }) => {
    const options = providers.filter((option) => option.group === group)
    if (options.length === 0) return []
    return [{ kind: "heading" as const, label }, ...options.flatMap((option) => providerRows(option, consent))]
  })
  return [...profileRow, ...(fileAttention === undefined ? [] : [{ kind: "file-attention" as const, attention: fileAttention }]), ...groupedRows]
}

function providerRows(option: ProviderOption, consent?: SubscriptionSpendConsentView): AuthRow[] {
  const capabilityFor = (account: AuthProviderAccountStatus): SubscriptionCapabilityAccount | undefined => consent?.kind === "available"
    ? consent.accounts.find((candidate) => candidate.providerId === option.id && candidate.accountCorrelationId === account.accountCorrelationId)
    : undefined
  if (option.accounts.length > 1) {
    return [
      { kind: "provider-group", option },
      ...option.accounts.map((account): AuthRow => ({ kind: "account", option, account, ...(capabilityFor(account) === undefined ? {} : { capabilityAccount: capabilityFor(account) }) })),
    ]
  }
  const [account] = option.accounts
  const sole = account === undefined ? undefined : capabilityFor(account)
  return [{ kind: "provider", option, ...(sole === undefined ? {} : { capabilityAccount: sole }) }]
}

export function soleAccount(option: ProviderOption): AuthProviderAccountStatus | undefined {
  return option.accounts.length === 1 ? option.accounts[0] : undefined
}

interface ProviderSettingsRefresh {
  readonly view: AuthView
  readonly cursor?: number
}

/** Reconciles a nested settings target against the current provider inventory. */
export function refreshProviderSettings(view: Extract<AuthView, { kind: "provider-settings" }>, providers: readonly ProviderOption[]): ProviderSettingsRefresh {
  const option = providers.find((candidate) => candidate.id === view.option.id)
  if (option === undefined) return { view: { kind: "list" }, cursor: view.originCursor }
  if (view.target.kind === "provider") return { view: { ...view, option } }
  const target = view.target
  const account = option.accounts.find((candidate) => candidate.instanceId === target.account.instanceId)
  if (account === undefined) return { view: { kind: "list" }, cursor: view.originCursor }
  const capabilityId = target.capability?.accountCorrelationId
  const capability = capabilityId === undefined ? undefined : option.capabilityAccounts.find((candidate) => candidate.accountCorrelationId === capabilityId)
  return { view: { ...view, option, target: { ...target, account, ...(capability === undefined ? {} : { capability }) } } }
}

export function statusText(option: ProviderOption): string {
  return authStatusPresentation(option).text
}

export function isConfigured(option: ProviderOption): boolean {
  return authStatusPresentation(option).configured
}
