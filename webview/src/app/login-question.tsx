import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { RuntimeAuthLoginQuestion, RuntimeAuthView } from "../../../src/protocol/auth-status-protocol-types.js"
import { loginQuestions } from "../../../src/protocol/client/auth-status-state.js"
import { LOGIN_QUESTION_COPY } from "../../../src/protocol/client/provider-account-copy.js"
import type { ConfirmRequest } from "./client-context.js"

/** Presents project-owned episodes once. Withdrawal and disposal do not answer the account condition. An answer
 *  that never reaches the runtime leaves the episode asking, so the returned `release` lets the next publication
 *  ask again. */
export function observeLoginQuestions(ports: {
  readonly auth: Accessor<RuntimeAuthView | undefined>
  readonly confirm: (request: ConfirmRequest, signal?: AbortSignal) => Promise<boolean>
  readonly open: (question: RuntimeAuthLoginQuestion) => void
  readonly decline: (question: RuntimeAuthLoginQuestion) => Promise<void>
  readonly failed: (cause: unknown) => void
}) {
  const presented = new Set<string>()
  const [revision, setRevision] = createSignal(0)
  let active: { readonly id: string; readonly controller: AbortController } | undefined
  let disposed = false
  createEffect(on(() => [ports.auth(), revision()] as const, ([auth]) => {
    if (auth === undefined) return
    const questions = loginQuestions(auth)
    if (active && !questions.some((question) => question.questionId === active?.id)) {
      active.controller.abort()
      active = undefined
    }
    if (active) return
    const question = questions.find((candidate) => !presented.has(candidate.questionId))
    if (!question) return
    presented.add(question.questionId)
    const attempt = { id: question.questionId, controller: new AbortController() }
    active = attempt
    void ports.confirm({
      title: LOGIN_QUESTION_COPY.title, detail: LOGIN_QUESTION_COPY.detail(question),
      confirmLabel: LOGIN_QUESTION_COPY.confirm, cancelLabel: LOGIN_QUESTION_COPY.decline,
    }, attempt.controller.signal).then(async (yes) => {
      if (disposed || attempt.controller.signal.aborted) return
      if (yes) ports.open(question)
      else {
        try {
          await ports.decline(question)
        } catch (cause) {
          presented.delete(question.questionId)
          throw cause
        }
      }
    }).catch(ports.failed).finally(() => {
      if (active === attempt) active = undefined
      if (!disposed) setRevision((value) => value + 1)
    })
  }))
  onCleanup(() => {
    disposed = true
    active?.controller.abort()
    active = undefined
  })
  return {
    release: (questionId: string): void => {
      if (!presented.delete(questionId) || disposed) return
      setRevision((value) => value + 1)
    },
  }
}
