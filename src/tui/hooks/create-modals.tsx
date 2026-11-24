/** @jsxImportSource @opentui/solid */

import type { SignInPage } from "../terminal-attach.js"
import { batch, createMemo, createSignal, type Accessor } from "solid-js"
import type { SessionCatalogRow, AttachedRuntimeClient, RuntimeClient } from "../../protocol/app-service-types.js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import type { RuntimeAuthProfileScope } from "../../protocol/auth-profile-selection-protocol-types.js"
import type { ModuleRow, ModuleRowAction } from "../../protocol/protocol-module.js"
import type { AccountDirectories } from "../../infra/directory-authorities.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { KernelSurfaceTable } from "../commands/command-surfaces.js"
import type { CommandSpec } from "../commands/command-types.js"
import type { ModalContext } from "../components/modal-stack.js"
import { openExternalUrl } from "../../infra/open-external-url.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { Clipboard } from "../clipboard.js"
import type { SettingsOperations, SettingsStore } from "./create-settings-store.js"
import type { ShellServices, ShellSignals } from "./shell-state.js"
import type { RuntimeConfigCache } from "./create-runtime-config-cache.js"
import type { AuthModalHook } from "./auth-modal-types.js"
import { paidModeAwaitsAnswer, subscriptionSpendConsentNeedsReview } from "../../protocol/subscription-spend-consent-protocol-types.js"
import { PAID_USE_SETTINGS_LOAD_FAILURE } from "../../protocol/client/provider-account-copy.js"
import type { BackgroundModalTarget, useBackgroundModal } from "./use-background-modal.js"
import type { ModelModalHook } from "./use-model-modal.js"
import type { TabInfo } from "./create-tabs.js"
import { createSettingsTree } from "./settings-tree.js"
import { createAuthProfileSelection } from "./auth-profile-selection.js"
import { automaticDialogsEnabled } from "./automatic-dialogs.js"
import { createLazyController } from "./lazy-controller.js"
import type { SessionActivationResult } from "./session-activation.js"
import type { SessionCreationSettlement } from "./create-session-creator.js"
import { settingsPlace, type SettingsDestination } from "../settings-destination.js"
import { kernelModalControllers, LazyAuthModal, LazyBackgroundModal, LazyCommandPalette, LazyModalHelp, LazyModelModal, LazyProfileModal, LazySessionChangesModal, LazySessionModal, LazySettingsModal, LazyStatusModal, LazyThemeModal } from "../modals/lazy-modal-registry.js"
import { effectiveSessionShortTitle } from "../../protocol/app-service-types.js"

const log = Log.create({ service: "modals" })

interface ActiveProfileConsentInspection {
  appService: Pick<RuntimeClient, "query" | "dispatch">
  auth: Accessor<RuntimeAuthView | undefined>
  authScope: () => RuntimeAuthProfileScope
  agentState: Accessor<"idle" | "active">
  showRefreshFailure: () => void
  openPaidUseQuestion: (...args: Parameters<AuthModalHook["openPaidUseQuestion"]>) => Promise<boolean>
}

/** Asks the paid-use question for the first account of the active profile
 *  that waits for an answer, optionally refreshing the view first for an
 *  explicit foreground action. The question is closable; closing answers it.
 *  Automatic presentation respects the verification override without skipping refresh.
 *  Resolves true only when the question is on screen, so a caller that
 *  remembers what it asked can retry at the next safe moment otherwise. */
