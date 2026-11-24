import type { AccountDirectories } from "../../infra/directory-authorities.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { CaptureSurfaceOpener } from "../../protocol/client/surface-presentation.js"
import type { AgentViewKind } from "../../protocol/client/slash-route.js"
import type { ShellServices, ShellSignals } from "../hooks/state/shell-state.js"
import type { RuntimeConfigCache } from "../hooks/state/runtime/create-runtime-config-cache.js"
import type { OpenSurface } from "./command-surfaces.js"

/** Static identity and presentation of a built-in slash command. */
export interface CommandSpec {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly aliases?: readonly string[]
  readonly keybinding?: string
  /** Excluded from palette listings; still dispatchable by token. */
  readonly hidden?: boolean
}

/** Runs one built-in command with the shell context constructed after modal
 *  openers. It answers false when the command refused the input after it told
 *  the person why, so the prompt gets the typed command back. */
type CommandExecute<Context> = (context: Context, arg: string | undefined) => boolean | Promise<boolean>

/** One immutable built-in command definition owns presentation and execution. */
export interface BuiltInCommandDefinition<Context = unknown> {
  readonly spec: CommandSpec
  readonly execute: CommandExecute<Context>
}

export interface FontCommandContext {
  directories: AccountDirectories
  launcher: LauncherScope
  appService: Pick<RuntimeClient, "dispatch">
  runtimeConfig: RuntimeConfigCache
  showToast: ShellServices["showToast"]
}

/** The shell context every built-in command runs with. */
export interface BuiltInCommandContext extends FontCommandContext {
  signals: Pick<ShellSignals, "sessionInputMode" | "foregroundId" | "commandCatalogRevision">
  startClearedChat: () => Promise<void>
  exit: () => void
  /** Restarts the account service and this terminal in place. */
  restart: () => Promise<never>
  openThemeModal: () => void
  /** Opens the client surface a descriptor or a runtime command outcome names. */
  openSurface: OpenSurface
  /** Captures the placement and opening intent before a runtime invocation. */
  captureSurfaceOpener: CaptureSurfaceOpener
  /** Brings a session the runtime created or named to the front. */
  focusSession: (sessionId: string) => void
  refreshCommandCatalog: () => Promise<void>
  /** The kind of agent whose view is in front, or undefined in a chat. */
  agentInView: () => AgentViewKind | undefined
}
