import { Schema } from "effect"
import { defineProtocolModule, defineProtocolMutation, defineProtocolQuery } from "../protocol-module.js"
import { redactSecrets } from "../../infra/redact-secrets.js"

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max))
const BugReportKindSchema = Schema.Literals(["crash", "manual"])
const BugReportErrorSchema = Schema.Struct({ name: text(200), message: text(4000), stack: text(12000) })
const BugReportSurfaceSchema = Schema.Literals(["tui", "web", "phone", "editor", "runtime"])
const DiagnosticRecordSchema = Schema.Struct({
  ts: Schema.Number,
  type: text(200),
  sessionId: Schema.optionalKey(text(200)),
  actor: Schema.optionalKey(text(200)),
  version: Schema.optionalKey(Schema.Number),
  payload: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
const records = Schema.Array(DiagnosticRecordSchema).check(Schema.isMaxLength(40))

/** Relay request. Diagnostics contain metadata only, never conversation, file, or process output. */
export const BugReportSchema = Schema.Struct({
  kind: BugReportKindSchema,
  error: BugReportErrorSchema,
  version: text(200),
  build: Schema.NullOr(text(200)),
  os: text(200),
  arch: text(200),
  surface: BugReportSurfaceSchema,
  sessionId: Schema.NullOr(text(200)),
  note: Schema.optionalKey(text(2000)),
  diagnostics: Schema.Struct({ tui: records, executor: records, account: records }),
})
export type BugReport = typeof BugReportSchema.Type
export type BugReportDiagnostic = typeof DiagnosticRecordSchema.Type
export const BUG_REPORT_MAX_BYTES = 48_000
export const BugReportReceiptSchema = Schema.Struct({ reportId: Schema.NonEmptyString.check(Schema.isMaxLength(32)) })
/** `not-release` is no failure: a build that is not an official release carries no report endpoint and sends no report,
 *  and a run under the test harness sends no crash report. Each returns the assembled report for Copy instead. */
const BugReportResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), reportId: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), kind: Schema.Literals(["disabled", "not-release", "unavailable", "rejected"]), error: Schema.String, reportText: Schema.optionalKey(Schema.String) }),
])
export type BugReportResult = typeof BugReportResultSchema.Type
/** What every surface says when a report stays local because the build is not an official release. */
export const NOT_RELEASE_REPORT_STATUS = "No bug report was sent because this build is not an official Flywheel release."
/** What every surface says when the report service accepted a report. An automatic report, which the person did
 *  not ask for, also says where the person turns automatic reports off: the module's row in Settings. */
export function reportSentStatus(reportId: string, automatic: boolean): string {
  return automatic
    ? `Report sent automatically (${reportId}). To stop automatic reports, turn off Bug reports in Settings.`
    : `Report sent (${reportId})`
}
const BugReportInputFields = {
  kind: BugReportKindSchema,
  error: BugReportErrorSchema,
  surface: BugReportSurfaceSchema,
  sessionId: Schema.NullOr(text(200)),
  note: Schema.optionalKey(text(2000)),
}
const BugReportInputSchema = Schema.Struct(BugReportInputFields)
export type BugReportInput = typeof BugReportInputSchema.Type

/** Sanitizes each client field before bounding it. Protocol inputs can already be truncated prefixes. */
export function sanitizeBugReportInput(input: BugReportInput): BugReportInput {
  const sanitize = (value: string, max: number) => redactSecrets(value, { completeness: "prefix" }).slice(0, max)
  return {
    kind: input.kind,
    error: { name: sanitize(input.error.name, 200), message: sanitize(input.error.message, 4000), stack: sanitize(input.error.stack, 12000) },
    surface: input.surface,
    sessionId: input.sessionId === null ? null : sanitize(input.sessionId, 200),
    ...(input.note === undefined ? {} : { note: sanitize(input.note, 2000) }),
  }
}

/** Builds local Copy text only when the account could not assemble a report. */
export function bugReportCopyText(input: BugReportInput, identity: {
  readonly version: string | null
  readonly build: string | null
  readonly platform?: string
}, failure?: string): string {
  return JSON.stringify({
    ...sanitizeBugReportInput(input),
    version: identity.version === null ? null : redactSecrets(identity.version).slice(0, 200),
    build: identity.build === null ? null : redactSecrets(identity.build).slice(0, 200),
    ...(identity.platform === undefined ? {} : { platform: redactSecrets(identity.platform) }),
    ...(failure === undefined ? {} : { failure: redactSecrets(failure, { completeness: "prefix" }) }),
  }, null, 2)
}

/** The surface `/report` opens: where a person sends a manual report with an
 *  optional note. A client that has no note field sends the command's
 *  argument as the note. */
export const BUG_REPORT_SURFACE = "bug-report"
export const BUG_REPORT_COMMAND = "report"
/** The command's one name, which its surface also heads with. */
export const BUG_REPORT_COMMAND_NAME = "Report a bug"

export const bugReportsProtocol = defineProtocolModule({
  id: "bug-reports",
  domains: [],
  queries: [defineProtocolQuery({
    query: "bugReport.failed",
    input: { source: Schema.Literals(["executor", "service"]) },
    result: Schema.NullOr(Schema.String),
    deadline: "control",
  })],
  mutations: [defineProtocolMutation({
    type: "bugReport.submit",
    fields: { ...BugReportInputFields, sessionId: Schema.optionalKey(text(200)) },
    result: BugReportResultSchema,
    policy: "lossless",
    refuse: (error): BugReportResult => ({ ok: false, kind: "unavailable", error }),
  })],
})
