/** @jsxImportSource @opentui/solid */
import { createRoot, createSignal, For, type JSX } from "solid-js"
import type { QuestionBlock } from "../../../../../src/infra/output-blocks.js"
import type { FrontendOutputBlock } from "../../../../../src/protocol/app-service-types.js"
import type { LeadRow, LeadRowState, LeadView } from "../../../../../src/protocol/modules/lead.js"
import { createOverlayLayers } from "../../../../../src/tui/components/modal-stack.js"
import { createDraftCache } from "../../../../../src/tui/hooks/create-draft-cache.js"
import { createLeadClient } from "../../../../../src/tui/modules/lead/client.js"
import type { LeadReaderHost } from "../../../../../src/tui/modules/lead/reader.js"
import { runtimeDispatch, runtimeQuery } from "../../../../helpers/runtime-dispatch.js"
import { heightEstimatesFromBlocks } from "../../../../../src/tui/hooks/output-height-estimates.js"
import { transcriptOf } from "../../_output-window-transcript.js"
import { childBodyProps, viewerSurface } from "../../components/_child-session-viewer-fixtures.js"

export const LEAD_ID = "lead-1"

/** A row as the lead's domain publishes it, five minutes old. */
export function leadRow(sessionId: string, state: LeadRowState, over: Partial<LeadRow> = {}): LeadRow {
  const since = Date.now() - 5 * 60_000
  return {
    sessionId, state, update: `Update from ${sessionId}`, since, request: { entryId: `${sessionId}-request`, text: `Request to ${sessionId}` }, updates: [],
    ...(state === "question" || state === "failed" || state === "cut" ? { waitingSince: since } : {}),
    ...(state === "question" ? { question: { toolUseId: `${sessionId}-ask`, context: `Context of ${sessionId}` } } : {}),
    ...(state === "result" ? { result: { entryId: `${sessionId}-final` } } : {}),
    ...(state === "failed" ? { failure: { entryId: null } } : {}),
    ...over,
  }
}

export function choiceQuestion(toolUseId: string): QuestionBlock {
  return { kind: "question", toolUseId, questions: [{ question: "Which provider?", choices: [{ kind: "option", choiceId: "a", label: "Alpha" }, { kind: "freeform", label: "Other" }], multiSelect: false }], timestamp: 1 }
}

/** The host capabilities the reader uses beyond the client and the toasts,
 *  each recording what it was asked. */
export function readerHost(input: { readonly transcripts?: { readonly [sessionId: string]: readonly FrontendOutputBlock[] } } = {}) {
  const overlay = createOverlayLayers()
  const [questions, setQuestions] = createSignal<{ readonly [sessionId: string]: QuestionBlock }>({})
  const sent: string[] = []
  const loadedAround: string[] = []
  const host = {
    viewerLayer: overlay.viewer,
    title: (sessionId: string) => `Chat ${sessionId}`,
    question: (sessionId: string) => questions()[sessionId],
    answerQuestion: async (sessionId: string, toolUseId: string) => { sent.push(`question.answer ${sessionId} ${toolUseId}`); return true },
    cancelQuestion: async (sessionId: string, toolUseId: string) => { sent.push(`question.cancel ${sessionId} ${toolUseId}`); return true },
    questionDrafts: createDraftCache().questions,
    viewer: () => ({
      ...childBodyProps(),
      createSurface: (sessionId: () => string | undefined) => {
        const id = sessionId() ?? ""
        const blocks = input.transcripts?.[id] ?? []
        const transcript = transcriptOf(blocks)
        // The store's own estimates, so a place by block index lands where it would in the product.
        const snapshot = transcript.visibleRange()
        const estimated = snapshot && { ...snapshot, heightEstimates: heightEstimatesFromBlocks(blocks, 0, false) }
        return viewerSurface("chat", { sessionId, transcript: { ...transcript, visibleRange: () => estimated, loadAround: async (entryId: string) => { loadedAround.push(`${id} ${entryId}`) } } })
      },
    }),
  } satisfies Omit<LeadReaderHost, "client" | "showToast"> & { readonly title: (sessionId: string) => string }
  return { host, overlay, setQuestions, sent, loadedAround }
}

/** The lead client over a scripted lead view, with every mutation the list
 *  and the reader send recorded in `sent`. */
export function leadHarness(rows: readonly LeadRow[], transcripts: { readonly [sessionId: string]: readonly FrontendOutputBlock[] } = {}) {
  const [view, setView] = createSignal<LeadView>({ leadSessionId: LEAD_ID, dismissed: false, rows })
  const reader = readerHost({ transcripts })
  const dispatch = runtimeDispatch({
    "lead.result.mark_read": async (command) => { reader.sent.push(`lead.result.mark_read ${command.sessionId} ${command.entryId}`); return { ok: true } },
  })
  const built = createRoot((dispose) => ({
    dispose,
    client: createLeadClient({ ...reader.host, domains: { lead: { scope: "workspace", view } }, client: { dispatch, query: runtimeQuery({}) }, dialog: reader.overlay.dialog, showToast: () => {} }),
  }))
  /** The open viewers, as the shell's overlay renders them. */
  const Viewers = (): JSX.Element => <For each={reader.overlay.viewer.stack}>{(entry) => typeof entry.element === "function" ? entry.element() : entry.element}</For>
  return { ...built, ...reader, view, setView, Viewers }
}
