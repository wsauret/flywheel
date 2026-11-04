import { Schema } from "effect";
import { SQLiteError } from "bun:sqlite";
import { errorMessage } from "../error-message.js";
import type {
  SubscriptionUsageAccountKey,
  SubscriptionUsageAlert,
  SubscriptionUsageFetchLease,
  SubscriptionUsageHistoryEntry,
  SubscriptionUsageSnapshot,
  SubscriptionUsageThreshold,
} from "./subscription-usage-store.js";
import { SubscriptionUsageMetricSchema, SubscriptionUsageResetCreditsSchema, SubscriptionUsageSpendSourceSchema } from "./subscription-usage.js";

const StoredMetricSchema = SubscriptionUsageMetricSchema;
export const StoredMetricsSchema = Schema.Array(StoredMetricSchema);
export const StoredSpendSourcesSchema = Schema.Array(SubscriptionUsageSpendSourceSchema);
export const StoredResetCreditsSchema = Schema.NullOr(SubscriptionUsageResetCreditsSchema);
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export interface SqlBinding {
  readonly [key: string]: string | number | null;
}

export class SubscriptionUsageCorruptError extends Error {
  readonly _tag = "SubscriptionUsageCorruptError" as const;
  constructor(readonly at: string, readonly reason: string) {
    super(`Malformed subscription usage authority at ${at}: ${reason}`);
  }
}

export class SubscriptionUsageProtocolError extends Error {
  readonly _tag = "SubscriptionUsageProtocolError" as const;
  constructor(readonly expected: number, readonly found: number) {
    super(`Subscription usage authority protocol ${found} does not match ${expected}`);
  }
}

export class SubscriptionUsageTransientError extends Error {
  readonly _tag = "SubscriptionUsageTransientError" as const;
  constructor(readonly at: string, readonly reason: string) {
    super(`Subscription usage authority is temporarily unavailable at ${at}: ${reason}`);
  }
}

export interface RawMetadata {
  readonly protocol_version: number;
  readonly profile_id: string;
  readonly revision: number;
}

export interface RawSnapshot {
  readonly provider_id: string;
  readonly instance_id: string;
  readonly subject_digest: string;
  readonly label: string | null;
  readonly plan: string | null;
  readonly tier: string | null;
  readonly provider_status: string;
  readonly observed_at: number;
  readonly reader_generation: number;
  readonly metrics_json: string;
  readonly spend_sources_json: string;
  readonly reset_credits_json: string;
}


export interface RawHistory extends RawSnapshot {
  readonly hour_start: number;
}

export interface RawThreshold {
  readonly provider_id: string;
  readonly instance_id: string;
  readonly subject_digest: string;
  readonly metric_name: string;
  readonly threshold_value: number;
  readonly cycle_key: string | null;
  readonly last_value: number | null;
  readonly armed: number;
}

export interface RawAlert {
  readonly id: string;
  readonly provider_id: string;
  readonly instance_id: string;
  readonly subject_digest: string;
  readonly metric_name: string;
  readonly account_label: string | null;
  readonly metric_label: string | null;
  readonly distinct_window: number | null;
  readonly reset_at: number | null;
  readonly threshold_value: number;
  readonly value: number;
  readonly observed_at: number;
  readonly cycle_key: string;
  readonly state: string;
  readonly fence: number;
  readonly claim_owner: string | null;
  readonly claim_expires_at: number;
  readonly project_root: string | null;
}

export interface RawLease {
  readonly provider_id: string;
  readonly instance_id: string;
  readonly subject_digest: string;
  readonly owner: string;
  readonly reader_generation: number;
  readonly fence: number;
  readonly lease_expires_at: number;
}

export const CREATE_AUTHORITY = `
  create table if not exists subscription_usage_authority (
    id integer primary key check (id = 0),
    protocol_version integer not null check (protocol_version > 0),
    profile_id text not null check (length(profile_id) > 0),
    revision integer not null check (revision >= 0)
  )
`;

