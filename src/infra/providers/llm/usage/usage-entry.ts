import { Schema } from "effect";

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegativeFinite = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));

/** The serving attribution that every settled attempt records, measured or not. */
const UsageAttemptFields = {
  attemptId: Uuid,
  occurredAt: Schema.String,
  profileId: Schema.NonEmptyString,
  attribution: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("candidate"), providerId: Schema.NonEmptyString, instanceId: Schema.optional(Schema.NonEmptyString) }),
    Schema.Struct({ kind: Schema.Literal("unattributed") }),
  ]),
  spendMode: Schema.Literals(["included", "prepaid", "automatic", "direct_api", "aggregator"]),
  credentialLineage: Uuid,
  model: Schema.NonEmptyString,
  classification: Schema.Literals(["subscription_equivalent", "real_spend"]),
} as const;

const UsagePriceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("priced"), estimatedUsd: NonNegativeFinite, rateCard: Schema.Record(Schema.String, NonNegativeFinite), provenance: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.NonEmptyString }),
]);

/** A measured attempt. `complete` holds the provider's final report; `partial` holds lower bounds from an attempt
 *  that ended before it. A null `cacheRead` means the provider did not report cache reads. `cacheWrite1h` is the part
 *  of `cacheWrite` that the provider reports it kept for one hour; the rest of `cacheWrite` was kept for five minutes
 *  (ARCH-PROVIDERS-079). An entry from before 2026-11-10, or of a provider that reports no split, has none. */
export const MeasuredUsageEntrySchema = Schema.Struct({
  ...UsageAttemptFields,
  coverage: Schema.Literals(["complete", "partial"]),
  currency: Schema.Literal("USD"),
  tokens: Schema.Struct({
    input: NonNegativeInteger, output: NonNegativeInteger, cacheRead: Schema.NullOr(NonNegativeInteger), cacheWrite: NonNegativeInteger,
    cacheWrite1h: Schema.optionalKey(NonNegativeInteger), reasoning: NonNegativeInteger,
  }),
  price: UsagePriceSchema,
});

/** A served attempt whose provider reported no usage. It carries no tokens and no price. */
export const UnmeasuredUsageEntrySchema = Schema.Struct({
  ...UsageAttemptFields,
  coverage: Schema.Literal("unmeasured"),
});

export const UsageEntrySchema = Schema.Union([MeasuredUsageEntrySchema, UnmeasuredUsageEntrySchema]);

export type UsageEntry = typeof UsageEntrySchema.Type;
export type MeasuredUsageEntry = typeof MeasuredUsageEntrySchema.Type;

// Remove after 2027-04-30. Entries written before coverage existed: every one held the provider's final report,
// with numeric cache reads. Ledger protocol 6 rows, `model.usage.measured` v5 facts, and settlement checkpoints
// carry this shape.
const UncoveredUsageEntryFields = {
  ...UsageAttemptFields,
  tokens: Schema.Struct({ input: NonNegativeInteger, output: NonNegativeInteger, cacheRead: NonNegativeInteger, cacheWrite: NonNegativeInteger, reasoning: NonNegativeInteger }),
  price: UsagePriceSchema,
} as const;
export const UncoveredUsageEntrySchema = Schema.Struct({ ...UncoveredUsageEntryFields, currency: Schema.Literal("USD") });
/** The ledger v3 shape, which also lacked the currency. */
const UsageEntryV3Schema = Schema.Struct(UncoveredUsageEntryFields);

/** Strictly validates a Flywheel-owned ledger entry and canonicalizes its UTC instant. */
export function decodeUsageEntry(value: unknown): UsageEntry {
  const entry = Schema.decodeUnknownSync(UsageEntrySchema, { onExcessProperty: "error" })(value);
  const timestamp = new Date(entry.occurredAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== entry.occurredAt) throw new Error("Usage entry occurredAt must be a canonical UTC timestamp");
  if (entry.classification === "subscription_equivalent" && entry.spendMode !== "included") throw new Error("Only included usage can be subscription equivalent");
  if (entry.classification === "subscription_equivalent" && (entry.attribution.kind !== "candidate" || entry.attribution.instanceId === undefined)) throw new Error("Subscription-equivalent usage requires an exact provider instance");
  if (entry.classification === "real_spend" && entry.spendMode === "included") throw new Error("Included usage must be subscription equivalent");
  return entry;
}

/** Converts one strictly valid entry written before coverage existed to a complete entry. Remove after 2027-04-30. */
export function migrateUncoveredUsageEntry(value: unknown): UsageEntry {
  const entry = Schema.decodeUnknownSync(UncoveredUsageEntrySchema, { onExcessProperty: "error" })(value);
  return decodeUsageEntry({ ...entry, coverage: "complete" });
}

/** Migrates one strictly valid intermediate v3 ledger entry to the current canonical shape. */
export function migrateUsageEntryV3(value: unknown): UsageEntry {
  const entry = Schema.decodeUnknownSync(UsageEntryV3Schema, { onExcessProperty: "error" })(value);
  return migrateUncoveredUsageEntry({ ...entry, currency: "USD" });
}
