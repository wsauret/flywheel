/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { createRoot, createSignal, For, type Accessor, type JSX } from "solid-js"
import type { QuestionBlock } from "../../../../../src/infra/output-blocks.js"
import type { FrontendOutputBlock } from "../../../../../src/protocol/app-service-types.js"
import { createChatSubmissions } from "../../../../../src/protocol/client/chat-submissions.js"
import { moduleDomainReader } from "../../../../../src/protocol/client/module-domain.js"
import { leadProtocol, type LeadRow, type LeadChatsView, type LeadRowState } from "../../../../../src/protocol/modules/lead.js"
import { ThemeProvider } from "../../../../../src/tui/context/theme.js"
import { TickPoolProvider } from "../../../../../src/tui/context/tick-pool-context.js"
import { LeadStrip } from "../../../../../src/tui/modules/lead/strip.js"
import type { TuiStripKeyEvent } from "../../../../../src/tui/tui-module.js"
import { createOverlayLayers, type OverlayLayers } from "../../../../../src/tui/components/modal-stack.js"
import { createDraftCache } from "../../../../../src/tui/hooks/create-draft-cache.js"
import { createLeadClient } from "../../../../../src/tui/modules/lead/client.js"
import type { LeadChatViewerHost } from "../../../../../src/tui/modules/lead/chat-viewer.js"
import type { TuiModuleClientHost } from "../../../../../src/tui/tui-module-client.js"
import { runtimeDispatch, runtimeQuery } from "../../../../helpers/runtime-dispatch.js"
import { heightEstimatesFromBlocks } from "../../../../../src/tui/hooks/output-height-estimates.js"
import { transcriptOf } from "../../_output-window-transcript.js"
import { childBodyProps, viewerSurface } from "../../components/_child-session-viewer-fixtures.js"

export const LEAD_ID = "lead-1"

/** A row as the lead's domain publishes it, five minutes old. */
export function leadRow(sessionId: string, state: LeadRowState, over: Partial<LeadRow> = {}): LeadRow {
  const since = Date.now() - 5 * 60_000
  return {
    sessionId, state, status: `Status of ${sessionId}`, since,
    ...(state === "question" || state === "failed" || state === "cut" ? { waitingSince: since } : {}),
    ...(state === "result" ? { result: { entryId: `${sessionId}-final` } } : {}),
    ...(state === "failed" || state === "cut" ? { ended: { entryId: `${sessionId}-end` } } : {}),
    ...over,
  }
}

export function choiceQuestion(toolUseId: string): QuestionBlock {
  return { kind: "question", toolUseId, questions: [{ question: "Which provider?", choices: [{ kind: "option", choiceId: "a", label: "Alpha" }, { kind: "freeform", label: "Other" }], multiSelect: false }], timestamp: 1 }
}

/** The host capabilities the chat viewer uses beyond the client and the
 *  toasts, each recording what it was asked. */
export function viewerHost(input: { readonly transcripts?: { readonly [sessionId: string]: readonly FrontendOutputBlock[] }; readonly titles?: { readonly [sessionId: string]: string }; readonly view?: Accessor<LeadChatsView>; readonly overlay?: OverlayLayers } = {}) {
  const overlay = input.overlay ?? createOverlayLayers()
  const [questions, setQuestions] = createSignal<{ readonly [sessionId: string]: QuestionBlock }>({})
  const sent: string[] = []
  // Each chat that the viewer showed, and how its view ended.
  const shows: string[] = []
  let gate: Promise<void> = Promise.resolve()
  /** Holds every later send until the returned release runs. */
  const holdSends = (): (() => void) => {
    let release = (): void => {}
    gate = new Promise((resolve) => { release = resolve })
    return () => { gate = Promise.resolve(); release() }
  }
  // The terminal's own submissions owner, so a message reaches the runtime as the shell sends it.
  const submissions = createChatSubmissions({ lanes: { onLane: () => () => {} }, dispatch: async (sessionId, message) => {
    await gate
    sent.push(`session.send ${sessionId} ${message.text}`)
    return { ok: true }
  } })
  const host = {
    navigateSession: async (sessionId: string) => { sent.push(`navigate ${sessionId}`) },
    dispatchCommand: async () => false,
    viewerLayer: overlay.viewer,
    sessionTitles: (sessionId: string) => ({ id: sessionId, title: input.titles?.[sessionId] ?? `Chat ${sessionId}`, shortTitle: "Short" }),
    question: (sessionId: string) => questions()[sessionId],
    answerQuestion: async (sessionId: string, toolUseId: string) => { sent.push(`question.answer ${sessionId} ${toolUseId}`); return true },
    cancelQuestion: async (sessionId: string, toolUseId: string) => { sent.push(`question.cancel ${sessionId} ${toolUseId}`); return true },
    questionDrafts: createDraftCache().questions,
    showSession: (sessionId: string) => {
      shows.push(`show ${sessionId}`)
      return (toTab?: boolean) => { shows.push(`${toTab ? "to tab" : "end"} ${sessionId}`) }
    },
    viewer: () => ({
      ...childBodyProps(),
      appService: { dispatch: runtimeDispatch({}), query: runtimeQuery({}) },
      submissions: { send: submissions.send, recallQueued: submissions.recallQueued },
      compactionThreshold: () => undefined,
      // The shell's module slots: the lead's count on every composer border.
      composerStatus: () => leadProtocol.composer.status(moduleDomainReader((domain) => domain.domain === "leadChats" ? input.view?.() : undefined)),
      createSurface: (sessionId: () => string | undefined) => {
        const id = sessionId() ?? ""
        const blocks = input.transcripts?.[id] ?? []
        const transcript = transcriptOf(blocks)
        // The store's own estimates, so a place by block index lands where it would in the product.
        const snapshot = transcript.visibleRange()
        const estimated = snapshot && { ...snapshot, heightEstimates: heightEstimatesFromBlocks(blocks, 0, false) }
        return viewerSurface("chat", { sessionId, transcript: { ...transcript, visibleRange: () => estimated } })
      },
    }),
  } satisfies Omit<LeadChatViewerHost, "client" | "showToast"> & Pick<TuiModuleClientHost, "sessionTitles">
  return { host, overlay, setQuestions, sent, shows, holdSends }
}