export const CREATE_SNAPSHOTS = `
  create table if not exists subscription_usage_snapshots (
    provider_id text not null check (length(provider_id) > 0),
    instance_id text not null check (length(instance_id) > 0),
    subject_digest text not null check (length(subject_digest) > 0),
    label text,
    plan text,
    tier text,
    provider_status text not null,
    observed_at integer not null check (observed_at >= 0),
    reader_generation integer not null check (reader_generation >= 0),
    metrics_json text not null check (length(metrics_json) > 0),
    spend_sources_json text not null default '[]' check (length(spend_sources_json) > 0),
    reset_credits_json text not null default 'null' check (length(reset_credits_json) > 0),
    primary key (provider_id, instance_id, subject_digest)
  )
`;

export const CREATE_CURRENT = `
  create table if not exists subscription_usage_current (
    provider_id text not null,
    instance_id text not null,
    subject_digest text not null,
    label text,
    metric_name text not null,
    unit text not null,
    used real,
    "limit" real,
    remaining real,
    resets_on text,
    observed_at integer not null check (observed_at >= 0),
    reader_generation integer not null check (reader_generation >= 0),
    primary key (provider_id, instance_id, subject_digest, metric_name)
  )
`;

export const CREATE_HISTORY = `
  create table if not exists subscription_usage_history (
    provider_id text not null,
    instance_id text not null,
    subject_digest text not null,
    hour_start integer not null check (hour_start >= 0),
    label text,
    plan text,
    tier text,
    provider_status text not null,
    metrics_json text not null check (length(metrics_json) > 0),
    spend_sources_json text not null default '[]' check (length(spend_sources_json) > 0),
    observed_at integer not null check (observed_at >= 0),
    reader_generation integer not null check (reader_generation >= 0),
    primary key (provider_id, instance_id, subject_digest, hour_start)
  )
`;

export const CREATE_THRESHOLDS = `
  create table if not exists subscription_usage_thresholds (
    provider_id text not null,
    instance_id text not null,
    subject_digest text not null,
    metric_name text not null,
    threshold_value real not null check (threshold_value >= 0),
    cycle_key text,
    last_value real,
    armed integer not null default 1 check (armed in (0, 1)),
    primary key (provider_id, instance_id, subject_digest, metric_name, threshold_value)
  )
`;

export const CREATE_ALERTS = `
  create table if not exists subscription_usage_alerts (
    id text primary key,
    provider_id text not null,
    instance_id text not null,
    subject_digest text not null,
    metric_name text not null,
    account_label text,
    metric_label text,
    distinct_window integer check (distinct_window in (0, 1)),
    reset_at integer check (reset_at >= 0),
    threshold_value real not null check (threshold_value >= 0),
    value real not null,
    observed_at integer not null check (observed_at >= 0),
    cycle_key text not null,
    state text not null check (state in ('open', 'claimed', 'delivered')),
    fence integer not null check (fence >= 0),
    claim_owner text,
    claim_expires_at integer not null check (claim_expires_at >= 0),
    project_root text,
    unique (provider_id, instance_id, subject_digest, metric_name, threshold_value, cycle_key)
  )
`;

export const CREATE_ALERTS_PENDING_INDEX = `
  create index if not exists subscription_usage_alerts_pending_idx
  on subscription_usage_alerts (provider_id, instance_id, subject_digest, state, observed_at, id)
`;

export const CREATE_LEASES = `
  create table if not exists subscription_usage_fetch_leases (
    provider_id text not null,
    instance_id text not null,
    subject_digest text not null,
    owner text not null check (length(owner) > 0),
    reader_generation integer not null check (reader_generation >= 1),
    fence integer not null check (fence >= 1),
    lease_expires_at integer not null check (lease_expires_at >= 0),
    primary key (provider_id, instance_id, subject_digest)
  )
`;

export const REQUIRED_SCHEMA_TABLES = [
  "subscription_usage_authority",
  "subscription_usage_snapshots",
  "subscription_usage_current",
  "subscription_usage_history",
  "subscription_usage_thresholds",
  "subscription_usage_alerts",
  "subscription_usage_fetch_leases",
] as const;

export function isCorruption(error: unknown): boolean {
  if (!(error instanceof SQLiteError) || error.code === undefined) return false;
  return error.code.startsWith("SQLITE_CORRUPT") || error.code === "SQLITE_NOTADB";
}

export function requireText(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) throw new SubscriptionUsageCorruptError(at, "expected non-empty text");
  return value;
}

export function requireNumber(value: unknown, at: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new SubscriptionUsageCorruptError(at, "expected a finite non-negative number");
  }
  return value;
}

