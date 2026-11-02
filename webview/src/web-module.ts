import type { Accessor, Component } from "solid-js"

import type { ModuleId } from "../../src/protocol/module-ids.js"
import type { RuntimeConnection } from "../../src/protocol/client/connection.js"
import type { FaultReach } from "../../src/protocol/client/runtime-fault-copy.js"
import type { RuntimeHealth } from "../../src/protocol/app-service-types.js"
import type { ModuleRow, DomainReader } from "../../src/protocol/protocol-module.js"
import type { ClientHost } from "./host.js"
import type { ClientContextValue } from "./app/client-context.js"
import type { PlacementLabels } from "./app/screen-stack.js"
import type { WebModuleClient, WebModuleClientHost } from "./web-module-client.js"

/** The web client's module contract. A module contributes its presence
 *  through the slot map (ARCH-PROTOCOL-034): declarative rows come from its protocol
 *  home, and the component slots below are written once for this client.
 *  `app.tsx` renders every registered module from this shape and names none. */

/** A surface the runtime's `open` outcome opens by id: a sheet of the
 *  module's own, which the app mounts beside its kernel sheets, or a focus
 *  inside the module's strip, which the module opens itself. */
type WebSurface =
  | { readonly id: string; readonly sheet: Component }
  | { readonly id: string; readonly open: () => void }

/** Host-owned placement and acquisition UI, available before a runtime answers. */
export interface WebHostPresence {
  readonly stage: Accessor<Component | undefined>
  readonly placement: Accessor<PlacementLabels | undefined>
  /** How the page reaches its runtime, which the fault notice names: the
   *  machine it reaches through the relay, and whether the relay reports
   *  that machine offline. Absent for a host that reaches no machine. */
  readonly reach?: Accessor<FaultReach | undefined>
  /** Whether the host's presence lists the runtime the page reaches as
   *  serving it, such as the chosen project open on its machine. The page
   *  tells its connection each time this turns true (`appeared`). */
  readonly served?: Accessor<boolean>
  readonly navigation?: "stack"
}

/** A module action in the command panel or complete settings sheet. */
export interface WebMenuRow {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly value?: string
  readonly toggle?: boolean
  readonly keepOpen?: boolean
  /** True while the row's action waits on the runtime, read from the actions layer. */
  readonly working?: boolean
  readonly run: () => void
}

/** A count a module shows in the toolbar after the kernel's own controls,
 *  with the one action that addresses it: a surface of the module's own, or a
 *  runtime command by its catalog id. */
export interface ToolbarBadge {
  readonly id: string
  /** The noun the count counts, in the chip's own words: "3 notifications". */
  readonly label: string
  readonly count: number
  readonly tone?: "warning" | "alert"
  readonly action: { readonly kind: "surface" | "command"; readonly id: string }
}

export interface WebModule {
  readonly id: ModuleId
  /** Replaces the stage's unavailable view after its error boundary catches an error. */
  readonly viewError?: {
    readonly component: Component<{ readonly error: unknown }>
  }
  /** Adds module-owned details to the resident runtime fault notice. */
  readonly runtimeFaultDetail?: Component<{ readonly health: RuntimeHealth }>
  readonly createClient?: (host: WebModuleClientHost) => WebModuleClient
  /** Read only when Status is open. */
  readonly status?: (connection: RuntimeConnection, sessionId: string | undefined) => Promise<readonly ModuleRow[]>
  /** Rendered above the composer for the open session, in registry order. */
  readonly strip?: Component<{ readonly sessionId: string }>
  /** A client-wide notice that stays visible on the session list as well as a chat. */
  readonly notice?: Component<{ readonly visible: boolean }>
  readonly surfaces?: readonly WebSurface[]
  /** Created under the app's owner; subscriptions stop when disabled or disposed. */
  readonly hostPresence?: (host: ClientHost, enabled: Accessor<boolean>) => WebHostPresence | undefined
  readonly menu?: {
    readonly rows: (client: ClientContextValue, location: "panel" | "settings") => readonly WebMenuRow[]
  }
  /** The `toolbar.badges` slot: one badge computed from the module's own
   *  views through the reader, or none while there is nothing to count. */
  readonly toolbar?: (read: DomainReader) => ToolbarBadge | undefined
}

/** Only a published selection can exclude a module, including before connection. */
export function webModuleEnabled(id: ModuleId, enabled: readonly ModuleId[] | undefined): boolean {
  return enabled?.includes(id) ?? true
}

export function moduleMenuRows(modules: readonly WebModule[], client: ClientContextValue, location: "panel" | "settings"): readonly WebMenuRow[] {
  const enabled = client.state().settings?.moduleIds
  return modules.flatMap((module) => module.menu && webModuleEnabled(module.id, enabled) ? module.menu.rows(client, location) : [])
}
