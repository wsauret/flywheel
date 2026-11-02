import { Schema } from "effect"
import { defineProtocolDomain, defineProtocolModule, type BackgroundSnapshotOf } from "../protocol-module.js"
import type { RuntimePosition } from "../runtime-ui-protocol-types.js"

/** The session-scoped `experiment_view` contract: what the runtime publishes
 *  about one session's experiment loop to the terminal and web clients. Every
 *  row is derived from the session's durable experiment facts; `running` alone
 *  comes from the session's live execution-state owner and is false for
 *  inactive or historical sessions. Agent-facing ASI payloads, `/experiment`
 *  command handling, and charter guard paths never cross this wire. */

export type FrontendExperimentMetricDirection = "lower" | "higher"
type FrontendExperimentRunStatus = "keep" | "discard" | "crash" | "checks_failed"

export interface FrontendExperimentMetric {
  readonly name: string
  readonly unit: string
}

/** One recorded run. `metrics` holds the secondary metric values the measure
 *  command reported; `confidence` is the advisory noise-floor multiple at the
 *  time the run was logged, null before enough runs exist. */
export interface FrontendExperimentRun {
  readonly run: number
  readonly segment: number
  readonly commit: string
  readonly metric: number
  readonly metrics: { readonly [name: string]: number }
  readonly status: FrontendExperimentRunStatus
  readonly description: string
  readonly confidence: number | null
  readonly durationMs: number | null
}

/** Counts over the current segment's runs, published so both clients render
 *  the same summary without each re-deriving it from the row list. */
interface FrontendExperimentRunCounts {
  readonly total: number
  readonly kept: number
  readonly discarded: number
  readonly crashed: number
  readonly checksFailed: number
}

/** `segment` is the current charter segment; `baseline`, `best`, and
 *  `confidence` are the current segment's derived primary-metric values.
 *  `runs` carries every recorded run across segments in recorded order. The
 *  autonomous loop is bounded by its resume guard and logs one run per logical
 *  turn, so the whole list travels; there is no paging. */
export interface FrontendExperimentView {
  readonly name: string | null
  readonly metric: FrontendExperimentMetric
  readonly secondaryMetrics: readonly FrontendExperimentMetric[]
  readonly direction: FrontendExperimentMetricDirection
  readonly segment: number
  readonly baseline: number | null
  readonly best: number | null
  readonly confidence: number | null
  readonly runCounts: FrontendExperimentRunCounts
  readonly runs: readonly FrontendExperimentRun[]
  readonly active: boolean
  readonly running: boolean
}

export interface RuntimeExperimentViewSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly experimentView: FrontendExperimentView | null
}

export type ExperimentViewPatchPayload =
  | { readonly kind: "experiment_view.updated"; readonly experimentView: FrontendExperimentView }
  | { readonly kind: "experiment_view.removed" }

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const FrontendExperimentMetricSchema: Schema.Codec<FrontendExperimentMetric> = Schema.Struct({ name: Schema.String, unit: Schema.String })
const FrontendExperimentRunSchema: Schema.Codec<FrontendExperimentRun> = Schema.Struct({
  run: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  segment: NonNegativeInt,
  commit: Schema.String,
  metric: Schema.Finite,
  metrics: Schema.Record(Schema.String, Schema.Finite),
  status: Schema.Literals(["keep", "discard", "crash", "checks_failed"]),
  description: Schema.String,
  confidence: Schema.NullOr(Schema.Finite),
  durationMs: Schema.NullOr(Schema.Finite),
})
const FrontendExperimentViewSchema: Schema.Codec<FrontendExperimentView> = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  metric: FrontendExperimentMetricSchema,
  secondaryMetrics: Schema.Array(FrontendExperimentMetricSchema),
  direction: Schema.Literals(["lower", "higher"]),
  segment: NonNegativeInt,
  baseline: Schema.NullOr(Schema.Finite),
  best: Schema.NullOr(Schema.Finite),
  confidence: Schema.NullOr(Schema.Finite),
  runCounts: Schema.Struct({ total: NonNegativeInt, kept: NonNegativeInt, discarded: NonNegativeInt, crashed: NonNegativeInt, checksFailed: NonNegativeInt }),
  runs: Schema.Array(FrontendExperimentRunSchema),
  active: Schema.Boolean,
  running: Schema.Boolean,
})

export const ExperimentViewPatchPayloadSchema: Schema.Codec<ExperimentViewPatchPayload> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("experiment_view.updated"), experimentView: FrontendExperimentViewSchema }),
  Schema.Struct({ kind: Schema.Literal("experiment_view.removed") }),
])
export const RuntimeExperimentViewSnapshotResultSchema: Schema.Codec<RuntimeExperimentViewSnapshotResult> = Schema.Struct({ snapshotPosition: Schema.Number, experimentView: Schema.NullOr(FrontendExperimentViewSchema) })
export const RuntimeBackgroundExperimentViewSnapshotSchema: Schema.Codec<BackgroundSnapshotOf<RuntimeExperimentViewSnapshotResult>> = Schema.Struct({ experimentView: Schema.NullOr(FrontendExperimentViewSchema) })

/** The module's one domain, exported so its client homes read the view by
 *  this declaration and never by a domain literal. */
export const experimentViewDomain = defineProtocolDomain({
  domain: "experiment_view",
  scope: "session",
  // Every run row is durable history; a client that missed a patch
  // resnapshots rather than trusting the newest patch to carry what it overtook.
  delivery: "durable-resnapshot",
  // Each patch carries the whole view.
  content: "whole-value",
  snapshot: {
    query: "experimentViewSnapshot",
    result: RuntimeExperimentViewSnapshotResultSchema,
    deadline: "control",
    background: RuntimeBackgroundExperimentViewSnapshotSchema,
  },
  patch: ExperimentViewPatchPayloadSchema,
  view: {
    snapshot: (result) => result.experimentView,
    patch: (payload) => payload.kind === "experiment_view.updated" ? payload.experimentView : null,
  },
})

export const experimentsProtocol = defineProtocolModule({
  id: "experiments",
  domains: [experimentViewDomain],
})
