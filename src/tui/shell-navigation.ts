import { createEffect, createMemo, type Accessor } from "solid-js"
import { useOverlay } from "@tui/components/modal"
import { useKeymap } from "@tui/context/keymap"
import { Log } from "../infra/log.js"
import type { LaunchState } from "../infra/launch-state.js"
import { effectiveSessionShortTitle, type AttachedRuntimeClient, type SessionRow } from "../protocol/app-service-types.js"
import type { BackgroundWorkTarget } from "../protocol/background-index-protocol-types.js"
import { createOpenSessionKeeper } from "../protocol/client/open-session-keeper.js"
import { sessionServingLabel } from "../protocol/role-protocol-types.js"
import type { RowProcessControls } from "./output-blocks/stop-affordance.js"
import type { TranscriptLayoutSlot } from "./output-window/output-window-scroll.js"
import type { SessionIntroProps } from "./welcome-notice.js"
import { createTuiModuleClients, moduleNavigation } from "./modules.js"
import { discardIfTransientForeground } from "./hooks/background-foreground.js"
import { createChildViewerOpener } from "./create-child-viewer-opener.js"
import { createForegroundSwitcher } from "./hooks/create-foreground-switcher.js"
import { createLaunchState } from "./hooks/create-launch-state.js"
import { createSessionCreator } from "./hooks/create-session-creator.js"
import { createTabCloser } from "./hooks/create-tab-closer.js"
import { createTabState } from "./hooks/create-tabs.js"
import { createLateBinding } from "./hooks/late-binding.js"
import { createLinkNavigator, createSessionActivator, createSessionActivatorById, readSessionRoute } from "./hooks/session-activation.js"
import { useShellState } from "./hooks/shell-state.js"
import { createFocusedSessionReadiness, useOpenSessionRunners } from "./hooks/use-open-session-runners.js"
import type { ShellComposerCore } from "./shell-composer.js"
import type { ShellOverlays } from "./shell-overlays.js"

const keeperLog = Log.create({ service: "session-keeper" })

interface ShellPlacesDeps {
  readonly appService: AttachedRuntimeClient
  readonly composer: Pick<ShellComposerCore, "draftCache" | "composerReturns" | "handle">
  readonly firstFrame: Accessor<boolean>
  /** True once the first frame is drawn and the runtime is ready. */
  readonly ready: Accessor<boolean>
}

/** The places the shell shows: the tabs, the session in front, and how a
 *  chat starts, comes to the front, and closes. The overlays open these
 *  places, so they come first. */
