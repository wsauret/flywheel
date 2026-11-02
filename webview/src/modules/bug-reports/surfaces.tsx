import { createSignal, onMount, Show } from "solid-js"
import type { RuntimeFaultReportOutcome, RuntimeHealth } from "../../../../src/protocol/app-service-types.js"
import { useClient } from "../../app/client-context.js"
import { Sheet } from "../../app/sheets/sheet.js"
import { NOT_RELEASE_REPORT_STATUS, reportSentStatus, type BugReportInput, BUG_REPORT_COMMAND_NAME } from "../../../../src/protocol/modules/bug-reports.js"
import { copyReport, createReportSubmission, reportInput } from "./report.js"
import "./surfaces.css"
import { describeFailure } from "../../client/failure-message.js"

/** A crash report is automatic, so its receipt also says where to turn automatic reports off. */
function ReportStatus(props: { readonly submission: ReturnType<typeof createReportSubmission>; readonly kind: BugReportInput["kind"] }) {
  const message = () => {
    const result = props.submission.result()
    if (props.submission.pending()) return "Sending report…"
    if (!result) return ""
    if (result.ok) return reportSentStatus(result.reportId, props.kind === "crash")
    return result.kind === "not-release" ? result.error : `Could not send report: ${result.error}`
  }
  return <div class="bug-report-status">
    <p role="status" aria-live="polite" aria-busy={props.submission.pending() || undefined}>{message()}</p>
    <Show when={props.submission.result()?.ok === false}><button class="ghost-text" onClick={props.submission.copy}>Copy report</button></Show>
  </div>
}

/** The error boundary owns this mount, so one appearance sends one report. */
export function ViewErrorReport(props: { readonly error: unknown }) {
  const client = useClient()
  const submission = createReportSubmission(client)
  const input = reportInput(client, { kind: "crash", error: props.error })
  onMount(() => { void submission.send(input) })
  return <div class="sheet-problem">
    <p>This view is unavailable.</p>
    <ReportStatus submission={submission} kind="crash" />
  </div>
}

/** A manual report keeps the note and send result visible until the person closes it. */
export function BugReportSheet() {
  const client = useClient()
  const submission = createReportSubmission(client)
  const [note, setNote] = createSignal("")
  const send = () => {
    void submission.send(reportInput(client, { kind: "manual", note: note().trim() }))
  }
  return <Sheet title={BUG_REPORT_COMMAND_NAME} onClose={client.closeSheet} footer={
    <button class="primary" disabled={submission.pending()} aria-busy={submission.pending() || undefined} onClick={send}>Send report</button>
  }>
    <div class="bug-report-form">
      <p>The report includes diagnostic records, not conversation or file content. Your note is sent as written.</p>
      <label for="bug-report-note">Note (optional)</label>
      <textarea id="bug-report-note" class="dialog-input" rows={4} maxLength={2000} value={note()} onInput={event => setNote(event.currentTarget.value)} />
      <ReportStatus submission={submission} kind="manual" />
    </div>
  </Sheet>
}

function reportOutcomeStatus(outcome: RuntimeFaultReportOutcome): string {
  if (outcome.kind === "sent") return reportSentStatus(outcome.reportId, true)
  return outcome.kind === "failed" ? "Could not send report." : NOT_RELEASE_REPORT_STATUS
}

/** Runtime reporting belongs to the account service; this surface never sends a second report. */
export function RuntimeReportDetail(props: { readonly health: RuntimeHealth }) {
  const client = useClient()
  const report = () => "report" in props.health ? props.health.report : undefined
  const copy = () => {
    const source = props.health.kind === "crash_loop" ? "service" : "executor"
    void (async () => {
      try {
        const text = await client.connection.query({ type: "bugReport.failed", source })
        if (client.signal.aborted) return
        if (text === null) { client.report("warning", "This fault report is no longer available."); return }
        await copyReport(client, text)
      } catch (error) {
        if (!client.signal.aborted) client.report("warning", `Could not copy the report: ${describeFailure(error)}`)
      }
    })()
  }
  return <span>
    <Show when={report()}>{outcome => <> {reportOutcomeStatus(outcome())}<Show when={outcome().kind !== "sent"}> <button class="ghost-text" onClick={copy}>Copy report</button></Show></>}</Show>
  </span>
}
