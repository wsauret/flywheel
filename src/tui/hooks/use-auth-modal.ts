import { Redacted } from "effect"
import { batch, createEffect, onCleanup, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import type { CredentialProviderId } from "../../infra/auth/auth-store-types.js"

import { Log } from "../../infra/log.js"
import type { RuntimeAuthLoginResult } from "../../protocol/auth-login-protocol-types.js"
import type { AuthOperationConfirmation, AuthOperationSettlement, AuthProviderAccountStatus } from "../../protocol/auth-status-protocol-types.js"
import { keptFreePlanMessage, loginOutcome } from "../../protocol/client/auth-login.js"
import { createListModalKeys } from "../components/modal-list-keys.js"
import type { ModalHandle } from "../components/modal-stack.js"
import { paidModeAwaitsAnswer, type SubscriptionSpendConsentView } from "../../protocol/subscription-spend-consent-protocol-types.js"
import { SUBSCRIPTION_SPEND_CONSENT_COPY } from "../components/modal-copy.js"
import { buildAuthRows, buildProviderOptions, isConfigured, nestedAuthViewProviderId, refreshProviderSettings, soleAccount, type ProviderOption } from "./auth-modal-options.js"
import { createAuthModalDisconnect, resolveDisconnect } from "./auth-modal-disconnect.js"
import { createAuthModalProfileControls } from "./auth-modal-profile-controls.js"
import { createAuthModalModelActions } from "./auth-modal-model-actions.js"
import { createAuthModalInput } from "./auth-modal-input.js"
import { createAuthModalLoginQuestion } from "./auth-modal-login-question.js"
import { createAuthModalLoginSettlement } from "./auth-modal-login-settlement.js"
import { createAuthModalAccountActions } from "./auth-modal-account-actions.js"
import { createAuthModalSettingEdits } from "./auth-modal-setting-edits.js"
import { createAuthModalLoginInput } from "./auth-modal-login-input.js"
import { useSubscriptionSpendConsentControl } from "./use-subscription-spend-consent-control.js"
import { createAuthModalProviderSettings } from "./auth-modal-provider-settings.js"
import { createAuthModalProviderModelControls } from "./auth-modal-provider-model-controls.js"
import type { AuthModalDeps, AuthModalHook, AuthModalState } from "./auth-modal-types.js"
import type { TextEditorPresentation } from "../keymap/text-entry.js"
const log = Log.create({ service: "auth-modal" })

export function useAuthModal(deps: AuthModalDeps): AuthModalHook {
  const [state, setState] = createStore<AuthModalState>({
    view: { kind: "list" },
    disconnect: undefined,
    cursor: 0,
    providers: [],
    apiKeyDraft: "",
    textDraft: "",
    profileScope: "defaults",
    attemptId: 0,
    attemptKind: undefined,
    policyOverride: undefined,
    policyProfileId: undefined,
    policyRevision: undefined,
    policyChanging: false,
    policyFeedback: undefined,
  })
  const apiKeyDraft = () => state.apiKeyDraft
  const textDraft = () => state.textDraft
  function profileBaseScope() {
    return deps.authProfileSelection?.scope() ?? { kind: "defaults" as const }
  }
  const authRows = () => settingEdits.rows(buildAuthRows(state.providers, deps.auth()?.profile, profileControls.profileScopeLabel(), state.attemptKind === "profile", deps.auth()?.subscriptionSpendConsent, deps.auth()?.fileAttention, { enabled: state.policyOverride ?? deps.auth()?.autoEnableNewModels?.enabled ?? true, changing: state.policyChanging, ...(state.policyFeedback === undefined ? {} : { feedback: state.policyFeedback }) }))
  let attemptCounter = 0
  // Private lifecycle handle for the current attempt's external work, not a
  // second authority: the store's attemptId decides whether an attempt is
  // current; this handle only stops the runtime's login flow.
  let attemptAbort: AbortController | undefined
  // The modal entry this modal instance owns. A completion closes or reports
  // into that exact entry, never into whatever modal is current later.
  let entry: ModalHandle | undefined
  let providerModelsRequest = 0
  /** Invalidate in the store first, then abort the live scope, so a provider
   *  that resolves despite the abort finds its attempt already superseded. */
  function invalidateAttempt(): void {
    loginQuestion.cancel()
    if (state.attemptId !== 0 || state.attemptKind !== undefined) setState({ attemptId: 0, attemptKind: undefined })
    const abort = attemptAbort
    attemptAbort = undefined
    abort?.abort()
  }

  function beginAttempt(kind: "provider" | "profile" = "provider") {
    invalidateAttempt()
    const id = ++attemptCounter
    const controller = new AbortController()
    attemptAbort = controller
    setState({ attemptId: id, attemptKind: kind })
    return { id, signal: controller.signal }
  }

  function attemptCurrent(id: number): boolean {
    return state.attemptId === id
  }

  /** Accept an attempt's completion: true only when the attempt is still the
   *  current one. All success/failure side effects gate on this acceptance. */
  function settleAttempt(id: number): boolean {
    if (!attemptCurrent(id)) return false
    setState({ attemptId: 0, attemptKind: undefined })
    attemptAbort = undefined
    return true
  }
  function refreshProviders(published = deps.auth()): void {
    const publishedPolicy = published?.autoEnableNewModels
    const policyCaughtUp = state.policyProfileId === published?.profile.id && state.policyRevision !== undefined && publishedPolicy !== undefined && publishedPolicy.eligibilityRevision >= state.policyRevision
    if ((state.policyProfileId !== undefined && state.policyProfileId !== published?.profile.id) || policyCaughtUp) {
      setState({ policyOverride: undefined, policyProfileId: undefined, policyRevision: undefined, policyChanging: false, policyFeedback: undefined })
    }
    const providers = buildProviderOptions(published?.providers ?? [], published?.subscriptionSpendConsent)
    if (resolveDisconnect(providers, state.disconnect) === undefined) setState("disconnect", undefined)
    const nested = nestedAuthViewProviderId(state.view)
    const nestedProfileId = state.view.kind === "provider-models" ? state.view.profileId : undefined
    if (nestedProfileId !== undefined && published?.profile.id !== undefined && nestedProfileId !== published.profile.id) {
      providerModelsRequest++
      setState({ providers, view: { kind: "list" }, cursor: 0 })
      return
    }
    if (nested !== undefined && !loginQuestion.ownsLogin() && !providers.some((option) => option.id === nested)) {
      if (state.view.kind === "api-key-input") resetInputEditors()
      invalidateAttempt()
      setState({ providers, view: { kind: "list" }, cursor: 0 })
      return
    }
    if (state.view.kind === "provider-settings") {
      setState({ providers, ...refreshProviderSettings(state.view, providers) })
      return
    }
    const policy = { enabled: state.policyOverride ?? published?.autoEnableNewModels?.enabled ?? true, changing: state.policyChanging, ...(state.policyFeedback === undefined ? {} : { feedback: state.policyFeedback }) }
    const selected = untrack(() => buildAuthRows(state.providers, published?.profile, profileControls.profileScopeLabel(), state.attemptKind === "profile", published?.subscriptionSpendConsent, published?.fileAttention, policy)[state.cursor])
    const rows = buildAuthRows(providers, published?.profile, profileControls.profileScopeLabel(), state.attemptKind === "profile", published?.subscriptionSpendConsent, published?.fileAttention, policy)
    const sameRow = rows.findIndex((row) =>
      (selected?.kind === "profile" && row.kind === "profile")
      || (selected?.kind === "file-attention" && row.kind === "file-attention")
      || (selected?.kind === "provider-group" && row.kind === "provider-group" && row.option.id === selected.option.id)
      || (selected?.kind === "provider" && row.kind === "provider" && row.option.id === selected.option.id)
      || (selected?.kind === "account" && row.kind === "account" && row.account.instanceId === selected.account.instanceId))
    const parent = selected?.kind === "account" ? rows.findIndex((row) => row.kind === "provider" && row.option.id === selected.option.id) : -1
    const fallback = Math.min(state.cursor, rows.length - 1)
    const cursor = sameRow >= 0 ? sameRow : parent >= 0 ? parent : rows[fallback]?.kind !== "heading" ? fallback : Math.max(rows.findIndex((row) => row.kind !== "heading"), 0)
    setState({ providers, cursor })
  }

  const loginSettlement = createAuthModalLoginSettlement(deps)

  function resetInputEditors(): void {
    setState("apiKeyDraft", "")
    modalInput.reset()
  }

  /** Returns to the list on the row the person acted on: the list cursor
   *  does not move while another view is open, and the refresh keeps it on
   *  the same row by identity. */
  function navigateToList(): void {
    invalidateAttempt()
    resetInputEditors()
    batch(() => {
      setState({ view: { kind: "list" } })
      refreshProviders()
    })
  }

  function returnToProviderList(): void {
    const originCursor = state.view.kind === "provider-models" ? state.view.originCursor : 0
    setState({ view: { kind: "list" }, cursor: originCursor })
  }

  function navigateToProfile(): void {
    invalidateAttempt()
    resetInputEditors()
    setState({ view: { kind: "list" }, cursor: 0 })
    refreshProviders()
  }
  const accountActions = createAuthModalAccountActions({
    ...deps,
    beginAttempt,
    settleAttempt,
  })
  const settingEdits = createAuthModalSettingEdits({
    ...deps, view: () => state.view, draft: textDraft, leave: navigateToList, accountEdit: accountActions.renameEdit,
  })
  const profileControls = createAuthModalProfileControls({
    auth: deps.auth,
    appService: deps.appService,
    showToast: deps.showToast,
    rows: authRows,
    cursor: () => state.cursor,
    attemptPending: () => state.attemptKind === "profile",
    baseScope: profileBaseScope,
    scopeMode: () => state.profileScope,
    setScopeMode: (mode) => setState("profileScope", mode),
    view: () => state.view,
    setEditor: (view, draft) => { setState({ view, textDraft: draft }); modalInput.prepare() },
    setDeleteConfirmation: (view) => setState("view", reconcile(view)),
    beginAttempt,
    attemptCurrent,
    settleAttempt,
    restoreList: navigateToProfile,
    invalidateProviderModels: () => { providerModelsRequest++ },
    modelPolicy: () => ({ override: state.policyOverride, revision: state.policyRevision, changing: state.policyChanging }),
    setModelPolicy: (policy) => setState({ policyOverride: policy.override, policyProfileId: policy.profileId, policyRevision: policy.revision, policyChanging: policy.changing, policyFeedback: policy.feedback }),
  })
  const modelActions = createAuthModalModelActions({
    appService: deps.appService,
    scope: profileBaseScope,
    profileId: () => deps.auth()?.profile.id,
    view: () => state.view,
    setView: (view) => setState({ view }),
    restoreList: navigateToProfile,
    nextRequest: () => ++providerModelsRequest,
    currentRequest: () => providerModelsRequest,
    profilePending: () => state.attemptKind === "profile",
    closeAuthModal,
  })
  const subscriptionSpendConsent = useSubscriptionSpendConsentControl({
    dispatch: deps.appService.dispatch,
    refresh: async (profileId) => {
      const snapshot = await deps.appService.query({ type: "authStatusSnapshot", scope: profileBaseScope() })
      if (snapshot.auth.profile.id !== profileId) return undefined
      return { consent: snapshot.auth.subscriptionSpendConsent, snapshotPosition: snapshot.snapshotPosition }
    },
    onAnswered: afterPaidUseQuestion,
    onAnswerFailed: () => { deps.showToast({ message: SUBSCRIPTION_SPEND_CONSENT_COPY.answerFailed, variant: "warning", duration: 8000 }); afterPaidUseQuestion() },
    onDismissedTickFailed: (feedback) => deps.showToast({ message: `Flywheel could not save paid-use settings. ${feedback}`, variant: "warning", duration: 8000 }),
    openBrowser: deps.openBrowser,
  })

  /** One question per account: the next account still waiting is asked from
   *  the committed view; when none is, the question returns where it came
   *  from, the provider list after a login or nothing after a startup ask. */
  function afterPaidUseQuestion(consent?: SubscriptionSpendConsentView, snapshotPosition?: number): void {
    const view = state.view
    if (view.kind !== "paid-use-question") return
    const auth = deps.auth()
    const next = consent?.kind === "available" ? consent.accounts.find((account) => account.modes.some(paidModeAwaitsAnswer)) : undefined
    if (next && auth && consent && snapshotPosition !== undefined && entry?.isOpen() && providerSettings.showPaidUseQuestion({ ...auth, subscriptionSpendConsent: consent }, snapshotPosition, next.providerId, next.accountCorrelationId, entry, view.returnTo)) return
    if (view.returnTo === "list") navigateToList()
    else closeAuthModal()
  }
  const disconnect = createAuthModalDisconnect({
    providers: () => state.providers,
    target: () => state.disconnect,
    setTarget: (target) => setState("disconnect", target),
    disconnect: ({ option, account }) => {
      if (state.view.kind === "provider-settings") subscriptionSpendConsent.close()
      if (account !== undefined) void accountActions.disconnect(option.id, account.displayLabel, account.instanceId)
      else void accountActions.disconnect(option.id, option.label)
    },
  })
  const providerModelControls = createAuthModalProviderModelControls({
    view: () => state.view, profileId: () => deps.auth()?.profile.id, dispatch: deps.appService.dispatch, query: deps.appService.query,
    setView: (view) => setState({ view }), closeConsent: subscriptionSpendConsent.close,
    loadModels: modelActions.loadProviderModels,
  })
  const providerSettings = createAuthModalProviderSettings({
    appService: deps.appService,
    consent: subscriptionSpendConsent,
    showToast: deps.showToast,
    openBrowser: deps.openBrowser,
    profileScopeLabel: profileControls.profileScopeLabel,
    profileId: () => deps.auth()?.profile.id,
    scope: profileBaseScope,
    owner: () => entry,
    currentView: () => state.view,
    attemptCurrent,
    showSettings: (view, providers) => setState({ view, ...(providers === undefined ? {} : { providers }), cursor: view.originCursor }),
    openAuthModal,
    closeAuthModal,
    returnToList: (originCursor) => setState({ view: { kind: "list" }, cursor: originCursor }),
    reconnectAccount,
    requestDisconnect: disconnect.request,
    renameAccount: (option, account) => { setState({ textDraft: account.label ?? "", view: { kind: "rename-input", providerId: option.id, instanceId: account.instanceId, label: account.displayLabel } }); modalInput.prepare() },
    addAccount: startProviderLogin,
    openModels: providerModelControls.openModels,
    toggleFreeRoutes: providerModelControls.toggleFreeRoutes,
    authFilePath: () => {
      const auth = deps.auth()
      if (!auth) throw new Error("Authentication status is unavailable")
      return auth.authFilePath
    },
  })

  /** Escape and the frame's close affordance: cancel any live attempt and
   *  dismiss the whole modal stack, settings root included. On the paid-use
   *  question, closing is the answer "keep paid use off", recorded first. */
  function closeAuthModal(): void {
    if (state.view.kind === "profile-delete-confirmation" && state.view.phase === "ready" && state.attemptKind === "profile") return
    const consent = subscriptionSpendConsent.state()
    if (consent.kind === "detail" && consent.surface === "question") { void subscriptionSpendConsent.decline(); return }
    subscriptionSpendConsent.close()
    deps.modal.clear()
  }

  /** The left arrow at the provider list: pop this entry back to settings. */
  function backToSettings(): void {
    invalidateAttempt()
    resetInputEditors()
    entry?.close()
  }

  const reviewNewSubscriptionSpend = providerSettings.reviewNewSubscriptionSpend

  /** Runs one login in the runtime that serves this session, which owns every
   *  credential write. The request names the profile the modal shows and who
   *  opens the sign-in page. Leaving the attempt (Escape, the left arrow, a
   *  closed modal, a newer attempt) stops the runtime's flow. */
  async function runLogin(target: { readonly id: CredentialProviderId; readonly label: string }, reconnectInstanceId: string | undefined, apiKey?: string): Promise<void> {
    const attempt = beginAttempt()
    const owner = entry
    const auth = deps.auth()
    const previousInstanceIds = new Set(auth?.providers.find((provider) => provider.providerId === target.id)?.accounts.map((account) => account.instanceId))
    const loginTarget = { providerId: target.id, displayName: target.label }
    let operationId: string | undefined
    const cancelOperation = (): void => { if (operationId !== undefined) void deps.appService.dispatch({ type: "auth.login.cancel", operationId }).catch(() => {}) }
    attempt.signal.addEventListener("abort", cancelOperation, { once: true })
    /** Records the operation an answer names; one that arrives after the attempt ended is stopped at once. */
    const adopt = (result: RuntimeAuthLoginResult): RuntimeAuthLoginResult => {
      if (result.kind === "prompt" || result.kind === "device_code" || result.kind === "browser") operationId = result.operationId
      if (attempt.signal.aborted) cancelOperation()
      return result
    }
    try {
      const profileId = auth?.profile.id
      if (profileId === undefined) throw new Error("Auth profile is unavailable")
      let result = adopt(await deps.appService.dispatch({
        type: "auth.login", providerId: target.id, profileId, ...deps.signInPage.request,
        ...(reconnectInstanceId === undefined ? {} : { instanceId: reconnectInstanceId }),
        ...(apiKey === undefined ? {} : { apiKey: Redacted.make(apiKey) }),
      }))
      let settlement: AuthOperationSettlement | undefined
      /** Asks the runtime's question before a new account replaces free-plan accounts, and returns the runtime's answer,
       *  or undefined when the person keeps the free-plan account, which ends the login as their choice. */
      const confirmReplace = async (question: AuthOperationConfirmation): Promise<RuntimeAuthLoginResult | undefined> => {
        if (await loginInput.confirm(attempt.id, attempt.signal, target, question.message)) return adopt(await deps.appService.dispatch({ type: "auth.login.answer", providerId: target.id, operationId: question.operationId, answer: "confirm" }))
        cancelOperation()
        if (settleAttempt(attempt.id)) {
          deps.showToast({ message: keptFreePlanMessage(target.label), variant: "info" })
          if (owner?.isOpen()) navigateToList()
        }
        return undefined
      }
      for (;;) {
        if (!attemptCurrent(attempt.id)) return
        const outcome = loginOutcome(result, loginTarget, reconnectInstanceId)
        if (outcome.kind === "ignored") {
          if (settleAttempt(attempt.id) && owner?.isOpen()) navigateToList()
          return
        }
        if (outcome.kind === "failed") throw new Error(outcome.message)
        if (outcome.kind === "connected") break
        const step = outcome.step
        if (step.kind === "prompt") {
          const answer = await loginInput.ask(attempt.id, attempt.signal, target, step.prompt)
          result = adopt(await deps.appService.dispatch({ type: "auth.login.answer", providerId: target.id, operationId: step.operationId, answer }))
          continue
        }
        if (step.kind === "needs-key") {
          // The runtime says this provider takes a key: ask for it, as selecting the provider does.
          if (settleAttempt(attempt.id)) apiKeyInput(state.providers.find((option) => option.id === target.id) ?? target, reconnectInstanceId)
          return
        }
        if (step.kind !== "device-code" && step.kind !== "browser") throw new Error(`${target.label} answered with an unexpected login step: ${step.kind}`)
        let ended: AuthOperationSettlement | AuthOperationConfirmation
        if (step.kind === "device-code") {
          showDeviceCode(attempt.id, target, step.userCode, step.verificationUri)
          openSignInPage(step.verificationUri)
          ended = await loginSettlement.awaitSettlement(step.operationId, attempt.signal)
        } else {
          setState({ textDraft: "", view: { kind: "browser-auth", providerId: target.id, label: target.label, url: step.authorizeUri } })
          openSignInPage(step.authorizeUri)
          const finished = loginSettlement.awaitSettlement(step.operationId, attempt.signal)
          // The code or address the provider's page shows, for a browser whose callback cannot reach this machine.
          const pasted = loginInput.awaitAnswer(attempt.signal).then(async (input) => {
            const completion = await deps.appService.dispatch({ type: "auth.login.complete", operationId: step.operationId, input: Redacted.make(input) })
            if (!completion.ok) throw new Error(completion.error)
            return finished
          })
          ended = await Promise.race([finished, pasted])
        }
        if (ended.kind !== "confirmation") { settlement = ended; break }
        const answered = await confirmReplace(ended)
        if (answered === undefined) return
        result = answered
      }
      if (settlement?.kind === "failed") throw new Error(settlement.message)
      if (!attemptCurrent(attempt.id)) return
      const review = apiKey === undefined ? await reviewNewSubscriptionSpend(attempt.id, target.id, reconnectInstanceId, previousInstanceIds) : "none"
      if (!attemptCurrent(attempt.id)) return
      if (!settleAttempt(attempt.id)) return
      if (review === "opened") return
      deps.showToast(apiKey === undefined ? { message: `${target.label} auth active`, variant: "success" } : { message: `${target.label} API key saved`, variant: "success" })
      if (owner?.isOpen()) navigateToList()
    } catch (err) {
      if (!settleAttempt(attempt.id)) return
      if (apiKey !== undefined) {
        deps.showToast({ message: `API key save failed: ${errorMessage(err)}`, variant: "error" })
        return
      }
      deps.showToast({ message: `${target.label} login failed: ${errorMessage(err)}`, variant: "error", duration: 8000 })
      if (owner?.isOpen()) navigateToList()
    }
  }


  function selectProvider(index: number): void {
    if (state.attemptKind === "profile") return
    const row = authRows()[index]
    if (row?.kind === "profile-policy") {
      if (!state.policyChanging) void profileControls.toggleModelPolicy()
      return
    }
    if (row?.kind === "profile") {
      if (!profileControls.profileControlsAvailable()) return
      if (row.profile.availableProfiles.length < 2) return
      setState("cursor", index)
      const profiles = row.profile.availableProfiles
      const current = profiles.findIndex((candidate) => candidate.id === row.profile.id)
      const next = profiles[(Math.max(0, current) + 1) % profiles.length]
      if (next) void profileControls.selectProfile(next)
      return
    }
    if (row?.kind === "account") {
      setState("cursor", index)
      void providerSettings.openAccountSettings(row.option, row.account, row.capabilityAccount, index)
      return
    }
    if (row?.kind !== "provider") return
    const option = row.option
    setState("cursor", index)

    // A misconfigured [custom_providers] entry cannot authenticate; selecting
    // it surfaces the loader's rejection reason so the user can fix the TOML.
    if (option.source === "misconfigured") {
      deps.showToast({ message: `${option.label}: ${option.detail ?? "invalid [custom_providers] entry in flywheel.toml"}`, variant: "error", duration: 8000 })
      return
    }

    const account = soleAccount(option)
    if (option.attention !== undefined) {
      if (account !== undefined) void providerSettings.openAccountSettings(option, account, row.capabilityAccount, index)
      else providerSettings.openProviderSettings(option, { kind: "provider", modelTarget: { kind: "singleton", providerId: option.id } }, index)
      return
    }
    if (isConfigured(option)) {
      if (account !== undefined) void providerSettings.openAccountSettings(option, account, row.capabilityAccount, index)
      else providerSettings.openProviderSettings(option, { kind: "provider", modelTarget: { kind: "singleton", providerId: option.id } }, index)
      return
    }

    startProviderLogin(option)
  }

  function appendSelectedSubscription(): boolean {
    if (state.attemptKind === "profile") return false
    const row = authRows()[state.cursor]
    if ((row?.kind !== "provider" && row?.kind !== "account" && row?.kind !== "provider-group") || row.option.kind !== "subscription") return false
    startProviderLogin(row.option)
    return true
  }

  function apiKeyInput(option: Pick<ProviderOption, "id" | "label" | "keyPrefix">, reconnectInstanceId?: string): void {
    setState({ apiKeyDraft: "", view: { kind: "api-key-input", providerId: option.id, label: option.label, ...(option.keyPrefix === undefined ? {} : { keyPrefix: option.keyPrefix }), ...(reconnectInstanceId === undefined ? {} : { reconnectInstanceId }) } })
    modalInput.prepare()
  }

  function startProviderLogin(option: ProviderOption): void {
    if (option.loginMethod === "api-key") apiKeyInput(option)
    else startOAuthLogin(option)
  }

  function reconnectAccount(option: ProviderOption, account: AuthProviderAccountStatus): void {
    if (option.loginMethod === "api-key") apiKeyInput(option, account.instanceId)
    else startOAuthLogin(option, account.instanceId)
  }

  function submitApiKey(): void {
    const v = state.view
    if (v.kind !== "api-key-input") return
    const key = state.apiKeyDraft.trim()
    if (!key) return
    if (state.attemptKind !== undefined) return
    // The row label came from the runtime's live catalog, which names the
    // provider as the runtime that stores the key knows it.
    void runLogin({ id: v.providerId, label: v.label }, v.reconnectInstanceId, key)
  }

  const loginInput = createAuthModalLoginInput({
    view: () => state.view, text: textDraft, reset: resetInputEditors, attemptCurrent,
    show: (view, draft) => setState({ view, ...(draft === undefined ? {} : { textDraft: draft }) }),
    prepare: () => modalInput.prepare(), submitQuestion: (text) => loginQuestion.submit(text),
  })

  /** A page the runtime reported without opening it opens here, where the
   *  person sits; its address stays on screen either way. */
  function openSignInPage(url: string): void {
    if (deps.signInPage.opensLocally) void deps.openBrowser(url).catch(() => false)
  }

  function showDeviceCode(attemptId: number, option: { readonly id: CredentialProviderId; readonly label: string }, userCode: string | undefined, url: string): void {
    if (!attemptCurrent(attemptId)) return
    resetInputEditors()
    setState("view", { kind: "device-code", providerId: option.id, label: option.label, url, ...(userCode === undefined ? {} : { userCode }) })
    if (userCode === undefined) return
    void deps.clipboard.copy(userCode)
      .then(() => deps.showToast({ message: "Code copied to clipboard", variant: "info" }))
      .catch((err) => {
        log.info("device code clipboard copy failed", { error: errorMessage(err), errorDetail: errorDetail(err) })
      })
  }

  function startOAuthLogin(option: ProviderOption, reconnectInstanceId?: string): void {
    resetInputEditors()
    void runLogin(option, reconnectInstanceId)
  }

  function copyDeviceCode(): void {
    const v = state.view
    if (v.kind !== "device-code" || v.userCode === undefined) return
    void deps.clipboard.copy(v.userCode)
      .then(() => deps.showToast({ message: "Code copied to clipboard", variant: "info" }))
      .catch((err) => deps.showToast({ message: `Copy failed: ${errorMessage(err)}`, variant: "error" }))
  }


  const handleListKey = createListModalKeys({
    rows: authRows,
    cursor: () => state.cursor,
    setCursor: (index) => setState("cursor", index),
    onSelect: selectProvider,
    onClose: closeAuthModal,
    selectable: (row) => row.kind !== "profile-policy" && row.kind !== "heading" && row.kind !== "provider-group" && row.kind !== "file-attention",
    extra: (evt) => {
      if (evt.name.toLowerCase() === "left") {
        evt.preventDefault?.()
        backToSettings()
        return true
      }
      const key = evt.name.toLowerCase()
      const row = authRows()[state.cursor]
      if (key === "right" && row?.kind === "profile") {
        evt.preventDefault?.()
        selectProvider(state.cursor)
        return true
      }
      if (profileControls.handleListKey(key)) {
        evt.preventDefault?.()
        return true
      }
      if (state.attemptKind === "profile") {
        evt.preventDefault?.()
        return true
      }
      if (key === "a" && appendSelectedSubscription()) { evt.preventDefault?.(); return true }
      if (key === "r" && row?.kind === "account" && row.option.loginProgram === undefined) {
        evt.preventDefault?.()
        setState({ textDraft: row.account.label ?? "", view: { kind: "rename-input", providerId: row.option.id, instanceId: row.account.instanceId, label: row.account.displayLabel } })
        modalInput.prepare()
        return true
      }
      if (key !== "d" || !disconnect.requestRow(row)) return false
      evt.preventDefault?.()
      return true
    },
  })

  const modalInput = createAuthModalInput({
    view: () => state.view,
    draft: () => ({ apiKey: state.apiKeyDraft, text: state.textDraft }),
    setApiKeyDraft: (value) => setState("apiKeyDraft", value),
    setTextDraft: (value) => {
      setState("textDraft", value)
      settingEdits.clearError()
    },
    submitApiKey,
    submitTextAnswer: loginInput.submit,
    handleSettingKey: settingEdits.handleKey,
    beginSettingEdit: settingEdits.begin,
    submitProfileDelete: () => { void profileControls.submitProfileDelete() },
    setLoginChoice: (view) => setState("view", view),
    answerLoginQuestion: (yes) => loginQuestion.answer(yes),
    setConfirmationChoice: (view) => setState("view", view),
    answerLoginConfirmation: (replace) => loginInput.answerConfirmation(replace),
    navigateToList,
    setDeleteConfirmation: (view) => setState("view", reconcile(view)),
    navigateToProfile,
    closeAuthModal,
    returnToProviderList,
    copyDeviceCode,
    handleListKey,
    handleProviderModelsKey: modelActions.handleKey,
  })

  const handleKey = (event: Parameters<typeof modalInput.handleKey>[0]): void => {
    if (disconnect.handleKey(event)) return
    if (state.view.kind === "profile-delete-confirmation" && state.view.phase === "ready" && state.attemptKind === "profile") { event.preventDefault?.(); return }
    // The paid-use controls take keys only on the views that show them. A
    // flow that leaves those views without closing them, such as a rename,
    // must not lose the arrows of the view it opens.
    if ((state.view.kind === "provider-settings" || state.view.kind === "paid-use-question") && subscriptionSpendConsent.handleKey(event)) return
    if (state.view.kind === "provider-settings") providerSettings.handleKey(event)
    else modalInput.handleKey(event)
  }
  const handlePaste = (text: string): void => {
    if (settingEdits.pending()) return
    if (state.view.kind === "provider-models") modelActions.handlePaste(text)
    else modalInput.handlePaste(text)
  }
  function finishRename(): void {
    if (state.view.kind !== "profile-create-input") settingEdits.finish(true)
  }
  const authInputPresentation = (): TextEditorPresentation => {
    const presentation = state.view.kind === "provider-models" ? modelActions.presentation() : modalInput.presentation()
    return state.view.kind === "api-key-input" ? { ...presentation, value: "*".repeat(presentation.value.length) } : presentation
  }

  function openAuthModal(): void {
    entry?.close()
    invalidateAttempt()
    resetInputEditors()
    batch(() => {
      setState({ view: { kind: "list" }, disconnect: undefined, apiKeyDraft: "", textDraft: "", profileScope: profileBaseScope().kind === "session" ? "tab" : "defaults", cursor: 0 })
      refreshProviders()
    })
    // The entry's lifecycle cancels the live attempt: a backdrop click or a
    // settings-tree sibling swap detaches this entry without going through
    // closeAuthModal, and a login must not settle into a dismissed modal.
    entry = deps.modal.replace(deps.renderModal, {
      onKey: handleKey,
      onPaste: handlePaste,
      onClose: () => {
        finishRename()
        modelActions.stopObserving()
        resetInputEditors()
        invalidateAttempt()
      },
    })
  }

  function focusProvider(providerId: string): boolean {
    const index = authRows().findIndex((row) =>
      (row.kind === "provider" || row.kind === "account") && row.option.id === providerId)
    if (index < 0) return false
    setState("cursor", index)
    return true
  }

  const { openAuthAccountDetail, openPaidUseQuestion } = providerSettings
  const loginQuestion = createAuthModalLoginQuestion({
    auth: deps.auth, dispatch: deps.appService.dispatch, showToast: deps.showToast,
    signInPage: deps.signInPage, openSignInPage,
    setView: (view) => setState("view", view),
    prepareInput: () => { setState("textDraft", ""); modalInput.prepare() },
    close: () => { batch(() => { entry?.close() }) },
  })
  function openLoginQuestion(questionId: string, onUndelivered?: () => void): boolean {
    const question = deps.auth()?.loginQuestions?.find((candidate) => candidate.questionId === questionId)
    if (question === undefined) return false
    openAuthModal()
    loginQuestion.open(question, onUndelivered)
    return true
  }
  onCleanup(() => { loginQuestion.cancel(); invalidateAttempt(); modelActions.stopObserving() })

  createEffect(() => {
    const published = deps.auth()
    untrack(() => { refreshProviders(published); loginQuestion.observe(published); loginSettlement.observe(published) })
  })

  return {
    profile: () => deps.auth()?.profile,
    authView: settingEdits.view,
    disconnectConfirmation: disconnect.confirmation, confirmDisconnect: disconnect.confirm, cancelDisconnect: disconnect.cancel,
    profileAttemptPending: () => state.attemptKind === "profile",
    authRows,
    authModalCursor: () => state.cursor,
    apiKeyDraft, authInputPresentation,
    openAuthModal, closeAuthModal, finishRename,
    openLoginQuestion, answerLoginQuestion: loginQuestion.answer, answerLoginConfirmation: loginInput.answerConfirmation,
    selectProvider, focusProvider,
    selectProviderModel: modelActions.selectProviderModel,
    recheckProviderModels: modelActions.recheckProviderModels,
    openAccountModels: providerModelControls.openModels,
    toggleFreeRoutes: providerModelControls.toggleFreeRoutes,
    openAuthAccountDetail, openPaidUseQuestion,
    subscriptionSpendConsent,
  }
}
