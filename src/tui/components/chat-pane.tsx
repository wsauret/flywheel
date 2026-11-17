/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js"
import type { RuntimeChatDefault, RuntimeClient } from "../../protocol/app-service-types.js"
import type { LocalChatSubmission, LocalRecall } from "../../protocol/client/chat-submissions.js"
import type { ChatInputLike } from "../../infra/chat-input.js"
import type { DiffColorMode } from "../../orchestration/config/schema.js"
import type { RoleAssignmentView } from "../../protocol/role-protocol-types.js"
import type { ChildCardStatus } from "../../protocol/client/session-controls.js"
import { OutputWindow, type OutputWindowCommand, type OutputWindowCommandType } from "../output-window/output-window.js"
import type { TranscriptLayoutSlot } from "../output-window/output-window-scroll.js"
import type { TranscriptSelectionDrag } from "../hooks/create-transcript-selection-drag.js"
import type { SessionChangesView } from "../hooks/create-session-changes.js"
import { sessionChangesPromptLabel } from "../../protocol/client/session-changes-copy.js"
import type { RowProcessControls } from "../output-blocks/stop-affordance.js"
import type { SessionIntroProps } from "../welcome-notice.js"
import { sessionSpinnerSource, type SessionSurface } from "../hooks/create-session-surface.js"
import type { ForegroundTarget } from "../hooks/shell-state.js"
import type { CommandsHook } from "../hooks/use-commands.js"
import type { BackgroundModalTarget } from "../hooks/use-background-modal.js"
import type { TranscriptInView } from "../hooks/transcript-in-view.js"
import type { ModuleSlots } from "../hooks/create-module-slots.js"
import { interruptOnEscape, type KeymapPane } from "../hooks/create-keyboard-handler.js"
import { createComposerBorderLayout, type DismissibleUpdateStatus } from "../hooks/create-composer-border-layout.js"
import { createComposerPopupKeySlot, type ComposerPopupKeySlot } from "../hooks/create-composer-popup-key-slot.js"
import { useSessionControls, type SessionControlsHook } from "../hooks/use-session-controls.js"
import { sessionModelLabel } from "../hooks/active-model-label.js"
import type { Keymap } from "../keymap/keymap.js"
import type { TuiFaultNotice } from "../tui-module.js"
import { Composer } from "./composer.js"
import type { ComposerHandle, ComposerProps } from "./composer-types.js"
import { createQuestionInputRegistry, type QuestionInputContext } from "./question-input.js"
import { RuntimeNotice } from "./runtime-notice.js"

export type PaneKeyEvent = Parameters<QuestionInputContext["input"]>[0]

/** The keys and the transcript commands of one mounted chat pane. The place
 *  that shows the pane owns it and routes keys to it: the shell for the tab
 *  in front, and a view over that tab for its own pane (`routeChatPaneKey`). */
export interface ChatPaneInput {
  /** The keys of the pane's question dock, which take each key first while it shows. */
  readonly questionInput: QuestionInputContext
  /** The keys that the pane's composer popups claim while one is open. */
  readonly promptPopup: ComposerPopupKeySlot
  /** The newest command to the pane's transcript. */
  readonly command: Accessor<OutputWindowCommand | undefined>
  /** Pages the pane's transcript. */
  output(command: OutputWindowCommandType): void
  /** Scrolls the pane's transcript to an entry and marks it. */
  land(entryId: string): void
}

/** `questionInput` is the shell's one question slot for the tab's pane; a
 *  view's pane takes keys through a registry of its own. */
export function createChatPaneInput(questionInput: QuestionInputContext = createQuestionInputRegistry()): ChatPaneInput {
  const [command, setCommand] = createSignal<OutputWindowCommand>()
  let id = 0
  return {
    questionInput,
    promptPopup: createComposerPopupKeySlot(),
    command,
    output: (type) => setCommand({ id: ++id, type }),
    land: (entryId) => setCommand({ id: ++id, type: "block", entryId }),
  }
}