export function createShellPlaces(deps: ShellPlacesDeps) {
  const { signals, services } = useShellState()
  const overlay = useOverlay()
  const { keymap } = useKeymap()
  const { draftCache, composerReturns } = deps.composer
  const { tabs, openSessionTab, closeSessionTab, openPendingTab, removePendingTab, hasPendingTab, isTransientSessionTab, reorderTab } = createTabState({ sessions: signals.sessionCatalogRows, signals })
  const sessionTabs = () => tabs().filter((tab) => tab.kind === "session")
  const activeSessionCount = createMemo(() => sessionTabs().length)
  createEffect(() => { composerReturns.own(deps.firstFrame() ? sessionTabs().map((tab) => tab.id) : []) })
  const switchForeground = createForegroundSwitcher({ signals, sessions: signals.sessionCatalogRows, tabs })
  const focusReady = createFocusedSessionReadiness(() => { const id = signals.foregroundId(); return id === undefined || services.transcripts.isCurrent(id) })
  useOpenSessionRunners({
    tabs,
    ready: deps.ready,
    keeper: createOpenSessionKeeper({ client: deps.appService, focusReady, onDiagnostic: (message, detail) => keeperLog.warn(message, { detail }) }),
  })
  const { startChat, focusSession, recallFailedChat } = createSessionCreator({
    signals,
    appService: deps.appService,
    openSessionTab,
    openPendingTab,
    removePendingTab,
    hasPendingTab,
    tabs,
    draftCache,
    adoptDraft: (key, sessionId) => deps.composer.handle().adoptDraft(key, sessionId),
    seedSessionCatalogRow: services.seedSessionCatalogRow,
    startKnownEmptyTranscript: services.startKnownEmptyTranscript,
    retireTransientSession: (sessionId) => { void discardIfTransientForeground({ draftCache, appService: deps.appService, showToast: services.showToast, closeSessionTab, isTransientSessionTab }, sessionId) },
    showToast: services.showToast,
  })
  const activateSession = createSessionActivator({
    signals,
    draftCache,
    appService: deps.appService,
    openSessionTab,
    closeSessionTab,
    isTransientSessionTab,
    showToast: services.showToast,
    dismissModalStack: overlay.clear,
  })
  const { closeTab, closeChat } = createTabCloser({
    tabs, appService: deps.appService, switchForeground, startChat, closeSessionTab, removePendingTab, draftCache, seedSessionCatalogRow: services.seedSessionCatalogRow,
    showToast: services.showToast,
  })
  async function startNewChat(): Promise<void> {
    const settlement = await startChat()
    if (settlement.kind === "foregrounded") {
      services.showToast({ message: "New chat started", variant: "success" })
    }
  }
  // /clear serves muscle memory from harnesses where it wipes the session in
  // place. Flywheel sessions are tabs, so it opens a fresh tab like /new and
  // teaches the model once, at the moment the user reached for a reset.
  async function startClearedChat(): Promise<void> {
    const settlement = await startChat()
    if (settlement.kind === "foregrounded") {
      services.showToast({
        message: `Sessions are tabs: this is a fresh one. Chats with content keep their tabs; unused empty tabs are replaced. ${keymap.chordFor("new")} new, ${keymap.chordFor("tab.close")} close tab.`,
        variant: "info",
        duration: 8000,
      })
    }
  }
  return {
    tabs, openSessionTab, closeSessionTab, reorderTab, activeSessionCount, switchForeground,
    startChat, startNewChat, startClearedChat, focusSession, recallFailedChat, activateSession, closeTab, closeChat,
  }
}

export type ShellPlaces = ReturnType<typeof createShellPlaces>

/** The welcome card rows that every session view shows alike. */
type SharedSessionIntro = Pick<SessionIntroProps, "runtimeIdentity" | "showBuild" | "projectRoot" | "userDataRoot" | "accountHome" | "profileName" | "moduleRows" | "fontTipDismissed" | "tabsHintDismissed" | "onDismissTabsHint">

interface ShellNavigationDeps {
  readonly appService: AttachedRuntimeClient
  readonly stateRoot: string
  readonly launchState: LaunchState | undefined
  readonly composer: Pick<ShellComposerCore, "draftCache" | "submissions" | "composerReturns" | "handle">
  readonly places: ShellPlaces
  readonly overlays: Pick<ShellOverlays, "modals" | "transcriptInView">
  readonly processControls: (sessionId: string) => RowProcessControls
  readonly transcriptLayout: (sessionId: string) => TranscriptLayoutSlot
  readonly sessionIntro: SharedSessionIntro
  readonly dispatchCommand: (text: string) => Promise<boolean>
}

/** How the shell reaches a place that a link, an id, or a module names: the
 *  child viewers, the module clients, and the place a predecessor terminal
 *  handed this one. */
