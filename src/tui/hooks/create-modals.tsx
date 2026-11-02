/** @jsxImportSource @opentui/solid */

import type { SignInPage } from "../terminal-attach.js"
import { createMemo, type Accessor } from "solid-js"
import type { SessionCatalogError, SessionCatalogRow, AttachedRuntimeClient, RuntimeClient } from "../../protocol/app-service-types.js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import type { RuntimeAuthProfileScope } from "../../protocol/auth-profile-selection-protocol-types.js"
import type { ModuleRow, ModuleRowAction } from "../../protocol/protocol-module.js"
import type { AccountDirectories } from "../../infra/directory-authorities.js"
import type { CommandSpec } from "../commands/command-types.js"
import type { ModalContext } from "../components/modal-stack.js"
import { openExternalUrl } from "../../infra/open-external-url.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { Clipboard } from "../utils/clipboard.js"
import { sessionModelLabel } from "./active-model-label.js"
import type { SettingsOperations, SettingsStore } from "./create-settings-store.js"
import type { RuntimeConfigCache, ShellServices, ShellSignals } from "./shell-state.js"
import { useAuthModal } from "./use-auth-modal.js"
import { paidModeAwaitsAnswer, subscriptionSpendConsentNeedsReview } from "../../protocol/subscription-spend-consent-protocol-types.js"
import { PAID_USE_SETTINGS_LOAD_FAILURE } from "../../protocol/client/provider-account-copy.js"
import { useBackgroundModal } from "./use-background-modal.js"
import type { ChatModeHook } from "./use-chat-mode.js"
import { useCommandPalette } from "./use-command-palette.js"
import { useHelpModal } from "./use-help-modal.js"
import { useModelModal } from "./use-model-modal.js"
import type { TabInfo } from "./create-tabs.js"
import { useSessionModal } from "./use-session-modal.js"
import { useSettingsModal } from "./use-settings-modal.js"
import { createSettingsTree } from "./settings-tree.js"
import { useProfileModal } from "./use-profile-modal.js"
import { createAuthProfileSelection } from "./auth-profile-selection.js"
import { automaticDialogsEnabled } from "./automatic-dialogs.js"
import { statusRows, useStatusModal } from "./use-status-modal.js"
import { useFindModal } from "./use-find-modal.js"
import { useThemeModal } from "./use-theme-modal.js"
import { useSessionChangesModal } from "./use-session-changes-modal.js"
import type { SessionActivationResult } from "./session-activation.js"
import type { SessionCreationSettlement } from "./create-session-creator.js"
import type { SettingsDestination } from "../settings-destination.js"
import { LazyAuthModal, LazyBackgroundModal, LazyCommandPalette, LazyModalHelp, LazyModelModal, LazyProfileModal, LazySessionChangesModal, LazySessionModal, LazySettingsModal, LazyStatusModal, LazyThemeModal, LazyFindModal } from "../modals/lazy-modal-registry.js"
import { effectiveSessionShortTitle } from "../../protocol/app-service-types.js"