export async function inspectActiveProfileConsent(deps: ActiveProfileConsentInspection, refresh: boolean, automatic = false): Promise<boolean> {
  const auth = deps.auth()
  if (!auth || deps.agentState() === "active") return false
  const profileId = auth.profile.id
  const scope = deps.authScope()
  if (refresh) {
    const detection = await deps.appService.dispatch({ type: "auth.refresh", profileId, operationId: crypto.randomUUID() })
    if (!detection.ok) {
      deps.showRefreshFailure()
      return false
    }
  }
  const snapshot = await deps.appService.query({ type: "authStatusSnapshot", scope }).catch(() => {
    deps.showRefreshFailure()
    return undefined
  })
  if (!snapshot) return false
  const current = deps.auth()
  const currentScope = deps.authScope()
  const sameScope = scope.kind === "defaults" ? currentScope.kind === "defaults" : currentScope.kind === "session" && currentScope.sessionId === scope.sessionId
  if (!sameScope || deps.agentState() === "active" || current?.profile.id !== profileId || snapshot.auth.profile.id !== profileId) return false
  const consent = snapshot.auth.subscriptionSpendConsent
  if (consent.kind !== "available") return false
  const account = consent.accounts.find((candidate) => candidate.modes.some(paidModeAwaitsAnswer))
  if (!account) return false
  if (automatic && !automaticDialogsEnabled()) return false
  return deps.openPaidUseQuestion(snapshot.auth, snapshot.snapshotPosition, account)
}


interface ModalsDeps {
  /** Account directories the font, theme, and settings modals resolve their
   *  config paths from. */
  directories: AccountDirectories
  /** Launch authority every process these modals start - the browser
   *  handoff, the font cache refresh - is launched into. */
  launcher: LauncherScope
  clipboard: Clipboard
  modal: ModalContext
  signals: ShellSignals
  services: ShellServices
  appService: Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane">
  tabs: Accessor<readonly TabInfo[]>
  /** How many session tabs are open, which the status modal reports. */
  activeSessionCount: Accessor<number>
  appVersion: string
  /** The theme in effect now, which Settings shows as the Theme row's value. */
  currentThemeName: Accessor<string>
  startChat: () => Promise<SessionCreationSettlement>
  switchForeground: (id: string) => Promise<void>
  activateSession: (session: SessionCatalogRow) => Promise<SessionActivationResult>
  activateSessionById: (sessionId: string) => Promise<void>
  closeSessionTab: (sessionId: string) => void
  /** Close chat, which also removes the tab that shows the chat. */
  closeChat: (sessionId: string) => Promise<void>
  settings: SettingsStore
  runtimeConfig: RuntimeConfigCache
  settingsOperations: SettingsOperations
  /** Who opens a login's sign-in page, as this terminal's attach decides. */
  signInPage: SignInPage
  onPaletteActivate: (slashText: string) => void
  commands: Accessor<readonly CommandSpec[]>
  /** The status rows every module contributes, appended after the kernel rows. */
  moduleStatusRows: Accessor<readonly ModuleRow[]>
  refreshModuleStatus: () => void
  /** The Settings rows every module contributes at the client-modules slot. */
  moduleSettingsRows: Accessor<readonly ModuleRow[]>
  /** Runs a module row's action: a runtime command or a client surface. */
  activateModuleRow: (action: ModuleRowAction) => void
  navigateToProcess: (toolUseId: string) => void
  openTarget: Parameters<typeof useBackgroundModal>[0]["openTarget"]
}



/** Delete the foreground session, then fall back to a neighbouring tab.
 *  Delete is destructive durable intent, unlike tab close: a refused delete
 *  keeps the session, so its tab stays until the delete actually lands. The
 *  fallback is derived from the tab list that survives the delete, and it is
 *  applied only while the foreground the user chose has not moved on. */
export function createActiveSessionDelete(deps: {
  appService: Pick<RuntimeClient, "dispatch">
  signals: Pick<ShellSignals, "foregroundRevision">
  tabs: Accessor<readonly TabInfo[]>
  closeSessionTab: (sessionId: string) => void
  switchForeground: (sessionId: string) => Promise<void>
  startChat: () => Promise<SessionCreationSettlement>
}): (sessionId: string) => Promise<void> {
  return async function deleteActiveSession(sessionId: string): Promise<void> {
    const revision = deps.signals.foregroundRevision()
    const result = await deps.appService.dispatch({ type: "session.delete", sessionId })
    if (!result.ok) throw new Error(result.error)
    const index = deps.tabs().findIndex((tab) => tab.kind === "session" && tab.id === sessionId)
    deps.closeSessionTab(sessionId)
    if (deps.signals.foregroundRevision() !== revision) return
    const remaining = deps.tabs().filter((tab) => tab.kind !== "session" || tab.id !== sessionId)
    const fallback = index >= 0 ? (remaining[index] ?? remaining[index - 1]) : remaining[0]
    if (fallback) await deps.switchForeground(fallback.id)
    else await deps.startChat()
  }
}

