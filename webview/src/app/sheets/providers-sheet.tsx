import { Redacted } from "effect"
import { Key } from "@solid-primitives/keyed"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type Accessor } from "solid-js"

import type { RuntimeAuthLoginResult } from "../../../../src/protocol/auth-login-protocol-types.js"
import type { AuthProviderStatus, RuntimeAuthLoginQuestion } from "../../../../src/protocol/auth-status-protocol-types.js"
import { awaitsSettlement, initialLoginStep, keptFreePlanMessage, loginConfirmation, loginOutcome, loginSettlement, REPLACING_FREE_PLAN, type LoginStep, type LoginTarget } from "../../../../src/protocol/client/auth-login.js"
import { actionKey } from "../../client/action-key.js"
import { describeFailure } from "../../client/failure-message.js"
import { buildProviderViewState, createProviderConsentMutation } from "../../client/provider-view-model.js"
import type { SheetFocus } from "../../../../src/protocol/client/host-contract.js"
import { BROWSER_LOGIN_COPY, LOGIN_QUESTION_COPY, PAID_USE_SETTINGS_LOAD_FAILURE } from "../../../../src/protocol/client/provider-account-copy.js"
import { useClient } from "../client-context.js"
import { Sheet, SheetEmpty, SheetLoading, SheetRow } from "./sheet.js"
import { SheetField } from "./controls.js"
import "../../styles/providers.css"
import { KERNEL_COMMAND_NAMES } from "../../../../src/protocol/command-names.js"

/** Authentication: who Flywheel can ask for a turn, and on what terms.
 *
 *  One sheet for connecting a provider, seeing which accounts each one holds,
 *  and reviewing paid use per account. Connecting used to mean opening a
 *  terminal, and then an editor-only flow; here it is the sheet itself asking
 *  for the one thing the provider needs, so the phone can do it too. The
 *  runtime keeps the credentials and publishes the view; this sheet holds only
 *  the step of a login in progress. Consent boxes show the runtime's saved decisions. */

/** Why an unanswered paid mode is highlighted: it is off, and only the person can turn it on (PI-MODEL-018, PI-MODEL-050). */
const PAID_USE_PENDING_NOTE = "Off. Flywheel keeps paid use off until you tick this box."

const REFUSALS = {
  stale: "Provider settings changed. Review the current account and try again.",
  contention: "Another update is in progress. Try again.",
  "invalid-envelope": "Paid capacity changed. Refresh providers before trying again.",
  "storage-failure": "Flywheel could not save paid-use settings. Check runtime storage and retry.",
} as const

/** Delivers each explicit sheet request once. Focus and authentication remain separate actions. */
export function observeProviderSheetFocus(
  focus: Accessor<SheetFocus | undefined>,
  focusProvider: (providerId: string) => void,
  connectProvider: (providerId: string) => void,
  reviewPaidUse: (intent: Extract<SheetFocus, { readonly kind: "review-paid-use" }>) => void,
  reconnectAccount: (question: RuntimeAuthLoginQuestion) => void,
): void {
  createEffect(on(focus, (intent) => {
    if (intent?.kind === "focus-provider") focusProvider(intent.providerId)
    else if (intent?.kind === "connect-provider") connectProvider(intent.providerId)
    else if (intent?.kind === "review-paid-use") reviewPaidUse(intent)
    else if (intent?.kind === "reconnect-account") reconnectAccount(intent.question)
  }))
}

