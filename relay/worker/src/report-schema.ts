import { Schema } from "effect"

const Diagnostic = Schema.Struct({
  ts: Schema.Number,
  type: Schema.String,
  sessionId: Schema.optionalKey(Schema.String),
  actor: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.Number),
  payload: Schema.optionalKey(Schema.Json),
})

const BugReportSchema = Schema.Struct({
  kind: Schema.Literals(["crash", "manual"]),
  error: Schema.Struct({ name: Schema.String, message: Schema.String, stack: Schema.String }),
  version: Schema.String,
  build: Schema.NullOr(Schema.String),
  os: Schema.String,
  arch: Schema.String,
  surface: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  note: Schema.optionalKey(Schema.String),
  diagnostics: Schema.Struct({ tui: Schema.Array(Diagnostic), executor: Schema.Array(Diagnostic), account: Schema.Array(Diagnostic) }),
})

export type BugReport = typeof BugReportSchema.Type
export const decodeBugReport = Schema.decodeUnknownSync(BugReportSchema, { onExcessProperty: "error" })
