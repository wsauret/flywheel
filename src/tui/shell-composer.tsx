/** @jsxImportSource @opentui/solid */
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createMemo, onCleanup, Show, type Accessor } from "solid-js"
import { useOverlay } from "@tui/components/modal"
import { useQuestionInput } from "@tui/components/question-input"
import { useKeymap } from "@tui/context/keymap"
import { restartAttached, type TerminalAttach } from "./terminal-attach.js"
import { usesPerCommand } from "../protocol/client/command-menu.js"
import { startupTrace } from "../infra/startup-trace.js"
import { launchOutbox, type LaunchState } from "../infra/launch-state.js"
import type { AccountDirectories } from "../infra/directory-authorities.js"
import type { LauncherScope } from "../infra/process-supervisor.js"
import type { AttachedRuntimeClient } from "../protocol/app-service-types.js"
import type { ProviderSetup } from "../protocol/client/provider-setup.js"
import type { Clipboard } from "./clipboard.js"
import type { TuiFaultNotice } from "./tui-module.js"
import { commandSpecs, commandsToOptions } from "./commands/command-catalog.js"
import { buildCommandDefinitions } from "./commands/command-definitions.js"
import { createCommandDispatch, createCommandUsageRecorder } from "./commands/command-dispatch.js"
import { exitTUI } from "./exit.js"
import { Composer } from "./components/composer.js"
import type { ComposerHandle } from "./components/composer-types.js"
import { RuntimeNotice } from "./components/runtime-notice.js"
import { QuestionDock } from "./question-dock.js"
import type { OutputWindowCommandType } from "./output-window/output-window.js"
import { createComposerAttachSlot } from "./components/create-composer-attach-slot.js"
import { createComposerBorderLayout } from "./hooks/create-composer-border-layout.js"
import { createComposerPopupKeySlot } from "./components/create-composer-popup-key-slot.js"
import { createTerminalChatSubmissions } from "./hooks/create-chat-submissions.js"
import { createTerminalComposerReturns } from "./hooks/create-composer-returns.js"
import { createDraftCache, mergeInputIntoDraft } from "./components/create-draft-cache.js"
import { createKeyboardHandler } from "./hooks/create-keyboard-handler.js"
import { onceWhen } from "./hooks/once-when.js"
import { useShellState } from "./hooks/shell-state.js"
import type { RuntimeConfigCache } from "./hooks/create-runtime-config-cache.js"
import { useChatMode } from "./hooks/use-chat-mode.js"
import { useCommands } from "./hooks/use-commands.js"
import { usePromptHistoryPersistence } from "./hooks/use-composer-history-persistence.js"
import { useSessionControls } from "./hooks/use-session-controls.js"
import { snapshotSeeded } from "./transcript-store/output-transcript-cache-types.js"
import type { ShellPlaces } from "./shell-navigation.js"
import type { ShellOverlays } from "./shell-overlays.js"
import type { FindBar } from "./output-window/create-find-bar.js"

/** What the composer holds before the places that hand it drafts exist: the
 *  draft cache, the chat submissions and the drafts they return, the prompt
 *  history, the slots that fill the prompt from outside, the foreground
 *  session's chat actions, and the command catalog its slash popup lists. */
