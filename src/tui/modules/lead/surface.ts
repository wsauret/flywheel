import { errorMessage } from "../../../infra/error-message.js"
import type { TuiControllerHost } from "../../tui-module.js"

/** The `/lead` command's surface: it asks the control part for the lead chat, which ends a dismissal, and shows it.
 *  The control part is the one writer of the designation (ARCH-STRUCTURE-045). */
export function createLeadSurface(host: Pick<TuiControllerHost, "client" | "navigate" | "showToast">): () => Promise<boolean> {
  return async () => {
    try {
      const result = await host.client.dispatch({ type: "lead.open", reason: "command" })
      if (!result.ok) { host.showToast({ message: result.error, variant: "error" }); return false }
      if (result.sessionId === null) { host.showToast({ message: "The lead is off", variant: "warning" }); return false }
      host.navigate.navigateSession(result.sessionId)
      return true
    } catch (cause) {
      host.showToast({ message: errorMessage(cause), variant: "error" })
      return false
    }
  }
}
