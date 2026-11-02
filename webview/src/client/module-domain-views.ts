import type { RuntimeHealth } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { MODULE_DOMAIN_BINDINGS, moduleDomainReader, type ModuleDomainBinding } from "../../../src/protocol/client/module-domain.js"
import type { DomainReader } from "../../../src/protocol/protocol-module.js"
import { PROTOCOL_MODULE_SESSION_DOMAINS, PROTOCOL_MODULE_WORKSPACE_DOMAINS, type ProtocolModuleDomainName, type ProtocolModuleSessionDomain, type ProtocolModuleView, type ProtocolModuleWorkspaceDomain } from "../../../src/protocol/modules.js"
import { createModuleDomainMonitor, type ModuleDomainMonitor } from "./module-domain-monitor.js"

/** The view of every module domain in the protocol registry: a workspace
 *  domain's as the runtime publishes it, a session domain's for the shown
 *  session, null where none has landed. */
export type ModuleDomainViews = { readonly [Name in ProtocolModuleDomainName]: ProtocolModuleView<Name> | null }

/** The page's one reader of its module views. A view the page holds through
 *  a fault reads in its unanswered form, so no sheet or row shows a held
 *  claim about the present as current. */
export function pageDomainReader(state: () => { readonly modules: Partial<ModuleDomainViews>; readonly health: RuntimeHealth }): DomainReader {
  return moduleDomainReader((domain) => state().modules[domain.domain], () => state().health.kind !== "faulted")
}

/** One session's monitors, one per session-scoped registry domain. Any chat
 *  may carry a session view, so each follows the session itself rather than a
 *  session kind. A page keeps them for every session it keeps resident. */
export interface SessionModuleMonitors {
  readonly monitors: ReadonlyMap<ProtocolModuleSessionDomain, ModuleDomainMonitor<unknown>>
  dispose(): void
}

type Connection = Pick<RuntimeConnection, "query" | "subscribe" | "onLane">

export function createSessionModuleMonitors(options: {
  readonly connection: Connection
  readonly sessionId: string
  readonly onChange: () => void
}): SessionModuleMonitors {
  const monitors = new Map(PROTOCOL_MODULE_SESSION_DOMAINS.map((domain) => {
    const binding: ModuleDomainBinding<string, "session", unknown, unknown> = MODULE_DOMAIN_BINDINGS[domain]
    const monitor = createModuleDomainMonitor({ binding, connection: options.connection, ownerId: options.sessionId })
    monitor.onChange(options.onChange)
    return [domain, monitor] as const
  }))
  return {
    monitors,
    dispose() { for (const monitor of monitors.values()) monitor.dispose() },
  }
}

export interface ModuleDomainMonitors {
  /** Every domain's view, with the session domains of `session`. */
  views(session: SessionModuleMonitors | undefined): ModuleDomainViews
  dispose(): void
}

/** The workspace monitors, one per workspace registry domain, which live as
 *  long as the client. Nothing here names a module; a monitor's dispose
 *  clears its listeners, so none is held apart. */
export function createModuleDomainMonitors(options: {
  readonly connection: Connection
  readonly onChange: () => void
}): ModuleDomainMonitors {
  // The loose base binding: every entry of the scope satisfies it, and the views record restores each key's view type.
  const workspace: ReadonlyMap<ProtocolModuleWorkspaceDomain, ModuleDomainMonitor<unknown>> = new Map(PROTOCOL_MODULE_WORKSPACE_DOMAINS.map((domain) => {
    const binding: ModuleDomainBinding<string, "workspace", unknown, unknown> = MODULE_DOMAIN_BINDINGS[domain]
    const monitor = createModuleDomainMonitor({ binding, connection: options.connection })
    monitor.onChange(options.onChange)
    return [domain, monitor]
  }))

  return {
    views(session) {
      // SAFETY: each key's monitor was built from that key's own binding, so its view is that domain's declared view; the map erases the per-domain correlation.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry-composed record
      return Object.fromEntries([
        ...PROTOCOL_MODULE_WORKSPACE_DOMAINS.map((domain) => [domain, workspace.get(domain)?.view ?? null]),
        ...PROTOCOL_MODULE_SESSION_DOMAINS.map((domain) => [domain, session?.monitors.get(domain)?.view ?? null]),
      ]) as ModuleDomainViews
    },
    dispose() {
      for (const monitor of workspace.values()) monitor.dispose()
    },
  }
}
