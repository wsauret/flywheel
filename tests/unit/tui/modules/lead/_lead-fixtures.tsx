/** @jsxImportSource @opentui/solid */
import { testRender, useKeyboard } from "@opentui/solid"
import { createRoot, createSignal, For, type Accessor, type JSX } from "solid-js"
import type { QuestionBlock } from "../../../../../src/infra/output-blocks.js"
import type { FrontendOutputBlock } from "../../../../../src/protocol/app-service-types.js"
import { createChatSubmissions } from "../../../../../src/protocol/client/chat-submissions.js"
import { moduleDomainReader } from "../../../../../src/protocol/client/module-domain.js"
import { leadProtocol, type LeadRow, type LeadChatsView, type LeadQuestionOutcome, type LeadRowState } from "../../../../../src/protocol/modules/lead.js"
import { ThemeProvider } from "../../../../../src/tui/context/theme.js"
import { TickPoolProvider } from "../../../../../src/tui/context/tick-pool-context.js"
import { LeadStrip } from "../../../../../src/tui/modules/lead/strip.js"
import type { TuiStripKeyEvent } from "../../../../../src/tui/tui-module.js"
import { createOverlayLayers, type OverlayLayers } from "../../../../../src/tui/components/modal-stack.js"
import { createLeadClient } from "../../../../../src/tui/modules/lead/client.js"
import type { LeadChatViewerHost } from "../../../../../src/tui/modules/lead/chat-viewer.js"
import type { TuiModuleClientHost } from "../../../../../src/tui/tui-module-client.js"
import { runtimeDispatch, runtimeQuery } from "../../../../helpers/runtime-dispatch.js"
import { chatPaneHost, chatSurface } from "../../components/_chat-pane-fixtures.js"
import type { ChatPaneHost } from "../../../../../src/tui/components/chat-pane.js"
import { ModalProvider } from "../../../../../src/tui/components/modal.js"
import { QuestionInputProvider } from "../../../../../src/tui/components/question-input.js"
import { ToastProvider } from "../../../../../src/tui/context/toast.js"
import type { SessionSurface } from "../../../../../src/tui/hooks/create-session-surface.js"
import { createDraftCache } from "../../../../../src/tui/hooks/create-draft-cache.js"
import type { LeadQuestionHost } from "../../../../../src/tui/modules/lead/question-widget.js"

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

/** What the viewer shows of each chat beyond its transcript: its title, its short title that its tab shows, which a
 *  chat has only when named, and its surface's own readings, such as its statistics. */
interface ViewerChats {
  readonly titles?: { readonly [sessionId: string]: string }
  readonly shortTitles?: { readonly [sessionId: string]: string }
  readonly surfaces?: { readonly [sessionId: string]: Partial<SessionSurface> }
}

/** The host capabilities the chat viewer uses beyond the client and the
 *  toasts, each recording what it was asked. */
