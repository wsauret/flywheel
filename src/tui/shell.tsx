/** @jsxImportSource @opentui/solid */
import { faultReach, restartAttached, signInPage, type TerminalAttach } from "./terminal-attach.js"
import { cardProfileName } from "../protocol/client/new-chat-card.js"
import { createSurfaceOpener } from "../protocol/client/surface-presentation.js"
import { usesPerCommand } from "../protocol/client/command-menu.js"
import { runtimeFaultCopy, type ReleaseInstall } from "../protocol/client/runtime-fault-copy.js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useModal, useOverlay } from "@tui/components/modal"
import { useQuestionInput } from "@tui/components/question-input"
import { ToastDisplay } from "@tui/components/toast-display"
import { useKeymap } from "@tui/context/keymap"
import { NavigationProvider } from "@tui/context/navigation.js"
import { SubagentControlsProvider } from "@tui/context/subagent-controls.js"
import { ClientExtensionProviders, ClientExtensionsProvider, hidesTabControls, moduleFirstTab } from "@tui/context/client-extensions.js"
import { createTuiModuleClients, moduleCloseGuards, moduleSessionNavigation, moduleTerminalTitle } from "@tui/modules.js"
import { useTheme } from "@tui/context/theme"
import { useTickPool } from "@tui/context/tick-pool-context"
import { useToast } from "@tui/context/toast"
import { createEffect, createMemo, createSignal, from, onCleanup, onMount } from "solid-js"
import { startupTrace, traceShellMount } from "../infra/startup-trace.js"
import { Log } from "../infra/log.js"
import { errorMessage } from "../infra/error-message.js"
import type { AttachedRuntimeClient } from "../protocol/app-service-types.js"
import type { RuntimeIdentity } from "../protocol/client/runtime-identity.js"
import type { ModuleRowAction } from "../protocol/protocol-module.js"
import type { LauncherScope } from "../infra/process-supervisor.js"
import type { Clipboard } from "./utils/clipboard.js"
import { commandSpecs, commandsToOptions } from "./commands/command-catalog.js"
import { buildCommandDefinitions } from "./commands/command-definitions.js"
import { createCommandDispatch, createCommandUsageRecorder } from "./commands/command-dispatch.js"
import { exitTUI } from "./exit.js"
import { ChatPane, createChatPaneInput, type ChatPaneHost } from "./components/chat-pane.js"
import type { ComposerHandle } from "./components/composer-types.js"
import { StartupViewport } from "./components/startup-viewport.js"
import { TabsBar, TabsBarDivider } from "./components/tabs-bar.js"
import { SessionHeaderStats } from "./components/session-header-stats.js"
import { createTabCloser } from "./hooks/create-tab-closer.js"
import { createComposerAttachSlot } from "./hooks/create-composer-attach-slot.js"
import { createAttachFilesCommand } from "./hooks/create-attach-files-command.js"
import { createSessionCreator } from "./hooks/create-session-creator.js"
import { createNewChatActions } from "./hooks/create-new-chat-actions.js"
import { discardIfTransientForeground } from "./hooks/background-foreground.js"
import { createModalModals } from "./hooks/create-modals.js"
import { createModuleSlots } from "./hooks/create-module-slots.js"
import { TUI_MODULES, tuiFaultNotice } from "./modules.js"
import { createSurfaceRouter, type KernelSurfaceTable } from "./commands/command-surfaces.js"
import { closeChatSurface } from "./commands/close-chat-surface.js"
import { settingsPlace } from "./settings-destination.js"
import { createAsyncReporter } from "./hooks/report-async.js"
import { createTranscriptInView } from "./hooks/transcript-in-view.js"
import { createDraftCache } from "./hooks/create-draft-cache.js"
import { createTerminalComposerReturns } from "./hooks/create-composer-returns.js"
import { mergeInputIntoDraft } from "./hooks/composer-draft-merge.js"
import { onceWhen } from "./hooks/once-when.js"
import { createLaunchState } from "./hooks/create-launch-state.js"
import { launchOutbox, type LaunchState } from "../infra/launch-state.js"
import { createTerminalChatSubmissions } from "./hooks/create-chat-submissions.js"
import type { SettingsOperations, SettingsStore } from "./hooks/create-settings-store.js"
import { createKeyboardHandler } from "./hooks/create-keyboard-handler.js"
import { createLinkNavigator, createSessionActivator, createSessionActivatorById, readSessionRoute } from "./hooks/session-activation.js"
import { createShellState, type RuntimeConfigCache } from "./hooks/shell-state.js"
import { useChatMode } from "./hooks/use-chat-mode.js"
import { useSessionControls } from "./hooks/use-session-controls.js"
import { usePaidUseQuestion } from "./hooks/use-paid-use-question.js"
import { useLoginQuestion } from "./hooks/use-login-question.js"
import { useAutomaticAuth } from "./hooks/automatic-dialogs.js"
import { useCopySelection } from "./hooks/use-copy-selection.js"
import { useCommands } from "./hooks/use-commands.js"
import { createForegroundSwitcher } from "./hooks/create-foreground-switcher.js"
import { createHeaderDisplay } from "./hooks/create-header-display.js"
import { createTabState } from "./hooks/create-tabs.js"
import { usePromptHistoryPersistence } from "./hooks/use-composer-history-persistence.js"
import { createFocusedSessionReadiness, useOpenSessionRunners } from "./hooks/use-open-session-runners.js"
import { createOpenSessionKeeper } from "../protocol/client/open-session-keeper.js"
import { createTranscriptSelectionDrag } from "./hooks/create-transcript-selection-drag.js"
import { createTranscriptLayoutCache } from "./output-window/output-window-scroll.js"
import { createDismissibleUpdateStatus } from "./hooks/create-composer-border-layout.js"
import { roleSlot } from "../orchestration/config/role-selection.js"
import { effectiveSessionShortTitle } from "../protocol/app-service-types.js"
import { createToastPresenter } from "./utils/toast-presenter.js"
import { providerSetup } from "../protocol/client/provider-setup.js"
import { createTerminalBackground, type TerminalBackgroundWriter } from "./hooks/create-terminal-background.js"
import { useTabsHint } from "./hooks/use-tabs-hint.js"
import { useReleaseNotice } from "./hooks/use-release-notice.js"
import { startSessionChangesWhenReady } from "./hooks/create-session-changes.js"
import { createChildViewerOpener } from "./hooks/create-child-viewer-opener.js"
import { sessionServingLabel } from "../protocol/role-protocol-types.js"
import { createSessionProcessControls } from "./hooks/create-session-process-controls.js"
import { snapshotSeeded } from "./transcript-store/output-transcript-cache-types.js"
/** A startup failure can carry a formatted multi-line blob (a code frame from
 *  the worker's raw error event). The notice shows the head; the log holds
 *  the rest. */
