import { createEffect, createMemo, on, type Accessor } from "solid-js"
import type { QuestionBlock } from "../../infra/output-blocks.js"
import type { DraftCache } from "./create-draft-cache.js"

export interface ComposerQuestionOwner {
  readonly sessionId: string
  readonly question: QuestionBlock
}

/** The handoff between the prompt and the question dock that replaces it
 *  while the foreground session waits on a question (PI-INTERACTION-009).
 *  Returns the question the prompt yields to.
 *
 *  `onDock` runs when a question docks, so the prompt can save its draft
 *  first. A question that leaves the foreground session while its form still
 *  holds a draft was settled without this client, because the form clears
 *  its draft when it sends: another client answered it, or the turn ended.
 *  The words the person typed into it move into the session's prompt draft,
 *  and `onDraftMoved` reloads the prompt from that draft. */
export function createComposerQuestionHandoff(deps: {
  readonly foregroundId: Accessor<string | undefined>
  readonly pendingQuestion: Accessor<QuestionBlock | undefined>
  readonly draftCache: DraftCache
  readonly onDock: () => void
  readonly onDraftMoved: (sessionId: string) => void
}): Accessor<ComposerQuestionOwner | undefined> {
  const owner = createMemo((): ComposerQuestionOwner | undefined => {
    const sessionId = deps.foregroundId()
    const question = deps.pendingQuestion()
    return sessionId && question ? { sessionId, question } : undefined
  })
  createEffect(on(owner, (current, previous) => {
    const left = previous !== undefined && previous.sessionId === deps.foregroundId() && previous.question.toolUseId !== current?.question.toolUseId
    if (left && deps.draftCache.questions.moveToComposer(previous.sessionId, previous.question.toolUseId)) deps.onDraftMoved(previous.sessionId)
    if (current) deps.onDock()
  }))
  return owner
}
