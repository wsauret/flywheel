import { describe, expect, it, mock } from "bun:test"
import type { BugReportResult } from "../../../../../src/protocol/modules/bug-reports.js"
import { createSendReport } from "../../../../../src/tui/modules/bug-reports/send-report.js"
import type { ToastInput } from "../../../../../src/tui/context/toast.js"
import { runtimeDispatch, runtimeQuery } from "../../../../helpers/runtime-dispatch.js"

function harness(foregroundId: string | undefined) {
  const dispatch = mock(async (): Promise<BugReportResult> => ({ ok: true, reportId: "FW-1234" }))
  const showToast = mock((_toast: ToastInput) => {})
  const copy = mock(async (_text: string) => {})
  const send = createSendReport({
    client: { dispatch: runtimeDispatch({ "bugReport.submit": dispatch }), query: runtimeQuery({}) },
    foregroundId: () => foregroundId, clipboard: { copy }, showToast, appVersion: "1.2.3",
  })
  return { dispatch, showToast, copy, send }
}

describe("Report a bug in the terminal", () => {
  it("submits the command's note and the current session, and names a send failure", async () => {
    const h = harness("chat-1")
    expect(await h.send("The screen froze")).toBe(true)
    expect(h.dispatch).toHaveBeenCalledWith({
      type: "bugReport.submit", kind: "manual", surface: "tui", sessionId: "chat-1", note: "The screen froze",
      error: { name: "", message: "", stack: "" },
    })
    expect(h.showToast).toHaveBeenLastCalledWith({ message: "Report sent (FW-1234)", variant: "success" })
    h.dispatch.mockImplementationOnce(async () => ({ ok: false, kind: "unavailable", error: "offline", reportText: "account-assembled report" }))
    expect(await h.send(undefined)).toBe(false)
    expect(h.copy).toHaveBeenCalledWith("account-assembled report")
    expect(h.showToast).toHaveBeenLastCalledWith({ message: "Could not send bug report: offline Report copied to the clipboard.", variant: "error" })
  })

  it("sends before a session exists and refuses an oversized note without sending, so the prompt keeps it", async () => {
    const h = harness(undefined)
    expect(await h.send(undefined)).toBe(true)
    expect(h.dispatch).toHaveBeenCalledWith({ type: "bugReport.submit", kind: "manual", surface: "tui", error: { name: "", message: "", stack: "" } })
    expect(await h.send("x".repeat(2001))).toBe(false)
    expect(h.dispatch).toHaveBeenCalledTimes(1)
    expect(h.showToast).toHaveBeenLastCalledWith({ message: "Report notes must be at most 2000 characters.", variant: "warning" })
  })
})
