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

/** A function name as an engine prints it in a frame, such as `Object.<anonymous>`, `async run`, or
 *  `new Foo`. A name that does not match is left out, so a frame never carries other text. */
const FRAME_FUNCTION = String.raw`(?:(?:async|new) )?[\w$.<>[\]]{1,200}(?: \[as [\w$]{1,100}\])?`
/** A file name without its directory, query, or hash. */
const FRAME_FILE = String.raw`[\w.-]{1,200}`
/** The one frame shape an automatic report sends: `    at fn (file.ts:1:2)` or `    at file.ts:1:2`. */
const FILE_NAME = new RegExp(`^${FRAME_FILE}$`)
const FUNCTION_NAME = new RegExp(`^${FRAME_FUNCTION}$`)
const CANONICAL_FRAME = new RegExp(String.raw`^    at (?:${FRAME_FUNCTION} \(${FRAME_FILE}:\d+:\d+\)|${FRAME_FILE}:\d+:\d+)$`)
const ERROR_NAME = /^[A-Za-z_$][\w$.]{0,99}$/
const TOKEN = /^[\w.:@/-]{1,200}$/
const token = Schema.String.check(Schema.isPattern(TOKEN))
const frames = text(12000).check(Schema.makeFilter((stack: string) => stack === "" || stack.split("\n").every((line) => CANONICAL_FRAME.test(line)) || "only stack frames"))

/** One frame of a V8 or JavaScriptCore stack (`at fn (location)`, `at location`), or of a WebKit or Gecko
 *  stack (`fn@location`), in the canonical shape with the file reduced to its name. A line that is not a
 *  frame with a line and column, or whose file name holds other characters, yields nothing. */
function canonicalFrame(line: string): string | undefined {
  const trimmed = line.trim()
  const v8 = /^at (?:(.+?) \((.+)\)|(.+))$/.exec(trimmed)
  const browser = v8 ? undefined : /^([^@]*)@(.+)$/.exec(trimmed)
  const name = v8 ? v8[1] : browser?.[1] || undefined
  const location = v8 ? v8[2] ?? v8[3] : browser?.[2]
  const position = location === undefined ? undefined : /^(.*):(\d+):(\d+)$/.exec(location)
  if (!position) return undefined
  const file = (position[1] ?? "").replace(/[?#].*$/, "").split(/[\\/]/).pop() ?? ""
  if (!FILE_NAME.test(file)) return undefined
  const where = `${file}:${position[2]}:${position[3]}`
  return name !== undefined && FUNCTION_NAME.test(name) ? `    at ${name} (${where})` : `    at ${where}`
}

/** The frames of a stack. V8 and JavaScriptCore start a stack with the error's `name: message` header, which
 *  can span lines, so that header is removed before any line is read as a frame. */
function stackFrames(error: { readonly name: string; readonly message: string; readonly stack: string }): string {
  const header = error.message === "" ? error.name : `${error.name}: ${error.message}`
  const body = header !== "" && error.stack.startsWith(header) ? error.stack.slice(header.length) : error.stack
  return body.split("\n").flatMap((line) => canonicalFrame(line) ?? []).join("\n")
}
const AutomaticDiagnosticRecordSchema = Schema.Struct({
  ts: Schema.Number,
  type: token,
  sessionId: Schema.optionalKey(token),
  actor: Schema.optionalKey(token),
  version: Schema.optionalKey(Schema.Number),
  payload: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([token, Schema.Number, Schema.Boolean, Schema.Null]))),
})
const automaticRecords = Schema.Array(AutomaticDiagnosticRecordSchema).check(Schema.isMaxLength(40))
const identityFields = {
  version: text(200),
  build: Schema.NullOr(text(200)),
  os: text(200),
  arch: text(200),
  surface: BugReportSurfaceSchema,
  sessionId: Schema.NullOr(text(200)),
}

