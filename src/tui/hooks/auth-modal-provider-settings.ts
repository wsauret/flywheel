import { batch } from "solid-js"
import type { CredentialProviderId } from "../../infra/auth/auth-store-types.js"
import type { ExternalUrlOpener } from "../../infra/open-external-url.js"
import type { AuthProviderAccountStatus, RuntimeAuthStatusScope, RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import { paidModeAwaitsAnswer, subscriptionSpendAccountCorrelationId } from "../../protocol/subscription-spend-consent-protocol-types.js"
import type { ModalHandle } from "../components/modal-stack.js"
import type { ShellServices } from "./shell-state.js"
import type { AuthProfileScopeLabel } from "./auth-profile-selection.js"
import { buildAuthRows, buildProviderOptions, type AuthView, type ProviderOption, type ProviderSettingsTarget, type SubscriptionCapabilityAccount } from "./auth-modal-options.js"
import type { SubscriptionSpendConsentControl } from "./use-subscription-spend-consent-control.js"
import { automaticDialogsEnabled } from "./automatic-dialogs.js"
import { PAID_USE_SETTINGS_LOAD_FAILURE } from "../../protocol/client/provider-account-copy.js"

type ProviderSettingsView = Extract<AuthView, { kind: "provider-settings" }>
type PaidUseQuestionView = Extract<AuthView, { kind: "paid-use-question" }>
type ProviderSettingsKeyEvent = { name: string; sequence?: string; preventDefault?: () => void }

interface AuthModalProviderSettingsDeps {
  readonly appService: Pick<RuntimeClient, "dispatch" | "query">
  readonly consent: Pick<SubscriptionSpendConsentControl, "openProviderSettings" | "openQuestion" | "close">
  readonly showToast: ShellServices["showToast"]
  readonly openBrowser: ExternalUrlOpener
  readonly profileScopeLabel: () => AuthProfileScopeLabel
  readonly profileId: () => string | undefined
  readonly scope: () => RuntimeAuthStatusScope
  readonly owner: () => ModalHandle | undefined
  readonly currentView: () => AuthView
  readonly attemptCurrent: (attemptId: number) => boolean
  readonly showSettings: (view: ProviderSettingsView | PaidUseQuestionView, providers?: ProviderOption[]) => void
  readonly openAuthModal: () => void
  readonly closeAuthModal: () => void
  readonly returnToList: (originCursor: number) => void
  readonly reconnectAccount: (option: ProviderOption, account: AuthProviderAccountStatus) => void
  /** Asks the person to confirm a disconnect of the account, or of the whole provider without one. */
  readonly requestDisconnect: (option: ProviderOption, account?: AuthProviderAccountStatus) => void
  readonly renameAccount: (option: ProviderOption, account: AuthProviderAccountStatus) => void
  readonly addAccount: (option: ProviderOption) => void
  readonly openModels: () => void
  readonly toggleFreeRoutes: () => void
  readonly authFilePath: () => string | undefined
}

function resolveProviderSettings(auth: RuntimeAuthView, providerId: string, accountCorrelationId: string, profileScopeLabel: AuthProfileScopeLabel): { readonly providers: ProviderOption[]; readonly view: ProviderSettingsView } | undefined {
  const providers = buildProviderOptions(auth.providers, auth.subscriptionSpendConsent)
  const option = providers.find((candidate) => candidate.id === providerId)
  const capability = option?.capabilityAccounts.find((candidate) => candidate.accountCorrelationId === accountCorrelationId)
  const account = option?.accounts.find((candidate) => candidate.accountCorrelationId === accountCorrelationId)
  if (!option || !capability || !account) return undefined
  const originCursor = Math.max(0, buildAuthRows(providers, auth.profile, profileScopeLabel, false, auth.subscriptionSpendConsent).findIndex((row) => row.kind === "account"
    ? row.option.id === providerId && row.account.instanceId === account.instanceId
    : row.kind === "provider" && row.option.id === providerId))
  return { providers, view: { kind: "provider-settings", option, target: { kind: "account", account, modelTarget: { kind: "subscription", providerId, accountCorrelationId }, capability }, originCursor, ...(account.freeRoutes === undefined ? {} : { freeRoutes: { ...account.freeRoutes, changing: false } }) } }
}

export function createAuthModalProviderSettings(deps: AuthModalProviderSettingsDeps) {
  /** Shows the paid-use question for one exact account inside the open modal. */
  function showPaidUseQuestion(auth: RuntimeAuthView, snapshotPosition: number, providerId: string, accountCorrelationId: string, owner: ModalHandle, returnTo: PaidUseQuestionView["returnTo"]): boolean {
    const resolved = resolveProviderSettings(auth, providerId, accountCorrelationId, deps.profileScopeLabel())
    if (!resolved || resolved.view.target.kind !== "account" || resolved.view.target.capability === undefined) return false
    const { account, capability } = resolved.view.target
    batch(() => {
      deps.showSettings({ kind: "paid-use-question", option: resolved.view.option, account, capability, originCursor: resolved.view.originCursor, returnTo }, resolved.providers)
      deps.consent.openQuestion(auth.subscriptionSpendConsent, snapshotPosition, accountCorrelationId, owner)
    })
    return true
  }

  /** After a login settles, asks the paid-use question for the connected
   *  account when the provider reports paid capacity it has no answer for.
   *  The reconnected or newly added account comes first; an earlier account
   *  of the same provider that never got its answer is asked otherwise. */
  async function reviewNewSubscriptionSpend(attemptId: number, providerId: CredentialProviderId, instanceId: string | undefined, previousInstanceIds: ReadonlySet<string>): Promise<"opened" | "none" | "failed"> {
    if (!automaticDialogsEnabled()) return "none"
    const owner = deps.owner()
    try {
      // Login settlement already refreshed the profile, its usage evidence, and its consent view.
      if (!deps.attemptCurrent(attemptId) || !owner?.isOpen()) return "none"
      const snapshot = await deps.appService.query({ type: "authStatusSnapshot", scope: { kind: "defaults" } })
      if (!deps.attemptCurrent(attemptId) || !owner.isOpen()) return "none"
      const consent = snapshot.auth.subscriptionSpendConsent
      if (consent.kind !== "available") return "none"
      const waiting = consent.accounts.filter((candidate) => candidate.providerId === providerId && candidate.modes.some(paidModeAwaitsAnswer))
      const connected = waiting.find((candidate) => instanceId === undefined
        ? ![...previousInstanceIds].some((previous) => candidate.accountCorrelationId === subscriptionSpendAccountCorrelationId(consent.profileId, providerId, previous))
        : candidate.accountCorrelationId === subscriptionSpendAccountCorrelationId(consent.profileId, providerId, instanceId))
      const capability = connected ?? waiting[0]
      if (!capability) return "none"
      return showPaidUseQuestion(snapshot.auth, snapshot.snapshotPosition, providerId, capability.accountCorrelationId, owner, "list") ? "opened" : "none"
    } catch {
      if (deps.attemptCurrent(attemptId)) deps.showToast({ message: PAID_USE_SETTINGS_LOAD_FAILURE, variant: "warning" })
      return "failed"
    }
  }

  /** Opens the modal on the paid-use question for one account; answering it closes the modal. */
  function openPaidUseQuestion(auth: RuntimeAuthView, snapshotPosition: number, providerId: string, accountCorrelationId: string): boolean {
    deps.openAuthModal()
    const owner = deps.owner()
    return owner?.isOpen() === true && showPaidUseQuestion(auth, snapshotPosition, providerId, accountCorrelationId, owner, "close")
  }

  async function openAccountSettings(option: ProviderOption, account: AuthProviderAccountStatus, capability: SubscriptionCapabilityAccount | undefined, originCursor: number): Promise<void> {
    const profileId = deps.profileId()
    if (profileId === undefined) return
    const modelTarget = { kind: "subscription" as const, providerId: option.id, accountCorrelationId: account.accountCorrelationId }
    const attentionPath = option.attention?.kind === "malformed" ? deps.authFilePath() : undefined
    const view: ProviderSettingsView = { kind: "provider-settings", option, target: { kind: "account", account, modelTarget, ...(capability === undefined ? {} : { capability }) }, originCursor, ...(attentionPath === undefined ? {} : { attentionPath }), ...(account.freeRoutes === undefined ? {} : { freeRoutes: { ...account.freeRoutes, changing: false } }) }
    const owner = deps.owner()
    if (capability === undefined || !owner?.isOpen()) { deps.showSettings(view); return }
    try {
      const snapshot = await deps.appService.query({ type: "authStatusSnapshot", scope: deps.scope() })
      if (!owner.isOpen() || deps.currentView().kind !== "list") return
      batch(() => {
        deps.showSettings(view)
        deps.consent.openProviderSettings(snapshot.auth.subscriptionSpendConsent, snapshot.snapshotPosition, capability.accountCorrelationId, owner)
      })
    } catch {
      if (!owner.isOpen()) return
      deps.showSettings(view)
      deps.showToast({ message: PAID_USE_SETTINGS_LOAD_FAILURE, variant: "warning" })
    }
  }

  function openProviderSettings(option: ProviderOption, target: ProviderSettingsTarget, originCursor: number): void {
    const attentionPath = option.attention?.kind === "malformed" ? deps.authFilePath() : undefined
    deps.showSettings({ kind: "provider-settings", option, target, originCursor, ...(attentionPath === undefined ? {} : { attentionPath }), ...(option.freeRoutes === undefined ? {} : { freeRoutes: { ...option.freeRoutes, changing: false } }) })
  }

  function openAuthAccountDetail(auth: RuntimeAuthView, snapshotPosition: number, providerId: string, accountCorrelationId: string, focusEnvelopeId?: string): boolean {
    const resolved = resolveProviderSettings(auth, providerId, accountCorrelationId, deps.profileScopeLabel())
    if (!resolved) return false
    deps.openAuthModal()
    const owner = deps.owner()
    if (!owner?.isOpen()) return false
    batch(() => {
      deps.showSettings(resolved.view, resolved.providers)
      deps.consent.openProviderSettings(auth.subscriptionSpendConsent, snapshotPosition, accountCorrelationId, owner, focusEnvelopeId)
    })
    return true
  }

  function handleKey(event: ProviderSettingsKeyEvent): void {
    const view = deps.currentView()
    if (view.kind !== "provider-settings") return
    const key = event.name.toLowerCase()
    const account = view.target.kind === "account" ? view.target.account : undefined
    const capability = view.target.kind === "account" ? view.target.capability : undefined
    if (key === "escape") { event.preventDefault?.(); deps.consent.close(); deps.closeAuthModal(); return }
    if (key === "left" || key === "backspace") { event.preventDefault?.(); deps.consent.close(); deps.returnToList(view.originCursor); return }
    if (key === "a" && view.option.kind === "subscription") { event.preventDefault?.(); deps.consent.close(); deps.addAccount(view.option); return }
    if (key === "r" && account !== undefined) { event.preventDefault?.(); deps.consent.close(); deps.reconnectAccount(view.option, account); return }
    if (key === "r" && view.target.kind === "provider") { event.preventDefault?.(); deps.consent.close(); deps.addAccount(view.option); return }
    if (key === "d") { event.preventDefault?.(); deps.requestDisconnect(view.option, account); return }
    if (key === "n" && account !== undefined && view.option.loginProgram === undefined) { event.preventDefault?.(); deps.renameAccount(view.option, account); return }
    if ((key === "m" || key === "enter" || key === "return") && view.option.modelSelectionAvailable) { event.preventDefault?.(); deps.openModels(); return }
    if (key === "f" && view.freeRoutes !== undefined && !view.freeRoutes.changing) { event.preventDefault?.(); deps.toggleFreeRoutes(); return }
    if (key === "b" && capability?.billingUrl !== undefined) {
      event.preventDefault?.()
      void deps.openBrowser(capability.billingUrl).then((opened) => { if (!opened) deps.showToast({ message: "Could not open provider billing", variant: "warning" }) }).catch(() => deps.showToast({ message: "Could not open provider billing", variant: "warning" }))
    }
  }

  return { reviewNewSubscriptionSpend, openAccountSettings, openProviderSettings, openAuthAccountDetail, openPaidUseQuestion, showPaidUseQuestion, handleKey }
}