export function createShellComposer(deps: { readonly appService: AttachedRuntimeClient; readonly stateRoot: string; readonly launchState: LaunchState | undefined }) {
  const { signals, services } = useShellState()
  const { keymap } = useKeymap()
  const renderer = useRenderer()
  // A predecessor terminal's drafts are in place before the composer mounts.
  const draftCache = createDraftCache(deps.launchState)
  const submissions = createTerminalChatSubmissions({
    dispatch: (sessionId, input) => deps.appService.dispatch({ type: "session.send", sessionId, input }),
    lanes: deps.appService,
    unsent: deps.launchState === undefined ? [] : launchOutbox(deps.launchState),
    report: (message, variant) => services.showToast({ message, variant }),
    position: (sessionId) => { const range = services.transcripts.visibleRange(sessionId); return range !== undefined && snapshotSeeded(range) ? range.totalBlocks : undefined },
    context: () => ({ health: signals.runtimeHealth().kind, foregroundId: signals.foregroundId() }),
  })
  // The mounted prompt replaces this handle; until then a draft goes to the cache.
  let handle: ComposerHandle = { adoptDraft: draftCache.adopt, persistDraft: () => {}, appendInput: (sessionId, input) => mergeInputIntoDraft(draftCache, sessionId, input) }
  const composerReturns = createTerminalComposerReturns({
    client: deps.appService, composer: () => handle, drafts: draftCache, submissions: () => submissions,
    row: signals.sessionRow,
    report: (message, variant) => services.showToast({ message, variant }),
  })
  services.observeOutput({ onBlocksAdopted: submissions.observe, onTranscriptChange: composerReturns.observe })
  renderer.on("frame", submissions.frame)
  onCleanup(() => {
    renderer.off("frame", submissions.frame)
    submissions.dispose()
  })
  const commandDefinitions = createMemo(() => buildCommandDefinitions(keymap.chordFor, signals.builtInCommands()))
  const commandCatalog = createMemo(() => commandSpecs(commandDefinitions()))
  const slashCatalog = createMemo(() => commandsToOptions(commandCatalog()))
  // The popup ranks one row per command, so an alias's uses count toward it.
  const commandUses = createMemo(() => usesPerCommand(signals.commandUsage(), commandCatalog().map((spec) => ({ id: spec.id, aliases: spec.aliases ?? [] }))))
  return {
    draftCache,
    submissions,
    composerReturns,
    handle: (): ComposerHandle => handle,
    mount: (mounted: ComposerHandle): void => { handle = mounted },
    promptHistory: usePromptHistoryPersistence(deps.stateRoot),
    // Created ahead of the surface that hands files into it; the composer
    // registers its sink once its textarea mounts.
    attachSlot: createComposerAttachSlot(),
    popupKeySlot: createComposerPopupKeySlot(),
    chat: useChatMode({ signals, appService: deps.appService, showToast: services.showToast }),
    sessionControls: useSessionControls({ row: signals.foregroundSummary, status: signals.foregroundStatus, appService: deps.appService, showToast: services.showToast }),
    commandDefinitions,
    commandCatalog,
    slashCatalog,
    commandUses,
  }
}

export type ShellComposerCore = ReturnType<typeof createShellComposer>

interface ShellCommandsDeps {
  readonly appService: AttachedRuntimeClient
  readonly attach: TerminalAttach
  readonly runtimeConfig: RuntimeConfigCache
  readonly directories: AccountDirectories
  readonly launcher: LauncherScope
  readonly composer: ShellComposerCore
  readonly places: ShellPlaces
  readonly overlays: ShellOverlays
  readonly providerSetup: Accessor<ProviderSetup>
  readonly dispatchOutputCommand: (type: OutputWindowCommandType) => void
  readonly findBar: FindBar
}

/** The composer's command line and the shell's keys: slash command dispatch,
 *  composer submission, and the key handler. Built last, because a command
 *  reaches every surface the other owners build. */
export function createShellCommands(deps: ShellCommandsDeps) {
  const { signals, services } = useShellState()
  const { keymap } = useKeymap()
  const overlay = useOverlay()
  const questionInput = useQuestionInput()
  const { composer, places, overlays } = deps
  const { modals } = overlays
  const dispatch = createCommandDispatch({
    definitions: composer.commandDefinitions,
    context: Object.freeze({
      signals, directories: deps.directories, appService: deps.appService, runtimeConfig: deps.runtimeConfig, launcher: deps.launcher,
      showToast: services.showToast,
      exit: exitTUI,
      restart: () => restartAttached(deps.attach),
      startClearedChat: places.startClearedChat,
      openThemeModal: modals.openThemeModal,
      openSurface: overlays.openSurface,
      captureSurfaceOpener: overlays.captureSurfaceOpener,
      focusSession: places.focusSession,
      refreshCommandCatalog: services.refreshCommandCatalog, agentInView: overlays.transcriptInView.agentInView,
    }),
    showToast: services.showToast,
    offCommands: signals.offCommands,
    catalog: services.commandCatalogReadiness,
    // The dispatcher knows a command ran; the runtime keeps the count so
    // every client ranks by the same one.
    recordUsage: createCommandUsageRecorder(deps.appService),
  })
  const commands = useCommands({
    signals,
    showToast: services.showToast,
    openSettingsDestination: modals.openSettingsDestination,
    dispatch,
    sendMessage: composer.submissions.send,
    startChat: places.startChat,
    providerSetup: deps.providerSetup,
    openSubscriptionSpendReview: modals.openSubscriptionSpendReview,
  })
  const { handleKey, promptBarActions } = createKeyboardHandler({
    signals,
    keymap,
    showToast: services.showToast,
    exit: exitTUI,
    tabs: places.tabs,
    startNewChat: places.startNewChat,
    chat: composer.chat,
    openSessionsModal: modals.openSessionsModal,
    sessionControls: composer.sessionControls,
    overlay,
    questionInput,
    promptPopup: composer.popupKeySlot,
    openCommandPalette: modals.openCommandPalette,
    findBar: deps.findBar,
    switchForeground: places.switchForeground,
    dispatchOutputCommand: deps.dispatchOutputCommand,
    closeTab: places.closeTab,
  })
  useKeyboard(handleKey)
  return { dispatch, handleComposerSubmit: commands.handleComposerSubmit, promptBarActions }
}

