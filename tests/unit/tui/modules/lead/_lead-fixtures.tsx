/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { createRoot, createSignal, For, type Accessor, type JSX } from "solid-js"
import type { QuestionBlock } from "../../../../../src/infra/output-blocks.js"
import type { FrontendOutputBlock } from "../../../../../src/protocol/app-service-types.js"
import { createChatSubmissions } from "../../../../../src/protocol/client/chat-submissions.js"
import { moduleDomainReader } from "../../../../../src/protocol/client/module-domain.js"
import { leadCountLabel, type LeadRow, type LeadRowState, type LeadView } from "../../../../../src/protocol/modules/lead.js"
import type { SessionChangesResult } from "../../../../../src/protocol/session-changes-protocol-types.js"
import { ThemeProvider } from "../../../../../src/tui/context/theme.js"
import { TickPoolProvider } from "../../../../../src/tui/context/tick-pool-context.js"
import { LeadStrip } from "../../../../../src/tui/modules/lead/strip.js"
import type { TuiStripKeyEvent } from "../../../../../src/tui/tui-module.js"
import { createOverlayLayers, type OverlayLayers } from "../../../../../src/tui/components/modal-stack.js"
import { createDraftCache } from "../../../../../src/tui/hooks/create-draft-cache.js"
import { createLeadClient } from "../../../../../src/tui/modules/lead/client.js"
import type { LeadChatViewerHost } from "../../../../../src/tui/modules/lead/chat-viewer.js"
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
export function readerHost(input: { readonly transcripts?: { readonly [sessionId: string]: readonly FrontendOutputBlock[] }; readonly view?: Accessor<LeadView>; readonly overlay?: OverlayLayers } = {}) {
  const overlay = input.overlay ?? createOverlayLayers()
  const [questions, setQuestions] = createSignal<{ readonly [sessionId: string]: QuestionBlock }>({})
  const sent: string[] = []
  const loadedAround: string[] = []
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
    title: (sessionId: string) => `Chat ${sessionId}`,
    question: (sessionId: string) => questions()[sessionId],
    answerQuestion: async (sessionId: string, toolUseId: string) => { sent.push(`question.answer ${sessionId} ${toolUseId}`); return true },
    cancelQuestion: async (sessionId: string, toolUseId: string) => { sent.push(`question.cancel ${sessionId} ${toolUseId}`); return true },
    questionDrafts: createDraftCache().questions,
    viewer: () => ({
      ...childBodyProps(),
      appService: { dispatch: runtimeDispatch({}), query: runtimeQuery({}) },
      submissions: { send: submissions.send, recallQueued: submissions.recallQueued },
      compactionThreshold: () => undefined,
      // The shell's module slots: the lead's count on every composer border.
      composerStatus: () => { const label = leadCountLabel(input.view?.()); return label === undefined ? [] : [{ id: "lead", text: label, tone: "warning" as const }] },
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
  } satisfies Omit<LeadReaderHost & LeadChatViewerHost, "client" | "showToast"> & { readonly title: (sessionId: string) => string }
  return { host, overlay, setQuestions, sent, loadedAround, holdSends }
}

/** The lead client over a scripted lead view, with every mutation the list
 *  and the reader send recorded in `sent`. */
export function leadHarness(rows: readonly LeadRow[], transcripts: { readonly [sessionId: string]: readonly FrontendOutputBlock[] } = {}, changes: { readonly [sessionId: string]: readonly string[] } = {}, overlay?: OverlayLayers) {
  const [view, setView] = createSignal<LeadView>({ leadSessionId: LEAD_ID, dismissed: false, rows })
  const reader = readerHost({ transcripts, view, ...(overlay ? { overlay } : {}) })
  const dispatch = runtimeDispatch({
    "lead.result.mark_read": async (command) => { reader.sent.push(`lead.result.mark_read ${command.sessionId} ${command.entryId}`); return { ok: true } },
  })
  const built = createRoot((dispose) => ({
    dispose,
    client: createLeadClient({ ...reader.host, domains: { lead: { scope: "workspace", view } }, client: { dispatch, query: runtimeQuery({ sessionChanges: (query) => changedFiles(changes[query.sessionId] ?? [], query.maxFiles) }) }, dialog: reader.overlay.dialog, showToast: () => {} }),
  }))
  /** The open viewers, as the shell's overlay renders them. */
  const Viewers = (): JSX.Element => <For each={reader.overlay.viewer.stack}>{(entry) => typeof entry.element === "function" ? entry.element() : entry.element}</For>
  return { ...built, ...reader, view, setView, Viewers }
}

/** A first page of a session's changes under `/repo`, as the runtime answers it. */
function changedFiles(paths: readonly string[], maxFiles: number): SessionChangesResult {
  return {
    status: "ready", cursor: "0".repeat(64), offset: 0, nextOffset: paths.length > maxFiles ? maxFiles : null, totalFiles: paths.length, revision: 1, unknownFileMutationGaps: 0,
    executionCwd: "/repo", excludedFileCount: 0,
    files: paths.slice(0, maxFiles).map((path, index) => ({ fileId: `file:${index}`, path: `/repo/${path}`, change: "modified", editToken: { position: index, eventId: `edit-${index}` }, review: { status: "unviewed" }, writers: [] })),
  }
}

/** The strip on a screen, with the kernel's key claim in its simplest form: a
 *  key reaches the strip's handler, and the focus is one signal. `viewerKey`
 *  sends a key to the top viewer, as the shell routes keys while one shows. */
export async function mountStrip(rows: readonly LeadRow[], options: {
  readonly width?: number
  readonly height?: number
  readonly sessionId?: string
  readonly changes?: { readonly [sessionId: string]: readonly string[] }
  readonly transcripts?: { readonly [sessionId: string]: readonly FrontendOutputBlock[] }
} = {}) {
  const lead = leadHarness(rows, options.transcripts, options.changes)
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