export function createShellNavigation(deps: ShellNavigationDeps) {
  const { signals, services } = useShellState()
  const overlay = useOverlay()
  const { places, composer } = deps
  const { openActiveModelPicker, openBackgroundModal, openSessionsModal, openThemeModal } = deps.overlays.modals
  const viewer: Parameters<typeof createChildViewerOpener>[0]["viewer"] = (sessionId) => ({
    createSurface: services.createSessionSurface,
    appService: deps.appService, submissions: { send: composer.submissions.sendWithReceipt, recallQueued: composer.submissions.recallQueued },
    modelLabel: () => sessionServingLabel(signals.roleView(sessionId)),
    onOpenModel: (agentName) => {
      const slot = signals.roleView(sessionId)?.serving?.slot
      if (slot !== undefined) void openActiveModelPicker({ sessionId, slot, label: agentName })
    },
    transcriptInView: deps.overlays.transcriptInView,
    onOpenBackground: (target) => openBackgroundModal(target),
    followBackground: signals.backgroundIndex.follow,
    compactionThreshold: () => signals.display.compactionThreshold,
    roleView: signals.roleView,
    childStatus: signals.childStatus,
    ensureChildViews: signals.ensureChildViews,
    layoutSlot: deps.transcriptLayout(sessionId),
    createProcessControls: deps.processControls,
    sessionIntro: {
      ...deps.sessionIntro,
      branchName: () => signals.branch(sessionId),
      modelLabel: () => undefined,
    },
    showThinking: () => signals.display.showThinking,
    inputReady: () => services.transcripts.isCurrent(sessionId),
    diffColors: () => signals.display.diffColors,
  })
  // A viewer's link can open another viewer, and a child that a module
  // client claims opens through the module that the child viewers serve, so
  // link and module navigation recur through these two bindings.
  const followLink = createLateBinding<[uri: string], void>("link navigation")
  const openModuleSession = createLateBinding<[session: Pick<SessionRow, "id" | "kind">], Promise<boolean>>("module session navigation")
  const childPlaces = createChildViewerOpener({
    navigateUri: followLink.call, viewer, viewerLayer: overlay.viewer, showToast: services.showToast,
    returnDraft: composer.composerReturns.returnDraft,
    client: deps.appService, dispatchCommand: deps.dispatchCommand,
    openModuleSession: openModuleSession.call,
  })
  const activateSessionById = createSessionActivatorById({
    rows: signals.sessionCatalogRows,
    appService: deps.appService,
    activateSession: places.activateSession,
    openChild: childPlaces.openChild,
    seedSessionCatalogRow: services.seedSessionCatalogRow,
    showToast: services.showToast,
  })
  const moduleClients = createTuiModuleClients({
    domains: signals.modules, client: deps.appService,
    roleView: signals.roleView, ensureRoleViews: signals.ensureRoleViews,
    viewerLayer: overlay.viewer, viewer, openChild: childPlaces.openChild,
    // The title the session's tab and list row show, which a workflow's way
    // back names as the place it returns to.
    title: (sessionId) => {
      const row = signals.sessionRow(sessionId)
      return row === undefined ? undefined : effectiveSessionShortTitle(row.title, row.shortTitle)
    },
    navigateUri: followLink.call, navigateSession: activateSessionById, showToast: services.showToast, dispatchCommand: deps.dispatchCommand,
  })
  const modules = moduleNavigation(moduleClients)
  openModuleSession.bind(modules.openSession)
  const navigateUri = createLinkNavigator({ openSession: activateSessionById, openModuleUri: modules.openUri, showToast: services.showToast })
  followLink.bind(navigateUri)
  async function openTarget(target: BackgroundWorkTarget): Promise<void> {
    if (target.kind === "session") await activateSessionById(target.sessionId)
    else await modules.openTarget(target)
  }
  const place = createLaunchState({
    projectRoot: deps.stateRoot, handed: deps.launchState, catalogReady: signals.catalogReady, signals, tabs: places.tabs, openSessionTab: places.openSessionTab,
    draftCache: composer.draftCache, outbox: composer.submissions, composer: composer.handle, transcripts: services.transcripts, layout: deps.transcriptLayout, overlay, activateSessionById,
    restoreModule: modules.restore,
    resolveSessionRoute: (id) => readSessionRoute(deps.appService, signals.sessionRow, id),
    reopen: { sessions: openSessionsModal, theme: openThemeModal },
    startChat: async () => (await places.startChat()).kind !== "failed",
    lanes: deps.appService,
  })
  return { navigateUri, activateSessionById, openTarget, moduleClients, modules, place }
}
