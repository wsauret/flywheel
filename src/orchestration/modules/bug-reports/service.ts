import { homedir } from "node:os"
import { Schema } from "effect"
import { Log } from "../../../infra/diagnostics/log.js"
import { moduleServiceHandle } from "../../../infra/definitions/modules/module-service.js"
import { readAppVersion } from "../../../infra/update/distribution/app-version.js"
import { redactSecrets } from "../../../infra/redact-secrets.js"
import {
  AUTOMATIC_REPORTS_OFF_STATUS, automaticReport, BUG_REPORT_MAX_BYTES, BugReportReceiptSchema, BugReportSchema, DO_NOT_TRACK_REPORT_STATUS, DO_NOT_TRACK_UNKNOWN_STATUS, NOT_RELEASE_REPORT_STATUS, sanitizeBugReportInput,
  type AssembledBugReport, type BugReportConsentResult, type BugReportInput, type BugReportResult,
} from "../../../protocol/modules/bug-reports.js"
import { runningDisplayBuildId } from "../../../infra/update/distribution/running-build.js"
import type { ModuleServiceInstance } from "../../app-service/executor/execution/module-service-host.js"
import type { RuntimeFaultReporter } from "../../app-service/executor/runtime-fault-reporting.js"
import { collectReportDiagnostics } from "./diagnostics.js"

export interface BugReportsService extends ModuleServiceInstance {
  submit(input: BugReportInput): Promise<BugReportResult>
  /** Records the person's answer to whether crash reports send automatically. Sends nothing. */
  answerAutomaticReports(allow: boolean): Promise<BugReportConsentResult>
  readonly reportFault: RuntimeFaultReporter
  failedReport(source: "executor" | "service"): string | null
  dispose(): Promise<void>
}
export const bugReportsService = moduleServiceHandle<BugReportsService>("bug-reports")

/** The report endpoint of the official release pipeline, or undefined. A built binary has it compiled in: only a
 *  release build command supplies it, from the release machine's environment (ARCH-DISTRIBUTION-034), so a local
 *  install and a fork's release build carry none. A source run reads it from its own environment. */
function reportEndpoint(): string | undefined {
  return process.env.FLYWHEEL_REPORT_ENDPOINT || undefined
}

/** A path below the home directory can name the person and their projects; a report names that directory `~`. */
function withoutHome(value: string): string {
  const home = homedir()
  return home.length > 1 ? value.replaceAll(home, "~") : value
}

/** Serializes a report within the relay cap: the oldest diagnostic records go first, then the end of the stack,
 *  then the end of the message. The stack is cut at a line end, so an automatic report keeps whole frames. */
function fitted<R extends { error: { readonly name: string; readonly message: string; readonly stack: string }; diagnostics: AssembledBugReport["diagnostics"] }>(input: R): string {
  const report = { ...input }
  const half = (value: string) => value.slice(0, Math.floor(value.length / 2))
  let body = JSON.stringify(report)
  while (Buffer.byteLength(body) > BUG_REPORT_MAX_BYTES) {
    const source = (["tui", "executor", "account"] as const).find((candidate) => report.diagnostics[candidate].length > 0)
    if (source) report.diagnostics = { ...report.diagnostics, [source]: report.diagnostics[source].slice(1) }
    else if (report.error.stack.length > 0) {
      const kept = half(report.error.stack)
      const lineEnd = kept.lastIndexOf("\n")
      report.error = { ...report.error, stack: lineEnd > 0 ? kept.slice(0, lineEnd) : kept }
    } else report.error = { ...report.error, message: half(report.error.message) }
    body = JSON.stringify(report)
  }
  return body
}

/** Account-owned report sender. Sends once per call; a failed send never retries or throws to the caller.
 *  A report from a build without the official report endpoint, and a crash report under the release harness,
 *  stays local: it is assembled for Copy and never sent. A crash report, which nobody asked for at the time it
 *  sends, also stays local unless the person answered yes and DO_NOT_TRACK is unset, and the one it sends holds
 *  no free text (PI-INTERACTION-064, PI-INTERACTION-107). The Copy text of every report keeps the full text. */
