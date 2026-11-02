import type { Database } from "bun:sqlite";
import { Schema } from "effect";
import { errorMessage } from "../error-message.js";
import {
  CREATE_ALERTS,
  CREATE_ALERTS_PENDING_INDEX,
  CREATE_AUTHORITY,
  CREATE_CURRENT,
  CREATE_HISTORY,
  CREATE_LEASES,
  CREATE_SNAPSHOTS,
  CREATE_THRESHOLDS,
  StoredMetricsSchema,
  SubscriptionUsageCorruptError,
} from "./subscription-usage-store-codec.js";
import { CREATE_USAGE_RESET_IN_FLIGHT, USAGE_AUTHORITY_PROTOCOL_VERSION } from "./usage-authority-codec.js";

const LegacyValue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("percentage"), value: Schema.Number, provenance: Schema.Literal("provider"), precision: Schema.Literals(["exact", "rounded", "unknown"]) }),
  Schema.Struct({ kind: Schema.Literal("count"), value: Schema.Number, unit: Schema.String, provenance: Schema.Literal("provider"), precision: Schema.Literals(["exact", "rounded", "unknown"]) }),
  Schema.Struct({ kind: Schema.Literal("money"), value: Schema.Number, currency: Schema.String, provenance: Schema.Literal("provider"), precision: Schema.Literals(["exact", "rounded", "unknown"]) }),
]);
const legacyFields = {
  name: Schema.NonEmptyString,
  used: Schema.optionalKey(LegacyValue),
  limit: Schema.optionalKey(LegacyValue),
  remaining: Schema.optionalKey(LegacyValue),
  usedFraction: Schema.optionalKey(Schema.Number),
  providerStatus: Schema.optionalKey(Schema.Literals(["ok", "warning", "exhausted", "unknown"])),
  resetId: Schema.optionalKey(Schema.NonEmptyString),
  resetAtMs: Schema.optionalKey(Schema.Number),
} as const;
const LegacyMetricV2 = Schema.Struct(legacyFields);
const LegacyMetricV3 = Schema.Struct({ ...legacyFields, allowanceMode: Schema.optionalKey(Schema.Literals(["finite", "pooled", "unclassified"])) });
const LegacyMetricV4 = LegacyMetricV3;
const LegacyMetrics = {
  2: Schema.Array(LegacyMetricV2),
  3: Schema.Array(LegacyMetricV3),
  4: Schema.Array(LegacyMetricV4),
} as const;

type LegacyMetric = typeof LegacyMetricV4.Type;
type MetricIdentity = {
  readonly metricKey: string;
  readonly label: string;
  readonly scope: { readonly kind: "account" } | { readonly kind: "feature"; readonly featureKey: string };
};

const ACCOUNT_SCOPE = { kind: "account" } as const;
const PROVIDER_KEYS = new Map<string, { readonly metricKey: string; readonly label: string }>([
  ["chatgpt:primary_window", { metricKey: "primary_window", label: "Primary window" }],
  ["chatgpt:secondary_window", { metricKey: "secondary_window", label: "Secondary window" }],
  ["opencode_go:rolling", { metricKey: "rolling", label: "Rolling" }],
  ["opencode_go:weekly", { metricKey: "weekly", label: "Weekly" }],
  ["opencode_go:monthly", { metricKey: "monthly", label: "Monthly" }],
  ["github_copilot:premium_interactions", { metricKey: "premium_interactions", label: "Premium interactions" }],
  ["github_copilot:ai_credits", { metricKey: "ai_credits", label: "AI Credits" }],
  ["supergrok:credits", { metricKey: "credits", label: "Credits" }],
  ["supergrok:monthly", { metricKey: "monthly", label: "Monthly" }],
]);

