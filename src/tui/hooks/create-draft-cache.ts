import type { ChatAttachment } from "../../infra/chat-input.js"
import { mergeComposerDrafts } from "./composer-draft-merge.js"

/** The prompt draft while no session or pending tab owns it. */
export const UNBOUND_COMPOSER_DRAFT = "composer:unbound"

export interface ComposerDraftPaste {
  readonly start: number
  readonly end: number
  readonly text: string
}

export type ComposerDraftAttachment = ChatAttachment

export interface ComposerDraft {
  readonly text: string
  readonly pastes: readonly ComposerDraftPaste[]
  readonly attachments: readonly ComposerDraftAttachment[]
  /** Where the caret stood when the draft was written; absent means the end. */
  readonly caret?: number
}

export interface QuestionFormDraft {
  readonly tab: number
  readonly cursor: number
  readonly answers: readonly {
    readonly picked: readonly number[]
    readonly freeformPicked: boolean
  }[]
  readonly editorText: readonly (readonly string[])[]
}

export interface QuestionDraftNamespace {
  get(sessionId: string, toolUseId: string): QuestionFormDraft | undefined
  set(sessionId: string, toolUseId: string, draft: QuestionFormDraft): void
  clear(sessionId: string, toolUseId: string): void
  /** Removes the form and appends the text typed into its fields to the
   *  session's prompt draft, one field per paragraph. Returns whether any
   *  text moved. */
  moveToComposer(sessionId: string, toolUseId: string): boolean
}

/** Every draft and question form the cache holds, as a successor terminal
 *  receives them (ARCH-DISTRIBUTION-031). */
export interface DraftCacheSnapshot {
  readonly drafts: { readonly [key: string]: ComposerDraft }
  readonly questionDrafts: { readonly [sessionId: string]: { readonly [toolUseId: string]: QuestionFormDraft } }
}

export interface DraftCache {
  get(sessionId: string): ComposerDraft
  set(sessionId: string, draft: ComposerDraft): void
  clear(sessionId: string): void
  /** Move a local draft into its durable owner, preserving an existing draft. */
  adopt(pendingKey: string, sessionId: string): void
  hasDraft(sessionId: string): boolean
  snapshot(): DraftCacheSnapshot
  readonly questions: QuestionDraftNamespace
}

const EMPTY_DRAFT: ComposerDraft = { text: "", pastes: [], attachments: [] }

function hasDraftContent(draft: ComposerDraft): boolean {
  return draft.text.length > 0 || draft.pastes.length > 0 || draft.attachments.length > 0
}

function cloneDraft(draft: ComposerDraft): ComposerDraft {
  return { text: draft.text, pastes: [...draft.pastes], attachments: [...draft.attachments], ...(draft.caret === undefined ? {} : { caret: draft.caret }) }
}

function cloneQuestionDraft(draft: QuestionFormDraft): QuestionFormDraft {
  return {
    tab: draft.tab,
    cursor: draft.cursor,
    answers: draft.answers.map((answer) => ({ picked: [...answer.picked], freeformPicked: answer.freeformPicked })),
    editorText: draft.editorText.map((row) => [...row]),
  }
}

export function createDraftCache(seed?: DraftCacheSnapshot): DraftCache {
  const drafts = new Map<string, ComposerDraft>(Object.entries(seed?.drafts ?? {}).map(([key, draft]) => [key, cloneDraft(draft)]))
  const questionDrafts = new Map<string, Map<string, QuestionFormDraft>>(Object.entries(seed?.questionDrafts ?? {}).map(([sessionId, forms]) => [
    sessionId,
    new Map(Object.entries(forms).map(([toolUseId, form]) => [toolUseId, cloneQuestionDraft(form)])),
  ]))

  return {
    get: (sessionId) => drafts.get(sessionId) ?? EMPTY_DRAFT,
    set: (sessionId, draft) => {
      if (hasDraftContent(draft)) drafts.set(sessionId, cloneDraft(draft))
      else drafts.delete(sessionId)
    },
    clear: (sessionId) => { drafts.delete(sessionId) },
    adopt: (pendingKey, sessionId) => {
      const pending = drafts.get(pendingKey)
      if (pending) drafts.set(sessionId, mergeComposerDrafts(drafts.get(sessionId) ?? EMPTY_DRAFT, pending))
      drafts.delete(pendingKey)
    },
    hasDraft: (sessionId) => hasDraftContent(drafts.get(sessionId) ?? EMPTY_DRAFT),
    snapshot: () => ({
      drafts: Object.fromEntries([...drafts].map(([key, draft]) => [key, cloneDraft(draft)])),
      questionDrafts: Object.fromEntries([...questionDrafts].map(([sessionId, forms]) => [
        sessionId,
        Object.fromEntries([...forms].map(([toolUseId, form]) => [toolUseId, cloneQuestionDraft(form)])),
      ])),
    }),
    questions: {
      get: (sessionId, toolUseId) => {
        const draft = questionDrafts.get(sessionId)?.get(toolUseId)
        return draft ? cloneQuestionDraft(draft) : undefined
      },
      set: (sessionId, toolUseId, draft) => {
        const sessionDrafts = questionDrafts.get(sessionId) ?? new Map<string, QuestionFormDraft>()
        sessionDrafts.set(toolUseId, cloneQuestionDraft(draft))
        questionDrafts.set(sessionId, sessionDrafts)
      },
      clear: clearQuestion,
      moveToComposer: (sessionId, toolUseId) => {
        const text = (questionDrafts.get(sessionId)?.get(toolUseId)?.editorText ?? []).flat().map((field) => field.trim()).filter(Boolean).join("\n\n")
        clearQuestion(sessionId, toolUseId)
        if (!text) return false
        drafts.set(sessionId, mergeComposerDrafts(drafts.get(sessionId) ?? EMPTY_DRAFT, { text, pastes: [], attachments: [] }))
        return true
      },
    },
  }

  function clearQuestion(sessionId: string, toolUseId: string): void {
    const sessionDrafts = questionDrafts.get(sessionId)
    if (!sessionDrafts) return
    sessionDrafts.delete(toolUseId)
    if (sessionDrafts.size === 0) questionDrafts.delete(sessionId)
  }
}
