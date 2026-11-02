import type { RuntimeAuthLoginQuestion, RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import { Redacted } from "effect"
import { errorMessage } from "../../infra/error-message.js"
import type { AuthModalDeps } from "./auth-modal-types.js"
import type { AuthView } from "./auth-modal-options.js"

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

/** Owns one modal's runtime login, not the account's answer authority. */
export function createAuthModalLoginQuestion(deps: LoginQuestionDeps) {
  let current: {
    readonly question: RuntimeAuthLoginQuestion
    readonly onUndelivered?: () => void
    phase: "asking" | "login"
    operationId?: string
    submitted?: true
  } | undefined

  function cancel(): void {
    const owned = current
    current = undefined
    if (owned === undefined) return
    const request = owned.phase === "asking"
      ? { type: "auth.login.decline" as const, providerId: owned.question.providerId, loginQuestionId: owned.question.questionId }
      : { type: "auth.login.cancel" as const, loginQuestionId: owned.question.questionId, ...(owned.operationId === undefined ? {} : { operationId: owned.operationId }) }
    void deps.dispatch(request).catch(() => { owned.onUndelivered?.() })
  }

  function finish(owned: NonNullable<typeof current>, message?: string): void {
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

  async function login(owned: NonNullable<typeof current>): Promise<void> {
    try {
      const question = owned.question
      const result = await deps.dispatch({ type: "auth.login", providerId: question.providerId, instanceId: question.instanceId, loginQuestionId: question.questionId, ...deps.signInPage.request })
      if (current !== owned) return
      if (result.kind === "ignored") { finish(owned); return }
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
      owned.phase = "login"
      deps.setView({ kind: "login-question", question: owned.question, choice: "login", submitting: true })
      void login(owned)
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
