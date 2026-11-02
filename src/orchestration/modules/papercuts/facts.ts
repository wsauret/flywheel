import { Schema } from "effect"
import { defineFact } from "../../../infra/event-registry.js"

const PapercutCategorySchema = Schema.Union([
  Schema.Literal("defect"),
  Schema.Literal("flaky"),
  Schema.Literal("docs-drift"),
  Schema.Literal("missing-tooling"),
])

const PapercutDispositionSchema = Schema.Union([
  Schema.Literal("fixed"),
  Schema.Literal("dismissed"),
  Schema.Literal("promoted"),
])

const PapercutRecordedFactSchema = defineFact({
  type: "papercut.recorded",
  version: 1,
  actor: Schema.Literal("agent"),
  payload: Schema.Struct({
    observation: Schema.NonEmptyString,
    category: Schema.optionalKey(PapercutCategorySchema),
    conversationId: Schema.NonEmptyString,
    modelRequestId: Schema.NonEmptyString,
    toolUseId: Schema.NonEmptyString,
    parentToolUseId: Schema.optionalKey(Schema.NonEmptyString),
  }),
})

const PapercutDisposedFactSchema = defineFact({
  type: "papercut.disposed",
  version: 1,
  actor: Schema.Literal("agent"),
  payload: Schema.Struct({
    recordedFactId: Schema.NonEmptyString,
    disposition: PapercutDispositionSchema,
    disposingSessionId: Schema.NonEmptyString,
  }),
})

export const PapercutRecordedFactSchemas = [PapercutRecordedFactSchema] as const
const PapercutFactSchemas = [PapercutRecordedFactSchema, PapercutDisposedFactSchema] as const
const PapercutFactSchema = Schema.Union(PapercutFactSchemas)

export type PapercutFact = typeof PapercutFactSchema.Type
export type PapercutRecordedFact = Extract<PapercutFact, { type: "papercut.recorded" }>
export type PapercutCategory = NonNullable<PapercutRecordedFact["payload"]["category"]>
export type PapercutDisposition = Extract<PapercutFact, { type: "papercut.disposed" }>["payload"]["disposition"]

export function parsePapercutFact(value: unknown): PapercutFact {
  return Schema.decodeUnknownSync(PapercutFactSchema, { onExcessProperty: "error" })(value)
}