function identity(providerId: string, name: string): MetricIdentity {
  const normalized = name.trim().toLowerCase().replace(/[ -]+/g, "_");
  const known = PROVIDER_KEYS.get(`${providerId}:${normalized}`);
  if (known !== undefined) return { ...known, scope: ACCOUNT_SCOPE };
  if (providerId === "chatgpt") {
    const match = /^(.+):(primary_window|secondary_window)$/.exec(name);
    const featureKey = match?.[1];
    if (featureKey !== undefined) return { metricKey: name, label: name, scope: { kind: "feature", featureKey } };
  }
  if (providerId === "supergrok" && name.startsWith("product:") && name.length > "product:".length) {
    const featureKey = name.slice("product:".length);
    return { metricKey: name, label: featureKey, scope: { kind: "feature", featureKey } };
  }
  return { metricKey: `legacy:${encodeURIComponent(name)}`, label: name, scope: ACCOUNT_SCOPE };
}

function migrateMetrics(providerId: string, json: string, version: 2 | 3 | 4, at: string): string {
  try {
    const legacy = Schema.decodeUnknownSync(LegacyMetrics[version], { onExcessProperty: "error" })(JSON.parse(json));
    const keys = new Set<string>();
    const migrated = legacy.map((metric: LegacyMetric, rank: number) => {
      const mapped = identity(providerId, metric.name);
      if (keys.has(mapped.metricKey)) throw new Error(`duplicate migrated metric key ${mapped.metricKey}`);
      keys.add(mapped.metricKey);
      const { name: _name, resetId, resetAtMs, allowanceMode, ...values } = metric;
      return {
        metricKey: mapped.metricKey,
        label: mapped.label,
        scope: mapped.scope,
        rank,
        timing: { kind: "unavailable" as const, ...(resetId === undefined ? {} : { resetId }), ...(resetAtMs === undefined ? {} : { resetAtMs }) },
        ...(allowanceMode === undefined && mapped.metricKey === "ai_credits" ? { allowanceMode: "unclassified" as const } : allowanceMode === undefined ? {} : { allowanceMode }),
        ...values,
      };
    });
    Schema.decodeUnknownSync(StoredMetricsSchema, { onExcessProperty: "error" })(migrated);
    return JSON.stringify(migrated);
  } catch (error) {
    throw new SubscriptionUsageCorruptError(at, errorMessage(error));
  }
}

function addColumn(opened: Database, table: string, column: string, ddl: string): void {
  const columns = opened.query<{ name: string }, []>(`pragma table_info(${table})`).all();
  if (!columns.some(({ name }) => name === column)) opened.exec(`alter table ${table} add column ${ddl}`);
}

function migrateMetricJsonTable(opened: Database, table: string, version: 2 | 3 | 4): void {
  let cursor = 0;
  const read = opened.query<{ rowid: number; provider_id: string; metrics_json: string }, [number]>(`select rowid, provider_id, metrics_json from ${table} where rowid > ? order by rowid limit 128`);
  const update = opened.query<void, [string, number]>(`update ${table} set metrics_json = ? where rowid = ?`);
  for (;;) {
    const rows = read.all(cursor);
    if (rows.length === 0) return;
    for (const row of rows) {
      update.run(migrateMetrics(row.provider_id, row.metrics_json, version, `${table}/${row.rowid}`), row.rowid);
      cursor = row.rowid;
    }
  }
}

function migrateMetricNames(opened: Database, table: string): void {
  let cursor = 0;
  const read = opened.query<{ rowid: number; provider_id: string; metric_name: string }, [number]>(`select rowid, provider_id, metric_name from ${table} where rowid > ? order by rowid limit 128`);
  const update = opened.query<void, [string, number]>(`update ${table} set metric_name = ? where rowid = ?`);
  for (;;) {
    const rows = read.all(cursor);
    if (rows.length === 0) return;
    for (const row of rows) {
      update.run(identity(row.provider_id, row.metric_name).metricKey, row.rowid);
      cursor = row.rowid;
    }
  }
}

