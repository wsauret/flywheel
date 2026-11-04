import type { RuntimeAuthLoginPrompt } from "../../protocol/auth-login-protocol-types.js"
import type { CredentialProviderId } from "../../infra/auth/auth-store-types.js"
import type { AuthView } from "./auth-modal-options.js"

/** Owns the one outstanding login answer. Leaving its attempt aborts the
 * wait; browser codes are credentials, not settings edits. */
export function createAuthModalLoginInput(deps: {
  view: () => AuthView
  text: () => string
  reset: () => void
  show: (view: AuthView, draft?: string) => void
  prepare: () => void
  attemptCurrent: (id: number) => boolean
  submitQuestion: (text: string) => boolean
}) {
  let textAnswer: ((answer: string) => void) | undefined
  function submit(): void {
    const answer = textAnswer
    const view = deps.view()
    const text = deps.text().trim()
    if (view.kind === "browser-auth" && deps.submitQuestion(text)) {
      if (text !== "") { deps.reset(); deps.show({ ...view, submitted: true }, "") }
      return
    }
    if (answer === undefined || (view.kind === "browser-auth" && text === "")) return
    textAnswer = undefined
    deps.reset()
    if (view.kind === "browser-auth") deps.show({ ...view, submitted: true }, "")
    answer(text)
  }
  function awaitAnswer(signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(new Error("Login cancelled"))
    const answer = Promise.withResolvers<string>()
    signal.addEventListener("abort", () => { textAnswer = undefined; answer.reject(new Error("Login cancelled")) }, { once: true })
    textAnswer = answer.resolve
    return answer.promise
  }
  function ask(attemptId: number, signal: AbortSignal, option: { readonly id: CredentialProviderId; readonly label: string }, prompt: RuntimeAuthLoginPrompt): Promise<string> {
    if (!deps.attemptCurrent(attemptId) || signal.aborted) return Promise.reject(new Error("Login cancelled"))
    deps.show({ kind: "login-prompt", providerId: option.id, label: option.label, prompt }, "")
    deps.prepare()
    return awaitAnswer(signal)
  }
  let confirmation: ((replace: boolean) => void) | undefined
  /** Shows the runtime's question before a new account replaces free-plan accounts, and resolves with the person's
   *  choice: true to replace them. Leaving the attempt rejects. */
  function confirm(attemptId: number, signal: AbortSignal, option: { readonly id: CredentialProviderId; readonly label: string }, message: string): Promise<boolean> {
    if (!deps.attemptCurrent(attemptId) || signal.aborted) return Promise.reject(new Error("Login cancelled"))
    const answer = Promise.withResolvers<boolean>()
    signal.addEventListener("abort", () => { confirmation = undefined; answer.reject(new Error("Login cancelled")) }, { once: true })
    confirmation = answer.resolve
    deps.show({ kind: "login-confirmation", providerId: option.id, label: option.label, message, choice: "replace" })
    return answer.promise
  }
  function answerConfirmation(replace: boolean): void {
    const answer = confirmation
    const view = deps.view()
    confirmation = undefined
    if (answer !== undefined && replace && view.kind === "login-confirmation") deps.show({ ...view, submitting: true })
    answer?.(replace)
  }
  return { submit, awaitAnswer, ask, confirm, answerConfirmation }
}
