import { errorMessage } from "../../../infra/error-message.js"
import type { RuntimeClient, RuntimeHealth } from "../../../protocol/app-service-types.js"
import { bugReportCopyText, NOT_RELEASE_REPORT_STATUS, reportSentStatus, sanitizeBugReportInput, type BugReportInput, type BugReportResult } from "../../../protocol/modules/bug-reports.js"
import { createSignal, onMount, onCleanup } from "solid-js"
import type { TuiErrorReport, TuiErrorReportProps, TuiFaultNotice, TuiFaultNoticeHost } from "../../tui-module.js"

/** Sends once when a crash fallback mounts and ignores completion after that fallback is disposed. */
export function createCrashReport(props: TuiErrorReportProps): TuiErrorReport {
  const [result, setResult] = createSignal<BugReportResult>()
  let alive = true
  onCleanup(() => { alive = false })
  onMount(() => {
    void submitTuiReport(props.client, "crash", props.error, props.sessionId).then((receipt) => {
      if (alive) setResult(receipt)
    })
  })
  return {
    status: () => {
      const receipt = result()
      return receipt?.ok === false && receipt.kind === "disabled" ? undefined : reportStatus(receipt, "crash")
    },
    failed: () => {
      const receipt = result()
      return receipt?.ok === false && receipt.kind !== "not-release"
    },
    copyText: () => crashReportText({ kind: "crash", error: props.error, version: props.version, sessionId: props.sessionId, result: result() }),
  }
}

/** Sends a client error through the account service. Transport failures become a displayable result. */
export async function submitTuiReport(
  client: Pick<RuntimeClient, "dispatch">,
  kind: BugReportInput["kind"],
  error: Pick<Error, "name" | "message" | "stack">,
  sessionId?: string,
  note?: string,
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
  return result.kind === "not-release" ? result.error : `Could not send bug report: ${result.error}`
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
  const status = report.kind === "sent" ? reportSentStatus(report.reportId, true)
    : report.kind === "failed" ? "Could not send bug report." : NOT_RELEASE_REPORT_STATUS
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
