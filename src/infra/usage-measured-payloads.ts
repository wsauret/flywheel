import { Schema } from "effect";
import { MeasuredUsageEntrySchema, UncoveredUsageEntrySchema, UnmeasuredUsageEntrySchema } from "./llm/usage-entry.js";

// Payloads of every recorded version of the `model.usage.measured` fact, which `runtime-fact-types.ts` registers.

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const ModelUsagePayloadV1 = Schema.Struct({
  totalCostUsd: NonNegativeNumber,
  billedCostUsd: Schema.optionalKey(NonNegativeNumber),
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheCreateTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  parentToolUseId: Schema.optionalKey(Schema.String),
}).check(Schema.makeFilter((payload) =>
  payload.billedCostUsd === undefined
  || payload.billedCostUsd <= payload.totalCostUsd + 1e-9
  || "billedCostUsd must not exceed totalCostUsd"));

export const ModelUsagePayloadV2 = Schema.Struct({
  totalCostUsd: NonNegativeNumber,
  billedCostUsd: NonNegativeNumber,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheCreateTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  parentToolUseId: Schema.optionalKey(Schema.String),
}).check(Schema.makeFilter((payload) =>
  payload.billedCostUsd <= payload.totalCostUsd + 1e-9
  || "billedCostUsd must not exceed totalCostUsd"));

export const ModelUsagePayloadV3 = Schema.Struct({
  totalCostUsd: NonNegativeNumber,
  billedCostUsd: NonNegativeNumber,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheCreateTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  parentToolUseId: Schema.optionalKey(Schema.String),
  budgetStreamId: Schema.optionalKey(Schema.NonEmptyString),
}).check(Schema.makeFilter((payload) =>
  payload.billedCostUsd <= payload.totalCostUsd + 1e-9
  || "billedCostUsd must not exceed totalCostUsd"));

export const ModelUsagePayloadV4 = Schema.Struct({
  usageEntryId: Schema.NonEmptyString,
  costUsdDelta: Schema.NullOr(NonNegativeNumber),
  billedCostUsdDelta: Schema.NullOr(NonNegativeNumber),
  inputTokensDelta: NonNegativeInt,
  outputTokensDelta: NonNegativeInt,
  cacheReadTokensDelta: NonNegativeInt,
  cacheCreateTokensDelta: NonNegativeInt,
  reasoningTokensDelta: NonNegativeInt,
  parentToolUseId: Schema.optionalKey(Schema.String),
  budgetStreamId: Schema.NonEmptyString,
}).check(Schema.makeFilter((payload) => {
  if (payload.costUsdDelta === null || payload.billedCostUsdDelta === null) {
    return payload.costUsdDelta === null && payload.billedCostUsdDelta === null
      || "costUsdDelta and billedCostUsdDelta must both be null or both be numbers"
  }
  return payload.billedCostUsdDelta <= payload.costUsdDelta
    || "billedCostUsdDelta must not exceed costUsdDelta"
}));

const UsageMeasuredStreamFields = {
  parentToolUseId: Schema.optionalKey(Schema.String),
  budgetStreamId: Schema.NonEmptyString,
} as const;

/** Remove after 2027-04-30. An entry written before coverage existed; `currentUsageMeasurement` reads it as complete. */
export const ModelUsagePayloadV5 = Schema.Struct({ ...UncoveredUsageEntrySchema.fields, ...UsageMeasuredStreamFields });

export const ModelUsagePayloadV6 = Schema.Union([
  Schema.Struct({ ...MeasuredUsageEntrySchema.fields, ...UsageMeasuredStreamFields }),
  Schema.Struct({ ...UnmeasuredUsageEntrySchema.fields, ...UsageMeasuredStreamFields }),
]);
