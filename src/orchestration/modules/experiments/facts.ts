import { Schema } from "effect"
import { defineFact } from "../../../infra/event-registry.js"

const MetricDirectionSchema = Schema.Union([
  Schema.Literal("lower"),
  Schema.Literal("higher"),
])

const ExperimentRunStatusSchema = Schema.Union([
  Schema.Literal("keep"),
  Schema.Literal("discard"),
  Schema.Literal("crash"),
  Schema.Literal("checks_failed"),
])

const ExperimentResumeReasonSchema = Schema.Union([
  Schema.Literal("turn_end"),
  Schema.Literal("compaction"),
])

const StringListSchema = Schema.Array(Schema.String)
const FiniteNumberRecordSchema = Schema.Record(Schema.String, Schema.Finite)
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)

const ExperimentModeChangedFactSchema = defineFact({
  type: "experiment.mode.changed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    active: Schema.Boolean,
    workDir: Schema.NullOr(Schema.String),
  }),
})

const ExperimentInitializedFactSchema = defineFact({
  type: "experiment.initialized",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    segment: Schema.Int,
    name: Schema.String,
    metricName: Schema.String,
    metricUnit: Schema.String,
    direction: MetricDirectionSchema,
    measureCommand: Schema.String,
    checksCommand: Schema.NullOr(Schema.String),
    workDir: Schema.String,
    maxIterations: Schema.NullOr(Schema.Int),
    protectedPaths: StringListSchema,
    sealedPaths: StringListSchema,
  }),
})

const ExperimentRunRecordedFactSchema = defineFact({
  type: "experiment.run.recorded",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    run: Schema.Int,
    segment: Schema.Int,
    commit: Schema.String,
    metric: Schema.Finite,
    metrics: FiniteNumberRecordSchema,
    status: ExperimentRunStatusSchema,
    description: Schema.String,
    asi: Schema.optionalKey(UnknownRecordSchema),
    confidence: Schema.NullOr(Schema.Finite),
    durationMs: Schema.NullOr(Schema.Finite),
  }),
})

const ExperimentResumedFactSchema = defineFact({
  type: "experiment.resumed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    turn: Schema.Int,
    reason: ExperimentResumeReasonSchema,
  }),
})

export const ExperimentFactSchemas = [
  ExperimentModeChangedFactSchema,
  ExperimentInitializedFactSchema,
  ExperimentRunRecordedFactSchema,
  ExperimentResumedFactSchema,
] as const

const ExperimentFactSchema = Schema.Union(ExperimentFactSchemas)

export type ExperimentFact = typeof ExperimentFactSchema.Type
export type ExperimentModeChangedFact = Extract<ExperimentFact, { type: "experiment.mode.changed" }>
export type ExperimentInitializedFact = Extract<ExperimentFact, { type: "experiment.initialized" }>
export type ExperimentRunRecordedFact = Extract<ExperimentFact, { type: "experiment.run.recorded" }>

export function parseExperimentFact(value: unknown): ExperimentFact {
  return Schema.decodeUnknownSync(ExperimentFactSchema, { onExcessProperty: "error" })(value)
}