/** Migrates every supported subscription usage schema inside the caller's immediate transaction. */
export function migrateSubscriptionUsageAuthority(opened: Database, profileId: string): void {
  opened.exec(CREATE_AUTHORITY);
  opened.exec(CREATE_SNAPSHOTS);
  opened.exec(CREATE_CURRENT);
  opened.exec(CREATE_HISTORY);
  opened.exec(CREATE_THRESHOLDS);
  opened.exec(CREATE_ALERTS);
  opened.exec(CREATE_LEASES);
  opened.exec(CREATE_USAGE_RESET_IN_FLIGHT);
  opened.query("insert or ignore into subscription_usage_authority (id, protocol_version, profile_id, revision) values (0, $version, $profile, 0)").run({ $version: USAGE_AUTHORITY_PROTOCOL_VERSION, $profile: profileId });
  const metadata = opened.query<{ protocol_version: number; profile_id: string }, []>("select protocol_version, profile_id from subscription_usage_authority where id = 0").get();
  if (metadata === null || metadata.profile_id !== profileId || ![2, 3, 4, 5, 6, USAGE_AUTHORITY_PROTOCOL_VERSION].includes(metadata.protocol_version)) throw new Error("Usage authority metadata does not match the active profile");
  addColumn(opened, "subscription_usage_snapshots", "label", "label text");
  addColumn(opened, "subscription_usage_snapshots", "plan", "plan text");
  addColumn(opened, "subscription_usage_snapshots", "tier", "tier text");
  addColumn(opened, "subscription_usage_snapshots", "provider_status", "provider_status text not null default 'unknown'");
  addColumn(opened, "subscription_usage_snapshots", "observed_at", "observed_at integer not null default 0");
  addColumn(opened, "subscription_usage_snapshots", "reader_generation", "reader_generation integer not null default 0");
  addColumn(opened, "subscription_usage_snapshots", "metrics_json", "metrics_json text not null default '[]'");
  addColumn(opened, "subscription_usage_snapshots", "spend_sources_json", "spend_sources_json text not null default '[]' check (length(spend_sources_json) > 0)");
  addColumn(opened, "subscription_usage_snapshots", "reset_credits_json", "reset_credits_json text not null default 'null' check (length(reset_credits_json) > 0)");
  addColumn(opened, "subscription_usage_history", "spend_sources_json", "spend_sources_json text not null default '[]' check (length(spend_sources_json) > 0)");
  addColumn(opened, "subscription_usage_alerts", "project_root", "project_root text");
  addColumn(opened, "subscription_usage_alerts", "account_label", "account_label text");
  addColumn(opened, "subscription_usage_alerts", "metric_label", "metric_label text");
  addColumn(opened, "subscription_usage_alerts", "distinct_window", "distinct_window integer check (distinct_window in (0, 1))");
  addColumn(opened, "subscription_usage_alerts", "reset_at", "reset_at integer check (reset_at >= 0)");
  // Reset credits once carried the provider's applicability hint. Snapshots decode
  // strictly, so the retired key is removed from persisted rows rather than tolerated.
  opened.query("update subscription_usage_snapshots set reset_credits_json = json_remove(reset_credits_json, '$.applicableCount') where json_type(reset_credits_json, '$.applicableCount') is not null").run();
  const sourceVersion = metadata.protocol_version;
  if (sourceVersion !== USAGE_AUTHORITY_PROTOCOL_VERSION) {
    if (sourceVersion !== 2 && sourceVersion !== 3 && sourceVersion !== 4 && sourceVersion !== 5 && sourceVersion !== 6) throw new Error("Usage authority metadata does not match the active profile");
    // Protocols 5 and 6 already hold current metric shapes; protocol 7 changed only the ledger.
    if (sourceVersion !== 5 && sourceVersion !== 6) {
      migrateMetricJsonTable(opened, "subscription_usage_snapshots", sourceVersion);
      migrateMetricJsonTable(opened, "subscription_usage_history", sourceVersion);
      migrateMetricNames(opened, "subscription_usage_current");
      migrateMetricNames(opened, "subscription_usage_thresholds");
      migrateMetricNames(opened, "subscription_usage_alerts");
    }
    opened.query("update subscription_usage_authority set protocol_version = $version where id = 0").run({ $version: USAGE_AUTHORITY_PROTOCOL_VERSION });
  }
  opened.exec(CREATE_ALERTS_PENDING_INDEX);
}
