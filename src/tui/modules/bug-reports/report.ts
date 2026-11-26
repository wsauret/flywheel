import { errorMessage } from "../../../infra/diagnostics/error-message.js"
import { doNotTrack } from "../../../infra/environment/do-not-track.js"
import type { RuntimeClient, RuntimeFaultReportOutcome, RuntimeHealth } from "../../../protocol/runtime/app-service-types.js"
import {
  AUTOMATIC_REPORTS_OFF_STATUS, AUTOMATIC_REPORTS_QUESTION, bugReportCopyText, DO_NOT_TRACK_REPORT_STATUS, NOT_RELEASE_REPORT_STATUS, reportSentStatus, sanitizeBugReportInput,
  type BugReportConsentResult, type BugReportInput, type BugReportResult,
} from "../../../protocol/modules/bug-reports.js"
import { createSignal, onMount, onCleanup } from "solid-js"
import type { TuiErrorReport, TuiErrorReportProps, TuiFaultNotice, TuiFaultNoticeHost } from "../../tui-module.js"

/** The results that kept a report local on purpose, which the screen states in muted text. */
const WITHHELD = new Set<string>(["not-release", "consent-needed", "not-allowed", "do-not-track"])

/** Sends once when a crash fallback mounts and ignores completion after that fallback is disposed. While the
 *  person has not answered whether crash reports send automatically, the screen asks once instead: yes stores
 *  the answer and sends this report, and no stores the answer and sends nothing. DO_NOT_TRACK in the terminal's
 *  environment sends nothing and asks nothing. */
export function createCrashReport(props: TuiErrorReportProps): TuiErrorReport {
  const [result, setResult] = createSignal<BugReportResult>()
  const [answering, setAnswering] = createSignal(false)
  const [answerFailure, setAnswerFailure] = createSignal<string>()
  let alive = true
  onCleanup(() => { alive = false })
  const submit = () => {
    void submitTuiReport(props.client, { kind: "crash", error: props.error, sessionId: props.sessionId }).then((receipt) => {
      if (alive) setResult(receipt)
    })
  }
  onMount(() => {
    if (doNotTrack(process.env.DO_NOT_TRACK)) setResult({ ok: false, kind: "do-not-track", error: DO_NOT_TRACK_REPORT_STATUS })
    else submit()
  })
  const answer = async (allow: boolean): Promise<void> => {
    const asked = result()
    if (answering() || asked?.ok !== false || asked.kind !== "consent-needed") return
    setAnswering(true)
    setAnswerFailure(undefined)
    let answered: BugReportConsentResult
    try {
      answered = await props.client.dispatch({ type: "bugReport.consent", allow })
    } catch (cause) {
      answered = { ok: false, error: errorMessage(cause) }
    }
    if (!alive) return
    setAnswering(false)
    // A failed save keeps the question open, so the person can answer again.
    if (!answered.ok) setAnswerFailure(`Could not save your answer: ${answered.error}`)
    // The answer in force decides, which is an earlier answer when another surface saved one first.
    else if (answered.automatic) { setResult(undefined); submit() }
    else setResult({ ...asked, kind: "not-allowed", error: AUTOMATIC_REPORTS_OFF_STATUS })
  }
  return {
    status: () => {
      const receipt = result()
      if (receipt?.ok === false && receipt.kind === "consent-needed") return answering() ? "Saving your answer..." : answerFailure()
      return receipt?.ok === false && receipt.kind === "disabled" ? undefined : reportStatus(receipt, "crash")
    },
    failed: () => {
      const receipt = result()
      return receipt?.ok === false && (receipt.kind === "consent-needed" ? answerFailure() !== undefined && !answering() : !WITHHELD.has(receipt.kind))
    },
    busy: answering,
    question: () => {
      const receipt = result()
      return receipt?.ok === false && receipt.kind === "consent-needed" ? AUTOMATIC_REPORTS_QUESTION : undefined
    },
    answer: (allow) => { void answer(allow) },
    copyText: () => crashReportText({ kind: "crash", error: props.error, version: props.version, sessionId: props.sessionId, result: result() }),
  }
}

