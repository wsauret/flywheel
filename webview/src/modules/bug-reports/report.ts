import { createSignal, onCleanup } from "solid-js"
import { AUTOMATIC_REPORTS_OFF_STATUS, bugReportCopyText, sanitizeBugReportInput, type BugReportConsentResult, type BugReportInput, type BugReportResult } from "../../../../src/protocol/modules/bug-reports.js"
import type { ClientContextValue } from "../../app/client-context.js"
import { describeFailure } from "../../client/format/failure-message.js"

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

/** One pending submission per mounted surface. Disposed surfaces ignore late receipts. `answer` settles the
 *  question a crash report raises while the person has not said whether crash reports send automatically:
 *  yes stores the answer and sends the captured report again, and no stores the answer and sends nothing. A
 *  failed save keeps the question open and says why in `answerFailure`. `keepLocal` holds a report that no
 *  project connection can take, so only Copy is offered. */
export function createReportSubmission(client: ClientContextValue) {
  const [pending, setPending] = createSignal(false)
  const [answering, setAnswering] = createSignal(false)
  const [answerFailure, setAnswerFailure] = createSignal<string>()
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
  const answer = async (allow: boolean): Promise<void> => {
    const asked = result()
    const captured = input()
    if (pending() || answering() || disposed || client.signal.aborted || captured === undefined || asked?.ok !== false || asked.kind !== "consent-needed") return
    setAnswering(true)
    setAnswerFailure(undefined)
    let answered: BugReportConsentResult
    try {
      answered = await client.connection.dispatch({ type: "bugReport.consent", allow })
    } catch (error) {
      answered = { ok: false, error: describeFailure(error) }
    }
    if (disposed || client.signal.aborted) return
    setAnswering(false)
    if (!answered.ok) setAnswerFailure(`Could not save your answer: ${answered.error}`)
    // The answer in force decides, which is an earlier answer when another surface saved one first.
    else if (answered.automatic) await send(captured)
    else setResult({ ...asked, kind: "not-allowed", error: AUTOMATIC_REPORTS_OFF_STATUS })
  }
  const keepLocal = (next: BugReportInput, reason: string): void => {
    setInput(sanitizeBugReportInput(next))
    setResult({ ok: false, kind: "unavailable", error: reason })
  }
  return {
    pending, answering, answerFailure, result, send, answer, keepLocal,
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