export function viewerHost(input: { readonly transcripts?: { readonly [sessionId: string]: readonly FrontendOutputBlock[] }; readonly view?: Accessor<LeadChatsView>; readonly overlay?: OverlayLayers } & ViewerChats = {}) {
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
  // The shell's chat pane host: the production command routing sends through the terminal's submissions owner,
  // and each chat's question and the lead's count on every composer border come from the scripted state.
  const shellPane = chatPaneHost({
    transcripts: input.transcripts ?? {},
    send: async (sessionId, message) => { await submissions.send(sessionId, message) },
    slashCatalog: [{ id: "status", title: "/status", value: "/status", description: "Show status" }],
    projectFiles: [{ path: "src/shell.tsx", directory: false }],
    over: {
      // The chat's own controls, such as the Interrupt that Escape sends while a turn runs, dispatch through this client.
      client: { dispatch: runtimeDispatch({ "chat.interrupt": async (command) => { sent.push(`chat.interrupt ${command.sessionId}`); return { ok: true } } }), query: runtimeQuery({}) },
      createSurface: (sessionId) => {
        const id = sessionId() ?? ""
        return chatSurface(id, input.transcripts?.[id] ?? [], { pendingQuestion: () => questions()[id], ...input.surfaces?.[id] })
      },
      compact: async (sessionId) => { sent.push(`chat.compact ${sessionId}`); return true },
      sessionRows: () => ({
        composerStatus: () => leadProtocol.composer.status(moduleDomainReader((domain) => domain.domain === "leadChats" ? input.view?.() : undefined)),
        introRows: () => [],
      }),
    },
  })
  const pane: ChatPaneHost = { ...shellPane, composer: {
    ...shellPane.composer,
    onAnswerQuestion: async (sessionId, toolUseId) => { sent.push(`question.answer ${sessionId} ${toolUseId}`); return true },
    onCancelQuestion: async (sessionId, toolUseId) => { sent.push(`question.cancel ${sessionId} ${toolUseId}`); return true },
  } }
  const host = {
    navigateSession: async (sessionId: string) => { sent.push(`navigate ${sessionId}`) },
    viewerLayer: overlay.viewer,
    sessionTitles: (sessionId: string) => {
      const title = input.titles?.[sessionId] ?? `Chat ${sessionId}`
      const shortTitle = input.shortTitles?.[sessionId]
      return { id: sessionId, title, ...(shortTitle === undefined ? {} : { shortTitle }) }
    },
    showSession: (sessionId: string) => {
      shows.push(`show ${sessionId}`)
      return (toTab?: boolean) => { shows.push(`${toTab ? "to tab" : "end"} ${sessionId}`) }
    },
    chatPane: () => pane,
    closeChat: async (sessionId: string) => { sent.push(`session.close ${sessionId}`) },
    question: (sessionId: string) => questions()[sessionId],
    answerQuestion: pane.composer.onAnswerQuestion,
    cancelQuestion: pane.composer.onCancelQuestion,
    questionDrafts: createDraftCache().questions,
  } satisfies Omit<LeadChatViewerHost, "client" | "showToast"> & Omit<LeadQuestionHost, "client"> & Pick<TuiModuleClientHost, "sessionTitles" | "closeChat">
  return { host, overlay, setQuestions, sent, shows, holdSends }
}

/** The lead client over a scripted designation of `LEAD_ID` and scripted rows
 *  (`view`), with every mutation the list and the viewer send recorded in `sent`. */
export function leadHarness(rows: readonly LeadRow[], transcripts: { readonly [sessionId: string]: readonly FrontendOutputBlock[] } = {}, overlay?: OverlayLayers, chats: ViewerChats = {}) {
  const [view, setView] = createSignal<LeadChatsView>({ rows })
  // Where each question stands, as `lead.question` answers it, keyed `<sessionId> <toolUseId>`. Each read is recorded
  // in `questionReads`, and a key in `failingReads` fails that many reads before it answers.
  const outcomes = new Map<string, LeadQuestionOutcome>()
  const questionReads: string[] = []
  const failingReads = new Map<string, number>()
  const readQuestion = ({ sessionId, toolUseId }: { readonly sessionId: string; readonly toolUseId: string }): LeadQuestionOutcome => {
    const key = `${sessionId} ${toolUseId}`
    questionReads.push(key)
    const failures = failingReads.get(key) ?? 0
    if (failures > 0) {
      failingReads.set(key, failures - 1)
      throw new Error("the read failed")
    }
    return outcomes.get(key) ?? { state: "unknown" }
  }
  const viewer = viewerHost({ transcripts, view, ...(overlay ? { overlay } : {}), ...chats })
  const dispatch = runtimeDispatch({
    "lead.result.mark_read": async (command) => { viewer.sent.push(`lead.result.mark_read ${command.sessionId} ${command.entryId}`); return { ok: true } },
    "lead.chat.mark_seen": async (command) => { viewer.sent.push(`lead.chat.mark_seen ${command.sessionId} ${command.state} ${command.entryId}`); return { ok: true } },
  })
  const built = createRoot((dispose) => ({
    dispose,
    client: createLeadClient({ ...viewer.host, domains: { lead: { scope: "workspace", view: () => ({ leadSessionId: LEAD_ID, dismissed: false }) }, leadChats: { scope: "workspace", view } }, client: { dispatch, query: runtimeQuery({ "lead.question": readQuestion }) }, dialog: viewer.overlay.dialog, showToast: () => {} }),
  }))
  /** The open viewers, as the shell's overlay renders them. */
  const Viewers = (): JSX.Element => <For each={viewer.overlay.viewer.stack}>{(entry) => typeof entry.element === "function" ? entry.element() : entry.element}</For>
  return { ...built, ...viewer, view, setView, Viewers, outcomes, questionReads, failingReads }
}

