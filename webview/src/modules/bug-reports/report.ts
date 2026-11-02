import { createSignal, onCleanup } from "solid-js"
import { bugReportCopyText, sanitizeBugReportInput, type BugReportInput, type BugReportResult } from "../../../../src/protocol/modules/bug-reports.js"
import type { ClientContextValue } from "../../app/client-context.js"
import { describeFailure } from "../../client/failure-message.js"

/** Captures only the client error and its identity, never conversation or file content. */
export function reportInput(client: ClientContextValue, report: { readonly kind: "crash"; readonly error: unknown } | { readonly kind: "manual"; readonly note?: string }): BugReportInput {
  return sanitizeBugReportInput({
    kind: report.kind,
    error: report.kind === "manual" ? { name: "", message: "", stack: "" } : report.error instanceof Error
      ? { name: report.error.name, message: report.error.message, stack: report.error.stack ?? "" }
      : { name: "Error", message: String(report.error), stack: "" },
    surface: client.host.surface ?? "web",
    sessionId: client.state().sessionId ?? null,
    ...(report.kind === "manual" && report.note ? { note: report.note } : {}),
  })
}

/** Clipboard rejection stays visible without replacing the original send failure. */
export async function copyReport(client: ClientContextValue, text: string): Promise<void> {
  try {
    const write = client.host.capabilities.writeClipboardText
    if (!write) { client.report("warning", "Clipboard access is not available."); return }
    await write(text)
    if (!client.signal.aborted) client.report("info", "Report copied.")
  } catch (error) {
    if (!client.signal.aborted) client.report("warning", `Could not copy the report: ${describeFailure(error)}`)
  }
}

/** One pending submission per mounted surface. Disposed surfaces ignore late receipts. */
export function createReportSubmission(client: ClientContextValue) {
  const [pending, setPending] = createSignal(false)
  const [result, setResult] = createSignal<BugReportResult>()
  const [input, setInput] = createSignal<BugReportInput>()
  let disposed = false
  onCleanup(() => { disposed = true })
  const send = async (next: BugReportInput): Promise<void> => {
    if (pending() || disposed || client.signal.aborted) return
    const sanitized = sanitizeBugReportInput(next)
    setInput(sanitized)
    setPending(true)
    setResult(undefined)
    let outcome: BugReportResult
    try {
      outcome = await client.connection.dispatch({
        type: "bugReport.submit",
        kind: sanitized.kind,
        error: sanitized.error,
        surface: sanitized.surface,
        ...(sanitized.sessionId === null ? {} : { sessionId: sanitized.sessionId }),
        ...(sanitized.note === undefined ? {} : { note: sanitized.note }),
      })
    } catch (error) {
      outcome = { ok: false, kind: "unavailable", error: describeFailure(error) }
    }
    if (disposed || client.signal.aborted) return
    setResult(outcome)
    setPending(false)
  }
  return {
    pending, result, send,
    copy: () => {
      const captured = input()
      const outcome = result()
      if (captured) void copyReport(client, outcome?.ok === false && outcome.reportText !== undefined
        ? outcome.reportText : bugReportCopyText(captured, {
          version: client.state().runtimeVersion ?? null,
          build: client.host.clientIdentity ?? client.state().runtimeBuildId ?? null,
        }, outcome?.ok === false ? outcome.error : undefined))
    },
  }
}