/** The kernel surfaces that open a modal, which a command reaches through the
 *  surface router. */
type KernelModalSurfaces = Pick<KernelSurfaceTable, "background" | "settings" | "auth-profiles" | "status" | "keyboard-shortcuts" | "commands" | "sessions" | "changes">

/** Builds the kernel modals. Each controller loads and is created on its
 *  modal's first open, through the shared lazy controller loader, so startup
 *  constructs none of them. The openers and surfaces this returns are the
 *  only way in. */
export function createModalModals(deps: ModalsDeps) {
  const { modal, signals, services, switchForeground, startChat, clipboard } = deps
  const [pendingOpens, setPendingOpens] = createSignal(0)
  // Each kernel open supersedes every earlier one, so a first open that
  // waited for its controller never covers a modal that was asked for later.
  let latestOpen = 0
  /** One kernel modal's controller. `open` runs `use` on the controller,
   *  loading it first when needed. After a load, `use` runs only while no
   *  later kernel open came and `isCurrent`, the presentation check of the
   *  command that asked, still holds. A load failure is reported here and
   *  resolves undefined, because every opener is fire-and-forget. */
  function kernelModal<M, C>(name: string, load: () => Promise<M>, create: (loaded: M) => C) {
    const controller = createLazyController(load, create)
    async function open<R>(use: (loaded: C) => R, isCurrent?: () => boolean): Promise<Awaited<R> | undefined> {
      const request = ++latestOpen
      const loaded = controller.current()
      if (loaded !== undefined) return await use(loaded)
      // Until the modal opens, the screen counts as occupied, as it did when
      // every controller was built at startup, so an automatic question never
      // opens over a modal that the person or another question asked for.
      setPendingOpens((count) => count + 1)
      const created = await controller.load().catch((error: unknown) => {
        log.error("kernel modal controller load failed", { modal: name, error: errorMessage(error) })
        services.showToast({ message: `Could not open this modal: ${errorMessage(error)}`, variant: "error" })
        return undefined
      })
      const result = batch(() => {
        setPendingOpens((count) => count - 1)
        const wanted = created !== undefined && request === latestOpen && (isCurrent === undefined || isCurrent())
        return wanted ? use(created) : undefined
      })
      return await result
    }
    return { load: controller.load, open }
  }

  // The launch-derived capability this modal layer needs, narrowed at its own
  // boundary rather than handed the launcher itself.
  const openBrowser = (url: string): Promise<boolean> => openExternalUrl(deps.launcher, url)

  // Theme, Auth, Models, and Auth Profile are settings-tree children:
  // they open above the settings root so the left arrow always returns there.
  // Each child's loader loads the settings controller first, which binds the root.
  const settingsTree = createSettingsTree(modal)
  const treeModal = settingsTree.childModal
  const authScope = (): RuntimeAuthProfileScope => {
    const sessionId = signals.foregroundId()
    return sessionId === undefined ? { kind: "defaults" as const } : { kind: "session" as const, sessionId }
  }
  const inspectActiveProfile = (refresh: boolean, automatic = false) => inspectActiveProfileConsent({
    appService: deps.appService,
    auth: signals.auth,
    authScope,
    agentState: signals.agentState,
    showRefreshFailure: () => services.showToast({ message: PAID_USE_SETTINGS_LOAD_FAILURE, variant: "warning" }),
    openPaidUseQuestion: async (...args) => (await auth.open((controller) => controller.openPaidUseQuestion(...args))) === true,
  }, refresh, automatic)
  async function openAuthAccountDestination(destination: Extract<SettingsDestination, { readonly kind: "auth-account" }>, isCurrent?: () => boolean): Promise<void> {
    const current = signals.auth()
    if (!current) return
    const profileId = current.profile.id
    const scope = authScope()
    const snapshot = await deps.appService.query({ type: "authStatusSnapshot", scope })
    const published = signals.auth()
    const sameScope = scope.kind === "defaults" ? signals.foregroundId() === undefined : signals.foregroundId() === scope.sessionId
    if (!sameScope || published?.profile.id !== profileId || snapshot.auth.profile.id !== profileId) return
    const consent = snapshot.auth.subscriptionSpendConsent
    if (consent.kind !== "available") return
    const account = consent.accounts.find((candidate) => candidate.providerId === destination.providerId && candidate.accountCorrelationId === destination.accountCorrelationId)
    if (!account || (destination.envelopeId !== undefined && !account.modes.some((mode) => mode.envelopeId === destination.envelopeId))) return
    // A notification about paid capacity lands on the question while it is unanswered, and on the account's settings afterwards.
    await auth.open((controller) => account.modes.some(paidModeAwaitsAnswer)
      ? controller.openPaidUseQuestion(snapshot.auth, snapshot.snapshotPosition, account)
      : controller.openAuthAccountDetail(snapshot.auth, snapshot.snapshotPosition, account, destination.envelopeId), isCurrent)
  }
  const reviewActiveProfile = () => inspectActiveProfile(true, true)
  const reviewCachedActiveProfile = () => inspectActiveProfile(false)
  function openSubscriptionSpendReview(): boolean {
    const consent = signals.auth()?.subscriptionSpendConsent
    if (signals.agentState() === "active" || !consent || !subscriptionSpendConsentNeedsReview(consent)) return false
    void inspectActiveProfile(false)
    return true
  }
  /** Opens a place inside Settings; `isCurrent` is the presentation check of
   *  the command that asked, when one did. */
  async function openSettingsDestination(destination: SettingsDestination, isCurrent?: () => boolean): Promise<void> {
    switch (destination.kind) {
      case "root": await settings.open((controller) => controller.openSettingsModal(), isCurrent); return
      case "models": await model.open((controller) => controller.openModelsModal(), isCurrent); return
      case "auth": await auth.open((controller) => controller.openAuthModal(), isCurrent); return
      case "auth-provider": {
        await auth.open((controller) => {
          controller.openAuthModal()
          controller.focusProvider(destination.providerId)
        }, isCurrent)
        return
      }
      case "auth-account": await openAuthAccountDestination(destination, isCurrent); return
    }
  }
  const authProfileSelection = createAuthProfileSelection({ appService: deps.appService, foregroundSessionId: signals.foregroundId, showToast: services.showToast, reviewActiveProfile })

  const changes = kernelModal("changes", () => kernelModalControllers.changes(), ({ useSessionChangesModal }) => {
    const sessionChangesModal = useSessionChangesModal({
      modal, view: signals.sessionChanges,
      renderModal: () => <LazySessionChangesModal view={signals.sessionChanges()} controls={sessionChangesModal} projectRoot={signals.projectRoot()} diffColors={() => signals.display.diffColors} />,
    })
    return sessionChangesModal
  })
  const model = kernelModal("model", () => Promise.all([kernelModalControllers.model(), settings.load()]), ([{ useModelModal }]) => {
    const modelModal = useModelModal({
      modal: treeModal,
      renderModal: () => <LazyModelModal state={modelModal.modelModalState()} onClose={modelModal.closeModelModal} onSelect={modelModal.selectModelItem} />,
      showToast: services.showToast,
      appService: deps.appService,
      foregroundSessionId: signals.foregroundId,
      foregroundTitle: () => {
        const row = signals.foregroundSummary()
        return row === null ? undefined : effectiveSessionShortTitle(row.title, row.shortTitle)
      },
    })
    return modelModal
  })
  const commands = kernelModal("commands", () => kernelModalControllers.commands(), ({ useCommandPalette }) => {
    const commandPalette = useCommandPalette({
      modal,
      renderModal: () => <LazyCommandPalette state={commandPalette.commandPaletteState()} onClose={() => modal.clear()} onRowClick={commandPalette.handleRowClick} />,
      commands: deps.commands,
      onActivate: deps.onPaletteActivate,
    })
    return commandPalette
  })
  const theme = kernelModal("theme", () => Promise.all([kernelModalControllers.theme(), settings.load()]), ([{ useThemeModal }]) => {
    const themeModal = useThemeModal({
      config: deps.runtimeConfig,
      appService: deps.appService,
      modal: treeModal,
      renderModal: () => <LazyThemeModal result={themeModal.themeModalResult()} cursor={themeModal.themeModalCursor()} current={themeModal.currentThemeName()} saving={themeModal.saving()} onClose={() => modal.clear()} onRowClick={themeModal.selectThemeRow} />,
      showToast: services.showToast,
    })
    return themeModal
  })
  const profile = kernelModal("profile", () => Promise.all([kernelModalControllers.profile(), settings.load()]), ([{ useProfileModal }]) => {
    const profileModal = useProfileModal({
      modal: treeModal,
      auth: signals.auth,
      authProfileSelection,
      renderModal: () => <LazyProfileModal result={profileModal.profileModalResult()} cursor={profileModal.profileModalCursor()} current={profileModal.profileModalCurrent()} onClose={() => modal.clear()} onRowClick={profileModal.selectProfileRow} />,
      showToast: services.showToast,
    })
    return profileModal
  })
  const background = kernelModal("background", () => kernelModalControllers.background(), ({ useBackgroundModal }) => {
    const backgroundModal = useBackgroundModal({
      modal,
      renderModal: () => (
        <LazyBackgroundModal
          result={backgroundModal.backgroundModalResult()}
          cursor={backgroundModal.backgroundModalCursor()}
          navigationRevision={backgroundModal.backgroundModalNavigationRevision()}
          filter={backgroundModal.backgroundModalFilter()}
          empty={backgroundModal.backgroundModalEmpty()}
          tail={backgroundModal.backgroundModalTail}
          onClose={() => modal.clear()}
          onRowClick={backgroundModal.landBackgroundRow}
          onStopClick={backgroundModal.stopBackgroundRow}
          onFilter={backgroundModal.setBackgroundFilter}
        />
      ),
      signals,
      appService: deps.appService,
      showToast: services.showToast,
      navigateToProcess: deps.navigateToProcess,
      openTarget: deps.openTarget,
    })
    return backgroundModal
  })
  const status = kernelModal("status", () => kernelModalControllers.status(), ({ statusRows, useStatusModal }) => {
    const foregroundBudget = () => {
      const sessionId = signals.foregroundId()
      return sessionId ? signals.budgetView(sessionId) : undefined
    }
    const statusModalRows = createMemo(() => [
      ...statusRows({
        sessionId: signals.foregroundId(),
        sessionKind: signals.sessionKind(),
        sessionState: signals.sessionState(),
        modelLabel: signals.activeModelLabel(),
        budget: foregroundBudget(),
        activeSessionCount: deps.activeSessionCount(),
        sessionCount: signals.sessionCount(),
        appVersion: deps.appVersion,
        projectRoot: signals.projectRoot(),
        executionCwd: signals.sessionExecutionCwd(),
        update: signals.updateStatus(),
      }),
      ...deps.moduleStatusRows(),
    ])
    const statusModal = useStatusModal({
      onOpen: deps.refreshModuleStatus,
      modal,
      renderModal: () => (
        <LazyStatusModal
          rows={statusModalRows()}
          cursor={statusModal.statusCursor()}
          onRowClick={statusModal.selectStatusRow}
          onClose={() => statusModal.closeStatusModal()}
        />
      ),
      rows: statusModalRows,
      copy: (text) => clipboard.copy(text),
      activate: deps.activateModuleRow,
      showToast: services.showToast,
    })
    return statusModal
  })
  const help = kernelModal("help", () => kernelModalControllers.help(), ({ useHelpModal }) => useHelpModal({
    modal,
    renderModal: (scroll) => <LazyModalHelp onClose={() => modal.clear()} scroll={scroll} />,
  }))
  const sessions = kernelModal("sessions", () => kernelModalControllers.sessions(), ({ useSessionModal }) => {
    const sessionModal = useSessionModal({
      modal,
      renderModal: () => (
        <LazySessionModal
          result={sessionModal.sessionModalResult()}
          cursor={sessionModal.modalCursor()}
          navigationRevision={sessionModal.modalNavigationRevision()}
          actions={sessionModal.sessionModalActions()}
          appService={deps.appService}
          onClose={() => sessionModal.closeSessionsModal()}
          onRowClick={sessionModal.selectModalItem}
          filterQuery={sessionModal.filterQuery()}
          inputPresentation={sessionModal.inputPresentation()}
          inputPlaceholder="Search"
          renaming={sessionModal.renameState() !== undefined}
          renameField={sessionModal.renameState()?.field}
          renamePresentation={sessionModal.renamePresentation}
          foregroundId={signals.foregroundId()}
          statusView={signals.statusView}
          waitingSessions={signals.waitingSessions()}
          now={sessionModal.pickerNow()}
          confirmDeleteSessionId={sessionModal.modalConfirmDelete()}
          showThinking={signals.display.showThinking}
          diffColors={() => signals.display.diffColors}
        />
      ),
      signals,
      appService: deps.appService,
      showToast: services.showToast,
      clipboard,
      sessions: signals.listedSessions,
      sessionCatalogErrors: signals.sessionCatalogErrors,
      activateSession: deps.activateSession,
      activateSessionById: deps.activateSessionById,
      landOnEntry: deps.navigateToProcess,
      closeChat: deps.closeChat,
      deleteActiveSession: createActiveSessionDelete({
        appService: deps.appService,
        signals,
        tabs: deps.tabs,
        closeSessionTab: deps.closeSessionTab,
        switchForeground,
        startChat,
      }),
    })
    return sessionModal
  })
  const auth = kernelModal("auth", () => Promise.all([kernelModalControllers.auth(), settings.load()]), ([{ useAuthModal }]) => {
    const authModal = useAuthModal({
      auth: signals.auth,
      authProfileSelection,
      modal: treeModal,
      renderModal: () => <LazyAuthModal
        view={authModal.authView()}
        disconnect={authModal.disconnectConfirmation()}
        profileAttemptPending={authModal.profileAttemptPending()}
        rows={authModal.authRows()}
        cursor={authModal.authModalCursor()}
        inputPresentation={authModal.authInputPresentation()}
        consent={authModal.subscriptionSpendConsent.state}
        onClose={() => authModal.closeAuthModal()}
        onRenameBlur={authModal.finishRename}
        onSelect={authModal.selectProvider}
        onSelectModel={authModal.selectProviderModel}
        onRecheckModels={authModal.recheckProviderModels}
        onOpenModels={authModal.openAccountModels}
        onToggleFreeRoutes={authModal.toggleFreeRoutes}
        onToggleConsent={authModal.subscriptionSpendConsent.toggle}
        onContinueConsent={() => { void authModal.subscriptionSpendConsent.decline() }}
        onConfirmDisconnect={authModal.confirmDisconnect}
        onCancelDisconnect={authModal.cancelDisconnect}
        onAnswerLoginQuestion={authModal.answerLoginQuestion}
        onAnswerLoginConfirmation={authModal.answerLoginConfirmation}
      />,
      showToast: services.showToast,
      appService: deps.appService,
      openBrowser,
      signInPage: deps.signInPage,
      clipboard,
    })
    return authModal
  })
  const settings = kernelModal("settings", () => kernelModalControllers.settings(), ({ useSettingsModal }) => {
    const settingsModal = useSettingsModal({
      directories: deps.directories,
      launcher: deps.launcher,
      modal,
      renderModal: () => (
        <LazySettingsModal
          cursor={settingsModal.settingsModalCursor()}
          view={settingsModal.settingsView()}
          onClose={() => settingsModal.closeSettingsModal()}
          onEditBlur={settingsModal.finishSettingsEdit}
          onActivate={settingsModal.activateSettingsRow}
          onToggle={settingsModal.toggleSettingsOption}
          onSelect={settingsModal.selectSettingsOption}
        />
      ),
      showToast: services.showToast,
      moduleRows: deps.moduleSettingsRows,
      activateModuleRow: deps.activateModuleRow,
      authProfileSelection,
      settings: deps.settings,
      operations: deps.settingsOperations,
      updateStatus: signals.updateStatus,
      auth: signals.auth,
      appService: deps.appService,
      gitAiAttributionStatus: signals.gitAiAttribution,
      setUpdateAutoInstall: async (expected, value) => {
        const result = await deps.appService.dispatch({ type: "settings.set_update_auto_install", expected, value })
        return result.ok ? { ok: true } : { ok: false, error: { message: result.error } }
      },
      capabilities: {
        view: signals.moduleSelection,
        setModule: async (moduleId, expected, enabled) => {
          const result = await deps.appService.dispatch({ type: "settings.set_module", moduleId, expected, enabled })
          return result.ok ? { ok: true } : { ok: false, error: { message: result.error } }
        },
        setModules: async (preset, expected) => {
          const result = await deps.appService.dispatch({ type: "settings.set_modules", preset, expected })
          return result.ok ? { ok: true } : { ok: false, error: { message: result.error } }
        },
        setWorkflowMode: async (expected, mode) => {
          const result = await deps.appService.dispatch({ type: "settings.set_workflow_mode", expected, mode })
          return result.ok ? { ok: true } : { ok: false, error: { message: result.error } }
        },
        setPersistentProcesses: async (expected, enabled) => {
          const result = await deps.appService.dispatch({ type: "settings.set_persistent_processes", expected, enabled })
          return result.ok ? { ok: true } : { ok: false, error: { message: result.error } }
        },
      },
      currentThemeName: deps.currentThemeName,
      openThemeModal: () => { void theme.open((controller) => controller.openThemeModal()) },
      openSettingsDestination,
      openSessionsModal: () => { void sessions.open((controller) => controller.openSessionsModal()) },
      openAuthProfiles: () => { void profile.open((controller) => controller.openProfileSwitcher()) },
      openStatusModal: () => { void status.open((controller) => controller.openStatusModal()) },
    })
    settingsTree.bindRoot({ open: settingsModal.openSettingsModal, isOpen: settingsModal.settingsModalOpen })
    return settingsModal
  })
  const surfaces: KernelModalSurfaces = {
    "background": ({ isCurrent }) => background.open((controller) => controller.openBackgroundModal(), isCurrent),
    "settings": ({ target, isCurrent }) => openSettingsDestination(target?.kind === "place" ? settingsPlace(target.place) : { kind: "root" }, isCurrent),
    "auth-profiles": ({ argument, isCurrent }) => profile.open((controller) => controller.openProfileSwitcher(argument), isCurrent),
    "status": ({ isCurrent }) => status.open((controller) => controller.openStatusModal(), isCurrent),
    "keyboard-shortcuts": ({ isCurrent }) => help.open((controller) => controller.openHelpModal(), isCurrent),
    "commands": ({ isCurrent }) => commands.open((controller) => controller.openCommandPalette(), isCurrent),
    "sessions": ({ isCurrent }) => sessions.open((controller) => controller.openSessionsModal(), isCurrent),
    "changes": ({ isCurrent }) => changes.open((controller) => controller.openSessionChangesModal(), isCurrent),
  }
  return {
    surfaces,
    openSessionChangesModal: () => changes.open((controller) => controller.openSessionChangesModal()),
    openActiveModelPicker: (target?: Parameters<ModelModalHook["openActiveModelPicker"]>[0]) => model.open((controller) => controller.openActiveModelPicker(target)),
    openCommandPalette: () => commands.open((controller) => controller.openCommandPalette()),
    openThemeModal: () => theme.open((controller) => controller.openThemeModal()),
    openSessionsModal: () => sessions.open((controller) => controller.openSessionsModal()),
    openAuthModal: () => auth.open((controller) => controller.openAuthModal()),
    /** Answers true at once: the question opens when the controller has
     *  loaded, and `onUndelivered` runs when it cannot. */
    openLoginQuestion: (questionId: string, onUndelivered: () => void): boolean => {
      void auth.open((controller) => controller.openLoginQuestion(questionId, onUndelivered)).then((opened) => { if (opened !== true) onUndelivered() })
      return true
    },
    openBackgroundModal: (target?: BackgroundModalTarget) => background.open((controller) => controller.openBackgroundModal(target)),
    openSettingsDestination, openSubscriptionSpendReview, reviewCachedActiveProfile,
    /** Whether a kernel modal waits for its controller to open; automatic
     *  questions treat the screen as occupied meanwhile. */
    opening: () => pendingOpens() > 0,
  }
}