function optionalText(value: unknown, at: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new SubscriptionUsageCorruptError(at, "expected text or null");
  return value;
}

export {
  createSubscriptionAccountIdentity as accountKeyFromIdentity,
  subscriptionSubjectDigest as quotaSubjectDigest,
  subscriptionAccountIdentityFromRef as accountKeyFromRef,
  subscriptionAccountIdentityKey as keyString,
} from "./subscription-account-identity.js";

export function bindings(key: SubscriptionUsageAccountKey) {
  return { $provider: key.providerId, $instance: key.instanceId, $subject: key.subjectDigest } satisfies SqlBinding;
}

export function metricUsedFraction(metric: typeof SubscriptionUsageMetricSchema.Type): number | undefined {
  if (metric.usedFraction !== undefined) return metric.usedFraction;
  if (metric.used?.kind === "percentage") return metric.used.value;
  if (metric.used?.kind === "count" && metric.limit?.kind === "count" && metric.limit.value > 0) return Math.min(1, Math.max(0, metric.used.value / metric.limit.value));
  if (metric.remaining?.kind === "count" && metric.limit?.kind === "count" && metric.limit.value > 0) return Math.min(1, Math.max(0, 1 - metric.remaining.value / metric.limit.value));
  return undefined;
}


function decodeMetrics(value: string, at: string): readonly typeof SubscriptionUsageMetricSchema.Type[] {
  try {
    const metrics = Schema.decodeUnknownSync(StoredMetricsSchema, { onExcessProperty: "error" })(JSON.parse(value));
    return metrics.map((metric) => metric.metricKey === "ai_credits" && metric.allowanceMode === undefined ? { ...metric, allowanceMode: "unclassified" as const } : metric);
  } catch (error) {
    throw new SubscriptionUsageCorruptError(at, errorMessage(error));
  }
}

function decodeSpendSources(value: string, at: string) {
  try {
    return Schema.decodeUnknownSync(StoredSpendSourcesSchema, { onExcessProperty: "error" })(JSON.parse(value));
  } catch (error) {
    throw new SubscriptionUsageCorruptError(at, errorMessage(error));
  }
}

function decodeResetCredits(value: string, at: string) {
  try {
    return Schema.decodeUnknownSync(StoredResetCreditsSchema, { onExcessProperty: "error" })(JSON.parse(value)) ?? undefined;
  } catch (error) {
    throw new SubscriptionUsageCorruptError(at, errorMessage(error));
  }
}

export function decodeMetadata(value: unknown): RawMetadata {
  try {
    return Schema.decodeUnknownSync(Schema.Struct({ protocol_version: PositiveInteger, profile_id: Schema.NonEmptyString, revision: NonNegativeInteger }), { onExcessProperty: "error" })(value);
  } catch (error) {
    throw new SubscriptionUsageCorruptError("authority metadata", errorMessage(error));
  }
}

export function decodeSnapshot(raw: RawSnapshot): SubscriptionUsageSnapshot {
  const providerId = requireText(raw.provider_id, "snapshot.provider_id");
  const instanceId = requireText(raw.instance_id, "snapshot.instance_id");
  const subjectDigest = requireText(raw.subject_digest, "snapshot.subject_digest");
  const label = optionalText(raw.label, "snapshot.label");
  const plan = optionalText(raw.plan, "snapshot.plan");
  const tier = optionalText(raw.tier, "snapshot.tier");
  if (raw.provider_status !== "ok" && raw.provider_status !== "warning" && raw.provider_status !== "exhausted" && raw.provider_status !== "unknown") throw new SubscriptionUsageCorruptError("snapshot.provider_status", "invalid provider status");
  const resetCredits = decodeResetCredits(raw.reset_credits_json, `${providerId}/${instanceId}/${subjectDigest}/reset-credits`);
  return {
    providerId,
    instanceId,
    subjectDigest,
    ...(label === undefined ? {} : { label }),
    ...(plan === undefined ? {} : { plan }),
    ...(tier === undefined ? {} : { tier }),
    providerStatus: raw.provider_status,
    observedAtMs: requireNumber(raw.observed_at, "snapshot.observed_at"),
    readerGeneration: requireNumber(raw.reader_generation, "snapshot.reader_generation", true),
    metrics: decodeMetrics(raw.metrics_json, `${providerId}/${instanceId}/${subjectDigest}`),
    spendSources: decodeSpendSources(raw.spend_sources_json, `${providerId}/${instanceId}/${subjectDigest}/spend-sources`),
    ...(resetCredits === undefined ? {} : { resetCredits }),
  };
}


