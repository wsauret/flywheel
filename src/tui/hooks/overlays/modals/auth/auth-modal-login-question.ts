import type { RuntimeAuthLoginQuestion, RuntimeAuthView } from "../../../../../protocol/auth/auth-status-protocol-types.js"
import { Redacted } from "effect"
import { errorMessage } from "../../../../../infra/diagnostics/error-message.js"
import { keptOffMessage } from "../../../../../protocol/client/auth-login.js"
import type { AuthModalDeps } from "./auth-modal-types.js"
import type { AuthView } from "../../../../modals/auth/auth-modal-options.js"

interface LoginQuestionDeps {
  auth: AuthModalDeps["auth"]
  dispatch: AuthModalDeps["appService"]["dispatch"]
  showToast: AuthModalDeps["showToast"]
  signInPage: AuthModalDeps["signInPage"]
  /** Opens a reported page where the person sits, when the runtime does not. */
  openSignInPage: (url: string) => void
  setView: (view: AuthView) => void
  prepareInput: () => void
  close: () => void
}

interface OwnedQuestion {
  readonly question: RuntimeAuthLoginQuestion
  readonly onUndelivered?: () => void
}

/** The question while the person decides whether to log in. */
interface AskingQuestion extends OwnedQuestion {
  readonly phase: "asking"
}

/** The login the person accepted: its operation once the runtime starts it,
 *  whether the person submitted the code that completes it, and whether it
 *  waits for the person's answer to the warning of a provider that the
 *  account's profile keeps off (PI-MODEL-096). */
interface LoginInProgress extends OwnedQuestion {
  readonly phase: "login"
  operationId?: string
  submitted?: true
  optIn?: true
}

/** Owns one modal's runtime login, not the account's answer authority. */
export function createAuthModalLoginQuestion(deps: LoginQuestionDeps) {
  let current: AskingQuestion | LoginInProgress | undefined

  function cancel(): void {
    const owned = current
    current = undefined
    if (owned === undefined) return
    const request = owned.phase === "asking"
      ? { type: "auth.login.decline" as const, providerId: owned.question.providerId, loginQuestionId: owned.question.questionId }
      : { type: "auth.login.cancel" as const, loginQuestionId: owned.question.questionId, ...(owned.operationId === undefined ? {} : { operationId: owned.operationId }) }
    void deps.dispatch(request).catch(() => { owned.onUndelivered?.() })
  }

  function finish(owned: AskingQuestion | LoginInProgress, message?: string): void {
    if (current !== owned) return
    current = undefined
    if (message !== undefined) deps.showToast({ message, variant: "error" })
    deps.close()
  }

  function observe(auth: RuntimeAuthView | undefined): void {
    const owned = current
    if (owned === undefined || auth === undefined) return
    if (owned.phase === "asking") {
      if (auth.loginQuestions?.some((question) => question.questionId === owned.question.questionId)) return
      finish(owned)
      return
    }
    const settlement = auth.settlement
    if (owned.operationId === undefined || settlement?.operationId !== owned.operationId || settlement.providerId !== owned.question.providerId) return
    if (settlement.kind === "failed") finish(owned, settlement.message)
    else {
      deps.showToast({ message: `${owned.question.providerDisplayName} auth active`, variant: "success" })
      finish(owned)
    }
  }

  async function login(owned: LoginInProgress, turnOn?: true): Promise<void> {
    try {
      const question = owned.question
      const result = await deps.dispatch({ type: "auth.login", providerId: question.providerId, instanceId: question.instanceId, loginQuestionId: question.questionId, ...deps.signInPage.request, ...(turnOn === undefined ? {} : { turnOn }) })
      if (current !== owned) return
      if (result.kind === "ignored") { finish(owned); return }
      if (result.kind === "needs_opt_in") {
        // The question stays open in the runtime until the person answers the warning.
        owned.optIn = true
        deps.setView({ kind: "login-confirmation", providerId: question.providerId, label: question.providerDisplayName, message: result.warning, question: "turn-on", choice: "keep" })
        return
      }
      if (result.kind === "browser") {
        owned.operationId = result.operationId
        deps.setView({ kind: "browser-auth", providerId: question.providerId, label: question.providerDisplayName, url: result.authorizeUri, question })
        deps.openSignInPage(result.authorizeUri)
        deps.prepareInput()
        observe(deps.auth())
      } else if (result.kind === "device_code") {
        owned.operationId = result.operationId
        deps.setView({ kind: "device-code", providerId: question.providerId, label: question.providerDisplayName, url: result.verificationUri, question, ...(result.userCode === undefined ? {} : { userCode: result.userCode }) })
        deps.openSignInPage(result.verificationUri)
        observe(deps.auth())
      } else if (result.kind === "completed") {
        deps.showToast({ message: `${question.providerDisplayName} auth active`, variant: "success" })
        finish(owned)
      } else {
        finish(owned, result.kind === "failed" ? result.message : result.kind === "unsupported" ? result.detail : "This account requires a different login method.")
      }
    } catch (error) {
      if (current !== owned) return
      current = undefined
      owned.onUndelivered?.()
      deps.showToast({ message: `Login failed: ${errorMessage(error)}`, variant: "error" })
      deps.close()
    }
  }

  return {
    open(question: RuntimeAuthLoginQuestion, onUndelivered?: () => void): void {
      cancel()
      current = { question, phase: "asking", ...(onUndelivered === undefined ? {} : { onUndelivered }) }
      deps.setView({ kind: "login-question", question, choice: "login" })
    },
    answer(yes: boolean): void {
      const owned = current
      if (owned?.phase !== "asking") return
      if (!yes) { cancel(); deps.close(); return }
      const accepted: LoginInProgress = { ...owned, phase: "login" }
      current = accepted
      deps.setView({ kind: "login-question", question: accepted.question, choice: "login", submitting: true })
      void login(accepted)
    },
    /** Answers the warning that this login shows, and returns false when it shows none. A yes logs in again with
     *  `turnOn`; a no declines the account's question, and nothing is changed. */
    answerTurnOn(yes: boolean): boolean {
      const owned = current
      if (owned?.phase !== "login" || owned.optIn !== true) return false
      delete owned.optIn
      if (yes) {
        deps.setView({ kind: "login-question", question: owned.question, choice: "login", submitting: true })
        void login(owned, true)
        return true
      }
      current = { question: owned.question, phase: "asking", ...(owned.onUndelivered === undefined ? {} : { onUndelivered: owned.onUndelivered }) }
      cancel()
      deps.showToast({ message: keptOffMessage(owned.question.providerDisplayName), variant: "info" })
      deps.close()
      return true
    },
    cancel,
    observe,
    submit(text: string): boolean {
      const owned = current
      if (owned?.phase !== "login") return false
      if (owned.operationId === undefined || owned.submitted || text.trim() === "") return true
      owned.submitted = true
      void deps.dispatch({ type: "auth.login.complete", operationId: owned.operationId, input: Redacted.make(text) }).then((result) => {
        if (current === owned && !result.ok) { cancel(); deps.showToast({ message: `Login failed: ${result.error}`, variant: "error" }); deps.close() }
      }).catch((error: unknown) => {
        if (current === owned) { cancel(); deps.showToast({ message: `Login failed: ${errorMessage(error)}`, variant: "error" }); deps.close() }
      })
      return true
    },
    ownsLogin: (): boolean => current?.phase === "login",
  }
}
