import { createSignal, onMount, Show } from "solid-js"
import type { RuntimeFaultReportOutcome, RuntimeHealth } from "../../../../src/protocol/runtime/app-service-types.js"
import { useClient } from "../../app/client-context.js"
import { Sheet } from "../../app/sheets/sheet.js"
import { AUTOMATIC_REPORTS_OFF_STATUS, AUTOMATIC_REPORTS_QUESTION, DO_NOT_TRACK_REPORT_STATUS, NOT_RELEASE_REPORT_STATUS, reportSentStatus, type BugReportInput, BUG_REPORT_COMMAND_NAME } from "../../../../src/protocol/modules/bug-reports.js"
import { copyReport, createReportSubmission, reportInput } from "./report.js"
import "./surfaces.css"
import { describeFailure } from "../../client/format/failure-message.js"

/** The results that kept a report local on purpose, which the status states as they are. */
const WITHHELD = new Set<string>(["not-release", "not-allowed", "do-not-track"])

/** A crash report is automatic, so its receipt also says where to turn automatic reports off. While the person
 *  has not answered whether crash reports send automatically, the status asks instead. */
function ReportStatus(props: { readonly submission: ReturnType<typeof createReportSubmission>; readonly kind: BugReportInput["kind"] }) {
  const result = () => props.submission.result()
  const asking = () => { const current = result(); return current?.ok === false && current.kind === "consent-needed" }
  // The question is the live status while it waits for an answer; while the answer saves, or after a save
  // failed, the status says so and the question stays in view below it.
  const message = () => {
    const current = result()
    if (asking()) return props.submission.answering() ? "Saving your answer…" : props.submission.answerFailure() ?? AUTOMATIC_REPORTS_QUESTION
    if (props.submission.pending()) return "Sending report…"
    if (!current) return ""
    if (current.ok) return reportSentStatus(current.reportId, props.kind === "crash")
    return WITHHELD.has(current.kind) ? current.error : `Could not send report: ${current.error}`
  }
  const busy = () => props.submission.pending() || props.submission.answering()
  return <div class="bug-report-status">
    <p role="status" aria-live="polite" aria-busy={busy() || undefined} classList={{ "bug-report-question": asking() && props.submission.answerFailure() === undefined }}>{message()}</p>
    <Show when={asking()}>
      <Show when={props.submission.answering() || props.submission.answerFailure() !== undefined}><p class="bug-report-question">{AUTOMATIC_REPORTS_QUESTION}</p></Show>
      <div class="bug-report-answers">
        <button class="primary" disabled={props.submission.answering()} onClick={() => { void props.submission.answer(true) }}>Send reports</button>
        <button class="ghost-text" disabled={props.submission.answering()} onClick={() => { void props.submission.answer(false) }}>Don't send</button>
      </div>
    </Show>
    <Show when={result()?.ok === false}><button class="ghost-text" onClick={props.submission.copy}>Copy report</button></Show>
  </div>
}

/** The error boundary owns this mount, so one appearance sends one report, or asks the one question first. */
export function ViewErrorReport(props: { readonly error: unknown }) {
  const client = useClient()
  const submission = createReportSubmission(client)
  const input = reportInput(client, { kind: "crash", error: props.error })
  // A phone shows this view in place of its machine picker, where no project connection is open, and a
  // submit there would wait for a connection that never opens. Copy is offered at once instead.
  const connected = client.state().projectRoot !== undefined && client.state().health.kind !== "faulted"
  onMount(() => {
    if (connected) void submission.send(input)
    else submission.keepLocal(input, "This page is not connected to a project.")
  })
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
  switch (outcome.kind) {
    case "sent": return reportSentStatus(outcome.reportId, true)
    case "failed": return "Could not send report."
    case "not-release": return NOT_RELEASE_REPORT_STATUS
    case "not-allowed": return AUTOMATIC_REPORTS_OFF_STATUS
    case "do-not-track": return DO_NOT_TRACK_REPORT_STATUS
  }
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
