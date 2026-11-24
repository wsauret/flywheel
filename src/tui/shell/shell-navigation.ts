import { useOverlay } from "@tui/components/modal/modal"
import type { LaunchState } from "../../infra/distribution/launch-state.js"
import { effectiveSessionShortTitle, type AttachedRuntimeClient, type SessionRow } from "../../protocol/app-service-types.js"
import type { BackgroundWorkTarget } from "../../protocol/background-index-protocol-types.js"
import { sessionServingLabel } from "../../protocol/role-protocol-types.js"
import type { RowProcessControls } from "../transcript/output-blocks/stop-affordance.js"
import type { TranscriptLayoutSlot } from "../transcript/output-window/output-window-scroll.js"
import type { SessionIntroProps } from "../transcript/welcome-notice.js"
import { createTuiModuleClients, moduleNavigation } from "../modules.js"
import { createChildViewerOpener } from "../child-viewer/create-child-viewer-opener.js"
import { createLaunchState } from "../hooks/create-launch-state.js"
import { createLateBinding } from "../hooks/wiring/late-binding.js"
import { createLinkNavigator, createSessionActivatorById, readSessionRoute } from "../hooks/foreground/session-activation.js"
import { useShellState } from "../hooks/state/shell-state.js"
import type { ShellComposerCore } from "./shell-composer-core.js"
import type { ShellPlaces } from "./shell-places.js"
import type { ShellOverlays } from "./shell-overlays.js"

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