export function createBugReportsService(options: {
  readonly userDataRoot: string
  readonly projectRoot?: string
  readonly enabled: () => boolean
  /** The person's answer to whether crash reports send automatically as the account's file holds it now, or
   *  undefined before they answer. Read once per automatic report, after it is assembled and before it sends. */
  readonly automaticReports: () => Promise<boolean | undefined>
  /** Stores the person's answer for the account while it is unanswered, and resolves to the answer in force
   *  afterwards, or undefined when it could not be saved. Absent where no client can answer, such as the
   *  account's own fault reporter. */
  readonly answerAutomaticReports?: (allow: boolean) => Promise<boolean | undefined>
  /** Whether DO_NOT_TRACK opts out where this service runs, or undefined while that is unknown, which also
   *  keeps an automatic report local. */
  readonly doNotTrack: () => Promise<boolean | undefined>
  readonly readFaultReport?: (source: "executor" | "service") => string | undefined
  readonly fetch?: typeof fetch
}): BugReportsService {
  const log = Log.create({ service: "bug-reports" })
  let closed = false
  const pending = new Set<Promise<BugReportResult>>()
  const submit = async (input: BugReportInput, projectRoot = options.projectRoot): Promise<BugReportResult> => {
    if (closed || !options.enabled()) return { ok: false, kind: "disabled", error: "Bug reports are turned off." }
    let bytes = 0
    let reportText: string | undefined
    try {
      const sanitized = sanitizeBugReportInput(input)
      const report: AssembledBugReport = {
        ...sanitized,
        error: { name: withoutHome(sanitized.error.name), message: withoutHome(sanitized.error.message), stack: withoutHome(sanitized.error.stack) },
        ...(sanitized.note === undefined ? {} : { note: withoutHome(sanitized.note) }),
        version: redactSecrets(await readAppVersion()).slice(0, 200), build: runningDisplayBuildId(),
        os: process.platform, arch: process.arch,
        diagnostics: await collectReportDiagnostics({ userDataRoot: options.userDataRoot, ...(projectRoot === undefined ? {} : { projectRoot }) }),
      }
      reportText = fitted(report)
      const body = report.kind === "crash" ? fitted(automaticReport(report)) : reportText
      Schema.decodeUnknownSync(BugReportSchema, { onExcessProperty: "error" })(JSON.parse(body))
      bytes = Buffer.byteLength(body)
      const endpoint = reportEndpoint()
      // The release harness drives official binaries, and its crashes are not a user's.
      if (endpoint === undefined || (input.kind === "crash" && process.env.FLYWHEEL_INTERNAL_RELEASE_HARNESS !== undefined)) {
        log.info("bug report not sent", { reason: "not-release", bytes })
        return { ok: false, kind: "not-release", error: NOT_RELEASE_REPORT_STATUS, reportText }
      }
      if (input.kind === "crash") {
        // The send admission of a report nobody asked for: it reads the answer and DO_NOT_TRACK as they are
        // now, so an answer saved while the report was assembled, or while this service waits to be
        // replaced, applies to it.
        const tracking = await options.doNotTrack()
        const answer = tracking === false ? await options.automaticReports() : undefined
        const held = tracking !== false ? "do-not-track" : answer === true ? undefined : answer === false ? "not-allowed" : "consent-needed"
        if (held !== undefined) {
          log.info("bug report not sent", { reason: tracking === undefined ? "do-not-track-unknown" : held, bytes })
          const error = held !== "do-not-track" ? AUTOMATIC_REPORTS_OFF_STATUS : tracking === undefined ? DO_NOT_TRACK_UNKNOWN_STATUS : DO_NOT_TRACK_REPORT_STATUS
          return { ok: false, kind: held, error, reportText }
        }
      }
      const response = await (options.fetch ?? fetch)(endpoint, {
        method: "POST", headers: { "content-type": "application/json" }, body,
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        log.info("bug report failed", { bytes })
        return { ok: false, kind: "rejected", error: "The report service could not accept this report.", reportText }
      }
      const receipt = Schema.decodeUnknownSync(BugReportReceiptSchema)(await response.json())
      log.info("bug report sent", { reportId: receipt.reportId, bytes })
      return { ok: true, reportId: receipt.reportId }
    } catch {
      log.info("bug report failed", { bytes })
      return { ok: false, kind: "unavailable", error: "The report service could not be reached.", ...(reportText === undefined ? {} : { reportText }) }
    }
  }
  const send = (input: BugReportInput, projectRoot?: string): Promise<BugReportResult> => {
    const work = submit(input, projectRoot)
    pending.add(work)
    void work.then(() => pending.delete(work))
    return work
  }
  return {
    submit: send,
    async answerAutomaticReports(allow) {
      if (closed || !options.enabled() || options.answerAutomaticReports === undefined) return { ok: false, error: "Bug reports are turned off." }
      const automatic = await options.answerAutomaticReports(allow).catch(() => undefined)
      log.info("automatic bug reports answered", { allow, ...(automatic === undefined ? { saved: false } : { automatic }) })
      return automatic === undefined ? { ok: false, error: "The answer could not be saved." } : { ok: true, automatic }
    },
    failedReport: (source) => options.readFaultReport?.(source) ?? null,
    async reportFault(error: Error, projectRoot?: string) {
      const result = await send({ kind: "crash", error: { name: error.name, message: error.message, stack: error.stack ?? "" }, surface: "runtime", sessionId: null }, projectRoot)
      if (result.ok) return { kind: "sent", reportId: result.reportId }
      // A DO_NOT_TRACK that could not be read is no claim that it is set, so the notice says no report went.
      const kind = result.kind === "not-release" ? result.kind
        : result.kind === "do-not-track" ? result.error === DO_NOT_TRACK_REPORT_STATUS ? "do-not-track" : "failed"
        : result.kind === "consent-needed" || result.kind === "not-allowed" ? "not-allowed" : "failed"
      return { kind, ...(result.reportText === undefined ? {} : { reportText: result.reportText }) }
    },
    closeAdmission() { closed = true },
    async dispose() { closed = true; await Promise.all(pending) },
  }
}
