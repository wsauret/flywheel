import { Redacted, Schema } from "effect";
import type { LauncherScope } from "../process-supervisor.js";

const MAX_PROVIDER_TEXT_LENGTH = 256;
const MAX_SUBSCRIPTION_USAGE_RESPONSE_BYTES = 256 * 1024;
const MAX_SUBSCRIPTION_USAGE_METRICS = 128;

export type SubscriptionUsageJson = null | boolean | number | string | readonly SubscriptionUsageJson[] | { readonly [key: string]: SubscriptionUsageJson };

const ProviderText = Schema.String.pipe(
  Schema.refine((value): value is string => value.length <= MAX_PROVIDER_TEXT_LENGTH && isPrintableText(value), { message: "expected bounded printable text" }),
);
const NonEmptyProviderText = ProviderText.pipe(Schema.refine((value): value is string => value.length > 0, { message: "expected non-empty printable text" }));
const NonNegativeFiniteNumber = Schema.Number.pipe(
  Schema.refine((value): value is number => Number.isFinite(value) && value >= 0, { message: "expected a finite non-negative number" }),
);
const BoundedFraction = NonNegativeFiniteNumber.pipe(
  Schema.refine((value): value is number => value <= 1, { message: "expected a fraction between zero and one" }),
);
const Currency = Schema.String.pipe(
  Schema.refine((value): value is string => /^[A-Z]{3}$/.test(value), { message: "expected an ISO 4217 currency code" }),
);
const PrecisionSchema = Schema.Literals(["exact", "rounded", "unknown"]);
const ProviderStatusSchema = Schema.Literals(["ok", "warning", "exhausted", "unknown"]);
const NonNegativeSafeInteger = Schema.Number.pipe(
  Schema.refine((value): value is number => Number.isSafeInteger(value) && value >= 0, { message: "expected a non-negative safe integer" }),
);
const MetricScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("account") }),
  Schema.Struct({ kind: Schema.Literal("feature"), featureKey: NonEmptyProviderText }),
]);
const MetricTimingSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("exact"), startMs: NonNegativeSafeInteger, endMs: NonNegativeSafeInteger }).pipe(Schema.refine(
    (timing): timing is typeof timing => timing.startMs < timing.endMs,
    { message: "exact timing must use non-empty half-open bounds" },
  )),
  Schema.Struct({ kind: Schema.Literal("unavailable"), resetId: Schema.optionalKey(NonEmptyProviderText), resetAtMs: Schema.optionalKey(NonNegativeSafeInteger) }),
]);

const SubscriptionUsageValueSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("percentage"), value: BoundedFraction, provenance: Schema.Literal("provider"), precision: PrecisionSchema }),
  Schema.Struct({ kind: Schema.Literal("count"), value: NonNegativeFiniteNumber, unit: NonEmptyProviderText, provenance: Schema.Literal("provider"), precision: PrecisionSchema }),
  Schema.Struct({ kind: Schema.Literal("money"), value: NonNegativeFiniteNumber, currency: Currency, provenance: Schema.Literal("provider"), precision: PrecisionSchema }),
]);

const SubscriptionUsageResetSchema = {
  resetId: Schema.optionalKey(NonEmptyProviderText),
  resetAtMs: Schema.optionalKey(NonNegativeSafeInteger),
} as const;

const SubscriptionUsageSpendValuesSchema = {
  used: Schema.optionalKey(SubscriptionUsageValueSchema),
  limit: Schema.optionalKey(SubscriptionUsageValueSchema),
  remaining: Schema.optionalKey(SubscriptionUsageValueSchema),
} as const;

export const SubscriptionUsageSpendSourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("prepaid"), availability: Schema.Literal("funded"), ...SubscriptionUsageSpendValuesSchema, ...SubscriptionUsageResetSchema }).pipe(Schema.refine(
    (source): source is typeof source => source.used !== undefined || source.limit !== undefined || source.remaining !== undefined,
    { message: "a funded prepaid source must report a native value" },
  )),
  Schema.Struct({ kind: Schema.Literal("prepaid"), availability: Schema.Literals(["available", "unlimited", "empty", "balance-unavailable", "unknown"]), ...SubscriptionUsageResetSchema }),
  Schema.Struct({ kind: Schema.Literal("automatic-billing"), enablement: Schema.Literals(["enabled", "disabled", "unknown"]), ...SubscriptionUsageSpendValuesSchema, ...SubscriptionUsageResetSchema }),
]);

