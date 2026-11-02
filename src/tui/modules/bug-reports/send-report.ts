import type { TuiControllerHost } from "../../tui-module.js"
import { crashReportText, reportStatus, submitTuiReport } from "./report.js"
import { errorMessage } from "../../../infra/error-message.js"

/** The terminal's Report a bug: it sends a manual report at once, with the
 *  command's argument as the note, and says how it settled. A report that
 *  was not sent is copied for the person to send on. It answers whether the
 *  report was sent, so an oversized note or a failed send gives the prompt
 *  the command back. */
export function createSendReport(host: Pick<TuiControllerHost, "client" | "foregroundId" | "clipboard" | "showToast" | "appVersion">): (note?: string) => Promise<boolean> {
  async function send(note: string | undefined): Promise<boolean> {
    if (note !== undefined && note.length > 2000) {
      host.showToast({ message: "Report notes must be at most 2000 characters.", variant: "warning" })
      return false
    }
    const error = { name: "", message: "", stack: "" }
    const sessionId = host.foregroundId()
    const result = await submitTuiReport(host.client, "manual", error, sessionId, note)
    let message = reportStatus(result, "manual")
    if (!result.ok) {
      try {
        await host.clipboard.copy(crashReportText({ kind: "manual", error, version: host.appVersion, sessionId, note, result }))
        message += " Report copied to the clipboard."
      } catch (cause) { message += ` Could not copy the report: ${errorMessage(cause)}` }
    }
    host.showToast({ message, variant: result.ok ? "success" : "error" })
    return result.ok
  }
  return (note) => send(note).catch((cause: unknown) => {
    host.showToast({ message: `Bug report failed: ${errorMessage(cause)}`, variant: "error" })
    return false
  })
}
