import { Schema } from "effect"
import { defineFact } from "../../infra/event-registry.js"

const DateTimeStringSchema = Schema.String.check(
  Schema.makeFilter((value) => !Number.isNaN(Date.parse(value)) || "Expected ISO datetime string"),
)

const ForkSelectionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("active_branch") }),
  Schema.Struct({
    kind: Schema.Literal("entry"),
    entryId: Schema.NonEmptyString,
    position: Schema.Union([Schema.Literal("at"), Schema.Literal("before")]),
  }),
])

const SessionForkedFactSchema = defineFact({
  type: "session.forked",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    sourceSessionId: Schema.NonEmptyString,
    targetSessionId: Schema.NonEmptyString,
    selection: ForkSelectionSchema,
    sourceEventPrefixPosition: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    copiedEntryCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    copiedRootEntryId: Schema.optionalKey(Schema.NonEmptyString),
    copiedLeafEntryId: Schema.optionalKey(Schema.NonEmptyString),
    publishedAt: DateTimeStringSchema,
  }),
})

export const SessionForkFactSchemas = [SessionForkedFactSchema] as const

export type ForkSelection = typeof ForkSelectionSchema.Type
export type SessionForkFact = typeof SessionForkedFactSchema.Type

export function buildSessionForkedFact(payload: SessionForkFact["payload"]): SessionForkFact {
  return parseSessionForkFact({
    type: "session.forked",
    version: 1,
    actor: "flywheel",
    payload,
  })
}

export function parseSessionForkFact(value: unknown): SessionForkFact {
  return Schema.decodeUnknownSync(SessionForkedFactSchema, { onExcessProperty: "error" })(value)
}