export const SubscriptionUsageMetricSchema = Schema.Struct({
  metricKey: NonEmptyProviderText,
  label: NonEmptyProviderText,
  scope: MetricScopeSchema,
  rank: NonNegativeSafeInteger,
  timing: MetricTimingSchema,
  allowanceMode: Schema.optionalKey(Schema.Literals(["finite", "pooled", "unclassified"])),
  used: Schema.optionalKey(SubscriptionUsageValueSchema),
  limit: Schema.optionalKey(SubscriptionUsageValueSchema),
  remaining: Schema.optionalKey(SubscriptionUsageValueSchema),
  usedFraction: Schema.optionalKey(BoundedFraction),
  providerStatus: Schema.optionalKey(ProviderStatusSchema),
  /** Provider detail most readers never need. The usage projection sets it
   *  from the provider's own classification; readers never store it. */
  detail: Schema.optionalKey(Schema.Literal(true)),
}).pipe(Schema.refine(
  (metric): metric is typeof metric => metric.used !== undefined || metric.limit !== undefined || metric.remaining !== undefined || metric.usedFraction !== undefined,
  { message: "a usage metric must report a native value or bounded used fraction" },
));

const SubscriptionUsageResetCreditSchema = Schema.Struct({ id: NonEmptyProviderText, resetType: NonEmptyProviderText, status: NonEmptyProviderText, grantedAtMs: Schema.optionalKey(NonNegativeSafeInteger), expiresAtMs: Schema.optionalKey(Schema.NullOr(NonNegativeSafeInteger)), title: Schema.optionalKey(ProviderText), description: Schema.optionalKey(ProviderText) });
export const SubscriptionUsageResetCreditsSchema = Schema.Struct({ availableCount: NonNegativeSafeInteger, credits: Schema.Array(SubscriptionUsageResetCreditSchema) });
export type SubscriptionUsageResetCredit = typeof SubscriptionUsageResetCreditSchema.Type;
export type SubscriptionUsageResetCredits = typeof SubscriptionUsageResetCreditsSchema.Type;

/** The ChatGPT backend's type for a banked reset of the subscription's rate limits, the only reset Flywheel offers. */
export const CHATGPT_RATE_LIMIT_RESET_TYPE = "codex_rate_limits";

/**
 * Lists available ChatGPT rate-limit resets in redemption order, earliest expiry first.
 *
 * Any available credit is offered. Flywheel never predicts from usage readings or
 * provider hints whether a limit can reset: the provider's redeem call is the sole
 * applicability authority and answers `nothing_to_reset` when no window is capped.
 * A predictive gate once hid the reset from a user whose every session was already
 * failing on the cap, which is exactly when the reset exists to be used.
 */
export function availableSubscriptionUsageResetCredits(credits: SubscriptionUsageResetCredits | undefined): readonly SubscriptionUsageResetCredit[] {
  if (credits === undefined || credits.availableCount <= 0) return [];
  return credits.credits
    .filter((credit) => credit.resetType === CHATGPT_RATE_LIMIT_RESET_TYPE && credit.status === "available")
    .toSorted((left, right) => (left.expiresAtMs ?? Number.POSITIVE_INFINITY) - (right.expiresAtMs ?? Number.POSITIVE_INFINITY) || left.id.localeCompare(right.id));
}

/** Selects the next reset for exact action targeting, using the display order. */
export function selectSubscriptionUsageResetCredit(credits: SubscriptionUsageResetCredits | undefined): SubscriptionUsageResetCredit | undefined {
  return availableSubscriptionUsageResetCredits(credits)[0];
}

