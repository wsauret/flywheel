import { homedir } from "node:os"
import { Schema } from "effect"
import { Log } from "../../../infra/log.js"
import { moduleServiceHandle } from "../../../infra/module-service.js"
import { readAppVersion } from "../../../infra/app-version.js"
import { redactSecrets } from "../../../infra/redact-secrets.js"
import { BUG_REPORT_MAX_BYTES, BugReportReceiptSchema, BugReportSchema, NOT_RELEASE_REPORT_STATUS, sanitizeBugReportInput, type BugReportInput, type BugReportResult } from "../../../protocol/modules/bug-reports.js"
import { runningDisplayBuildId } from "../../app-service/runtime-executable.js"
import type { ModuleServiceInstance } from "../../app-service/module-service-host.js"
import type { RuntimeFaultReporter } from "../../app-service/runtime-fault-reporting.js"
import { collectReportDiagnostics } from "./diagnostics.js"

export interface BugReportsService extends ModuleServiceInstance {
  submit(input: BugReportInput): Promise<BugReportResult>
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

/** Account-owned report sender. Sends once per call; a failed send never retries or throws to the caller.
 *  A report from a build without the official report endpoint, and a crash report under the release harness,
 *  stays local: it is assembled for Copy and never sent. */
export function createBugReportsService(options: {
  readonly userDataRoot: string
  readonly projectRoot?: string
  readonly enabled: () => boolean
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
      const report = {
        ...sanitized,
        error: { name: withoutHome(sanitized.error.name), message: withoutHome(sanitized.error.message), stack: withoutHome(sanitized.error.stack) },
        ...(sanitized.note === undefined ? {} : { note: withoutHome(sanitized.note) }),
        version: redactSecrets(await readAppVersion()).slice(0, 200), build: runningDisplayBuildId(),
        os: process.platform, arch: process.arch,
        diagnostics: await collectReportDiagnostics({ userDataRoot: options.userDataRoot, ...(projectRoot === undefined ? {} : { projectRoot }) }),
      }
      let body = JSON.stringify(report)
      while (Buffer.byteLength(body) > BUG_REPORT_MAX_BYTES) {
        const source = (["tui", "executor", "account"] as const).find((candidate) => report.diagnostics[candidate].length > 0)
        if (source) report.diagnostics = { ...report.diagnostics, [source]: report.diagnostics[source].slice(1) }
        else if (report.error.stack.length > 0) report.error = { ...report.error, stack: report.error.stack.slice(0, Math.floor(report.error.stack.length / 2)) }
        else report.error = { ...report.error, message: report.error.message.slice(0, Math.floor(report.error.message.length / 2)) }
        body = JSON.stringify(report)
      }
      Schema.decodeUnknownSync(BugReportSchema, { onExcessProperty: "error" })(JSON.parse(body))
      bytes = Buffer.byteLength(body)
      reportText = body
      const endpoint = reportEndpoint()
      // The release harness drives official binaries, and its crashes are not a user's.
      if (endpoint === undefined || (input.kind === "crash" && process.env.FLYWHEEL_INTERNAL_RELEASE_HARNESS !== undefined)) {
        log.info("bug report not sent", { reason: "not-release", bytes })
        return { ok: false, kind: "not-release", error: NOT_RELEASE_REPORT_STATUS, reportText }
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
    failedReport: (source) => options.readFaultReport?.(source) ?? null,
    async reportFault(error: Error, projectRoot?: string) {
      const result = await send({ kind: "crash", error: { name: error.name, message: error.message, stack: error.stack ?? "" }, surface: "runtime", sessionId: null }, projectRoot)
      if (result.ok) return { kind: "sent", reportId: result.reportId }
      return { kind: result.kind === "not-release" ? "not-release" : "failed", ...(result.reportText === undefined ? {} : { reportText: result.reportText }) }
    },
    closeAdmission() { closed = true },
    async dispose() { closed = true; await Promise.all(pending) },
  }
}