/** The lead client over a scripted designation of `LEAD_ID` and scripted rows
 *  (`view`), with every mutation the list and the viewer send recorded in `sent`. */
export function leadHarness(rows: readonly LeadRow[], transcripts: { readonly [sessionId: string]: readonly FrontendOutputBlock[] } = {}, overlay?: OverlayLayers, titles?: { readonly [sessionId: string]: string }) {
  const [view, setView] = createSignal<LeadChatsView>({ rows })
  const viewer = viewerHost({ transcripts, view, ...(overlay ? { overlay } : {}), ...(titles ? { titles } : {}) })
  const dispatch = runtimeDispatch({
    "lead.result.mark_read": async (command) => { viewer.sent.push(`lead.result.mark_read ${command.sessionId} ${command.entryId}`); return { ok: true } },
    "lead.chat.mark_seen": async (command) => { viewer.sent.push(`lead.chat.mark_seen ${command.sessionId} ${command.state} ${command.entryId}`); return { ok: true } },
  })
  const built = createRoot((dispose) => ({
    dispose,
    client: createLeadClient({ ...viewer.host, domains: { lead: { scope: "workspace", view: () => ({ leadSessionId: LEAD_ID, dismissed: false }) }, leadChats: { scope: "workspace", view } }, client: { dispatch, query: runtimeQuery({}) }, dialog: viewer.overlay.dialog, showToast: () => {} }),
  }))
  /** The open viewers, as the shell's overlay renders them. */
  const Viewers = (): JSX.Element => <For each={viewer.overlay.viewer.stack}>{(entry) => typeof entry.element === "function" ? entry.element() : entry.element}</For>
  return { ...built, ...viewer, view, setView, Viewers }
}

/** The strip on a screen, with the kernel's key claim in its simplest form: a
 *  key reaches the strip's handler, and the focus is one signal. `viewerKey`
 *  sends a key to the top viewer, as the shell routes keys while one shows. */
export async function mountStrip(rows: readonly LeadRow[], options: {
  readonly width?: number
  readonly height?: number
  readonly sessionId?: string
  readonly titles?: { readonly [sessionId: string]: string }
  readonly transcripts?: { readonly [sessionId: string]: readonly FrontendOutputBlock[] }
} = {}) {
  const lead = leadHarness(rows, options.transcripts, undefined, options.titles)
  const [focused, setFocused] = createSignal(false)
  const [composerEmpty, setComposerEmpty] = createSignal(true)
  const [sessionId, setSessionId] = createSignal(options.sessionId ?? LEAD_ID)
  let handler: ((event: TuiStripKeyEvent) => boolean) | undefined
  let chords: readonly string[] = []
  const width = options.width ?? 80
  const rendered = await testRender(() => <ThemeProvider mode="dark"><TickPoolProvider>
    {lead.client.provide?.(() => <box flexDirection="column">
      <LeadStrip sessionId={sessionId()} read={moduleDomainReader(() => undefined)} width={() => width} openSurface={() => {}} composer={{ empty: composerEmpty }}
        keys={{ claim: (input) => { handler = input.onKey; chords = input.chords; return { focused, setFocused } } }} />
      <lead.Viewers />
    </box>)}
  </TickPoolProvider></ThemeProvider>, { width, height: options.height ?? 24 })
  const settle = async (): Promise<void> => {
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await rendered.renderOnce()
    }
  }
  const key = async (name: string, modifiers: Omit<TuiStripKeyEvent, "name"> = {}): Promise<boolean> => {
    const taken = handler?.({ name, ...modifiers }) ?? false
    await settle()
    return taken
  }
  const viewerKey = async (name: string, modifiers: { readonly ctrl?: boolean; readonly shift?: boolean } = {}): Promise<void> => {
    lead.overlay.viewer.input({ name, sequence: name.length === 1 ? name : undefined, ...modifiers, preventDefault: () => {} })
    await settle()
  }
  await rendered.renderOnce()
  const lines = () => rendered.captureCharFrame().split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0)
  return { ...lead, rendered, focused, setComposerEmpty, setSessionId, key, viewerKey, lines, chords: () => chords, dispose: () => { rendered.renderer.destroy(); lead.dispose() } }
}
