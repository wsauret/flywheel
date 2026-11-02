import { createEffect, untrack } from "solid-js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import { loginQuestions } from "../../protocol/client/auth-status-state.js"
import { automaticDialogsEnabled } from "./automatic-dialogs.js"

interface LoginQuestionDeps {
  readonly auth: () => RuntimeAuthView | undefined
  readonly overlayOpen: () => boolean
  readonly open: (questionId: string, onUndelivered: () => void) => boolean
}

/** Presents each project account episode once when the modal slot is free. */
export function useLoginQuestion(deps: LoginQuestionDeps): void {
  const presented = new Set<string>()
  createEffect(() => {
    const auth = deps.auth()
    const occupied = deps.overlayOpen()
    if (!automaticDialogsEnabled() || occupied) return
    const question = loginQuestions(auth).find(({ questionId }) => !presented.has(questionId))
    if (question === undefined) return
    untrack(() => {
      presented.add(question.questionId)
      if (!deps.open(question.questionId, () => { presented.delete(question.questionId) })) presented.delete(question.questionId)
    })
  })
}
