import { normalizeChatInput, type ChatInputLike } from "../../../infra/substrate/events/chat-input.js"
import { attachmentMarker, nextAttachmentOrdinal } from "../../../protocol/client/chat/attachments.js"
import { draftMarkers, mergeComposerDrafts, replaceDraftMarker, type ComposerDraft } from "./composer-draft.js"
import type { QuestionFormDraft, QuestionFormDrafts } from "./question-dock-form.js"

/** The prompt draft while no session or pending tab owns it. */
export const UNBOUND_COMPOSER_DRAFT = "composer:unbound"

/** The question form drafts of the cache, with the composer handoff that
 *  only the cache can do because it also owns the prompt drafts. */
interface QuestionDraftNamespace extends QuestionFormDrafts {
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

/** Moves ready and pending attachments together when a new chat adopts an existing session. */
export function adoptDraftAttachments(
  cache: DraftCache,
  from: string,
  to: string,
  adoptPending: (from: string, to: string, occupied: readonly string[]) => ReadonlyMap<string, string>,
): void {
  const source = cache.get(from)
  const reserved = draftMarkers(cache.get(to))
  const next = nextAttachmentOrdinal(reserved)
  const occupied = [...reserved, ...source.attachments.map((_, index) => attachmentMarker("image", next + index))]
  let renamed = source
  for (const [oldMarker, newMarker] of adoptPending(from, to, occupied)) renamed = replaceDraftMarker(renamed, oldMarker, newMarker)
  cache.set(from, renamed)
  cache.adopt(from, to)
}

/** Merges a chat input that left the prompt back into its owner's cached
 *  draft, after anything the person typed there since. */
export function mergeInputIntoDraft(cache: DraftCache, ownerId: string, input: ChatInputLike): void {
  const normalized = normalizeChatInput(input)
  cache.set(ownerId, mergeComposerDrafts(cache.get(ownerId), { text: normalized.text, pastes: [], attachments: normalized.attachments ?? [] }))
}