export function decodeHistory(raw: RawHistory): SubscriptionUsageHistoryEntry {
  return { ...decodeSnapshot(raw), hourStartMs: requireNumber(raw.hour_start, "history.hour_start", true) };
}

export function decodeThreshold(raw: RawThreshold): SubscriptionUsageThreshold {
  if (raw.armed !== 0 && raw.armed !== 1) throw new SubscriptionUsageCorruptError("threshold.armed", "expected zero or one");
  return {
    providerId: requireText(raw.provider_id, "threshold.providerId"),
    instanceId: requireText(raw.instance_id, "threshold.instanceId"),
    subjectDigest: requireText(raw.subject_digest, "threshold.subjectDigest"),
    metricName: requireText(raw.metric_name, "threshold.metricName"),
    value: requireNumber(raw.threshold_value, "threshold.value"),
    ...(raw.cycle_key === null ? {} : { cycleKey: requireText(raw.cycle_key, "threshold.cycleKey") }),
    ...(raw.last_value === null ? {} : { lastValue: requireNumber(raw.last_value, "threshold.lastValue") }),
    armed: raw.armed === 1,
  };
}

export function decodeAlert(raw: RawAlert): SubscriptionUsageAlert {
  if (raw.state !== "open" && raw.state !== "claimed" && raw.state !== "delivered") throw new SubscriptionUsageCorruptError(`alert/${raw.id}`, "invalid state");
  if (raw.distinct_window !== null && raw.distinct_window !== 0 && raw.distinct_window !== 1) throw new SubscriptionUsageCorruptError(`alert/${raw.id}`, "invalid window discriminator");
  return {
    id: requireText(raw.id, "alert.id"),
    providerId: requireText(raw.provider_id, "alert.provider_id"),
    instanceId: requireText(raw.instance_id, "alert.instance_id"),
    subjectDigest: requireText(raw.subject_digest, "alert.subject_digest"),
    metricName: requireText(raw.metric_name, "alert.metric_name"),
    ...(raw.account_label === null ? {} : { accountLabel: requireText(raw.account_label, "alert.account_label") }),
    ...(raw.metric_label === null ? {} : { metricLabel: requireText(raw.metric_label, "alert.metric_label") }),
    ...(raw.distinct_window === null ? {} : { distinctWindow: raw.distinct_window === 1 }),
    ...(raw.reset_at === null ? {} : { resetAtMs: requireNumber(raw.reset_at, "alert.reset_at", true) }),
    threshold: requireNumber(raw.threshold_value, "alert.threshold"),
    value: requireNumber(raw.value, "alert.value"),
    observedAtMs: requireNumber(raw.observed_at, "alert.observed_at"),
    cycleKey: requireText(raw.cycle_key, "alert.cycle_key"),
    state: raw.state,
    fence: requireNumber(raw.fence, "alert.fence", true),
    ...(raw.claim_owner === null ? {} : { claimOwner: requireText(raw.claim_owner, "alert.claim_owner") }),
    ...(raw.project_root === null ? {} : { projectRoot: requireText(raw.project_root, "alert.project_root") }),
    claimExpiresAtMs: requireNumber(raw.claim_expires_at, "alert.claim_expires_at", true),
  };
}

export function decodeLease(raw: RawLease): SubscriptionUsageFetchLease {
  return {
    providerId: requireText(raw.provider_id, "lease.provider_id"),
    instanceId: requireText(raw.instance_id, "lease.instance_id"),
    subjectDigest: requireText(raw.subject_digest, "lease.subject_digest"),
    owner: requireText(raw.owner, "lease.owner"),
    readerGeneration: requireNumber(raw.reader_generation, "lease.reader_generation", true),
    fence: requireNumber(raw.fence, "lease.fence", true),
    leaseExpiresAtMs: requireNumber(raw.lease_expires_at, "lease.lease_expires_at", true),
  };
}

export function sleepFor(ms: number): Promise<void> {
  return Bun.sleep(Math.max(0, ms));
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Subscription usage fetch aborted", "AbortError");
}
