import { createEffect } from "solid-js"
import { useModal, useOverlay } from "@tui/components/modal"
import { presentKeymapIssues } from "@tui/context/keymap"
import { useToast } from "@tui/context/toast"
import { signInPage, type TerminalAttach } from "./terminal-attach.js"
import { createSurfaceOpener } from "../protocol/client/surface-presentation.js"
import type { AccountDirectories } from "../infra/directory-authorities.js"
import type { LauncherScope } from "../infra/process-supervisor.js"
import type { AttachedRuntimeClient } from "../protocol/app-service-types.js"
import type { BackgroundWorkTarget } from "../protocol/background-index-protocol-types.js"
import type { ModuleRowAction } from "../protocol/protocol-module.js"
import type { Clipboard } from "./utils/clipboard.js"
import { createToastPresenter } from "./utils/toast-presenter.js"
import { TUI_MODULES } from "./modules.js"
import { closeChatSurface } from "./commands/close-chat-surface.js"
import { createSurfaceRouter, type KernelSurfaceTable, type OpenSurface } from "./commands/command-surfaces.js"
import { settingsPlace, type SettingsDestination } from "./settings-destination.js"
import { useAutomaticAuth } from "./hooks/automatic-dialogs.js"
import { createAttachFilesCommand } from "./hooks/create-attach-files-command.js"
import { createModalModals } from "./hooks/create-modals.js"
import { createModuleSlots } from "./hooks/create-module-slots.js"
import type { SettingsOperations } from "./hooks/create-settings-store.js"
import { createLateBinding } from "./hooks/late-binding.js"
import { createAsyncReporter } from "./hooks/report-async.js"
import { useShellState, type RuntimeConfigCache } from "./hooks/shell-state.js"
import { createTranscriptInView } from "./hooks/transcript-in-view.js"
import { useLoginQuestion } from "./hooks/use-login-question.js"
import { usePaidUseQuestion } from "./hooks/use-paid-use-question.js"
import type { ShellComposerCore } from "./shell-composer.js"
import type { ShellPlaces } from "./shell-navigation.js"

interface ShellOverlaysDeps {
  readonly appService: AttachedRuntimeClient
  readonly attach: TerminalAttach
  readonly runtimeConfig: RuntimeConfigCache
  readonly directories: AccountDirectories
  readonly appVersion: string
  readonly launcher: LauncherScope
  readonly clipboard: Clipboard
  readonly settingsOperations: SettingsOperations
  readonly composer: Pick<ShellComposerCore, "chat" | "sessionControls" | "attachSlot" | "commandCatalog">
  readonly places: ShellPlaces
  readonly navigateToProcess: (toolUseId: string) => void
  /** The calls below reach owners that the shell builds after the overlays. */
  readonly openSession: (sessionId: string) => Promise<void>
  readonly openTarget: (target: BackgroundWorkTarget) => Promise<void>
  readonly dispatchCommand: (text: string) => Promise<boolean>
}

/** What opens over the shell: the module slot host and its surfaces, the
 *  kernel modals, the router that opens a surface by id, the automatic
 *  questions, and the configuration notices. */
