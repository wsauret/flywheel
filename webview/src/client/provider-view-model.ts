import type { RuntimeAuthStatusSnapshotResult, RuntimeAuthView } from "../../../src/protocol/auth-status-protocol-types.js"
import { accountStatusInput, authStatusState } from "../../../src/protocol/client/auth-status-state.js"
import { accountRepairLabel, accountTitle, disconnectConsequence, paidUseEvidence } from "../../../src/protocol/client/provider-account-copy.js"
import { paidModeAwaitsAnswer, subscriptionSpendConsentEnvelopeIds, type SubscriptionSpendConsentMutation } from "../../../src/protocol/subscription-spend-consent-protocol-types.js"

/** The provider list as the Authentication sheet shows it: every model provider,
 *  its accounts, and per account the paid-use modes a person may turn on,
 *  cut from the runtime's auth view. The consent write echoes the exact
 *  snapshot, generation, and envelope set it was reviewed against, so a stale
 *  review cannot enable paid use the runtime has since re-evaluated. */

export interface ProviderViewState {
  readonly profileName: string
  readonly pendingCount: number
  readonly providers: readonly ProviderViewProviderRow[]
}

interface ProviderViewProviderRow {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly source: RuntimeAuthView["providers"][number]["source"]
  readonly detail?: string
  /** What keeps the provider from serving and the step that repairs it, such as installing its program. */
  readonly problem?: string
  /** What the provider's Disconnect does, for its confirmation. */
  readonly disconnectDetail: string
  readonly accounts: readonly ProviderViewAccount[]
}

interface ProviderViewAccount {
  readonly id: string
  /** The account's name, with its plan when the provider names one. */
  readonly label: string
  readonly status: string
  /** What keeps the account from serving and the step that repairs it. */
  readonly problem?: string
  /** The button that repairs the account's login, when it needs one. */
  readonly repair?: "Log in again" | "Reconnect"
  /** True when the person can give the account a label; an external login's accounts take none. */
  readonly renamable: boolean
  /** What the account's Disconnect does, for its confirmation. */
  readonly disconnectDetail: string
  readonly billingUrl?: string
  readonly modes: readonly ProviderViewMode[]
}

interface ProviderViewMode {
  readonly envelopeId: string
  readonly label: string
  readonly status: string
  readonly details: readonly string[]
  readonly decision: "unreviewed" | "accepted" | "declined"
  readonly checked: boolean
  readonly pending: boolean
}

export function buildProviderViewState(auth: RuntimeAuthView): ProviderViewState {
  const consent = auth.subscriptionSpendConsent
  const capabilities = consent.kind === "available" ? consent.accounts : []
  const providers = auth.providers
    .filter((provider) => provider.group === "model")
    .toSorted((left, right) => left.statusRank - right.statusRank || left.displayName.localeCompare(right.displayName))
    .map((provider): ProviderViewProviderRow => {
      const accounts = provider.accounts.map((account): ProviderViewAccount => {
        const accountCorrelationId = account.accountCorrelationId
        const capability = capabilities.find((candidate) => candidate.providerId === provider.providerId && candidate.accountCorrelationId === accountCorrelationId)
        const repair = accountRepairLabel(account)
        const state = authStatusState(accountStatusInput(provider, account))
        return {
          id: accountCorrelationId,
          label: accountTitle(account),
          status: state === "needs-attention" ? "Needs attention" : capability === undefined ? (state === "expired" ? "Expired" : "Connected") : includedQuotaStatus(capability.providerStatus),
          ...(account.attention === undefined ? {} : { problem: account.attention.message }),
          ...(repair === undefined ? {} : { repair }),
          renamable: provider.loginProgram === undefined,
          disconnectDetail: disconnectConsequence(provider, account),
          ...(capability?.billingUrl === undefined ? {} : { billingUrl: capability.billingUrl }),
          modes: capability?.modes.map((mode): ProviderViewMode => ({
            envelopeId: mode.envelopeId,
            label: mode.mode === "prepaid" ? "Prepaid" : "Automatic billing",
            ...paidUseEvidence(mode.evidence),
            decision: mode.decision,
            checked: mode.decision === "accepted",
            pending: paidModeAwaitsAnswer(mode),
          })) ?? [],
        }
      })
      return {
        id: provider.providerId,
        name: provider.displayName,
        status: providerStatus(provider),
        source: provider.source,
        ...(provider.detail === undefined ? {} : { detail: provider.detail }),
        ...(provider.attention === undefined ? {} : { problem: provider.attention.message }),
        disconnectDetail: disconnectConsequence(provider),
        accounts,
      }
    })
  const pendingCount = providers.reduce((total, provider) => total + provider.accounts.reduce((accountTotal, account) => accountTotal + account.modes.filter((mode) => mode.pending).length, 0), 0)
  return { profileName: auth.profile.displayName, pendingCount, providers }
}

/** Builds one paid-mode decision from the saved account view. Returns nothing for a hidden control. */
export function createProviderConsentMutation(snapshot: RuntimeAuthStatusSnapshotResult, providerId: string, accountCorrelationId: string, envelopeId: string, checked: boolean): SubscriptionSpendConsentMutation | undefined {
  const consent = snapshot.auth.subscriptionSpendConsent
  if (consent.kind !== "available") return undefined
  const visibleAccount = buildProviderViewState(snapshot.auth).providers.find((provider) => provider.id === providerId)?.accounts.find((account) => account.id === accountCorrelationId)
  if (visibleAccount === undefined) return undefined
  const mode = visibleAccount.modes.find((candidate) => candidate.envelopeId === envelopeId)
  if (mode === undefined) return undefined
  return {
    type: "subscription_spend_consent.save",
    profileId: consent.profileId,
    usageGeneration: consent.usageGeneration,
    authorityIncarnation: consent.authorityIncarnation,
    authorityRevision: consent.authorityRevision,
    clientSnapshotPosition: snapshot.snapshotPosition,
    envelopeIds: subscriptionSpendConsentEnvelopeIds(consent),
    reviewedEnvelopeIds: [envelopeId],
    acceptedEnvelopeIds: checked ? [envelopeId] : [],
  }
}

/** The web client's words for the shared auth status state (`authStatusState`). */
function providerStatus(provider: RuntimeAuthView["providers"][number]): string {
  switch (authStatusState(provider)) {
    case "needs-attention": return "Needs attention"
    case "invalid": return "Invalid credential"
    case "unconfigured": return "Not configured"
    case "misconfigured": return "Misconfigured"
    case "expired": return "Expired"
    case "stored": case "connected": return "Connected"
  }
}

function includedQuotaStatus(status: "ok" | "warning" | "exhausted" | "unknown"): string {
  if (status === "ok") return "Included quota: Healthy"
  if (status === "warning") return "Included quota: Limited"
  if (status === "exhausted") return "Included quota: Exhausted"
  return "Included quota: Unknown"
}