interface ActiveProfileConsentInspection {
  appService: Pick<RuntimeClient, "query" | "dispatch">
  auth: Accessor<RuntimeAuthView | undefined>
  authScope: () => RuntimeAuthProfileScope
  agentState: Accessor<"idle" | "active">
  showRefreshFailure: () => void
  openPaidUseQuestion: (auth: RuntimeAuthView, snapshotPosition: number, providerId: string, accountCorrelationId: string) => boolean
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
  return deps.openPaidUseQuestion(snapshot.auth, snapshot.snapshotPosition, account.providerId, account.accountCorrelationId)
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
  sessions: Accessor<readonly SessionCatalogRow[]>
  sessionCatalogErrors: Accessor<readonly SessionCatalogError[]>
  sessionCount: Accessor<number>
  tabs: Accessor<readonly TabInfo[]>
  appVersion: string
  chat: ChatModeHook
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

export function createModalModals(deps: ModalsDeps) {
  const { modal, signals, services, switchForeground, startChat, clipboard } = deps
  const sessionChangesModal = useSessionChangesModal({
    modal, view: signals.sessionChanges,
    renderModal: () => <LazySessionChangesModal view={signals.sessionChanges()} controls={sessionChangesModal} projectRoot={signals.projectRoot()} diffColors={() => signals.runtimeConfig()?.values.diffColors ?? "theme"} />,
  })
  // The launch-derived capability this modal layer needs, narrowed at its own
  // boundary rather than handed the launcher itself.
  const openBrowser = (url: string): Promise<boolean> => openExternalUrl(deps.launcher, url)

  // Theme, Auth, Models, and Auth Profile are settings-tree children:
  // they open above the settings root so the left arrow always returns there.
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
    openPaidUseQuestion: (...args) => authModal.openPaidUseQuestion(...args),
  }, refresh, automatic)
  async function openAuthAccountDestination(destination: Extract<SettingsDestination, { readonly kind: "auth-account" }>): Promise<void> {
    const auth = signals.auth()
    if (!auth) return
    const profileId = auth.profile.id
    const scope = authScope()
    const snapshot = await deps.appService.query({ type: "authStatusSnapshot", scope })
    const current = signals.auth()
    const sameScope = scope.kind === "defaults" ? signals.foregroundId() === undefined : signals.foregroundId() === scope.sessionId
    if (!sameScope || current?.profile.id !== profileId || snapshot.auth.profile.id !== profileId) return
    const consent = snapshot.auth.subscriptionSpendConsent
    if (consent.kind !== "available") return
    const account = consent.accounts.find((candidate) => candidate.providerId === destination.providerId && candidate.accountCorrelationId === destination.accountCorrelationId)
    if (!account || (destination.envelopeId !== undefined && !account.modes.some((mode) => mode.envelopeId === destination.envelopeId))) return
    // A notification about paid capacity lands on the question while it is unanswered, and on the account's settings afterwards.
    if (account.modes.some(paidModeAwaitsAnswer)) authModal.openPaidUseQuestion(snapshot.auth, snapshot.snapshotPosition, account.providerId, account.accountCorrelationId)
    else authModal.openAuthAccountDetail(snapshot.auth, snapshot.snapshotPosition, account.providerId, account.accountCorrelationId, destination.envelopeId)
  }
  const reviewActiveProfile = () => inspectActiveProfile(true, true)
  const reviewCachedActiveProfile = () => inspectActiveProfile(false)
  function openSubscriptionSpendReview(): boolean {
    const consent = signals.auth()?.subscriptionSpendConsent
    if (signals.agentState() === "active" || !consent || !subscriptionSpendConsentNeedsReview(consent)) return false
    void inspectActiveProfile(false)
    return true
  }
  async function openSettingsDestination(destination: SettingsDestination): Promise<void> {
    switch (destination.kind) {
      case "root": settingsModal.openSettingsModal(); return
      case "models": await modelModal.openModelsModal(); return
      case "auth": authModal.openAuthModal(); return
      case "auth-provider": {
        authModal.openAuthModal()
        authModal.focusProvider(destination.providerId)
        return
      }
      case "auth-account": await openAuthAccountDestination(destination); return
    }
  }
  const authProfileSelection = createAuthProfileSelection({ appService: deps.appService, foregroundSessionId: signals.foregroundId, showToast: services.showToast, reviewActiveProfile })

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
  const activeModelLabel = createMemo(() => {
    const foregroundId = signals.foregroundId()
    return sessionModelLabel(foregroundId ? signals.roleView(foregroundId) : undefined, signals.chatDefault())
  })
  const commandPalette = useCommandPalette({
    modal,
    renderModal: () => <LazyCommandPalette state={commandPalette.commandPaletteState()} onClose={() => modal.clear()} onRowClick={commandPalette.handleRowClick} />,
    commands: deps.commands,
    onActivate: deps.onPaletteActivate,
  })
  const themeModal = useThemeModal({
    config: deps.runtimeConfig,
    appService: deps.appService,
    modal: treeModal,
    renderModal: () => <LazyThemeModal result={themeModal.themeModalResult()} cursor={themeModal.themeModalCursor()} current={themeModal.currentThemeName()} saving={themeModal.saving()} onClose={() => modal.clear()} onRowClick={themeModal.selectThemeRow} />,
    showToast: services.showToast,
  })
  const profileModal = useProfileModal({
    modal: treeModal,
    auth: signals.auth,
    authProfileSelection,
    renderModal: () => <LazyProfileModal result={profileModal.profileModalResult()} cursor={profileModal.profileModalCursor()} current={profileModal.profileModalCurrent()} onClose={() => modal.clear()} onRowClick={profileModal.selectProfileRow} />,
    showToast: services.showToast,
  })
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
  const activeSessionCount = createMemo(() => deps.tabs().filter((tab) => tab.kind === "session").length)
  const sessionCount = deps.sessionCount
  const foregroundBudget = () => {
    const sessionId = signals.foregroundId()
    return sessionId ? signals.budgetView(sessionId) : undefined
  }
  const statusModalRows = createMemo(() => [
    ...statusRows({
      sessionId: signals.foregroundId(),
      sessionKind: signals.sessionKind(),
      sessionState: signals.sessionState(),
      modelLabel: activeModelLabel(),
      budget: foregroundBudget(),
      activeSessionCount: activeSessionCount(),
      sessionCount: sessionCount(),
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
  const helpModal = useHelpModal({
    modal,
    renderModal: (scroll) => <LazyModalHelp onClose={() => modal.clear()} scroll={scroll} />,
  })
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
        now={sessionModal.pickerNow()}
        confirmDeleteSessionId={sessionModal.modalConfirmDelete()}
        showThinking={deps.settings.values.showThinking}
        diffColors={() => deps.settings.values.diffColors}
      />
    ),
    signals,
    appService: deps.appService,
    showToast: services.showToast,
    clipboard,
    sessions: signals.listedSessions,
    sessionCatalogErrors: deps.sessionCatalogErrors,
    activateSession: deps.activateSession,
    activateSessionById: deps.activateSessionById,
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
    currentThemeName: themeModal.currentThemeName,
    openThemeModal: themeModal.openThemeModal,
    openSettingsDestination,
    openSessionsModal: sessionModal.openSessionsModal,
    openAuthProfiles: () => profileModal.openProfileSwitcher(),
    openStatusModal: statusModal.openStatusModal,
  })
  settingsTree.bindRoot({ open: settingsModal.openSettingsModal, isOpen: settingsModal.settingsModalOpen })
  const findModal = useFindModal({
    modal,
    appService: deps.appService,
    sessions: deps.sessions,
    foregroundSessionId: signals.foregroundId,
    activateSession: deps.activateSession,
    showToast: services.showToast,
    renderModal: () => (
      <LazyFindModal
        query={findModal.query()}
        scope={findModal.scope()}
        hits={findModal.hits()}
        total={findModal.total()}
        busy={findModal.busy()}
        cursor={findModal.cursor()}
        hitSession={findModal.hitSession}
        onClose={() => modal.clear()}
        onRowClick={findModal.selectRow}
        onOpen={findModal.openRow}
      />
    ),
  })
  return {
    sessionChangesModal,
    modelModal, commandPalette, themeModal, profileModal, sessionModal, settingsModal, authModal, openSettingsDestination, openSubscriptionSpendReview, reviewCachedActiveProfile,
    statusModal, helpModal, backgroundModal,
    findModal,
    activeSessionCount, sessionCount, activeModelLabel,
  }
}