export function createShellOverlays(deps: ShellOverlaysDeps) {
  const { signals, services } = useShellState()
  const modal = useModal()
  const overlay = useOverlay()
  const toast = useToast()
  const { places, composer } = deps
  // The modals list the module rows, a module surface opens Settings or
  // another module's surface, and a module row opens any surface, so the slot
  // host reaches the modals, its own surfaces, and the router below through
  // these bindings.
  const openSettings = createLateBinding<[destination: SettingsDestination], Promise<void>>("settings navigation")
  const openModuleSurface = createLateBinding<[id: string], void>("module surface navigation")
  const openSurface = createLateBinding<Parameters<OpenSurface>, ReturnType<OpenSurface>>("surface router")
  const slots = createModuleSlots({
    modules: TUI_MODULES, intakes: signals.modules, foregroundId: signals.foregroundId, modal, showToast: toast.show, client: deps.appService, enabled: () => signals.moduleSelection()?.moduleIds, auth: signals.auth,
    answering: () => signals.runtimeHealth().kind !== "faulted",
    projectRoot: signals.projectRoot,
    clipboard: deps.clipboard,
    appVersion: deps.appVersion,
    navigate: { openSettings: openSettings.call, openSurface: openModuleSurface.call, navigateSession: places.focusSession },
  })
  // A module opens only module surfaces, and a surface of a disabled module is
  // absent without a notice.
  openModuleSurface.bind((id) => { void slots.surfaces.get(id)?.() })
  function activateModuleRow(action: ModuleRowAction): void {
    if (action.kind === "command") void deps.dispatchCommand(`/${action.id}`)
    else void openSurface.call(action.id)
  }
  const modals = createModalModals({
    directories: deps.directories, launcher: deps.launcher, clipboard: deps.clipboard, modal, signals, services, appService: deps.appService,
    tabs: places.tabs, activeSessionCount: places.activeSessionCount, appVersion: deps.appVersion, chat: composer.chat, startChat: places.startChat, switchForeground: places.switchForeground,
    activateSession: places.activateSession, activateSessionById: deps.openSession, closeSessionTab: places.closeSessionTab, closeChat: places.closeChat,
    settings: services.settings, runtimeConfig: deps.runtimeConfig, settingsOperations: deps.settingsOperations,
    signInPage: signInPage(deps.attach),
    onPaletteActivate: (text) => { void deps.dispatchCommand(text) },
    commands: composer.commandCatalog,
    moduleStatusRows: slots.statusRows,
    moduleSettingsRows: slots.settingsRows,
    refreshModuleStatus: slots.refreshStatus,
    activateModuleRow,
    navigateToProcess: deps.navigateToProcess,
    openTarget: deps.openTarget,
  })
  openSettings.bind(modals.openSettingsDestination)
  const transcriptInView = createTranscriptInView(() => { void modals.modelModal.openActiveModelPicker() })
  // Where this terminal opens every surface a command names: the kernel's own
  // by this table, and every module surface by its terminal home.
  const kernelSurfaces: KernelSurfaceTable = {
    "background": () => modals.backgroundModal.openBackgroundModal(),
    "models": ({ target }) => target?.kind === "transcript-in-view" ? transcriptInView.openModel() : modals.openSettingsDestination({ kind: "models" }),
    "settings": ({ target }) => modals.openSettingsDestination(target?.kind === "place" ? settingsPlace(target.place) : { kind: "root" }),
    "auth-profiles": ({ argument }) => modals.profileModal.openProfileSwitcher(argument),
    "status": () => modals.statusModal.openStatusModal(),
    "keyboard-shortcuts": () => modals.helpModal.openHelpModal(),
    "commands": () => modals.commandPalette.openCommandPalette(),
    "new-chat": () => places.startNewChat(),
    "sessions": () => modals.sessionModal.openSessionsModal(),
    "changes": () => modals.sessionChangesModal.openSessionChangesModal(),
    "resume": () => composer.sessionControls.resume(),
    "attach-files": createAttachFilesCommand({ launcher: deps.launcher, showToast: services.showToast, slot: composer.attachSlot }),
    "find": ({ argument }) => modals.findModal.openFindModal(argument),
    "close-chat": closeChatSurface({ agentInView: transcriptInView.agentInView, chatInFront: () => signals.sessionInputMode()?.kind === "chat" ? signals.foregroundId() : undefined, closeChat: places.closeChat, showToast: services.showToast }),
  }
  const router = createSurfaceRouter({ kernel: kernelSurfaces, modules: slots.surfaces, report: createAsyncReporter(services.showToast),
    missing: (surface) => services.showToast({ message: `This client has no "${surface}" surface`, variant: "warning" }) })
  openSurface.bind(router)
  const captureSurfaceOpener = createSurfaceOpener({
    sessionId: signals.foregroundId,
    placement: signals.foregroundRevision,
    surfaces: () => [modal.stack, overlay.viewer.stack],
    openSurface: (surface, isCurrent, opening) => router(surface, { ...opening, isCurrent }),
  })
  useAutomaticAuth({ auth: signals.auth, overlayOpen: () => overlay.isOpen(), open: modals.authModal.openAuthModal })
  usePaidUseQuestion({ signals, overlayOpen: () => overlay.isOpen(), review: modals.reviewCachedActiveProfile })
  useLoginQuestion({ auth: signals.auth, overlayOpen: () => overlay.isOpen(), open: modals.authModal.openLoginQuestion })
  const configToasts = createToastPresenter(services.showToast)
  createEffect(() => {
    const config = deps.runtimeConfig.view()
    if (!config || config.status.kind === "valid") return
    configToasts.present("config.invalid", { message: config.status.message, variant: config.status.kind === "disposed" ? "error" : "warning", duration: 15000 })
  })
  // Rejected [keybindings] overrides are actionable config mistakes; surface
  // them rather than silently falling back to defaults.
  presentKeymapIssues(configToasts)
  return { slots, modals, transcriptInView, openSurface: router, captureSurfaceOpener, activateModuleRow }
}

export type ShellOverlays = ReturnType<typeof createShellOverlays>