/** What the shell lends every chat pane. A pane reads its own session through
 *  its surface and names no module. */
export interface ChatPaneHost {
  readonly client: Pick<RuntimeClient, "dispatch" | "query">
  readonly showToast: (opts: { message: string; variant: "info" | "warning" | "error" | "success"; duration?: number }) => void
  /** Gives a view's pane the contexts that the tab's pane has from the shell; a view mounts outside them. */
  readonly provide: (children: () => JSX.Element) => JSX.Element
  /** Creates the per-session source of a pane that a view shows, under the caller's owner. */
  readonly createSurface: (sessionId: Accessor<string | undefined>) => SessionSurface
  /** Follows the role and module readings of a session that a pane shows. */
  readonly follow: (sessionId: string) => void
  /** The runtime fault, which every pane shows above its composer while one holds. */
  readonly runtimeFault: Accessor<TuiFaultNotice | null>
  readonly update: DismissibleUpdateStatus
  readonly chordFor: Keymap["chordFor"]
  readonly activeSessionCount: Accessor<number>
  readonly sessionCount: Accessor<number>
  readonly chatDefault: Accessor<RuntimeChatDefault>
  /** Whether a session's tab hides the tab controls (`TuiFirstTab.hidesTabControls`). */
  readonly hidesTabControls: (sessionId: string | undefined) => boolean
  readonly roleView: (sessionId: string) => RoleAssignmentView | undefined
  readonly childStatus: (childSessionId: string, parentSessionId: string) => ChildCardStatus
  readonly ensureChildViews: (sessionIds: readonly string[]) => void
  readonly branch: (sessionId: string) => string | undefined
  /** Reads the changes of a session that a view shows, under the caller's owner. */
  readonly createChanges: (sessionId: Accessor<string | undefined>) => Accessor<SessionChangesView | undefined>
  /** Opens the review of the changes that a pane reads. */
  readonly openChanges: (changes: Accessor<SessionChangesView | undefined>) => void
  readonly layoutSlot: (sessionId: string) => TranscriptLayoutSlot
  readonly pendingSubmissions: (sessionId: string) => readonly LocalChatSubmission[]
  readonly processControls: (sessionId: string) => RowProcessControls
  readonly showThinking: Accessor<boolean>
  readonly diffColors: Accessor<DiffColorMode>
  /** The proactive compaction threshold that a chat's context reading measures against. */
  readonly compactionThreshold: Accessor<number | undefined>
  /** Compacts a chat's conversation, as the context control of a view's statistics line asks. */
  readonly compact: (sessionId: string) => Promise<boolean>
  readonly sessionIntro: Omit<SessionIntroProps, "branchName" | "sessionKind" | "modelLabel" | "availableWidth" | "moduleRows">
  readonly Strips: ModuleSlots["Strips"]
  readonly sessionRows: ModuleSlots["sessionRows"]
  /** True while a module strip under the tab's composer holds key focus. */
  readonly stripFocused: Accessor<boolean>
  readonly releaseStripFocus: () => void
  readonly composer: Pick<ComposerProps,
    "completableNames" | "dispatchableNames" | "projectFiles" | "promptAttachSlot" | "history" | "commandFrequency" | "clipboard"
    | "onAttachmentWarning" | "draftCache" | "onAnswerQuestion" | "onCancelQuestion" | "onOpenSessions" | "onModuleAction"
    | "onNew" | "onClose" | "onNextTab"> & { readonly slashCatalog: Accessor<ComposerProps["slashCatalog"]> }
  readonly submit: CommandsHook["handleComposerSubmit"]
  readonly recallLocal: (sessionId: string) => LocalRecall | null
  readonly recallQueued: (sessionId: string) => Promise<ChatInputLike | null>
  /** Opens the model and effort of a chat. */
  readonly openModel: (sessionId: string | undefined) => void
  readonly openBackground: (target: BackgroundModalTarget) => void
  readonly transcriptInView: Pick<TranscriptInView, "show">
  /** Follows the background index of a session that a view shows. Returns the end. */
  readonly followBackground: (sessionId: string) => () => void
  /** The keymap's part of a key for a view's pane (`createKeyboardHandler`'s `paneKey`). */
  readonly paneKey: (evt: PaneKeyEvent, pane: KeymapPane) => void
}

