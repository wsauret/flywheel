import { Schema } from "effect"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeFinite = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
const GenerationTotalsSchema = Schema.Struct({
  outputTokens: NonNegativeInt,
  durationMs: NonNegativeFinite,
  measuredRequests: NonNegativeInt,
  unmeasuredRequests: NonNegativeInt,
  measuredBlocks: NonNegativeInt,
  excludedBlocks: NonNegativeInt,
  averageTokensPerSecond: Schema.NullOr(NonNegativeFinite),
})

/** Runtime-owned common-token measurements. Null speed means no measured duration; coverage is independent of provider accounting. */
export const GenerationStatisticsSchema = Schema.Struct({
  basis: Schema.Literal("O200kBase"),
  totals: GenerationTotalsSchema,
  models: Schema.Array(GenerationTotalsSchema.pipe(Schema.fieldsAssign({
    model: Schema.NonEmptyString,
    reasoningEffort: Schema.NullOr(Schema.String),
  }))),
  coverageComplete: Schema.Boolean,
})

export type GenerationStatistics = typeof GenerationStatisticsSchema.Type

/** Formats a measured comparison-token reading. An absent measurement has no header text. */
export function formatGenerationSpeed(average: number | null | undefined): string {
  return average == null ? "" : `${average.toFixed(1)} avg tok/s`
}
