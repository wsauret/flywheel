import { Schema } from "effect";

const BenchmarkObservationSchema = <Value extends Schema.Top>(value: Value) => Schema.Union([
  Schema.Struct({ kind: Schema.Literal("observed"), value }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.NonEmptyString }),
]);

export const BenchmarkAccountingSchema = Schema.Struct({
  estimatedUsd: BenchmarkObservationSchema(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  billedUsd: BenchmarkObservationSchema(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  tokens: BenchmarkObservationSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  providers: BenchmarkObservationSchema(Schema.Array(Schema.NonEmptyString)),
  pricedEntryCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unpricedEntryCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const BenchmarkCampaignIdentitySchema = Schema.Struct({
  profileId: Schema.NonEmptyString,
  authorityIncarnation: Schema.NonEmptyString,
  contentIdentity: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});

export type BenchmarkAccounting = typeof BenchmarkAccountingSchema.Type;

/** Truthful accounting for a boundary failure that committed no observable UsageEntry. */
export function unavailableBenchmarkAccounting(reason: string): BenchmarkAccounting {
  const unavailable = { kind: "unavailable", reason } as const;
  return {
    estimatedUsd: unavailable,
    billedUsd: unavailable,
    tokens: unavailable,
    providers: unavailable,
    pricedEntryCount: 0,
    unpricedEntryCount: 0,
  };
}