const keeperLog = Log.create({ service: "session-keeper" })

export function FlywheelShell(props: { appService: AttachedRuntimeClient; attach: TerminalAttach; runtimeConfig: RuntimeConfigCache; projectRoot: string; stateRoot: string; userDataRoot: string; accountHome: string; appVersion: string; launcher: LauncherScope; clipboard: Clipboard; settings: SettingsStore; settingsOperations: SettingsOperations; launchState: LaunchState | undefined; attachedIdentity: Promise<RuntimeIdentity | undefined>; registerForeground?: (read: () => string | undefined) => void; terminalWriter: TerminalBackgroundWriter }) {
  startupTrace("flywheel shell setup start")
  const themeContext = useTheme()
  const theme = themeContext.theme
  const { keymap, issues: keymapIssues } = useKeymap()
  const toast = useToast()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const modal = useModal()
  const overlay = useOverlay()
  const questionInput = useQuestionInput()
  // Terminal.app (or the Compatible rendering setting): transparent base
  // cells + OSC 11 render theme-colored with native-drawn connected borders.
  // Other terminals get the theme background painted per cell by the root
  // box below, and the hook restores their own default background.
  // eslint-disable-next-line solid/reactivity -- the ordered terminal writer belongs to this shell's lifetime
  createTerminalBackground(props.terminalWriter)
  /* eslint-disable solid/reactivity -- shell props are static for the session lifetime, set once from composition root */
  const { projectRoot, stateRoot, userDataRoot, accountHome, appVersion, appService, attach, runtimeConfig, launcher, clipboard, settings, settingsOperations, launchState, attachedIdentity, registerForeground } = props
  const copySelection = useCopySelection(clipboard)
  const transcriptSelectionDrag = createTranscriptSelectionDrag(renderer)
  const onShellMouseUp = (): boolean => {
    transcriptSelectionDrag.onMouseUp()
    return copySelection()
  }
  const directories = { userDataRoot, accountHome }
  const tabsHint = useTabsHint(runtimeConfig, appService, toast.show)
  // The keys and transcript commands of the tab's chat pane; its question dock takes keys through the shell's one slot.
  const tabPane = createChatPaneInput(questionInput)
  /* eslint-enable solid/reactivity */
  const promptHistory = usePromptHistoryPersistence(stateRoot)
  // A predecessor terminal's drafts are in place before the composer mounts.
  const draftCache = createDraftCache(launchState)
  const composerReturns = createTerminalComposerReturns({
    client: appService, composer: () => composer, drafts: draftCache, submissions: () => submissions,
    row: (id) => signals.sessionCatalogRows().find((row) => row.id === id) ?? services.sessionDetails.view(id)?.row,
    report: (message, variant) => toast.show({ message, variant }),
  })
  const submissions = createTerminalChatSubmissions({
    dispatch: (sessionId, input) => appService.dispatch({ type: "session.send", sessionId, input }),
    lanes: appService,
    unsent: launchState === undefined ? [] : launchOutbox(launchState),
    report: (message, variant) => toast.show({ message, variant }),
    position: (sessionId) => { const range = services.transcripts.visibleRange(sessionId); return range !== undefined && snapshotSeeded(range) ? range.totalBlocks : undefined },
    context: () => ({ health: signals.runtimeHealth().kind, foregroundId: signals.foregroundId() }),
  })
  const pool = useTickPool()
  const wallTick = pool.createSharedTick(1000, () => true)
  const now = createMemo(() => { wallTick(); return Date.now() })
  const navigateUri = createLinkNavigator({
    openSession: (sessionId) => activateSessionById(sessionId),
    openModuleUri: async (uri) => {
      for (const client of moduleClients) if (await client.openUri(uri)) return true
      return false
    },
    showToast: toast.show,
  })
  const { signals, services } = createShellState({
    appService,
    runtimeConfig,
    projectRoot,
    now,
    onBlocksAdopted: submissions.observe,
    onTranscriptChange: composerReturns.observe,
    attachedIdentity,
    setTerminalTitle: (t: string) => { if (!renderer.isDestroyed) renderer.setTerminalTitle(t) },
    terminalTitle: (sessionId, root) => moduleTerminalTitle(moduleClients, sessionId, root),
    showToast: (opts: { message: string; variant: "info" | "warning" | "error" | "success"; duration?: number }) => toast.show(opts),
  })
  const releaseNotice = () => signals.updateStatus()?.releaseNotice
  const releaseNoticeActions = useReleaseNotice(releaseNotice, runtimeConfig, appService, toast.show)
  registerForeground?.(signals.foregroundId)
  renderer.on("frame", submissions.frame)
  onCleanup(() => {
    renderer.off("frame", submissions.frame)
    submissions.dispose()
  })
  const transcriptInView = createTranscriptInView(() => { void modelModal.openActiveModelPicker() })
  // The session a command or a surface acts on: the chat that a view over the
  // tab in front shows, as in its own tab, else the session in front.
  const sessionInView = (): string | undefined => { const shown = transcriptInView.chatInView(); return shown ? shown.sessionId() : signals.foregroundId() }
  const chatInFront = (): string | undefined => signals.sessionInputMode()?.kind === "chat" ? signals.foregroundId() : undefined
  // The kernel destinations are built by the modals below; a surface reaches
  // them only after the shell has mounted, so the closures resolve in time.
  const slots = createModuleSlots({
    modules: TUI_MODULES, intakes: signals.modules, foregroundId: signals.foregroundId, surfaceSession: sessionInView, modal, showToast: toast.show, client: appService, enabled: () => signals.moduleSelection()?.moduleIds, auth: signals.auth,
    answering: () => signals.runtimeHealth().kind !== "faulted",
    projectRoot: signals.projectRoot,
    clipboard,
    appVersion, keymap, reportIssue: (message) => configToasts.present("config.invalid", { message, variant: "error", duration: 10000 }), composer: { hasDraft: draftCache.hasDraft, syncFocus: () => composer.syncFocus() }, foregroundQuestion: () => signals.pendingQuestion() !== undefined,
    overlayOpen: () => overlay.isOpen(),
    navigate: { openSettings: (destination) => openSettingsDestination(destination), openSurface: (id) => slots.surfaces.get(id)?.(), navigateSession: (sessionId) => focusSession(sessionId) },
  })
  const commonSessionIntro = {
    runtimeIdentity: signals.runtimeIdentity,
    showBuild: () => runtimeConfig.view()?.values.showBuild ?? false,
    projectRoot: signals.projectRoot,
    userDataRoot,
    accountHome,
    profileName: () => { const profile = signals.auth()?.profile; return cardProfileName(profile && { displayName: profile.displayName, count: profile.availableProfiles.length }) },
    moduleRows: slots.introRows,
    fontTipDismissed: () => runtimeConfig.view()?.values.fontTipDismissed ?? false,
    tabsHintDismissed: tabsHint.dismissed,
    onDismissTabsHint: () => { void tabsHint.dismiss() },
  }
  const [firstFrame, setFirstFrame] = createSignal(false)
  const afterFrame = (): void => { setFirstFrame(true); renderer.off("frame", afterFrame) }
  renderer.on("frame", afterFrame)
  onCleanup(() => renderer.off("frame", afterFrame))
  startSessionChangesWhenReady(
    // eslint-disable-next-line solid/reactivity -- the helper tracks readiness in its owned effect
    () => firstFrame() && signals.startupStatus() === null,
    services.startDeferredReadings,
  )
  const processControls = createSessionProcessControls({ appService, signals, showToast: services.showToast })
  startupTrace("shell state created")
  const transcriptLayout = createTranscriptLayoutCache(() => signals.sessionCatalogRows().filter((row) => row.lifecycleState === "active").length)
  // The module clients exist once setup ends, before the tab state's first effect reads this.
  const firstTab = () => moduleFirstTab(moduleClients)
  const { tabs, openSessionTab, closeSessionTab, openPendingTab, removePendingTab, hasPendingTab, isTransientSessionTab, reorderTab } = createTabState({ sessions: signals.sessionCatalogRows, signals, firstTab: () => firstTab().current() })
  createEffect(() => { composerReturns.own(firstFrame() ? tabs().filter((tab) => tab.kind === "session").map((tab) => tab.id) : []) })
  const switchForeground = createForegroundSwitcher({ signals, sessions: signals.sessionCatalogRows, tabs })
  const focusReady = createFocusedSessionReadiness(() => { const id = signals.foregroundId(); return id === undefined || services.transcripts.isCurrent(id) })
  const sessionShows = useOpenSessionRunners({
    tabs, client: appService,
    // eslint-disable-next-line solid/reactivity -- the hook tracks readiness in its owned effect
    ready: () => firstFrame() && signals.startupStatus() === null,
    keeper: createOpenSessionKeeper({ client: appService, focusReady, onDiagnostic: (message, detail) => keeperLog.warn(message, { detail }) }),
  })
  const retireTransientSession = (sessionId: string): void => { void discardIfTransientForeground({ draftCache, appService, showToast: services.showToast, closeSessionTab, isTransientSessionTab }, sessionId) }
  let composer: ComposerHandle = { adoptDraft: draftCache.adopt, persistDraft: () => {}, syncFocus: () => {}, appendInput: (sessionId, input) => mergeInputIntoDraft(draftCache, sessionId, input) }
  const { startChat, focusSession, recallFailedChat } = createSessionCreator({
    signals,
    appService,
    openSessionTab,
    openPendingTab,
    removePendingTab,
    hasPendingTab,
    tabs,
    draftCache,
    adoptDraft: (key, sessionId) => composer.adoptDraft(key, sessionId),
    seedSessionCatalogRow: services.seedSessionCatalogRow,
    startKnownEmptyTranscript: services.startKnownEmptyTranscript,
    retireTransientSession,
    showToast: services.showToast,
  })
  const chat = useChatMode({ signals, appService, showToast: services.showToast })
  const sessionControlsHook = useSessionControls({ row: signals.foregroundSummary, status: signals.foregroundStatus, appService, showToast: services.showToast })
  // A session's catalog row, also for a session that only a detail read names.
  const sessionTitles = (sessionId: string) =>
    signals.sessionCatalogRows().find(({ id }) => id === sessionId) ?? services.sessionDetails.view(sessionId)?.row
  const viewerProps: Parameters<typeof createChildViewerOpener>[0]["viewer"] = (sessionId) => ({
      createSurface: services.createSessionSurface,
      appService, submissions: { send: submissions.sendWithReceipt, recallQueued: submissions.recallQueued },
      modelLabel: () => sessionServingLabel(signals.roleView(sessionId)),
      onOpenModel: (agentName) => {
        const slot = signals.roleView(sessionId)?.serving?.slot
        if (slot !== undefined) void modelModal.openActiveModelPicker({ sessionId, slot, label: agentName })
      },
      transcriptInView, composerStatus: slots.composerStatus, onModuleAction: activateModuleRow,
      onOpenBackground: (target) => backgroundModal.openBackgroundModal(target),
      followBackground: signals.backgroundIndex.follow,
      compactionThreshold: () => signals.runtimeConfig()?.values.proactiveCompactionThreshold,
      roleView: signals.roleView,
      childStatus: signals.childStatus,
      ensureChildViews: signals.ensureChildViews,
      layoutSlot: transcriptLayout(sessionId),
      createProcessControls: processControls,
      sessionIntro: {
        ...commonSessionIntro,
        branchName: () => signals.branch(sessionId),
        modelLabel: () => undefined,
      },
      showThinking: runtimeConfig.view()?.values.showThinking ?? false,
      inputReady: () => services.transcripts.isCurrent(sessionId),
      diffColors: () => runtimeConfig.view()?.values.diffColors ?? "theme",
    })
  const subagentControls = {
    details: services.sessionDetails,
    client: appService,
    report: (message: string, variant: "warning" | "error") => services.showToast({ message, variant }),
  }
  const childPlaces = createChildViewerOpener({
    navigateUri, viewer: viewerProps, viewerLayer: overlay.viewer, showToast: services.showToast,
    returnDraft: composerReturns.returnDraft,
    kindOf: (id) => services.sessionDetails.view(id)?.row.kind, dispatchCommand: (text) => commandDispatch.dispatch(text),
    provide: (children) => <SubagentControlsProvider value={subagentControls}><ClientExtensionsProvider value={moduleClients}><ClientExtensionProviders>{children()}</ClientExtensionProviders></ClientExtensionsProvider></SubagentControlsProvider>,
    openModuleSession: (session) => {
      const open = (index: number): boolean | Promise<boolean> => {
        const client = moduleClients[index]
        if (!client) return false
        const result = client.openSession(session)
        return typeof result === "boolean" ? result || open(index + 1) : result.then((opened) => opened || open(index + 1))
      }
      return open(0)
    },
  })
  const activateSession = createSessionActivator({
    signals,
    draftCache,
    appService,
    openSessionTab,
    closeSessionTab,
    isTransientSessionTab,
    showToast: services.showToast,
    dismissModalStack: overlay.clear,
  })
  const activateSessionById = createSessionActivatorById({
    rows: signals.sessionCatalogRows,
    shown: (sessionId) => transcriptInView.chatInView()?.sessionId() === sessionId,
    appService,
    activateSession,
    openChild: childPlaces.openChild,
    seedSessionCatalogRow: services.seedSessionCatalogRow,
    showToast: services.showToast,
  })
  const moduleClients = createTuiModuleClients({
    domains: signals.modules, client: appService,
    roleView: signals.roleView, ensureRoleViews: signals.ensureRoleViews,
    viewerLayer: overlay.viewer, dialog: modal, viewer: viewerProps, openChild: childPlaces.openChild,
    sessionTitles, navigateUri, navigateSession: activateSessionById, showToast: services.showToast, dispatchCommand: (text) => commandDispatch.dispatch(text),
    question: signals.followQuestion, answerQuestion: chat.answerQuestion, cancelQuestion: chat.cancelQuestion, questionDrafts: draftCache.questions, showSession: sessionShows.show,
    // The tab closer takes the module clients' close guards, so it is read when a module closes a chat.
    closeChat: (sessionId) => closeChat(sessionId),
    // Built after the clients, at the end of setup; a view reads it when it opens.
    chatPane: () => chatPaneHost })
  const commandDefinitions = createMemo(() => buildCommandDefinitions(keymap.chordFor, signals.builtInCommands()))
  const commandCatalog = createMemo(() => commandSpecs(commandDefinitions()))
  function dispatchPaletteCommand(text: string): void {
    void commandDispatch.dispatch(text)
  }
  function activateModuleRow(action: ModuleRowAction): void {
    if (action.kind === "command") dispatchPaletteCommand(`/${action.id}`)
    else openSurface(action.id)
  }
  const { closeTab, closeChat } = createTabCloser({
    tabs, appService, switchForeground, startChat, closeSessionTab, removePendingTab, draftCache, seedSessionCatalogRow: services.seedSessionCatalogRow,
    showToast: services.showToast, closeGuards: moduleCloseGuards(moduleClients), firstTab: firstTab().current,
  })
  const {
    commandPalette, themeModal, profileModal, sessionModal, authModal, openSettingsDestination, openSubscriptionSpendReview, reviewCachedActiveProfile,
    statusModal, helpModal, backgroundModal, modelModal, findModal, sessionChangesModal, activeSessionCount, sessionCount,
  } = createModalModals({
    directories, launcher, clipboard, modal, signals, services, appService, sessions: signals.sessionCatalogRows, sessionCatalogErrors: signals.sessionCatalogErrors, tabs, appVersion, chat, startChat, switchForeground,
    activateSession, activateSessionById, closeSessionTab, closeChat, sessionNavigation: moduleSessionNavigation(moduleClients), settings, runtimeConfig, settingsOperations,
    signInPage: signInPage(attach),
    onPaletteActivate: dispatchPaletteCommand,
    commands: commandCatalog,
    moduleStatusRows: slots.statusRows,
    moduleSettingsRows: slots.settingsRows,
    refreshModuleStatus: slots.refreshStatus,
    activateModuleRow,
    navigateToProcess: tabPane.land,
    openTarget: async (target) => {
      if (target.kind === "session") { await activateSessionById(target.sessionId); return }
      for (const client of moduleClients) if (await client.openTarget?.(target)) return
    },
  })

  const place = createLaunchState({ projectRoot: stateRoot, handed: launchState, catalogReady: signals.catalogReady, signals, tabs, openSessionTab, draftCache, outbox: submissions, composer: () => composer, transcripts: services.transcripts, layout: transcriptLayout, overlay, activateSessionById,
    restoreModule: async (route) => { for (const client of moduleClients) if (await client.restore(route)) return true; return false },
    resolveSessionRoute: (id) => readSessionRoute(appService, signals.sessionCatalogRows(), id),
    reopen: { sessions: sessionModal.openSessionsModal, theme: themeModal.openThemeModal }, startChat: async () => (await startChat()).kind !== "failed", openFirstTab: () => firstTab().open(), seedSessionCatalogRow: services.seedSessionCatalogRow, startKnownEmptyTranscript: services.startKnownEmptyTranscript, lanes: appService })
  const setup = createMemo(() => providerSetup(signals.auth()))
  useAutomaticAuth({ auth: signals.auth, overlayOpen: () => overlay.isOpen(), open: authModal.openAuthModal })
  usePaidUseQuestion({ signals, overlayOpen: () => overlay.isOpen(), review: reviewCachedActiveProfile })
  useLoginQuestion({ auth: signals.auth, overlayOpen: () => overlay.isOpen(), open: authModal.openLoginQuestion })
  const inChat = createMemo(() => signals.sessionKind() === "chat")
  // eslint-disable-next-line solid/reactivity -- onceWhen evaluates this condition inside its createEffect scope
  onceWhen(() => Boolean(signals.foregroundId()) && inChat(), () => startupTrace("chat input mode ready"))
  const { startNewChat, startClearedChat } = createNewChatActions({ startChat, showToast: services.showToast, chordFor: keymap.chordFor })
  // Created ahead of the surface that hands files into it; the composer
  // registers its sink once its textarea mounts.
  const promptAttachSlot = createComposerAttachSlot()
  // Where this terminal opens every surface a command names: the kernel's own
  // by this table, and every module surface by its terminal home.
  const kernelSurfaces: KernelSurfaceTable = {
    "background": () => { const shown = transcriptInView.chatInView(); if (shown) shown.openBackground(); else backgroundModal.openBackgroundModal() },
    "models": ({ target }) => target?.kind === "transcript-in-view" ? transcriptInView.openModel() : openSettingsDestination({ kind: "models" }),
    "settings": ({ target }) => openSettingsDestination(target?.kind === "place" ? settingsPlace(target.place) : { kind: "root" }),
    "auth-profiles": ({ argument }) => profileModal.openProfileSwitcher(argument),
    "status": () => statusModal.openStatusModal(),
    "keyboard-shortcuts": () => helpModal.openHelpModal(),
    "commands": () => commandPalette.openCommandPalette(),
    "new-chat": () => startNewChat(),
    "sessions": () => sessionModal.openSessionsModal(),
    "changes": () => { const shown = transcriptInView.chatInView(); if (shown) shown.openChanges(); else sessionChangesModal.openSessionChangesModal() },
    "resume": () => { const shown = transcriptInView.chatInView(); if (shown) shown.resume(); else sessionControlsHook.resume() },
    "attach-files": createAttachFilesCommand({ launcher, showToast: services.showToast, slot: promptAttachSlot }),
    "find": ({ argument }) => findModal.openFindModal(argument),
    "close-chat": closeChatSurface({ agentInView: transcriptInView.agentInView, chatInView: transcriptInView.chatInView, chatInFront, closeChat, showToast: services.showToast }),
  }
  const openSurface = createSurfaceRouter({ kernel: kernelSurfaces, modules: slots.surfaces, report: createAsyncReporter(services.showToast),
    missing: (surface) => services.showToast({ message: `This client has no "${surface}" surface`, variant: "warning" }) })
  const captureSurfaceOpener = createSurfaceOpener({
    sessionId: sessionInView,
    placement: signals.foregroundRevision,
    surfaces: () => [modal.stack, overlay.viewer.stack],
    openSurface: (surface, isCurrent, opening) => openSurface(surface, { ...opening, isCurrent }),
  })
  const configToasts = createToastPresenter(services.showToast)
  createEffect(() => {
    const config = runtimeConfig.view()
    if (!config || config.status.kind === "valid") return
    configToasts.present("config.invalid", { message: config.status.message, variant: config.status.kind === "disposed" ? "error" : "warning", duration: 15000 })
  })
  onMount(() => {
    traceShellMount(renderer)
    // Rejected [keybindings] overrides are actionable config mistakes; surface
    // them rather than silently falling back to defaults.
    for (const issue of keymapIssues) configToasts.present("config.invalid", { message: issue, variant: "error", duration: 10000 })
    void place.restore().catch((cause: unknown) => services.showToast({ message: errorMessage(cause), variant: "error" }))
  })
  const commandContext = Object.freeze({
    signals, directories, appService, runtimeConfig, launcher,
    showToast: services.showToast,
    exit: exitTUI,
    restart: () => restartAttached(attach),
    startClearedChat,
    openThemeModal: themeModal.openThemeModal,
    openSurface,
    captureSurfaceOpener,
    focusSession,
    refreshCommandCatalog: services.refreshCommandCatalog, agentInView: transcriptInView.agentInView,
    chatSessionId: () => { const shown = transcriptInView.chatInView(); return shown ? shown.sessionId() : chatInFront() },
  })
  const commandDispatch = createCommandDispatch({
    definitions: commandDefinitions,
    context: commandContext,
    showToast: services.showToast,
    offCommands: signals.offCommands,
    catalog: services.commandCatalogReadiness,
    // The dispatcher knows a command ran; the runtime keeps the count so
    // every client ranks by the same one.
    recordUsage: createCommandUsageRecorder(appService),
  })
  const commands = useCommands({
    showToast: services.showToast,
    openSettingsDestination,
    dispatch: commandDispatch,
    sendMessage: submissions.send,
    startChat,
    providerSetup: setup,
    openSubscriptionSpendReview,
  })
  const slashCatalog = createMemo(() => commandsToOptions(commandCatalog()))
  // The popup ranks one row per command, so an alias's uses count toward it.
  const commandUses = createMemo(() => usesPerCommand(signals.commandUsage(), commandCatalog().map((spec) => ({ id: spec.id, aliases: spec.aliases ?? [] }))))
  const { handleKey, paneKey, promptBarActions } = createKeyboardHandler({
    signals,
    keymap,
    showToast: services.showToast,
    exit: exitTUI,
    tabs,
    startNewChat,
    chat,
    sessionModal,
    sessionControls: sessionControlsHook,
    overlay,
    questionInput,
    promptPopup: tabPane.promptPopup, strips: slots,
    openCommandPalette: commandPalette.openCommandPalette,
    switchForeground,
    dispatchOutputCommand: tabPane.output,
    closeTab,
  })
  useKeyboard(handleKey)
  onCleanup(() => { if (!renderer.isDestroyed) renderer.setTerminalTitle("") })

  const lineWidth = createMemo(() => Math.max(dimensions().width, 40))
  const compactionThreshold = () => signals.runtimeConfig()?.values.proactiveCompactionThreshold
  const header = createHeaderDisplay({
    surface: signals.foregroundSurface,
    dimensions,
    compactionThreshold,
    theme,
  })
  const tabsAvailableWidth = createMemo(() =>
    Math.max(0, dimensions().width - header.headerStats().width - 2)
  )
  const showPrompt = createMemo(() => !overlay.isOpen())
  // The one notice a runtime that is not healthy gets: never a recovery in
  // progress, only a fault, with the runtime's own cause when it reported one
  // and the remedy for this lane or remote machine, or a process for this
  // project that Flywheel starts again, with how it last stopped. A relay
  // terminal that installs the machine's release says so in the same notice,
  // and says why when it could not (PI-REMOTE-016).
  const releaseInstall = attach.kind === "relay" ? from<ReleaseInstall | undefined>((set) => attach.install.subscribe((install) => set(install))) : () => undefined
  const runtimeFault = createMemo(() => { const health = signals.runtimeHealth(); return health.kind === "healthy" ? null : tuiFaultNotice(runtimeFaultCopy(health, faultReach(attach, releaseInstall())), health, { client: appService, clipboard, showToast: toast.show }) })
  const updateStatus = createDismissibleUpdateStatus(signals.updateStatus)
  const diffColors = () => runtimeConfig.view()?.values.diffColors ?? "theme"
  const showThinking = () => runtimeConfig.view()?.values.showThinking ?? false
  // What every chat pane takes from the window: the tab in front and every view of a chat over it (PI-LEAD-005).
  const chatPaneHost: ChatPaneHost = {
    client: appService, showToast: services.showToast,
    provide: (children) => <SubagentControlsProvider value={subagentControls}><NavigationProvider value={navigateUri}>
      <ClientExtensionsProvider value={moduleClients}><ClientExtensionProviders>{children()}</ClientExtensionProviders></ClientExtensionsProvider>
    </NavigationProvider></SubagentControlsProvider>,
    createSurface: (sessionId) => services.createSessionSurface(sessionId),
    follow: signals.followSession,
    runtimeFault, update: updateStatus, chordFor: (commandId) => keymap.chordFor(commandId),
    activeSessionCount, sessionCount, chatDefault: signals.chatDefault,
    hidesTabControls: (sessionId) => hidesTabControls(moduleClients, sessionId),
    roleView: signals.roleView, childStatus: signals.childStatus, ensureChildViews: signals.ensureChildViews,
    branch: (sessionId) => signals.branch(sessionId),
    createChanges: services.createSessionChanges,
    openChanges: (changes) => sessionChangesModal.openSessionChangesModal(changes),
    layoutSlot: transcriptLayout,
    pendingSubmissions: (sessionId) => submissions.pending(sessionId),
    processControls,
    showThinking, diffColors,
    compactionThreshold, compact: chat.compactConversation,
    sessionIntro: {
      ...commonSessionIntro,
      noProviderReady: () => setup() === "none",
      releaseNotice: { notice: releaseNotice, dismiss: () => { void releaseNoticeActions.dismiss() } },
    },
    Strips: slots.Strips, sessionRows: slots.sessionRows, stripFocused: slots.stripFocused, releaseStripFocus: slots.releaseStripFocus,
    composer: {
      completableNames: commandDispatch.completableNames,
      dispatchableNames: commandDispatch.dispatchableNames,
      slashCatalog,
      projectFiles: (query) => appService.query({ type: "projectFiles", request: { query, limit: 10 } }).then((result) => result.entries),
      promptAttachSlot,
      history: promptHistory,
      commandFrequency: commandUses,
      clipboard,
      onAttachmentWarning: (message) => services.showToast({ message, variant: "warning" }),
      draftCache,
      onAnswerQuestion: chat.answerQuestion,
      onCancelQuestion: chat.cancelQuestion,
      onOpenSessions: sessionModal.openSessionsModal,
      onModuleAction: activateModuleRow,
      onNew: promptBarActions.newChat,
      onClose: promptBarActions.closeTab,
      onNextTab: promptBarActions.nextTab,
    },
    submit: commands.handleComposerSubmit,
    recallLocal: (sessionId) => submissions.recallLocal(sessionId),
    recallQueued: (sessionId) => submissions.recallQueued(sessionId, () => appService.query({ type: "recallQueuedMessage", sessionId })),
    openModel: (sessionId) => {
      if (sessionId === undefined || sessionId === signals.foregroundId()) { void modelModal.openActiveModelPicker(); return }
      // Another chat's own seat under its title, and never the chat in front's: its serving seat once its role view
      // is read, else the chat seat that serves every chat.
      const row = sessionTitles(sessionId)
      void modelModal.openActiveModelPicker({ sessionId, slot: signals.roleView(sessionId)?.serving?.slot ?? roleSlot("chat"),
        label: row ? effectiveSessionShortTitle(row.title, row.shortTitle) : "Chat" })
    },
    openBackground: (target) => backgroundModal.openBackgroundModal(target),
    transcriptInView,
    followBackground: signals.backgroundIndex.follow,
    paneKey,
  }
  return (
    <SubagentControlsProvider value={subagentControls}><NavigationProvider value={navigateUri}>
    <ClientExtensionsProvider value={moduleClients}><ClientExtensionProviders>
    <box width={dimensions().width} height={dimensions().height} flexDirection="column" backgroundColor={themeContext.baseBackground}
      onMouseDown={transcriptSelectionDrag.onMouseDown} onMouseDrag={transcriptSelectionDrag.onMouseDrag} onMouseUp={onShellMouseUp}>

      <box flexShrink={0} flexDirection="column">
        <box flexDirection="row">
          <box width={1} flexShrink={0} />
          <box flexGrow={1} overflow="hidden" flexShrink={1}>
            <TabsBar tabs={tabs} availableWidth={tabsAvailableWidth} theme={theme} onActivate={switchForeground} onNewTab={() => { void startChat() }} onReorder={reorderTab} />
          </box>
          <box flexDirection="column">
            <box height={1} />
            <SessionHeaderStats header={header} surface={signals.foregroundSurface} compact={chat.compactConversation} />
            <TabsBarDivider tabs={tabs} width={() => header.headerStats().width} theme={theme} />
          </box>
          <box width={1} flexShrink={0} />
        </box>
      </box>

      <ChatPane host={chatPaneHost} surface={signals.foregroundSurface} changes={signals.sessionChanges} controls={sessionControlsHook} input={tabPane}
        target={signals.foregroundTarget} width={lineWidth} focused={showPrompt}
        above={<StartupViewport foregroundKind={signals.foregroundTarget()?.kind} status={signals.startupStatus()} fault={runtimeFault()} />}
        recallFailed={() => { const failedChat = recallFailedChat(); return failedChat ? { kind: "input", input: failedChat } : null }}
        selectionDrag={transcriptSelectionDrag}
        ref={(handle) => { composer = handle }} />
      <ToastDisplay headerHeight={showPrompt() ? 3 : 0} />
    </box>
    </ClientExtensionProviders></ClientExtensionsProvider>
    </NavigationProvider></SubagentControlsProvider>
  )
}