export function ProvidersSheet() {
  const client = useClient()
  const snapshot = () => client.state().authStatus
  const auth = () => snapshot()?.auth
  const view = createMemo(() => {
    const current = auth()
    return current === undefined ? undefined : buildProviderViewState(current)
  })
  const [step, setStep] = createSignal<LoginStep | undefined>(undefined)
  let automatic: { readonly questionId: string; operationId?: string } | undefined
  // The latest login this sheet started. A later one replaces it, so an older answer that arrives late changes nothing.
  let attempts = 0
  let disposed = false
  const cancelAutomatic = (): void => {
    const attempt = automatic
    automatic = undefined
    if (attempt) void client.connection.dispatch({ type: "auth.login.cancel", loginQuestionId: attempt.questionId, ...(attempt.operationId === undefined ? {} : { operationId: attempt.operationId }) }).catch(() => undefined)
  }
  onCleanup(() => { disposed = true; cancelAutomatic() })
  // A sign-in holds every account control until it settles: its steps answer
  // with the provider's next question, and a second sign-in would race it.
  const loginKey = actionKey("provider-login")
  const finishKey = actionKey("provider-login-finish")
  const busy = () => client.actions.working(loginKey) || client.actions.working(finishKey)
  const refreshKey = () => actionKey("providers-refresh", auth()?.profile.id)
  const consentKey = (envelopeId: string) => actionKey("provider-consent", envelopeId)
  const disconnectKey = (providerId: string, instanceId?: string) => actionKey("provider-disconnect", `${providerId}:${instanceId ?? ""}`)
  const renameKey = (providerId: string, instanceId: string) => actionKey("provider-rename", `${providerId}:${instanceId}`)
  const providerElements = new Map<string, HTMLElement>()
  const paidUseElements = new Map<string, HTMLInputElement>()

  const providerOf = (id: string): AuthProviderStatus | undefined => auth()?.providers.find((provider) => provider.providerId === id)
  const focusElement = (element: HTMLElement | undefined): void => {
    element?.focus({ preventScroll: true })
    element?.scrollIntoView({ block: "nearest" })
  }
  const paidUseElementKey = (providerId: string, accountCorrelationId: string, envelopeId: string): string =>
    JSON.stringify([providerId, accountCorrelationId, envelopeId])
  const registerPaidUseElement = (key: string, element: HTMLInputElement): void => {
    paidUseElements.set(key, element)
    onCleanup(() => {
      if (paidUseElements.get(key) === element) paidUseElements.delete(key)
    })
  }

  observeProviderSheetFocus(
    client.sheetFocus,
    (providerId) => focusElement(providerElements.get(providerId)),
    (providerId) => {
      const provider = providerOf(providerId)
      if (provider) void begin(provider)
    },
    (intent) => {
      const target = paidUseElements.get(paidUseElementKey(intent.providerId, intent.accountCorrelationId, intent.envelopeId))
      focusElement(target ?? providerElements.get(intent.providerId))
    },
    (question) => {
      cancelAutomatic()
      const attempt = { questionId: question.questionId }
      automatic = attempt
      // The answer goes out at once, beside any manual login still starting, which it replaces.
      void signIn({ providerId: question.providerId, displayName: question.providerDisplayName, lead: LOGIN_QUESTION_COPY.lead(question) }, question.instanceId, undefined, attempt)
    },
  )

  // A device-code or browser login ends on the auth cursor, not on the
  // dispatch that started it.
  createEffect(on(() => [step(), auth()?.settlement, auth()?.confirmation] as const, ([current]) => {
    if (!awaitsSettlement(current)) return
    const settlement = loginSettlement(auth(), current.operationId)
    if (settlement === undefined) {
      // After the person signed in, the runtime may ask before it stores the account.
      const question = current.kind === "confirm" ? undefined : loginConfirmation(auth(), current.provider, current.operationId)
      if (question !== undefined) setStep(question)
      return
    }
    automatic = undefined
    setStep(undefined)
    if (settlement.kind === "completed") client.report("info", `Connected to ${current.provider.displayName}.`)
    else if (settlement.refused === true) client.report("warning", `Flywheel could not connect ${current.provider.displayName}: ${settlement.message}`)
    else client.report("warning", `Flywheel could not connect ${current.provider.displayName}: ${settlement.message.replace(/\.$/u, "")}. Log in again.`)
  }))

  async function begin(provider: AuthProviderStatus): Promise<void> {
    cancelAutomatic()
    attempts++
    const first = initialLoginStep(provider)
    if (first.kind === "choose-account") {
      setStep(first)
      return
    }
    await login(provider, first.kind === "working" ? first.instanceId : undefined)
  }

  async function login(provider: LoginTarget, instanceId: string | undefined, apiKey?: string): Promise<void> {
    await client.actions.run(loginKey, () => signIn(provider, instanceId, apiKey))
  }

  function signIn(provider: LoginTarget, instanceId: string | undefined, apiKey: string | undefined, recovery?: { readonly questionId: string; operationId?: string }): Promise<void> {
    const attempt = ++attempts
    const superseded = (): boolean => disposed || attempt !== attempts
    setStep({ kind: "working", provider, ...(instanceId === undefined ? {} : { instanceId }) })
    // An account question names its own profile; any other login writes the profile this sheet shows.
    const profileId = recovery === undefined ? auth()?.profile.id : undefined
    return settleStep(provider, instanceId, superseded, recovery, () => client.connection.dispatch({
      type: "auth.login",
      providerId: provider.providerId,
      ...(instanceId === undefined ? {} : { instanceId }),
      ...(recovery === undefined ? {} : { loginQuestionId: recovery.questionId }),
      ...(profileId === undefined ? {} : { profileId }),
      // Redacted from the first moment the client holds it as a value: the
      // wire codec unwraps at encode, and nothing between here and the frame
      // can log the plain string.
      ...(apiKey === undefined ? {} : { apiKey: Redacted.make(apiKey) }),
    }))
  }

  /** Answers the flow's pre-flight question; the runtime answers with the flow's next step. Only a flow
   *  that Flywheel runs itself asks one, and an account question is always for a login that another
   *  program owns, so an answer never belongs to an account question. */
  async function answerPrompt(question: Extract<LoginStep, { kind: "prompt" }>, answer: string): Promise<void> {
    const attempt = ++attempts
    const superseded = (): boolean => disposed || attempt !== attempts
    await client.actions.run(loginKey, () => settleStep(question.provider, undefined, superseded, undefined, () => client.connection.dispatch({
      type: "auth.login.answer", providerId: question.provider.providerId, operationId: question.operationId, answer,
    })))
  }

  /** Shows what the runtime answered to one login request. */
  async function settleStep(provider: LoginTarget, instanceId: string | undefined, superseded: () => boolean, recovery: { readonly questionId: string; operationId?: string } | undefined, request: () => Promise<RuntimeAuthLoginResult>): Promise<void> {
    try {
      const result = await request()
      if (superseded()) return
      if (recovery && (result.kind === "browser" || result.kind === "device_code")) recovery.operationId = result.operationId
      const outcome = loginOutcome(result, provider, instanceId)
      if (outcome.kind === "ignored") { automatic = undefined; setStep(undefined); return }
      if (outcome.kind === "connected") {
        automatic = undefined
        setStep(undefined)
        client.report("info", `Connected to ${provider.displayName}.`)
        return
      }
      if (outcome.kind === "failed") {
        automatic = undefined
        setStep(undefined)
        client.report("warning", `Flywheel could not connect ${provider.displayName}: ${outcome.message}`)
        return
      }
      // The page is not opened here. This answer arrives after the tap that
      // started the login ended, and a browser such as iOS Safari opens a page
      // only inside a tap, so the step offers the page as its primary action.
      setStep(outcome.step)
    } catch (cause) {
      // An answer that never reached the runtime leaves its question open, so the next publication asks again.
      if (recovery !== undefined) client.retryLoginQuestion(recovery.questionId)
      if (superseded()) return
      automatic = undefined
      setStep(undefined)
      client.report("warning", `Flywheel could not connect ${provider.displayName}: ${describeFailure(cause)}`)
    }
  }

  /** Confirms the runtime's question; the runtime answers with the login's end. */
  async function confirm(question: Extract<LoginStep, { kind: "confirm" }>): Promise<void> {
    const attempt = ++attempts
    const superseded = (): boolean => disposed || attempt !== attempts
    // A working step, so the end that the cursor also carries is shown once, from this answer.
    setStep({ kind: "working", provider: question.provider, message: REPLACING_FREE_PLAN })
    await client.actions.run(loginKey, () => settleStep(question.provider, undefined, superseded, undefined, () => client.connection.dispatch({
      type: "auth.login.answer", providerId: question.provider.providerId, operationId: question.operationId, answer: "confirm",
    })))
  }

  async function completeBrowserLogin(operationId: string, input: string): Promise<void> {
    await client.actions.run(finishKey, () => finishSignIn(operationId, input))
  }

  async function finishSignIn(operationId: string, input: string): Promise<void> {
    try {
      const result = await client.connection.dispatch({
        type: "auth.login.complete",
        operationId,
        input: Redacted.make(input),
      })
      if (!result.ok) {
        cancelAutomatic()
        setStep(undefined)
        client.report("warning", result.error)
      }
    } catch (cause) {
      client.report("warning", `Flywheel could not finish browser login: ${describeFailure(cause)}`)
    }
  }

  function cancel(): void {
    attempts++
    const current = step()
    if (automatic) cancelAutomatic()
    else if (awaitsSettlement(current)) void client.connection.dispatch({ type: "auth.login.cancel", operationId: current.operationId }).catch(() => undefined)
    setStep(undefined)
  }

  function refresh(): void {
    const current = auth()
    if (!current) return
    // The operation id keys the runtime's settlement of this refresh; a fresh
    // one per press keeps a repeated press from cancelling the first.
    void client.actions.run(refreshKey(), () => client.connection.dispatch({ type: "auth.refresh", profileId: current.profile.id, operationId: crypto.randomUUID() })
      .then(() => client.report("info", `Refreshing provider status for the ${current.profile.displayName} profile.`)),
    () => client.report("warning", PAID_USE_SETTINGS_LOAD_FAILURE))
  }

  async function tick(providerId: string, accountId: string, envelopeId: string, checked: boolean): Promise<void> {
    const current = snapshot()
    if (!current) return
    const mutation = createProviderConsentMutation(current, providerId, accountId, envelopeId, checked)
    if (!mutation) return
    await client.actions.run(consentKey(envelopeId), async () => {
      const result = await client.connection.dispatch(mutation)
      if (result.kind === "committed") {
        client.report("info", "Paid-use settings saved.")
      } else {
        client.report("warning", REFUSALS[result.kind])
      }
    }, (cause) => client.report("warning", `Flywheel could not save paid-use settings: ${describeFailure(cause)}`))
  }

  const disconnect = (providerId: string, label: string, detail: string, instanceId?: string) => {
    const run = async () => {
      const confirmed = await client.confirm({ title: `Disconnect ${label}?`, detail, confirmLabel: "Disconnect", destructive: true })
      if (!confirmed) return
      await client.actions.run(disconnectKey(providerId, instanceId), async () => {
        const profileId = auth()?.profile.id
        const result = await client.connection.dispatch({ type: "auth.account.disconnect", providerId, ...(instanceId === undefined ? {} : { instanceId }), ...(profileId === undefined ? {} : { profileId }) })
        if (result.ok) client.report("info", `${label} disconnected.`)
        else client.report("warning", `Flywheel could not disconnect ${label}: ${result.error}`)
      }, (cause) => client.report("warning", `Flywheel could not disconnect ${label}: ${describeFailure(cause)}`))
    }
    void run().catch((cause: unknown) => client.report("warning", `Flywheel could not disconnect ${label}: ${describeFailure(cause)}`))
  }

  const rename = (providerId: string, account: AuthProviderStatus["accounts"][number], label: string, profileId: string | undefined) => {
    return client.actions.run(renameKey(providerId, account.instanceId), async () => {
        const result = await client.connection.dispatch({ type: "auth.account.rename", providerId, instanceId: account.instanceId, ...(label.trim().length === 0 ? {} : { label: label.trim() }), ...(profileId === undefined ? {} : { profileId }) })
        if (!result.ok) client.report("warning", `Flywheel could not rename the account: ${result.error}`)
    }, (cause) => client.report("warning", `Flywheel could not rename the account: ${describeFailure(cause)}`))
  }

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text)
      .then(() => client.report("info", "Copied."))
      .catch((cause: unknown) => client.report("warning", `Could not copy: ${describeFailure(cause)}`))
  }

  const consentUnavailable = () => {
    const consent = auth()?.subscriptionSpendConsent
    return consent?.kind === "unavailable" ? consent.message : undefined
  }

  return (
    <Sheet
      title={step() === undefined ? KERNEL_COMMAND_NAMES.auth : `Connect ${step()!.provider.displayName}`}
      onClose={() => { cancel(); client.closeSheet() }}
      tools={
        <Show when={step() === undefined} fallback={<button class="ghost-text" onClick={cancel}>Cancel</button>}>
          <button class="ghost-text" aria-busy={client.actions.working(refreshKey()) || undefined} onClick={refresh}>Refresh</button>
        </Show>
      }
    >
      <Show when={view()} fallback={<SheetLoading />}>
        {(state) => (
          <Show when={step()} fallback={
            <>
              <SheetRow label="Auth profile" detail="Switch, create, rename, or delete credential profiles" value={state().profileName} onClick={() => client.openSheet("profiles")} />
              <div class="sheet-section">{state().profileName} profile</div>
              <Show when={state().pendingCount > 0}>
                <div class="sheet-problem">
                  <strong>{state().pendingCount} paid {state().pendingCount === 1 ? "mode needs" : "modes need"} review.</strong>
                  <span>Each stays off until you tick it.</span>
                </div>
              </Show>
              <Show when={consentUnavailable()}>{(message) => <div class="sheet-problem">{message()}</div>}</Show>
              <Show when={state().providers.length > 0} fallback={<SheetEmpty>No model providers are configured.</SheetEmpty>}>
                {/* Each auth snapshot builds a new view. Keyed rows update in
                    place, so a card or box the sheet focused, and the scroll
                    that shows it, outlive the next snapshot. */}
                <Key each={state().providers} by={(row) => row.id}>
                  {(provider) => (
                    <section class="provider-card" tabIndex={-1} ref={(element) => providerElements.set(provider().id, element)}>
                      <div class="provider-card-head">
                        <div class="provider-card-title">
                          <span class="provider-card-name">{provider().name}</span>
                          <span class="provider-card-status">{provider().status}</span>
                        </div>
                        <Show when={provider().source !== "misconfigured"}>
                          <span class="provider-card-actions">
                            <Show when={provider().accounts.length === 0 && (provider().source === "stored_key" || provider().source === "oauth" || provider().source === "invalid")}>
                              <button class="ghost-text" disabled={busy()} aria-busy={client.actions.working(disconnectKey(provider().id)) || undefined} onClick={() => disconnect(provider().id, provider().name, provider().disconnectDetail)}>Disconnect</button>
                            </Show>
                            <button class="ghost-text" disabled={busy()} onClick={() => { const found = providerOf(provider().id); if (found) void begin(found) }}>
                              {provider().accounts.length === 0 ? "Connect" : "Add or reconnect"}
                            </button>
                          </span>
                        </Show>
                      </div>
                      <Show when={provider().source === "misconfigured" && provider().detail}>{(detail) => <p class="account-note">{detail()}</p>}</Show>
                      <Show when={provider().problem}>{(problem) => <p class="card-problem" role="status">{problem()}</p>}</Show>
                      <Key each={provider().accounts} by={(row) => JSON.stringify([auth()?.profile.id, row.id])}>
                        {(account) => {
                          const profileId = auth()?.profile.id
                          return (
                          <article class="account-card">
                            <div class="account-card-head">
                              <span class="account-card-label">{account().label}</span>
                              <span class="account-card-status">{account().status}</span>
                            </div>
                            <Show when={account().problem}>{(problem) => <p class="card-problem" role="status">{problem()}</p>}</Show>
                            <Show when={account().modes.length > 0} fallback={<p class="account-note">Paid capacity status is not available for this account.</p>}>
                              <Key each={account().modes} by={(row) => row.envelopeId}>
                                {(mode) => (
                                  <label class="mode-row" classList={{ pending: mode().pending }}>
                                    <input
                                      type="checkbox"
                                      ref={(element) => registerPaidUseElement(paidUseElementKey(provider().id, account().id, mode().envelopeId), element)}
                                      aria-disabled={account().modes.some((row) => client.actions.working(consentKey(row.envelopeId))) || undefined}
                                      aria-busy={client.actions.working(consentKey(mode().envelopeId)) || undefined}
                                      checked={mode().checked}
                                      onChange={(event) => {
                                        const checked = event.currentTarget.checked
                                        event.currentTarget.checked = mode().checked
                                        if (account().modes.some((row) => client.actions.working(consentKey(row.envelopeId)))) return
                                        void tick(provider().id, account().id, mode().envelopeId, checked)
                                      }}
                                    />
                                    <span class="mode-text">
                                      <span class="mode-label">{mode().label} <span class="mode-status">{mode().status}{client.actions.working(consentKey(mode().envelopeId)) ? " · Saving…" : ""}</span></span>
                                      <Show when={mode().details.length > 0}><span class="mode-details">{mode().details.join(" · ")}</span></Show>
                                      <Show when={mode().pending}><span class="mode-details">{PAID_USE_PENDING_NOTE}</span></Show>
                                    </span>
                                  </label>
                                )}
                              </Key>
                            </Show>
                            <div class="account-card-actions">
                              <Key each={providerOf(provider().id)?.accounts.filter((candidate) => candidate.accountCorrelationId === account().id) ?? []} by="instanceId">
                                {(found) => (
                                  <>
                                    <Show when={account().repair}>
                                      {(repair) => <button class="ghost-text" disabled={busy()} onClick={() => { const owner = providerOf(provider().id); if (owner) void login(owner, found().instanceId) }}>{repair()}</button>}
                                    </Show>
                                    <Show when={account().renamable}>
                                      <SheetField label="Account name" value={found().label ?? ""} placeholder="Account's own name"
                                        disabled={busy()} working={client.actions.working(renameKey(provider().id, found().instanceId))}
                                        onCommit={(label) => rename(provider().id, found(), label, profileId)} />
                                    </Show>
                                    <button class="ghost-text" disabled={busy()} aria-busy={client.actions.working(disconnectKey(provider().id, found().instanceId)) || undefined} onClick={() => disconnect(provider().id, account().label, account().disconnectDetail, found().instanceId)}>Disconnect</button>
                                  </>
                                )}
                              </Key>
                              <Show when={account().billingUrl && client.actions.canOpenExternal}>
                                <button class="ghost-text" onClick={() => client.actions.openExternal(account().billingUrl ?? "")}>Provider billing</button>
                              </Show>
                            </div>
                          </article>
                        )}}
                      </Key>
                    </section>
                  )}
                </Key>
              </Show>
            </>
          }>
            {(current) => <LoginPanel step={current()} busy={busy()} onAccount={(instanceId) => { void login(current().provider, instanceId) }} onKey={(key) => { const now = current(); void login(now.provider, now.kind === "needs-key" ? now.instanceId : undefined, key) }} onBrowserComplete={completeBrowserLogin} onPromptAnswer={(answer) => { const now = current(); if (now.kind === "prompt") void answerPrompt(now, answer) }} onConfirm={() => { const now = current(); if (now.kind === "confirm") void confirm(now) }} onDecline={() => { const now = current(); cancel(); client.report("info", keptFreePlanMessage(now.provider.displayName)) }} onOpen={(url) => client.actions.openExternal(url)} canOpen={client.actions.canOpenExternal} onCopy={copy} />}
          </Show>
        )}
      </Show>
    </Sheet>
  )
}