/** A pane that a view over the tab in front shows, such as the lead's chat view. */
export interface ChatPaneView {
  /** True while the view is the top view, also under a dialog. */
  readonly active: Accessor<boolean>
  /** Escape goes back from the view once nothing runs; a question shown there stays pending. */
  readonly leave: () => void
  /** Closes the chat as Close chat does, and leaves the view. */
  readonly closeChat: () => void
}

export interface ChatPaneProps {
  readonly host: ChatPaneHost
  /** The per-session source the pane reads: the foreground's surface for the tab, a surface of its own for a view. */
  readonly surface: SessionSurface
  /** The changes of the pane's session: the foreground's for the tab, its own for a view. */
  readonly changes: Accessor<SessionChangesView | undefined>
  readonly controls: SessionControlsHook
  readonly input: ChatPaneInput
  /** Absent for the tab in front. A view's pane does all that a tab does,
   *  except the tab keys, which act on the tab bar, and an idle Escape, which goes back. */
  readonly view?: ChatPaneView
  /** What the composer sends to, which a pending tab names before its session exists; the surface's session when absent. */
  readonly target?: Accessor<ForegroundTarget | undefined>
  readonly width: Accessor<number>
  /** Whether the pane's composer may hold the cursor. */
  readonly focused: Accessor<boolean>
  /** Shown above the transcript, such as the window's startup state. */
  readonly above?: JSX.Element
  /** An entry the transcript lands on and marks when it first shows. */
  readonly landing?: string
  /** What Up on an empty prompt brings back after the chat's own sends, such as a chat that failed to start. */
  readonly recallFailed?: () => LocalRecall | null
  /** The selection drag of the frame the pane sits in, which also follows a
   *  drag over the frame's own rows, such as the tab bar or a view's title. */
  readonly selectionDrag: Pick<TranscriptSelectionDrag, "register">
  readonly ref?: (handle: ComposerHandle) => void
}

/** One chat as the person sees it: its transcript, the runtime notice, the
 *  module strips, and its composer with the question dock. The tab in front
 *  and every view of a chat mount this one pane, so a chat renders the same
 *  wherever it shows (PI-LEAD-005). */