type ShellCommands = ReturnType<typeof createShellCommands>

/** The prompt area: the runtime fault notice, the module strips, and the
 *  composer with its border. */
export function ShellComposer(props: {
  readonly composer: ShellComposerCore
  readonly commands: ShellCommands
  readonly places: ShellPlaces
  readonly overlays: ShellOverlays
  readonly runtimeFault: Accessor<TuiFaultNotice | null>
  readonly captureFocus: Accessor<boolean>
  readonly clipboard: Clipboard
}) {
  /* eslint-disable solid/reactivity -- the shell's owners are static for the shell's lifetime */
  const { composer, commands, places, overlays, runtimeFault } = props
  /* eslint-enable solid/reactivity */
  const { modals, slots } = overlays
  const { signals, services } = useShellState()
  const { keymap } = useKeymap()
  const dimensions = useTerminalDimensions()
  const lineWidth = createMemo(() => Math.max(dimensions().width, 40))
  const inChat = createMemo(() => signals.sessionKind() === "chat")
  // eslint-disable-next-line solid/reactivity -- onceWhen evaluates this condition inside its createEffect scope
  onceWhen(() => Boolean(signals.foregroundId()) && inChat(), () => startupTrace("chat input mode ready"))
  const draftKey = () => {
    const target = signals.foregroundTarget()
    return target?.kind === "pending" ? target.key : target?.sessionId
  }
  const { layout: promptBorderLayout, waitingCount, dismissUpdate: dismissUpdateStatus } = createComposerBorderLayout({
    signals,
    terminalWidth: lineWidth,
    composerStatus: slots.composerStatus,
    chordFor: keymap.chordFor,
    resumeOffered: () => composer.sessionControls.offered().primary === "resume",
    activeSessionCount: places.activeSessionCount,
  })
  const ModuleStrips = slots.Strips
  return (
    <box flexShrink={1} minHeight={0}>
      <Show when={signals.foregroundId() ? runtimeFault() : null}>
        {(fault) => <RuntimeNotice notice={fault()} placement="composer" />}
      </Show>
      <Show when={signals.sessionState() !== null && signals.foregroundId()} keyed>
        {(id) => <ModuleStrips sessionId={id} width={lineWidth} />}
      </Show>
      <Composer
        ref={composer.mount}
        foregroundId={draftKey}
        agentState={signals.agentState}
        interruptible={signals.interruptible}
        pendingQuestion={signals.pendingQuestion}
        inChat={inChat}
        lineWidth={lineWidth}
        completableNames={commands.dispatch.completableNames}
        dispatchableNames={commands.dispatch.dispatchableNames}
        slashCatalog={composer.slashCatalog()}
        projectFiles={(query) => services.appService.query({ type: "projectFiles", request: { query, limit: 10 } }).then((result) => result.entries)}
        promptPopupKeySlot={composer.popupKeySlot}
        promptAttachSlot={composer.attachSlot}
        spinnerSource={signals.spinnerStatusSource}
        promptBorderLayout={promptBorderLayout}
        waitingCount={waitingCount}
        onDismissUpdate={dismissUpdateStatus}
        onOpenChanges={modals.openSessionChangesModal}
        history={composer.promptHistory}
        commandFrequency={composer.commandUses}
        clipboard={props.clipboard}
        onAttachmentWarning={(message) => services.showToast({ message, variant: "warning" })}
        onSubmit={commands.handleComposerSubmit}
        onRecallLocal={() => {
          const sessionId = signals.foregroundId()
          const local = sessionId ? composer.submissions.recallLocal(sessionId) : null
          const failedChat = local ? null : places.recallFailedChat()
          return local ?? (failedChat ? { kind: "input", input: failedChat } : null)
        }}
        onRecallQueued={() => {
          const sessionId = signals.foregroundId()
          return sessionId ? composer.submissions.recallQueued(sessionId, () => services.appService.query({ type: "recallQueuedMessage", sessionId })) : null
        }}
        onAnswerQuestion={(toolUseId, answers) => composer.chat.answerQuestion(toolUseId, answers)}
        onCancelQuestion={(toolUseId) => composer.chat.cancelQuestion(toolUseId)}
        questionDock={QuestionDock}
        draftCache={composer.draftCache}
        onOpenSessions={modals.openSessionsModal}
        onModuleAction={overlays.activateModuleRow}
        onOpenModel={() => { void modals.openActiveModelPicker() }}
        onNew={commands.promptBarActions.newChat}
        onClose={commands.promptBarActions.closeTab}
        onNextTab={commands.promptBarActions.nextTab}
        onOpenBackground={modals.openBackgroundModal}
        onResume={composer.sessionControls.resume}
        captureFocus={props.captureFocus}
      />
    </box>
  )
}