/** A report the person asked for: their note and the full error text. */
const ManualBugReportSchema = Schema.Struct({
  kind: Schema.Literal("manual"),
  error: BugReportErrorSchema,
  ...identityFields,
  note: Schema.optionalKey(text(2000)),
  diagnostics: Schema.Struct({ tui: records, executor: records, account: records }),
})
/** A report that a crash or a runtime fault sent on its own. It holds no free
 *  text: an identifier as the error name, an empty message, only stack frames,
 *  no note, and only token, number, and boolean diagnostic values. */
const AutomaticBugReportSchema = Schema.Struct({
  kind: Schema.Literal("crash"),
  error: Schema.Struct({ name: Schema.String.check(Schema.isPattern(ERROR_NAME)), message: Schema.Literal(""), stack: frames }),
  ...identityFields,
  diagnostics: Schema.Struct({ tui: automaticRecords, executor: automaticRecords, account: automaticRecords }),
})

/** Relay request. Diagnostics contain metadata only, never conversation, file, or process output. */
export const BugReportSchema = Schema.Union([ManualBugReportSchema, AutomaticBugReportSchema])
type ManualBugReport = typeof ManualBugReportSchema.Type
/** A report as the account assembles it, before an automatic report drops its free text. */
export type AssembledBugReport = Omit<ManualBugReport, "kind"> & { readonly kind: BugReportKind }
export type BugReportDiagnostic = typeof DiagnosticRecordSchema.Type
type BugReportKind = typeof BugReportKindSchema.Type

/** What an automatic report sends of an assembled report: the error name, the
 *  stack frames with each file reduced to its name, and the diagnostic values
 *  that are tokens. The message, the note, and every other line are dropped. */
export function automaticReport(report: AssembledBugReport): typeof AutomaticBugReportSchema.Type {
  const diagnostics = (stream: readonly BugReportDiagnostic[]) => stream.map((record) => ({
    ts: record.ts,
    type: TOKEN.test(record.type) ? record.type : "unknown",
    ...(record.sessionId !== undefined && TOKEN.test(record.sessionId) ? { sessionId: record.sessionId } : {}),
    ...(record.actor !== undefined && TOKEN.test(record.actor) ? { actor: record.actor } : {}),
    ...(record.version === undefined ? {} : { version: record.version }),
    ...(record.payload === undefined ? {} : {
      payload: Object.fromEntries(Object.entries(record.payload).filter((entry): entry is [string, string | number | boolean | null] => {
        const value = entry[1]
        return typeof value === "string" ? TOKEN.test(value) : typeof value === "number" || typeof value === "boolean" || value === null
      })),
    }),
  }))
  return {
    kind: "crash",
    error: {
      name: ERROR_NAME.test(report.error.name) ? report.error.name : "Error",
      message: "",
      stack: stackFrames(report.error),
    },
    version: report.version, build: report.build, os: report.os, arch: report.arch, surface: report.surface, sessionId: report.sessionId,
    diagnostics: { tui: diagnostics(report.diagnostics.tui), executor: diagnostics(report.diagnostics.executor), account: diagnostics(report.diagnostics.account) },
  }
}
export const BUG_REPORT_MAX_BYTES = 48_000
export const BugReportReceiptSchema = Schema.Struct({ reportId: Schema.NonEmptyString.check(Schema.isMaxLength(32)) })
/** `not-release` is no failure: a build that is not an official release carries no report endpoint and sends no report,
 *  and a run under the test harness sends no crash report. An automatic report sends only with the person's yes:
 *  `consent-needed` means the person has not answered yet, so the crash screen asks, `not-allowed` means the person
 *  said no, and `do-not-track` means DO_NOT_TRACK is set where the account service runs. Each returns the assembled
 *  report for Copy instead. */
const BugReportResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), reportId: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), kind: Schema.Literals(["disabled", "not-release", "consent-needed", "not-allowed", "do-not-track", "unavailable", "rejected"]), error: Schema.String, reportText: Schema.optionalKey(Schema.String) }),
])
export type BugReportResult = typeof BugReportResultSchema.Type
/** What every surface says when a report stays local because the build is not an official release. */
export const NOT_RELEASE_REPORT_STATUS = "No bug report was sent because this build is not an official Flywheel release."
/** The Settings row that holds the person's answer to the crash screen's question. */
export const AUTOMATIC_REPORTS_SETTING = "Automatic crash reports"
/** What every surface says when an automatic report stays local because the person said no or has not answered. */
export const AUTOMATIC_REPORTS_OFF_STATUS = `No bug report was sent because automatic crash reports are off. To send them, turn on ${AUTOMATIC_REPORTS_SETTING} in Settings.`
/** What every surface says when an automatic report stays local because DO_NOT_TRACK is set. */
export const DO_NOT_TRACK_REPORT_STATUS = "No bug report was sent because DO_NOT_TRACK is set."
/** What every surface says when an automatic report stays local because the account service could not read
 *  DO_NOT_TRACK from the person's login shell. */
export const DO_NOT_TRACK_UNKNOWN_STATUS = "No bug report was sent because Flywheel could not read whether DO_NOT_TRACK is set in your login shell."
/** The crash screen's one question, asked while the person has not answered it. */
export const AUTOMATIC_REPORTS_QUESTION = "Send this crash report to Flywheel, and send later crash reports automatically? A crash report holds the error name, its stack frames, and diagnostic ids and timings, never the error message, conversation, or file content."
/** What every surface says when the report service accepted a report. An automatic report, which the person did
 *  not ask for each time, also says where the person turns automatic reports off. */
export function reportSentStatus(reportId: string, automatic: boolean): string {
  return automatic
    ? `Report sent automatically (${reportId}). To stop automatic reports, turn off ${AUTOMATIC_REPORTS_SETTING} in Settings.`
    : `Report sent (${reportId})`
}
/** `automatic` is the answer in force after the write. A question answered on another surface first keeps
 *  that earlier answer, so a stale question never overwrites it. */
const BugReportConsentResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), automatic: Schema.Boolean }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])
export type BugReportConsentResult = typeof BugReportConsentResultSchema.Type
const BugReportInputFields = {
  kind: BugReportKindSchema,
  error: BugReportErrorSchema,
  surface: BugReportSurfaceSchema,
  sessionId: Schema.NullOr(text(200)),
  note: Schema.optionalKey(text(2000)),
}
const BugReportInputSchema = Schema.Struct(BugReportInputFields)
export type BugReportInput = typeof BugReportInputSchema.Type

/** Sanitizes each client field before bounding it. Protocol inputs can already be truncated prefixes. A stack
 *  that starts with the `name: message` header keeps that header cut to the same length as the message, so an
 *  automatic report can still remove the whole header and never reads a line of a long message as a frame. */
export function sanitizeBugReportInput(input: BugReportInput): BugReportInput {
  const redact = (value: string) => redactSecrets(value, { completeness: "prefix" })
  const sanitize = (value: string, max: number) => redact(value).slice(0, max)
  const fullName = redact(input.error.name)
  const name = fullName.slice(0, 200)
  const fullMessage = redact(input.error.message)
  const message = fullMessage.slice(0, 4000)
  const fullHeader = `${fullName}: ${fullMessage}`
  const stack = redact(input.error.stack)
  const truncated = name.length < fullName.length || message.length < fullMessage.length
  const cutHeader = truncated && (stack.startsWith(fullHeader) || fullHeader.startsWith(stack))
  return {
    kind: input.kind,
    error: { name, message, stack: (cutHeader ? `${name}: ${message}${stack.slice(fullHeader.length)}` : stack).slice(0, 12000) },
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
    refuse: (error): BugReportResult => ({ ok: false, kind: "unavailable", error }),
  }), defineProtocolMutation({
    // The person's answer to the crash screen's question, which the account
    // keeps for every client. It sends nothing; a yes is followed by a submit.
    type: "bugReport.consent",
    fields: { allow: Schema.Boolean },
    result: BugReportConsentResultSchema,
    refuse: (error): BugReportConsentResult => ({ ok: false, error }),
  })],
})