export function ChatPane(props: ChatPaneProps) {
  const host = untrack(() => props.host)
  const surface = untrack(() => props.surface)
  const view = untrack(() => props.view)
  const sessionId = surface.sessionId
  const target = (): ForegroundTarget | undefined => {
    if (props.target) return props.target()
    const id = sessionId()
    return id === undefined ? undefined : { kind: "session", sessionId: id }
  }
  const draftKey = (): string | undefined => {
    const current = target()
    return current?.kind === "pending" ? current.key : current?.sessionId
  }
  // A module strip's key focus belongs to the tab's composer; a view's composer keeps its own focus.
  const stripFocused = (): boolean => view === undefined && host.stripFocused()
  const tabHints = (): boolean => view === undefined && !host.hidesTabControls(sessionId())
  const modelLabel = (): string | undefined => { const id = sessionId(); return sessionModelLabel(id ? host.roleView(id) : undefined, host.chatDefault()) }
  const rows = host.sessionRows(sessionId)
  const openModel = (): void => { host.openModel(sessionId()) }
  createEffect(() => { const id = sessionId(); if (id !== undefined) untrack(() => host.follow(id)) })
  const openBackground = (): void => {
    const id = sessionId()
    if (id !== undefined) host.openBackground({ sessionId: id, streamingToolText: surface.streamingToolText, navigateToProcess: props.input.land })
  }
  const openChanges = (): void => { host.openChanges(props.changes) }
  if (view) {
    createEffect(() => { const id = sessionId(); if (id !== undefined) onCleanup(untrack(() => host.followBackground(id))) })
    // Each command that acts on a chat acts on this one while the view is in front, as in its tab.
    host.transcriptInView.show({ active: view.active, openModel, kind: "chat",
      chat: { sessionId, openBackground, resume: () => props.controls.resume(), openChanges, closeChat: view.closeChat } })
  }
  const borderLayout = createComposerBorderLayout({
    terminalWidth: () => props.width(),
    modelLabel,
    update: host.update,
    composerStatus: rows.composerStatus,
    changesLabel: () => sessionChangesPromptLabel(props.changes()?.snapshot().summary),
    pendingQuestion: () => surface.pendingQuestion() !== undefined,
    agentState: surface.agentState,
    sessionState: surface.sessionState,
    chordFor: host.chordFor,
    resumeOffered: () => props.controls.offered().primary === "resume",
    activeSessionCount: host.activeSessionCount,
    sessionCount: host.sessionCount,
    tabHints,
    escapeHints: () => view === undefined && !stripFocused(),
  })
  return <box flexDirection="column" flexGrow={1} minHeight={0}>
    {/* The transcript takes the rows the prompt area leaves. A tall pending
        question shrinks the prompt area instead of pushing its choices out of
        the frame, and the question dock scrolls inside the rows it gets. */}
    <box flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column" paddingLeft={2} paddingRight={1} paddingBottom={1} gap={1}>
      {props.above}
      <Show when={surface.sessionState() !== null && sessionId()} keyed>
        {(id) => {
          // One controls object for the session this mount shows: a call in
          // the attribute would run again on every read of the prop.
          const processControls = host.processControls(id)
          return <OutputWindow
            localSubmissions={host.pendingSubmissions(id)}
            layoutSlot={host.layoutSlot(id)}
            transcript={surface.transcript} running={surface.agentState() === "active"}
            showThinking={host.showThinking()}
            streamingToolText={surface.streamingToolText()}
            diffColors={host.diffColors} command={props.input.command()}
            {...(props.landing === undefined ? {} : { landing: props.landing })}
            onNearEdge={surface.pageOutput}
            registerSelectionAutoScroll={props.selectionDrag.register}
            processControls={processControls}
            roleView={host.roleView}
            childStatus={(childSessionId) => host.childStatus(childSessionId, id)}
            ensureChildViews={host.ensureChildViews}
            sessionIntro={{
              ...host.sessionIntro,
              // The tab keys do not act in a view, so its intro does not teach them.
              tabsHintDismissed: () => view !== undefined || host.sessionIntro.tabsHintDismissed(),
              branchName: () => host.branch(id),
              sessionKind: () => "chat",
              modelLabel,
              moduleRows: rows.introRows,
              availableWidth: () => Math.max(1, props.width() - 4),
            }}
          />
        }}
      </Show>
    </box>
    <box flexShrink={1} minHeight={0}>
      <Show when={sessionId() ? host.runtimeFault() : null}>
        {(fault) => <RuntimeNotice notice={fault()} placement="composer" />}
      </Show>
      <host.Strips sessionId={() => surface.sessionState() !== null ? sessionId() : undefined} width={props.width}>
        <Composer
          {...(props.ref ? { ref: props.ref } : {})}
          foregroundId={draftKey}
          agentState={surface.agentState}
          interruptible={() => surface.interruptible() && !stripFocused()}
          tabHints={tabHints}
          pendingQuestion={surface.pendingQuestion}
          questionInput={props.input.questionInput}
          {...(view ? { onLeaveQuestion: view.leave } : {})}
          inChat={() => surface.sessionKind() === "chat"}
          lineWidth={props.width}
          completableNames={host.composer.completableNames}
          dispatchableNames={host.composer.dispatchableNames}
          slashCatalog={host.composer.slashCatalog()}
          projectFiles={host.composer.projectFiles}
          promptPopupKeySlot={props.input.promptPopup}
          promptAttachSlot={host.composer.promptAttachSlot}
          spinnerSource={sessionSpinnerSource(surface)}
          promptBorderLayout={borderLayout}
          onDismissUpdate={host.update.dismiss}
          onOpenChanges={openChanges}
          history={host.composer.history}
          commandFrequency={host.composer.commandFrequency}
          clipboard={host.composer.clipboard}
          onAttachmentWarning={host.composer.onAttachmentWarning}
          onSubmit={(input) => host.submit(input, target())}
          onRecallLocal={() => {
            const id = sessionId()
            return (id === undefined ? null : host.recallLocal(id)) ?? props.recallFailed?.() ?? null
          }}
          onRecallQueued={() => { const id = sessionId(); return id === undefined ? null : host.recallQueued(id) }}
          onAnswerQuestion={host.composer.onAnswerQuestion}
          onCancelQuestion={host.composer.onCancelQuestion}
          draftCache={host.composer.draftCache}
          onOpenSessions={host.composer.onOpenSessions}
          onModuleAction={host.composer.onModuleAction}
          onOpenModel={openModel}
          onNew={host.composer.onNew}
          onClose={host.composer.onClose}
          onNextTab={host.composer.onNextTab}
          onOpenBackground={openBackground}
          onResume={props.controls.resume}
          captureFocus={() => props.focused() && !stripFocused()}
          onPromptPress={() => { if (view === undefined) host.releaseStripFocus() }}
        />
      </host.Strips>
    </box>
  </box>
}