/** The shell's keyboard listener, in its first step: an open overlay takes the key. */
function OverlayKeys(props: { readonly overlay: OverlayLayers }): JSX.Element {
  useKeyboard((event) => { props.overlay.input(event) })
  return null
}

/** The strip on a screen, with the kernel's key claim in its simplest form: a
 *  key reaches the strip's handler, and the focus is one signal. `viewerKey`
 *  sends a key to the top viewer, as the shell routes keys while one shows. */
export async function mountStrip(rows: readonly LeadRow[], options: {
  readonly width?: number
  readonly height?: number
  readonly sessionId?: string
  readonly transcripts?: { readonly [sessionId: string]: readonly FrontendOutputBlock[] }
} & ViewerChats = {}) {
  const lead = leadHarness(rows, options.transcripts, undefined, { ...(options.titles ? { titles: options.titles } : {}), ...(options.shortTitles ? { shortTitles: options.shortTitles } : {}), ...(options.surfaces ? { surfaces: options.surfaces } : {}) })
  const [focused, setFocused] = createSignal(false)
  const [composerEmpty, setComposerEmpty] = createSignal(true)
  const [sessionId, setSessionId] = createSignal(options.sessionId ?? LEAD_ID)
  let handler: ((event: TuiStripKeyEvent) => boolean) | undefined
  let chords: readonly string[] = []
  const width = options.width ?? 80
  // The shell's modal provider, under which a viewer's own dialogs, such as a chat's context reading, open.
  const rendered = await testRender(() => <ToastProvider><ThemeProvider mode="dark"><QuestionInputProvider><ModalProvider clipboard={{ copy: async () => {}, readImage: async () => null }}><TickPoolProvider>
    <OverlayKeys overlay={lead.overlay} />
    {lead.client.provide?.(() => <box flexDirection="column">
      <LeadStrip sessionId={sessionId()} read={moduleDomainReader(() => undefined)} width={() => width} openSurface={() => {}} composer={{ empty: composerEmpty }}
        keys={{ claim: (input) => { handler = input.onKey; chords = input.chords; return { focused, setFocused } } }} />
      <lead.Viewers />
    </box>)}
  </TickPoolProvider></ModalProvider></QuestionInputProvider></ThemeProvider></ToastProvider>, { width, height: options.height ?? 24 })
  const settle = async (): Promise<void> => {
    // A send goes through the command routing and the submissions owner, which take a few turns of the event loop.
    for (let frame = 0; frame < 5; frame += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
      await rendered.renderOnce()
    }
  }
  const key = async (name: string, modifiers: Omit<TuiStripKeyEvent, "name"> = {}): Promise<boolean> => {
    const taken = handler?.({ name, ...modifiers }) ?? false
    await settle()
    return taken
  }
  // A key reaches the renderer as the terminal's parser hands it on: the shell's keyboard listener offers it to the
  // top viewer, and a key that no handler prevents reaches the focused composer.
  const pressKey = (name: string, modifiers: { readonly ctrl?: boolean; readonly shift?: boolean } = {}): void => {
    const sequence = name === "space" ? " " : name.length === 1 ? name : ""
    rendered.renderer.keyInput.processParsedKey({
      name, ctrl: modifiers.ctrl ?? false, shift: modifiers.shift ?? false, meta: false, option: false, number: false,
      sequence, raw: sequence, eventType: "press", source: "raw",
    })
  }
  const viewerKey = async (name: string, modifiers: { readonly ctrl?: boolean; readonly shift?: boolean } = {}): Promise<void> => {
    pressKey(name, modifiers)
    await settle()
  }
  await rendered.renderOnce()
  const lines = () => rendered.captureCharFrame().split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0)
  return { ...lead, rendered, focused, setComposerEmpty, setSessionId, key, viewerKey, pressKey, settle, lines, chords: () => chords, dispose: () => { rendered.renderer.destroy(); lead.dispose() } }
}