const SubscriptionUsageReportSchema = Schema.Struct({
  providerId: NonEmptyProviderText, instanceId: NonEmptyProviderText, identity: NonEmptyProviderText, label: Schema.optionalKey(ProviderText), plan: Schema.optionalKey(ProviderText), tier: Schema.optionalKey(ProviderText), providerStatus: ProviderStatusSchema, observedAtMs: NonNegativeFiniteNumber,
  spendSources: Schema.optionalKey(Schema.Array(SubscriptionUsageSpendSourceSchema)), resetCredits: Schema.optionalKey(SubscriptionUsageResetCreditsSchema),
  metrics: Schema.Array(SubscriptionUsageMetricSchema).pipe(Schema.refine((value): value is typeof value => value.length <= MAX_SUBSCRIPTION_USAGE_METRICS, { message: "too many metrics" }), Schema.refine((value): value is typeof value => new Set(value.map((metric) => metric.metricKey)).size === value.length, { message: "duplicate metric keys" })),
});

export type SubscriptionUsageMetric = typeof SubscriptionUsageMetricSchema.Type;
export type SubscriptionUsageReport = typeof SubscriptionUsageReportSchema.Type;
export type SubscriptionUsageSpendSource = typeof SubscriptionUsageSpendSourceSchema.Type;
export type NormalizedSubscriptionUsageReport = Omit<SubscriptionUsageReport, "spendSources"> & { readonly spendSources: readonly SubscriptionUsageSpendSource[] };


export interface SubscriptionUsageRuntimeAccount {
  readonly instanceId: string;
  readonly identity?: string;
  readonly label?: string;
  readonly credential: import("../auth/auth-context.js").RuntimeCredential;
}
export type SubscriptionUsageOutcome =
  | { readonly kind: "success"; readonly report: SubscriptionUsageReport }
  | { readonly kind: "expired-auth" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "identity-unavailable" }
  | { readonly kind: "quota-error"; readonly status?: number }
  | { readonly kind: "fetch-failure" };

export interface SubscriptionUsageReaderContext {
  readonly providerId: string;
  readonly authDir: string;
  readonly account: SubscriptionUsageRuntimeAccount;
  readonly signal: AbortSignal;
  /** The runtime's launch authority, for a reader that asks a program that owns the login, such as an external
   *  login's CLI. Without it the reader starts no process. */
  readonly launcher?: LauncherScope;
  readonly compareAndSetTokens: (expected: import("../auth/openai-auth-types.js").StoredTokens, next: import("../auth/openai-auth-types.js").StoredTokens, signal?: AbortSignal) => Promise<boolean>;
}

export type SubscriptionUsageReader = (context: SubscriptionUsageReaderContext) => Promise<SubscriptionUsageOutcome>;
export type SubscriptionUsageResetOutcome = { readonly kind: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" | "uncertain" };
export type SubscriptionUsageResetConsumer = (input: { readonly accessToken: Redacted.Redacted<string>; readonly accountId?: string; readonly creditId: string; readonly providerKey: string; readonly signal: AbortSignal }) => Promise<SubscriptionUsageResetOutcome>;

function isPrintableText(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  });
}

/** Decodes a provider-owned report after one account has been normalized. Missing spend observations remain an explicit empty collection. */
export function normalizeSubscriptionUsageReport(value: unknown): NormalizedSubscriptionUsageReport {
  const report = Schema.decodeUnknownSync(SubscriptionUsageReportSchema, { onExcessProperty: "error" })(value);
  return { ...report, spendSources: report.spendSources ?? [] };
}


/** Normalizes provider text once before it can persist or reach a user surface. */
export function boundedProviderText(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("").replace(/\s+/g, " ").trim().slice(0, MAX_PROVIDER_TEXT_LENGTH);
}

/** Reads a JSON response without permitting an unbounded provider body allocation. */
export async function readBoundedSubscriptionUsageJson(response: Response): Promise<SubscriptionUsageJson> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_SUBSCRIPTION_USAGE_RESPONSE_BYTES) throw new Error("response exceeds size limit");
  const reader = response.body?.getReader();
  if (reader === undefined) return JSON.parse(await response.text());
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_SUBSCRIPTION_USAGE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response exceeds size limit");
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(body));
}

/** Returns the typed result for an enabled provider without a usage reader. */
export function unsupportedSubscriptionUsageOutcome(): SubscriptionUsageOutcome {
  return { kind: "unsupported" };
}