/** A chat's pane for a view over the tab in front: the same pane that a tab
 *  mounts, with the view's own surface (`host.createSurface`), controls, and
 *  keys. Route the view's keys through `routeChatPaneKey` with the same `input`. */
export function ChatViewPane(props: {
  readonly host: ChatPaneHost
  readonly surface: SessionSurface
  readonly input: ChatPaneInput
  readonly view: ChatPaneView
  readonly width: Accessor<number>
  readonly focused: Accessor<boolean>
  readonly selectionDrag: Pick<TranscriptSelectionDrag, "register">
  readonly landing?: string
}) {
  const host = untrack(() => props.host)
  const input = untrack(() => props.input)
  const surface = untrack(() => props.surface)
  const controls = useSessionControls({ row: surface.summary, status: surface.status, appService: host.client, showToast: host.showToast })
  const changes = host.createChanges(surface.sessionId)
  bindPane(input, { pendingQuestion: () => surface.pendingQuestion() !== undefined, sessionControls: controls,
    interruptible: surface.interruptible, interrupt: controls.interrupt, output: input.output })
  return host.provide(() => <ChatPane host={host} surface={surface} changes={changes} controls={controls} input={input} view={props.view} width={props.width} focused={props.focused}
    selectionDrag={props.selectionDrag} {...(props.landing === undefined ? {} : { landing: props.landing })} />)
}

const boundPanes = new WeakMap<ChatPaneInput, KeymapPane>()

function bindPane(input: ChatPaneInput, pane: KeymapPane): void {
  boundPanes.set(input, pane)
  onCleanup(() => { if (boundPanes.get(input) === pane) boundPanes.delete(input) })
}

/** Routes a key of a view to the chat pane it shows, in the tab's order: the
 *  pane's question dock, then its composer popups, then Escape's interrupt of
 *  a running turn, as in a tab, then `viewKey` (the view's own keys, such as an
 *  idle Escape back), then the keymap. A key that none takes reaches the pane's
 *  focused composer. */
export function routeChatPaneKey(host: Pick<ChatPaneHost, "paneKey">, input: ChatPaneInput, evt: PaneKeyEvent, viewKey: (evt: PaneKeyEvent) => boolean): void {
  if (input.questionInput.input(evt)) return
  if (input.promptPopup.input(evt)) return
  const pane = boundPanes.get(input)
  if (evt.name === "escape" && pane && interruptOnEscape(pane)) return
  if (viewKey(evt)) return
  if (pane) host.paneKey(evt, pane)
}
