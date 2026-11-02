import type { ClientContextValue } from "../../app/client-context.js"
import type { WebMenuRow } from "../../web-module.js"
import { pushRegistration } from "./push-registration.js"

export const MACHINES_SURFACE = "runtimes"

/** The remote module's actions in the client menus. */
export function remoteMenu(client: ClientContextValue, location: "panel" | "settings"): readonly WebMenuRow[] {
  // Remote access reaches the command menu from the runtime's command catalog
  // and Settings from the module's protocol rows, so only this host's own rows are here.
  const rows: WebMenuRow[] = []
  if (client.host.capabilities.remote) rows.push({ id: "runtimes", label: "Machines", description: "The machines this phone is paired with", run: () => client.openSurface(MACHINES_SURFACE) })
  if (location === "settings") return rows
  const remote = client.state().modules.remote ?? undefined
  if (!client.host.capabilities.push || !client.host.capabilities.remote || !remote?.pushPublicKey) return rows
  const registration = pushRegistration(client)
  if (!registration) return rows
  rows.push({
    id: "push", label: "Notify this device",
    keepOpen: true,
    value: registration.state().kind,
    working: registration.busy(),
    run: () => { void registration.enable() },
  })
  return rows
}

