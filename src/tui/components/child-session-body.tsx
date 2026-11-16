/** @jsxImportSource @opentui/solid */

import type { AgentViewKind } from "../../protocol/client/slash-route.js"
import { createEffect, createSignal, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import type { DiffColorMode } from "../../orchestration/config/schema.js"
import type { RoleAssignmentView } from "../../protocol/role-protocol-types.js"
import type { ChildCardStatus } from "../../protocol/client/session-controls.js"
import { OutputWindow, type OutputWindowCommand, type OutputWindowCommandType } from "../output-window/output-window.js"
import type { TranscriptLayoutSlot } from "../output-window/output-window-scroll.js"
import type { RowProcessControls } from "../output-blocks/stop-affordance.js"
import type { SessionIntroProps } from "../welcome-notice.js"
import { sessionSpinnerSource, type SessionSurface } from "../hooks/create-session-surface.js"
import type { BackgroundModalTarget } from "../hooks/use-background-modal.js"
import type { TranscriptInView } from "../hooks/transcript-in-view.js"
import { useTheme } from "../context/theme.js"
import { useTickPool } from "../context/tick-pool-context.js"
import { createSpinnerStatus, spinnerAnimates } from "../hooks/create-spinner-status.js"
import { Button } from "./button.js"
import { ComposerBody, ComposerFrame, composerBodyGeometry } from "./composer-frame.js"
import { createPromptBorderChunks } from "./composer-border-labels.js"
import { InitialMessageProvider } from "../output-blocks/user-message-block.js"
import type { QuestionBlock, UserMessageBlock } from "../../infra/output-blocks.js"
import type { ChatInputLike } from "../../infra/chat-input.js"
import type { ModuleComposerStatus, ModuleRowAction } from "../../protocol/protocol-module.js"
import { useWrappedLineCount } from "../utils/text.js"
import { computeComposerBorderLayout } from "./composer-border-layout.js"
import type { QuestionInputContext } from "./question-input.js"
import { QuestionDock } from "../question-dock.js"
import type { QuestionDraftNamespace } from "../hooks/create-draft-cache.js"
import type { ChatModeHook } from "../hooks/use-chat-mode.js"

/** A hidden composer keeps its draft. Sending resolves true only after runtime acceptance. */
export interface ChildMessaging {
  readonly ready?: () => boolean
  readonly admits: Accessor<boolean>
  readonly shown: Accessor<boolean>
  send(text: string): Promise<boolean>
  readonly sessionId?: Accessor<string | undefined>
  recall?(): Promise<ChatInputLike | null>
  returnToParent?(sourceSessionId: string, input: ChatInputLike): void
}

/** The caller retains input across body mounts; the body binds output and messaging on mount. */
export interface ChildSessionBodyInput {
  readonly text: Accessor<string>
  readonly lines: Accessor<number>
  attach(prompt: TextareaRenderable): void
  focus(): void
  submit(): void
  bindOutput(dispatch: (command: OutputWindowCommandType) => void): void
  bindMessaging(messaging: ChildMessaging): void
  /** The key registry of the body's question dock, which takes the keys
   *  first while it shows. */
  readonly questionInput: QuestionInputContext
}

/** The pending question of a chat that shows outside its own tab. The person
 *  answers it here; Escape calls `leave` and the question stays pending. */
interface ChildQuestion {
  readonly view: Accessor<QuestionBlock | undefined>
  readonly answer: ChatModeHook["answerQuestion"]
  readonly cancel: ChatModeHook["cancelQuestion"]
  readonly leave: () => void
  readonly drafts: QuestionDraftNamespace
}

export interface ChildSessionBodyProps {
  readonly sessionId: string
  readonly input: ChildSessionBodyInput
  readonly layoutSlot: TranscriptLayoutSlot
  readonly createProcessControls: (sessionId: string) => RowProcessControls
  readonly sessionIntro: Omit<SessionIntroProps, "availableWidth" | "sessionKind">
  readonly showThinking: boolean
  readonly diffColors: () => DiffColorMode
  readonly active: Accessor<boolean>
  readonly focused: Accessor<boolean>
  readonly modelLabel: () => string | undefined
  /** Opens the model picker of the shown session's serving seat, under the
   *  session's own title, which names its agent. */
  readonly onOpenModel: (agentName: string) => void
  /** Where this view registers as a transcript the person may see, so Model
   *  and effort reaches this agent while its view is in front. */
  readonly transcriptInView: Pick<TranscriptInView, "show">
  /** The kind of agent this view shows, which a command refused here names. */
  readonly agentKind: Exclude<AgentViewKind, "chat">
  /** A root chat's question. While it is pending, its dock takes the place
   *  of the composer. An agent's view has none, because an agent asks its
   *  parent (PI-AGENT-024). */
  readonly question?: ChildQuestion
  /** The module labels of the composer border, as the chat composer shows them. */
  readonly composerStatus?: Accessor<readonly ModuleComposerStatus[]>
  readonly onModuleAction?: (action: ModuleRowAction) => void
  readonly onOpenBackground: (target: BackgroundModalTarget) => void
  /** Follows the background index of the shown session while this view is
   *  open, so its background list opens on held rows. Returns the end. */
  readonly followBackground: (sessionId: string) => () => void
  readonly roleView: (sessionId: string) => RoleAssignmentView | undefined
  /** What a child of the viewed session waits on, for its card. */
  readonly childStatus: (childSessionId: string, parentSessionId: string) => ChildCardStatus
  readonly ensureChildViews: (sessionIds: readonly string[]) => void
  readonly surface: SessionSurface
  readonly width: number
  readonly height: number
  readonly header: JSX.Element
  readonly navigation: JSX.Element
  readonly messaging: ChildMessaging
  readonly placeholder: string
  /** An entry the transcript lands on and marks when it first shows. */
  readonly landing?: string
  readonly initialMessageLabel?: (block: UserMessageBlock) => string
  readonly controls: Accessor<{
    readonly interrupt?: () => void
    readonly resume?: () => void
    readonly stop?: () => void
  }>
}

/** Ordinary child conversation, independent of modal or workflow chrome.
 * The caller owns the surface lifetime and supplies admitted messaging and controls. */
export function ChildSessionBody(props: ChildSessionBodyProps) {
  const wrappedLineCount = useWrappedLineCount()
  const { theme } = useTheme()
  const surface = untrack(() => props.surface)
  const processControls = untrack(() => props.createProcessControls(props.sessionId))
  const [outputCommand, setOutputCommand] = createSignal<OutputWindowCommand>()
  let outputCommandId = 0
  // The model control shows only once the session's row names its kind, so
  // the row that holds its title is there.
  const openModel = (): void => { const row = surface.summary(); if (row !== null) props.onOpenModel(row.title) }
  const docked = () => props.question?.view() !== undefined
  untrack(() => {
    props.input.bindOutput((type) => { setOutputCommand({ id: ++outputCommandId, type }) })
    // The input owner types into the composer only while no dock replaces it.
    props.input.bindMessaging({ ...props.messaging, shown: () => props.messaging.shown() && !docked() })
    props.transcriptInView.show({ active: props.active, openModel, kind: props.agentKind })
    onCleanup(props.followBackground(props.sessionId))
  })
  const spinnerSource = sessionSpinnerSource(surface)
  const spinnerTick = useTickPool().createSharedTick(50, () => props.active() && spinnerAnimates(spinnerSource))
  const { status: spinnerStatus } = createSpinnerStatus({ source: spinnerSource, terminalWidth: () => props.width, tick: spinnerTick })
  const modelReading = () => surface.sessionKind() === null ? undefined : props.modelLabel()
  const finished = () => {
    const row = surface.summary()
    return row?.kind === "subagent" && (row.runOutcome === "completed" || row.runOutcome === "partial")
  }
  const finishedNotice = "This subagent finished. Unread messages stay in the parent chat and return to the sending window's composer while it is open."
  const initialMessageId = () => {
    if (!props.initialMessageLabel) return undefined
    const range = surface.transcript.visibleRange()
    const first = range?.blocks[0]
    return range?.window.startBlockIndex === 0 && first?.kind === "userMessage" && !first.injected ? first.id : undefined
  }
  const border = createPromptBorderChunks({
    theme,
    layout: () => computeComposerBorderLayout({
      terminalWidth: props.width, modelLabel: modelReading(), update: undefined, composerStatus: props.composerStatus?.() ?? [],
      primaryHints: [], showGlobalHints: false, tabHints: false, activeSessionCount: 0, sessionCount: 0,
      resumeHint: undefined, newHint: undefined, closeHint: undefined, sessionsHint: undefined,
    }),
    lineWidth: () => props.width, status: () => props.active() ? spinnerStatus() : null, idle: () => surface.agentState() === "idle",
  })
  // The composer input stays until the dock has measured itself, so the place
  // swaps from the input to the dock in one frame and is never empty. The
  // frame stays under the dock with no body, because its border carries the
  // status labels that every view shows, such as the count of chats that
  // need the person.
  const [dockMeasured, setDockMeasured] = createSignal(false)
  const composerShown = () => props.messaging.shown() && !(docked() && dockMeasured())
  return <box flexDirection="column" width={props.width} height={props.height} gap={1}>
    {props.header}
    <Show when={surface.loadResult()?.loadError}>{(message) => <text fg={theme.error}>{message()}</text>}</Show>
    <box flexGrow={1} minHeight={0} flexShrink={1} flexDirection="column" gap={1}>
      <box flexGrow={1} minHeight={0} flexShrink={1} flexDirection="column">
        <Show when={props.active() && surface.sessionKind()}>{(kind) =>
          <InitialMessageProvider value={{ id: initialMessageId, label: (block) => props.initialMessageLabel?.(block) ?? "" }}><OutputWindow
            transcript={surface.transcript}
            layoutSlot={props.layoutSlot}
            sessionIntro={{ ...props.sessionIntro, sessionKind: kind, availableWidth: () => props.width }}
            running={surface.agentState() === "active"}
            command={outputCommand()}
            {...(props.landing === undefined ? {} : { landing: props.landing })}
            showThinking={props.showThinking}
            streamingToolText={surface.streamingToolText()}
            diffColors={props.diffColors}
            onNearEdge={surface.pageOutput}
            processControls={processControls}
            roleView={props.roleView}
            childStatus={(childSessionId) => props.childStatus(childSessionId, props.sessionId)}
            ensureChildViews={props.ensureChildViews}
          /></InitialMessageProvider>
        }</Show>
      </box>
      <Show when={props.question}>{(question) =>
        <Show when={question().view()}>{(pending) =>
          <QuestionDock sessionId={props.sessionId} question={pending()} drafts={question().drafts} input={props.input.questionInput}
            width={props.width} captureFocus={props.focused} onMeasured={setDockMeasured}
            onAnswer={(answers) => question().answer(props.sessionId, pending().toolUseId, answers)}
            onCancel={() => question().cancel(props.sessionId, pending().toolUseId)}
            escape="leave" onLeave={question().leave} />
        }</Show>
      }</Show>
      <ComposerFrame theme={theme} width={props.width} bodyHeight={composerShown() ? composerBodyGeometry(props.width, props.input.lines()).height : finished() ? wrappedLineCount(finishedNotice, composerBodyGeometry(props.width, 1).width) : 0}
        topRightChunks={border.topRightChunks} bottomLeftChunks={border.bottomLeftChunks} bottomRightChunks={border.bottomRightChunks}
        controls={border.controls} onMouseDown={() => { if (composerShown()) props.input.focus() }} onModuleAction={props.onModuleAction}
        actions={{
          model: openModel,
          background: () => props.onOpenBackground({
            sessionId: props.sessionId,
            streamingToolText: surface.streamingToolText,
            navigateToProcess: (entryId) => setOutputCommand({ id: ++outputCommandId, type: "block", entryId }),
          }),
        }}>
        <Show when={composerShown()} fallback={<Show when={finished()}><text fg={theme.textMuted} wrapMode="word">{finishedNotice}</text></Show>}>
          <ComposerBody theme={theme} width={props.width} lines={props.input.lines()} text={props.input.text()}
            placeholder={props.placeholder} onSubmit={props.input.submit}
            attach={(prompt) => {
              props.input.attach(prompt)
              createEffect(() => { if (props.focused() && !docked()) prompt.focus(); else prompt.blur() })
              onCleanup(() => prompt.blur())
            }} />
        </Show>
      </ComposerFrame>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        {props.navigation}
        <box flexDirection="row" gap={1}>
          <Show when={props.controls().interrupt}>{(action) => <Button label="Interrupt" onPress={() => action()()} />}</Show>
          <Show when={props.controls().resume}>{(action) => <Button label="Resume" onPress={() => action()()} />}</Show>
          <Show when={props.controls().stop}>{(action) => <Button label="Stop" onPress={() => action()()} />}</Show>
        </box>
      </box>
    </box>
  </box>
}