/** Sends a client error through the account service. Transport failures become a displayable result. */
export async function submitTuiReport(
  client: Pick<RuntimeClient, "dispatch">,
  { kind, error, sessionId, note }: {
    readonly kind: BugReportInput["kind"]
    readonly error: Pick<Error, "name" | "message" | "stack">
    readonly sessionId?: string | undefined
    readonly note?: string | undefined
  },
): Promise<BugReportResult> {
  try {
    const input = sanitizeBugReportInput({
      kind, surface: "tui", error: { name: error.name, message: error.message, stack: error.stack ?? "" },
      sessionId: sessionId ?? null, ...(note === undefined ? {} : { note }),
    })
    return await client.dispatch({
      type: "bugReport.submit",
      kind: input.kind, surface: input.surface, error: input.error,
      ...(input.sessionId === null ? {} : { sessionId: input.sessionId }),
      ...(input.note === undefined ? {} : { note: input.note }),
    })
  } catch (cause) {
    return { ok: false, kind: "unavailable", error: errorMessage(cause) }
  }
}

/** The status shown by the crash screen and the manual report command. A crash report is automatic. */
export function reportStatus(result: BugReportResult | undefined, kind: BugReportInput["kind"]): string {
  if (result === undefined) return "Sending bug report..."
  if (result.ok) return reportSentStatus(result.reportId, kind === "crash")
  return WITHHELD.has(result.kind) ? result.error : `Could not send bug report: ${result.error}`
}

/** Uses the account's assembled report, or sanitized client fields when the account did not assemble one. */
export function crashReportText(input: {
  readonly kind: BugReportInput["kind"]
  readonly error: Pick<Error, "name" | "message" | "stack">
  readonly version: string
  readonly sessionId?: string
  readonly result?: BugReportResult
  readonly note?: string
}): string {
  if (input.result?.ok === false && input.result.reportText !== undefined) return input.result.reportText
  return bugReportCopyText({
    kind: input.kind,
    error: { name: input.error.name, message: input.error.message, stack: input.error.stack ?? "" },
    surface: "tui", sessionId: input.sessionId ?? null, ...(input.note === undefined ? {} : { note: input.note }),
  }, { version: input.version, build: null, platform: `${process.platform} ${process.arch}` }, input.result?.ok === false ? input.result.error : undefined)
}

/** Adds the account-owned receipt to a notice without sending a second report. */
export function reportFaultNotice(notice: TuiFaultNotice, health: RuntimeHealth, host: TuiFaultNoticeHost): TuiFaultNotice {
  const report = "report" in health ? health.report : undefined
  if (report === undefined) return notice
  const status = faultReportStatus(report)
  return {
    ...notice, detail: `${notice.detail}\n${status}`,
    ...(report.kind !== "sent" ? {
      copyReport: () => {
        void (async () => {
          try {
            const text = await host.client.query({ type: "bugReport.failed", source: health.kind === "crash_loop" ? "service" : "executor" })
            if (text === null) { host.showToast({ message: "This fault report is no longer available.", variant: "warning" }); return }
            await host.clipboard.copy(text)
            host.showToast({ message: "Report copied.", variant: "success" })
          } catch (error) {
            host.showToast({ message: `Could not copy the report: ${errorMessage(error)}`, variant: "error" })
          }
        })()
      },
    } : {}),
  }
}

function faultReportStatus(report: RuntimeFaultReportOutcome): string {
  switch (report.kind) {
    case "sent": return reportSentStatus(report.reportId, true)
    case "failed": return "Could not send bug report."
    case "not-release": return NOT_RELEASE_REPORT_STATUS
    case "not-allowed": return AUTOMATIC_REPORTS_OFF_STATUS
    case "do-not-track": return DO_NOT_TRACK_REPORT_STATUS
  }
}