/** The step of a login in progress, as one panel the sheet body shows instead
 *  of the provider list, so the person is never asked to find the code or the
 *  key field among other rows. */
function LoginPanel(props: {
  readonly step: LoginStep
  readonly busy: boolean
  readonly canOpen: boolean
  readonly onAccount: (instanceId: string | undefined) => void
  readonly onKey: (key: string) => void
  readonly onBrowserComplete: (operationId: string, input: string) => Promise<void>
  readonly onPromptAnswer: (answer: string) => void
  readonly onConfirm: () => void
  readonly onDecline: () => void
  readonly onOpen: (url: string) => void
  readonly onCopy: (text: string) => void
}) {
  const [key, setKey] = createSignal("")
  const [browserInput, setBrowserInput] = createSignal("")
  const [browserInputSubmitted, setBrowserInputSubmitted] = createSignal(false)
  const [promptAnswer, setPromptAnswer] = createSignal("")
  const submitKey = () => {
    const trimmed = key().trim()
    if (trimmed.length === 0) return
    props.onKey(trimmed)
    setKey("")
  }
  const submitBrowserInput = (operationId: string) => {
    const trimmed = browserInput().trim()
    if (trimmed.length === 0 || browserInputSubmitted()) return
    setBrowserInputSubmitted(true)
    void props.onBrowserComplete(operationId, trimmed)
    setBrowserInput("")
  }
  const submitPromptAnswer = (allowEmpty: boolean) => {
    const trimmed = promptAnswer().trim()
    if (trimmed.length === 0 && !allowEmpty) return
    props.onPromptAnswer(trimmed)
    setPromptAnswer("")
  }
  const step = () => props.step
  // Solid's Show narrows on what `when` returns, so each step kind gets an
  // accessor that returns it or nothing.
  const keyStep = () => { const current = step(); return current.kind === "needs-key" ? current : undefined }
  const promptStep = () => { const current = step(); return current.kind === "prompt" ? current : undefined }
  const codeStep = () => { const current = step(); return current.kind === "device-code" ? current : undefined }
  const browserStep = () => { const current = step(); return current.kind === "browser" ? current : undefined }
  const accountStep = () => { const current = step(); return current.kind === "choose-account" ? current : undefined }
  const confirmStep = () => { const current = step(); return current.kind === "confirm" ? current : undefined }
  const workingStep = () => { const current = step(); return current.kind === "working" ? current : undefined }
  return (
    <div class="login-panel">
      <Show when={accountStep()}>{(current) => <>
        <div class="sheet-section">Which account?</div>
        <p class="login-lead">Signing in again as an account you already hold is different from adding another one.</p>
        <For each={current().provider.accounts}>
          {(account) => <SheetRow label={account.displayLabel} value={account.expired ? "signed out" : "connected"} onClick={() => props.onAccount(account.instanceId)} />}
        </For>
        <SheetRow label="Add another account" onClick={() => props.onAccount(undefined)} />
      </>}</Show>
      <Show when={confirmStep()}>{(current) => <>
        <p class="login-lead">{current().message}</p>
        <div class="login-actions">
          <button class="ghost-text" type="button" disabled={props.busy} onClick={() => props.onDecline()}>Keep free account</button>
          <button class="primary" type="button" disabled={props.busy} onClick={() => props.onConfirm()}>Replace</button>
        </div>
      </>}</Show>
      <Show when={workingStep()}>
        {(current) => <p class="login-lead" aria-busy="true">{current().message ?? `Asking ${current().provider.displayName} how to log in…`}</p>}
      </Show>
      <Show when={keyStep()}>
        {(current) => (
          <form class="login-form" onSubmit={(event) => { event.preventDefault(); submitKey() }}>
            <p class="login-lead">{current().hint ?? `Paste the key for ${current().provider.displayName}.`}</p>
            {/* The field is the only place the key is ever shown, and it is a credential. */}
            <input class="sheet-input" type="password" aria-label="API key" autocomplete="off" spellcheck={false} placeholder="API key" value={key()} onInput={(event) => setKey(event.currentTarget.value)} />
            <div class="login-actions">
              <button class="primary" type="submit" disabled={props.busy || key().trim().length === 0}>Save key</button>
            </div>
          </form>
        )}
      </Show>
      <Show when={promptStep()}>
        {(current) => (
          <form class="login-form" onSubmit={(event) => { event.preventDefault(); submitPromptAnswer(current().prompt.allowEmpty === true) }}>
            <p class="login-lead">{current().prompt.message}</p>
            <input class="sheet-input" type="text" aria-label={current().prompt.message} autocomplete="off" spellcheck={false} placeholder={current().prompt.placeholder ?? ""} value={promptAnswer()} onInput={(event) => setPromptAnswer(event.currentTarget.value)} />
            <div class="login-actions">
              <button class="primary" type="submit" disabled={props.busy || (current().prompt.allowEmpty !== true && promptAnswer().trim().length === 0)}>Continue</button>
            </div>
          </form>
        )}
      </Show>
      <Show when={codeStep()}>
        {(current) => {
          const code = () => current().userCode
          const uri = () => current().verificationUri
          return (
            <>
              <p class="login-lead">{code() === undefined ? `Open the ${current().provider.displayName} page to log in.` : `Enter this code on the ${current().provider.displayName} page.`} Flywheel finishes on its own once {code() === undefined ? "you approve" : "the code is accepted"}.</p>
              <Show when={code()}>{(text) => <code class="login-code">{text()}</code>}</Show>
              <Show when={!props.canOpen}><p class="login-lead">{uri()}</p></Show>
              <div class="login-actions">
                <Show when={code()}>{(text) => <button class="ghost-text" onClick={() => props.onCopy(text())}>Copy code</button>}</Show>
                <Show when={props.canOpen}><button class="primary" onClick={() => props.onOpen(uri())}>Open the page</button></Show>
              </div>
              <p class="login-wait" aria-busy="true">Waiting for {current().provider.displayName}…</p>
            </>
          )
        }}
      </Show>
      <Show when={browserStep()}>
        {(current) => {
          const uri = () => current().authorizeUri
          return (
            <>
              <p class="login-lead">{current().provider.lead ?? BROWSER_LOGIN_COPY.lead(current().provider.displayName)} {BROWSER_LOGIN_COPY.paste}</p>
              <Show when={props.canOpen} fallback={<p class="login-lead">{uri()}</p>}>
                <div class="login-actions">
                  <button class="primary" type="button" onClick={() => props.onOpen(uri())}>{BROWSER_LOGIN_COPY.open}</button>
                </div>
              </Show>
              <form class="login-form" onSubmit={(event) => { event.preventDefault(); submitBrowserInput(current().operationId) }}>
                <input class="sheet-input" type="password" aria-label={BROWSER_LOGIN_COPY.placeholder} autocomplete="off" spellcheck={false} placeholder={BROWSER_LOGIN_COPY.placeholder} value={browserInput()} disabled={props.busy || browserInputSubmitted()} onInput={(event) => setBrowserInput(event.currentTarget.value)} />
                <div class="login-actions">
                  <button class="primary" type="submit" disabled={props.busy || browserInputSubmitted() || browserInput().trim().length === 0}>Finish login</button>
                </div>
              </form>
              <p class="login-wait" aria-busy="true">{browserInputSubmitted() ? BROWSER_LOGIN_COPY.submitted : `Waiting for ${current().provider.displayName}…`}</p>
            </>
          )
        }}
      </Show>
    </div>
  )
}
