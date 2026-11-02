import type { Accessor, JSX } from "solid-js"
import type { RuntimeClient, RuntimeHealth } from "../protocol/app-service-types.js"
import type { RuntimeFaultCopy } from "../protocol/client/runtime-fault-copy.js"
import type { ModuleId } from "../protocol/module-ids.js"
import type { RuntimeAuthView } from "../protocol/auth-status-protocol-types.js"
import type { ModalContext } from "./components/modal-stack.js"
import type { DomainReader, ModuleRow } from "../protocol/protocol-module.js"
import type { ListModalKeyEvent } from "./components/modal-list-keys.js"
import type { ModalScrollController } from "./components/modal-scroll-controller.js"
import type { ToastInput } from "./context/toast.js"
import type { OpenSettingsDestination } from "./settings-destination.js"
import type { Clipboard } from "./utils/clipboard.js"

/** The terminal client's module contract. A module contributes its presence
 *  through the slot map (ARCH-PROTOCOL-034): declarative rows come from its protocol
 *  home, and the component slots below are written once for this client.
 *  The slot host in `hooks/create-module-slots.tsx` renders every registered
 *  module from this shape and names none. */

/** What every slot component receives: the session it renders for and a
 *  reader over the module's own domain views for that session. */
interface TuiSlotProps {
  readonly sessionId: string
  readonly read: DomainReader
}

export interface TuiStripProps extends TuiSlotProps {
  /** Composer line width: a strip shares the composer's horizontal extent. */
  readonly width: Accessor<number>
  /** Opens a registered surface by id. */
  readonly openSurface: (id: string) => void
}

/** The kernel destinations a surface may send the person to. */
export interface TuiNavigation {
  readonly navigateSession: (sessionId: string) => void
  readonly openSettings: OpenSettingsDestination
  readonly openSurface: (id: string) => void
}

/** What the host lends a surface's own key handler: the reader over the
 *  session it opened for, the runtime client for its mutations, and the kernel
 *  destinations, beside scroll and close. */
export interface TuiSurfaceHost {
  readonly read: DomainReader
  readonly client: Pick<RuntimeClient, "dispatch">
  readonly navigate: TuiNavigation
  /** Reports how a mutation the surface dispatched settled. */
  readonly showToast: (toast: ToastInput) => void
  readonly scroll: ModalScrollController
  readonly close: () => void
}

export interface TuiSurfaceProps extends TuiSlotProps {
  readonly client: Pick<RuntimeClient, "dispatch">
  readonly navigate: TuiNavigation
  readonly showToast: (toast: ToastInput) => void
  readonly scroll: ModalScrollController
  /** The frame width and control copy the surface declared. */
  readonly width: number
  readonly controls: readonly string[]
  readonly onClose: () => void
}

/** A modal the runtime's `open` outcome or a strip opens by id. */
export interface TuiComponentSurface {
  readonly id: string
  readonly title: string
  readonly width: number
  readonly controls: readonly string[]
  /** Lazy so the module's view code loads on first open, as the kernel modals do. */
  readonly load: () => Promise<(props: TuiSurfaceProps) => JSX.Element>
  /** Keys the surface handles itself, tried before the host's scroll and
   *  close keys; true when consumed. */
  readonly onKey?: (event: ListModalKeyEvent, host: TuiSurfaceHost) => boolean
}

/** What a module's shell-lifetime presence reads: the foreground session's
 *  views and the toast sink. It runs once under the shell's owner, so an
 *  effect it creates lives as long as the shell. */
export interface TuiPresenceProps {
  readonly read: DomainReader
  readonly showToast: (toast: ToastInput) => void
}

export interface TuiControllerHost {
  /** Current module admission, independent of cached domain availability. */
  readonly enabled: Accessor<boolean>
  readonly clipboard: Pick<Clipboard, "copy">
  readonly navigate: TuiNavigation
  readonly modal: Pick<ModalContext, "replace">
  readonly client: Pick<RuntimeClient, "query" | "dispatch">
  readonly foregroundId: Accessor<string | undefined>
  readonly auth: Accessor<RuntimeAuthView | undefined>
  readonly read: DomainReader
  readonly projectRoot: Accessor<string>
  readonly showToast: (toast: ToastInput) => void
  /** The version this terminal runs, for copy a person sends on. */
  readonly appVersion: string
}

/** A stateful surface owns its view, keyboard routes, and confirmation
 *  lifecycle. Its opener receives the argument of the command that opened it. */
export type TuiSurface = TuiComponentSurface | {
  readonly id: string
  /** An opener that settles false refused the opening, such as for an
   *  invalid argument, and gives the prompt its command back. */
  readonly loadController: () => Promise<(host: TuiControllerHost) => (argument?: string) => void | Promise<boolean>>
}

/** Crash presentation runs under the fallback's owner, not the failed shell. */
export interface TuiErrorReportProps {
  readonly error: Error
  readonly client: Pick<RuntimeClient, "dispatch">
  readonly version: string
  readonly sessionId?: string
}

export interface TuiErrorReport {
  readonly status: Accessor<string | undefined>
  readonly failed: Accessor<boolean>
  readonly copyText: () => string
}

export interface TuiFaultNotice extends RuntimeFaultCopy {
  readonly copyReport?: () => void
}
export interface TuiFaultNoticeHost {
  readonly client: Pick<RuntimeClient, "query">
  readonly clipboard: Pick<Clipboard, "copy">
  readonly showToast: (toast: ToastInput) => void
}

export interface TuiModule {
  readonly errorReport?: (props: TuiErrorReportProps) => TuiErrorReport
  readonly faultNotice?: (notice: TuiFaultNotice, health: RuntimeHealth, host: TuiFaultNoticeHost) => TuiFaultNotice
  readonly createClient?: (host: import("./tui-module-client.js").TuiModuleClientHost) => import("./tui-module-client.js").TuiModuleClient
  readonly id: ModuleId
  /** Rendered above the composer for the foreground session, in registry order. */
  readonly strip?: (props: TuiStripProps) => JSX.Element
  /** Read only when the person opens Status. */
  readonly status?: (host: Pick<TuiControllerHost, "client" | "foregroundId">) => Promise<readonly ModuleRow[]>
  readonly surfaces?: readonly TuiSurface[]
  /** Runs once when the shell mounts, for presentation that is not a strip or
   *  a surface: a toast when a view changes. */
  readonly present?: (props: TuiPresenceProps) => void
}
