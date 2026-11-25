import { webModuleEnabled, type WebMenuRow } from "../../../web-module.js"
import type { ClientContextValue } from "../../client-context.js"

/** The menu rows of each enabled module of `client`, for the command panel
 *  or the complete settings sheet. */
export function moduleMenuRows(client: ClientContextValue, location: "panel" | "settings"): readonly WebMenuRow[] {
  const enabled = client.state().settings?.moduleIds
  return client.modules.flatMap((module) => module.menu && webModuleEnabled(module.id, enabled) ? module.menu.rows(client, location) : [])
}
