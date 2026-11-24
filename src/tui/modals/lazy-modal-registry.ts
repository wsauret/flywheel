import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"
import { settingCatalogRow } from "../../protocol/setting-catalog.js"
import { createLazyTuiView } from "../components/lazy-tui-view.js"

export const LazyAuthModal = createLazyTuiView(KERNEL_COMMAND_NAMES.auth, async () => (await import("./auth/auth-modal.js")).AuthModal)
export const LazyBackgroundModal = createLazyTuiView(KERNEL_COMMAND_NAMES.bg, async () => (await import("./background-modal.js")).BackgroundModal)
export const LazyCommandPalette = createLazyTuiView(KERNEL_COMMAND_NAMES.help, async () => (await import("./command-palette.js")).CommandPalette)
export const LazyModalHelp = createLazyTuiView(KERNEL_COMMAND_NAMES.shortcuts, async () => (await import("../components/modal-help.js")).ModalHelp)
export const LazyModelModal = createLazyTuiView(KERNEL_COMMAND_NAMES.model, async () => (await import("./model/model-modal.js")).ModelModal)
export const LazyProfileModal = createLazyTuiView(KERNEL_COMMAND_NAMES.profile, async () => (await import("./profile-modal.js")).ProfileModal)
export const LazySessionModal = createLazyTuiView(KERNEL_COMMAND_NAMES.sessions, async () => (await import("./session-modal.js")).SessionModal)
export const LazySessionChangesModal = createLazyTuiView(KERNEL_COMMAND_NAMES.changes, async () => (await import("./session-changes-modal.js")).SessionChangesModal)
export const LazySettingsModal = createLazyTuiView(KERNEL_COMMAND_NAMES.settings, async () => (await import("./settings-modal.js")).SettingsModal)
export const LazyStatusModal = createLazyTuiView(KERNEL_COMMAND_NAMES.status, async () => (await import("./status-modal.js")).StatusModal)
export const LazyThemeModal = createLazyTuiView(settingCatalogRow("theme").label, async () => (await import("./theme-modal.js")).ThemeModal)

/** The kernel modal controller modules, each imported on its modal's first
 *  open, so startup evaluates none of them. */
export const kernelModalControllers = {
  auth: () => import("../hooks/use-auth-modal.js"),
  background: () => import("../hooks/use-background-modal.js"),
  changes: () => import("../hooks/use-session-changes-modal.js"),
  commands: () => import("../hooks/use-command-palette.js"),
  help: () => import("../hooks/use-help-modal.js"),
  model: () => import("../hooks/use-model-modal.js"),
  profile: () => import("../hooks/use-profile-modal.js"),
  sessions: () => import("../hooks/use-session-modal.js"),
  settings: () => import("../hooks/use-settings-modal.js"),
  status: () => import("../hooks/use-status-modal.js"),
  theme: () => import("../hooks/use-theme-modal.js"),
}
