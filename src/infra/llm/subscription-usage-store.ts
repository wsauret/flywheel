import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { Schema } from "effect";
import { errorMessage } from "../error-message.js";
import { applySqliteDurabilityPragmas, isSqliteBusyError } from "../sqlite-durability.js";
import { subscriptionUsageAuthorityDbFile } from "../paths.js";
import { normalizeSubscriptionUsageReport, SubscriptionUsageMetricSchema, type NormalizedSubscriptionUsageReport, type SubscriptionUsageOutcome, type SubscriptionUsageReport, type SubscriptionUsageSpendSource } from "./subscription-usage.js";
import type { CapturedSubscriptionCredential } from "../auth/auth-context.js";
import type { SubscriptionAccountIdentity } from "./subscription-account-identity.js";
import { migrateSubscriptionUsageAuthority } from "./subscription-usage-store-migration.js";
import { USAGE_AUTHORITY_PROTOCOL_VERSION } from "./usage-authority-codec.js";
import {
  StoredMetricsSchema,
  StoredSpendSourcesSchema,
  StoredResetCreditsSchema,
  SubscriptionUsageCorruptError,
  SubscriptionUsageProtocolError,
  SubscriptionUsageTransientError,
  accountKeyFromIdentity,
  accountKeyFromRef,
  bindings,
  isCorruption,
  decodeAlert,
  decodeHistory,
  decodeLease,
  decodeMetadata,
  decodeSnapshot,
  decodeThreshold,
  keyString,
  metricUsedFraction,
  requireNumber,
  requireText,
  sleepFor,
  throwIfAborted,
  REQUIRED_SCHEMA_TABLES,
  type RawAlert,
  type RawHistory,
  type RawLease,
  type RawMetadata,
  type RawSnapshot,
  type RawThreshold,
  type SqlBinding,
} from "./subscription-usage-store-codec.js";

export { SubscriptionUsageProtocolError, quotaSubjectDigest } from "./subscription-usage-store-codec.js";
const SUBSCRIPTION_USAGE_PROTOCOL_VERSION = USAGE_AUTHORITY_PROTOCOL_VERSION;
export const SUBSCRIPTION_USAGE_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60_000;
export const SUBSCRIPTION_USAGE_HISTORY_HOUR_MS = 60 * 60_000;

const ACQUIRE_BUSY_TIMEOUT_MS = 250;
const OPERATION_BUSY_TIMEOUT_MS = 100;
const FETCH_LEASE_MS = 30_000;
const FETCH_WAIT_MS = 100;
const FETCH_DEADLINE_MS = 10_000;
const HISTORY_PRUNE_BATCH_SIZE = 128;

export interface SubscriptionUsageAccount {
  readonly providerId: string;
  readonly instanceId: string;
  readonly identity?: string;
}

export type SubscriptionUsageAccountKey = SubscriptionAccountIdentity;

export type SubscriptionUsageAccountRef = SubscriptionUsageAccount | SubscriptionUsageAccountKey;

export interface SubscriptionUsageSnapshot extends SubscriptionUsageAccountKey {
  readonly label?: string;
  readonly plan?: string;
  readonly tier?: string;
  readonly providerStatus: "ok" | "warning" | "exhausted" | "unknown";
  readonly observedAtMs: number;
  readonly readerGeneration: number;
  readonly metrics: readonly typeof SubscriptionUsageMetricSchema.Type[];
  readonly spendSources: readonly SubscriptionUsageSpendSource[];
  readonly resetCredits?: import("./subscription-usage.js").SubscriptionUsageResetCredits;
}

export interface SubscriptionUsageHistoryEntry extends SubscriptionUsageSnapshot {
  readonly hourStartMs: number;
}

interface SubscriptionUsageHistoryBounds {
  readonly startMs: number;
  readonly endMs: number;
}

export interface SubscriptionUsageThreshold extends SubscriptionUsageAccountKey {
  readonly metricName: string;
  readonly value: number;
  readonly cycleKey?: string;
  readonly lastValue?: number;
  readonly armed: boolean;
}

export interface SubscriptionUsageAlert extends SubscriptionUsageAccountKey {
  readonly id: string;
  readonly metricName: string;
  readonly accountLabel?: string;
  readonly metricLabel?: string;
  readonly distinctWindow?: boolean;
  readonly resetAtMs?: number;
  readonly threshold: number;
  readonly value: number;
  readonly observedAtMs: number;
  readonly cycleKey: string;
  readonly state: "open" | "claimed" | "delivered";
  readonly fence: number;
  readonly claimOwner?: string;
  readonly claimExpiresAtMs: number;
  readonly projectRoot?: string;
}

export interface SubscriptionUsageFetchLease extends SubscriptionUsageAccountKey {
  readonly owner: string;
  readonly readerGeneration: number;
  readonly fence: number;
  readonly leaseExpiresAtMs: number;
}

type SubscriptionUsageFetchClaim =
  | { readonly kind: "won"; readonly lease: SubscriptionUsageFetchLease }
  | { readonly kind: "lost"; readonly lease: SubscriptionUsageFetchLease };

type SubscriptionUsageReportCommit = { readonly kind: "committed" | "unchanged" | "conflict"; readonly snapshot: SubscriptionUsageSnapshot };
type SubscriptionUsageFetchCompletion =
  | SubscriptionUsageReportCommit
  | { readonly kind: "failed"; readonly snapshot: SubscriptionUsageSnapshot | undefined }
  | { readonly kind: "rejected"; readonly snapshot: SubscriptionUsageSnapshot | undefined };

type SubscriptionUsageAlertClaim =
  | { readonly kind: "won"; readonly alert: SubscriptionUsageAlert }
  | { readonly kind: "lost"; readonly alert: SubscriptionUsageAlert };

export interface SubscriptionUsageStoreOptions {
  /** Immutable auth profile directory. The database is created below this directory. */
  readonly profileDir?: string;
  /** Test and migration seam for an already-derived profile-local path. */
  readonly dbFile?: string;
  /** Stable profile identity. Defaults to the resolved profile directory. */
  readonly profileId?: string;
  readonly now?: () => number;
  readonly fetchLeaseMs?: number;
  readonly fetchDeadlineMs?: number;
  readonly freshnessMs?: number;
  /** Initialized authority-owned connection. The store validates it but does not migrate or publish protocol metadata. */
  readonly database?: Database;
}

interface SubscriptionUsageFetchOptions {
  readonly forceRefresh?: boolean;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly leaseMs?: number;
  readonly freshnessMs?: number;
}

export interface SubscriptionUsageStore {
  readonly dbFile: string;
  readonly profileId: string;
  revision(): number;
  accountKey(account: SubscriptionUsageAccount | CapturedSubscriptionCredential, providerId?: string): SubscriptionUsageAccountKey;
  current(account: SubscriptionUsageAccountRef): SubscriptionUsageSnapshot | undefined;
  history(account: SubscriptionUsageAccountRef, bounds: SubscriptionUsageHistoryBounds, metricName?: string): readonly SubscriptionUsageHistoryEntry[];
  threshold(account: SubscriptionUsageAccountRef, metricName: string, value?: number): SubscriptionUsageThreshold | undefined;
  thresholds(account: SubscriptionUsageAccountRef): readonly SubscriptionUsageThreshold[];
  setThreshold(account: SubscriptionUsageAccountRef, metricName: string, value: number): void;
  setThresholds(account: SubscriptionUsageAccountRef, metricName: string, values: readonly number[]): void;
  crossedThresholds(account: SubscriptionUsageAccountRef): readonly { readonly metricName: string; readonly threshold: number }[];
  pendingAlerts(account: SubscriptionUsageAccountRef, limit: number): readonly SubscriptionUsageAlert[];
  alerts(account: SubscriptionUsageAccountRef, metricName?: string): readonly SubscriptionUsageAlert[];
  claimAlert(input: { readonly alertId: string; readonly projectRoot?: string; readonly nowMs?: number; readonly leaseMs?: number; readonly owner?: string }): SubscriptionUsageAlertClaim;
  completeAlert(input: { readonly alertId: string; readonly fence: number; readonly owner?: string; readonly nowMs?: number }): boolean;
  releaseAlert(input: { readonly alertId: string; readonly fence: number; readonly owner?: string; readonly nowMs?: number }): boolean;
  record(report: SubscriptionUsageReport, thresholds?: readonly number[]): { readonly kind: "committed" | "unchanged" | "conflict"; readonly snapshot: SubscriptionUsageSnapshot };
  recordOutcome(outcome: SubscriptionUsageOutcome, thresholds?: readonly number[]): { readonly kind: "ignored" | "committed" | "unchanged" | "conflict"; readonly snapshot?: SubscriptionUsageSnapshot };
  claimFetch(account: SubscriptionUsageAccountRef, options?: { readonly nowMs?: number; readonly leaseMs?: number; readonly owner?: string }): SubscriptionUsageFetchClaim;
  acquireFetch(account: SubscriptionUsageAccountRef, options?: { readonly signal?: AbortSignal; readonly deadlineMs?: number; readonly leaseMs?: number }): Promise<SubscriptionUsageFetchLease | undefined>;
  completeFetch(lease: SubscriptionUsageFetchLease, outcome: SubscriptionUsageOutcome, thresholds?: readonly number[]): SubscriptionUsageFetchCompletion;
  fetch(account: SubscriptionUsageAccountRef, read: (signal: AbortSignal) => Promise<SubscriptionUsageOutcome>, options?: SubscriptionUsageFetchOptions): Promise<SubscriptionUsageSnapshot | undefined>;
  dispose(): void;
}





export function createSubscriptionUsageStore(options: SubscriptionUsageStoreOptions): SubscriptionUsageStore {
  const configuredDbFile = options.dbFile;
  if (options.profileDir === undefined && configuredDbFile === undefined) throw new Error("subscription usage store requires profileDir or dbFile");
  const profileDir = options.profileDir === undefined ? path.dirname(requireText(configuredDbFile, "dbFile")) : path.resolve(options.profileDir);
  const dbFile = configuredDbFile ?? subscriptionUsageAuthorityDbFile(profileDir);
  const profileId = options.profileId ?? profileDir;
  const now = options.now ?? Date.now;
  const owner = randomUUID();
  const inFlight = new Map<string, Promise<SubscriptionUsageSnapshot | undefined>>();
  let inFlightCleanup: Promise<void> | undefined;
  let disposed = false;
  let db: Database | undefined = options.database;
  const ownsDatabase = options.database === undefined;
  let terminalFailure: Error | undefined;

  function classify(error: unknown, at: string): Error {
    if (error instanceof SubscriptionUsageCorruptError || error instanceof SubscriptionUsageProtocolError || error instanceof SubscriptionUsageTransientError) return error;
    if (isCorruption(error)) return new SubscriptionUsageCorruptError(at, errorMessage(error));
    return new SubscriptionUsageTransientError(at, errorMessage(error));
  }

  function readMetadata(opened: Database): RawMetadata {
    const row = opened.query<unknown, []>("select protocol_version, profile_id, revision from subscription_usage_authority where id = 0").get();
    if (row === null) throw new SubscriptionUsageCorruptError("authority metadata", "missing singleton row");
    return decodeMetadata(row);
  }

  function assertMetadata(metadata: RawMetadata): void {
    if (metadata.protocol_version !== SUBSCRIPTION_USAGE_PROTOCOL_VERSION) {
      throw new SubscriptionUsageProtocolError(SUBSCRIPTION_USAGE_PROTOCOL_VERSION, metadata.protocol_version);
    }
    if (metadata.profile_id !== profileId) throw new SubscriptionUsageProtocolError(SUBSCRIPTION_USAGE_PROTOCOL_VERSION, metadata.protocol_version);
  }

  function initialize(opened: Database): void {
    opened.transaction((): void => migrateSubscriptionUsageAuthority(opened, profileId)).immediate();
  }

  function assertSchema(opened: Database): void {
    const names = new Set(opened.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all().map((row) => row.name));
    const missing = REQUIRED_SCHEMA_TABLES.filter((name) => !names.has(name));
    if (missing.length > 0) throw new SubscriptionUsageCorruptError("authority schema", `missing tables: ${missing.join(", ")}`);
  }

  function acquire(): Database {
    let opened: Database | undefined = options.database;
    try {
      if (opened === undefined) {
        if (options.profileDir === undefined) fs.mkdirSync(path.dirname(dbFile), { recursive: true });
        else {
          const profileStat = fs.lstatSync(profileDir);
          if (!profileStat.isDirectory()) throw new Error("the active auth profile is not a directory");
        }
        opened = new Database(dbFile, { create: true });
        applySqliteDurabilityPragmas(opened, ACQUIRE_BUSY_TIMEOUT_MS);
      }
      const objects = opened.query<{ name: string }, []>("select name from sqlite_master where type in ('table', 'index', 'trigger', 'view')").all();
      const authority = objects.some((object) => object.name === "subscription_usage_authority");
      if (!authority && objects.length > 0) throw new SubscriptionUsageProtocolError(SUBSCRIPTION_USAGE_PROTOCOL_VERSION, 0);
      if (ownsDatabase) initialize(opened);
      assertSchema(opened);
      opened.exec(`PRAGMA busy_timeout = ${OPERATION_BUSY_TIMEOUT_MS}`);
      assertMetadata(readMetadata(opened));
      return opened;
    } catch (error) {
      if (ownsDatabase) opened?.close();
      throw classify(error, "acquiring the database");
    }
  }

  try {
    db = acquire();
  } catch (error) {
    terminalFailure = error instanceof Error ? error : new Error(String(error));
  }

  function handle(): Database {
    if (disposed) throw new SubscriptionUsageTransientError("using a disposed store", "disposed");
    if (terminalFailure instanceof SubscriptionUsageProtocolError) throw new SubscriptionUsageProtocolError(terminalFailure.expected, terminalFailure.found);
    if (terminalFailure instanceof SubscriptionUsageCorruptError) throw new SubscriptionUsageCorruptError(terminalFailure.at, terminalFailure.reason);
    if (terminalFailure instanceof SubscriptionUsageTransientError) throw new SubscriptionUsageTransientError(terminalFailure.at, terminalFailure.reason);
    if (db === undefined) throw new SubscriptionUsageTransientError("opening the database", "not acquired");
    return db;
  }

  function run<T>(at: string, use: (opened: Database) => T): T {
    try {
      return use(handle());
    } catch (error) {
      const classified = classify(error, at);
      if (!(classified instanceof SubscriptionUsageTransientError)) {
        terminalFailure = classified;
        if (ownsDatabase) db?.close();
        db = undefined;
      }
      throw classified;
    }
  }

  function snapshotForOpened(opened: Database, key: SubscriptionUsageAccountKey): SubscriptionUsageSnapshot | undefined {
    const raw = opened.query<RawSnapshot, [SqlBinding]>("select provider_id, instance_id, subject_digest, label, plan, tier, provider_status, observed_at, reader_generation, metrics_json, spend_sources_json, reset_credits_json from subscription_usage_snapshots where provider_id = $provider and instance_id = $instance and subject_digest = $subject").get(bindings(key));
    return raw === null ? undefined : decodeSnapshot(raw);
  }

  function currentForKey(key: SubscriptionUsageAccountKey): SubscriptionUsageSnapshot | undefined {
    return run("reading current usage", (opened) => snapshotForOpened(opened, key));
  }

  function syncThresholds(opened: Database, key: SubscriptionUsageAccountKey, metricName: string, values: readonly number[]): ReadonlySet<number> {
    const added = new Set<number>();
    const normalized = [...new Set(values)].filter((value) => Number.isFinite(value) && value >= 0 && value <= 100);
    if (normalized.length === 0) {
      opened.query("delete from subscription_usage_thresholds where provider_id = $provider and instance_id = $instance and subject_digest = $subject and metric_name = $metric").run({ ...bindings(key), $metric: metricName });
      return added;
    }
    const placeholders = normalized.map((_, index) => `$threshold${index}`).join(", ");
    opened.query(`delete from subscription_usage_thresholds where provider_id = $provider and instance_id = $instance and subject_digest = $subject and metric_name = $metric and threshold_value not in (${placeholders})`).run({ ...bindings(key), $metric: metricName, ...Object.fromEntries(normalized.map((value, index) => [`$threshold${index}`, value])) });
    for (const value of normalized) {
      const inserted = opened.query("insert into subscription_usage_thresholds (provider_id, instance_id, subject_digest, metric_name, threshold_value, cycle_key, last_value, armed) values ($provider, $instance, $subject, $metric, $value, null, null, 1) on conflict(provider_id, instance_id, subject_digest, metric_name, threshold_value) do nothing").run({ ...bindings(key), $metric: metricName, $value: value });
      if (inserted.changes === 1) added.add(value);
    }
    return added;
  }

  function commitReport(opened: Database, report: NormalizedSubscriptionUsageReport, readerGeneration: number, thresholds?: readonly number[]): SubscriptionUsageReportCommit {
    const key = accountKeyFromIdentity(report.providerId, report.instanceId, report.identity);
    const metrics = Schema.decodeUnknownSync(StoredMetricsSchema, { onExcessProperty: "error" })(report.metrics);
    const metricsJson = JSON.stringify(metrics);
    const spendSources = Schema.decodeUnknownSync(StoredSpendSourcesSchema, { onExcessProperty: "error" })(report.spendSources);
    const spendSourcesJson = JSON.stringify(spendSources);
    const resetCredits = Schema.decodeUnknownSync(StoredResetCreditsSchema, { onExcessProperty: "error" })(report.resetCredits ?? null);
    const resetCreditsJson = JSON.stringify(resetCredits);
    const rawPrevious = opened.query<RawSnapshot, [SqlBinding]>("select provider_id, instance_id, subject_digest, label, plan, tier, provider_status, observed_at, reader_generation, metrics_json, spend_sources_json, reset_credits_json from subscription_usage_snapshots where provider_id = $provider and instance_id = $instance and subject_digest = $subject").get(bindings(key));
    if (rawPrevious !== null && report.observedAtMs <= rawPrevious.observed_at) {
      const snapshot = decodeSnapshot(rawPrevious);
      if (report.observedAtMs < rawPrevious.observed_at) return { kind: "unchanged", snapshot };
      const identical = rawPrevious.label === (report.label ?? null)
        && rawPrevious.plan === (report.plan ?? null)
        && rawPrevious.tier === (report.tier ?? null)
        && rawPrevious.provider_status === report.providerStatus
        && rawPrevious.metrics_json === metricsJson
        && rawPrevious.spend_sources_json === spendSourcesJson
        && rawPrevious.reset_credits_json === resetCreditsJson;
      return { kind: identical ? "unchanged" : "conflict", snapshot };
    }
    opened.query("insert into subscription_usage_snapshots (provider_id, instance_id, subject_digest, label, plan, tier, provider_status, observed_at, reader_generation, metrics_json, spend_sources_json, reset_credits_json) values ($provider, $instance, $subject, $label, $plan, $tier, $providerStatus, $observedAt, $generation, $metrics, $spendSources, $resetCredits) on conflict(provider_id, instance_id, subject_digest) do update set label = excluded.label, plan = excluded.plan, tier = excluded.tier, provider_status = excluded.provider_status, observed_at = excluded.observed_at, reader_generation = excluded.reader_generation, metrics_json = excluded.metrics_json, spend_sources_json = excluded.spend_sources_json, reset_credits_json = excluded.reset_credits_json").run({ ...bindings(key), $label: report.label ?? null, $plan: report.plan ?? null, $tier: report.tier ?? null, $providerStatus: report.providerStatus, $observedAt: report.observedAtMs, $generation: readerGeneration, $metrics: metricsJson, $spendSources: spendSourcesJson, $resetCredits: resetCreditsJson });
    opened.query("insert into subscription_usage_history (provider_id, instance_id, subject_digest, hour_start, label, plan, tier, provider_status, metrics_json, spend_sources_json, observed_at, reader_generation) values ($provider, $instance, $subject, $hour, $label, $plan, $tier, $providerStatus, $metrics, $spendSources, $observedAt, $generation) on conflict(provider_id, instance_id, subject_digest, hour_start) do update set label = excluded.label, plan = excluded.plan, tier = excluded.tier, provider_status = excluded.provider_status, metrics_json = excluded.metrics_json, spend_sources_json = excluded.spend_sources_json, observed_at = excluded.observed_at, reader_generation = excluded.reader_generation where excluded.observed_at > subscription_usage_history.observed_at").run({ ...bindings(key), $hour: Math.floor(report.observedAtMs / SUBSCRIPTION_USAGE_HISTORY_HOUR_MS) * SUBSCRIPTION_USAGE_HISTORY_HOUR_MS, $label: report.label ?? null, $plan: report.plan ?? null, $tier: report.tier ?? null, $providerStatus: report.providerStatus, $metrics: metricsJson, $spendSources: spendSourcesJson, $observedAt: report.observedAtMs, $generation: readerGeneration });
    for (const metric of metrics) {
      const addedThresholds = thresholds === undefined ? undefined : syncThresholds(opened, key, metric.metricKey, thresholds);
      updateThresholdAndAlert(opened, key, metric, report.label, metrics.length > 1, report.observedAtMs, rawPrevious === null ? undefined : addedThresholds);
    }
    opened.query("update subscription_usage_authority set revision = revision + 1 where id = 0").run();
    return { kind: "committed", snapshot: { ...key, ...(report.label === undefined ? {} : { label: report.label }), ...(report.plan === undefined ? {} : { plan: report.plan }), ...(report.tier === undefined ? {} : { tier: report.tier }), providerStatus: report.providerStatus, observedAtMs: report.observedAtMs, readerGeneration, metrics, spendSources, ...(resetCredits === null ? {} : { resetCredits }) } };
  }

  function updateThresholdAndAlert(opened: Database, key: SubscriptionUsageAccountKey, metric: typeof SubscriptionUsageMetricSchema.Type, accountLabel: string | undefined, distinctWindow: boolean, observedAtMs: number, addedThresholds?: ReadonlySet<number>): void {
    const rows = opened.query<{ threshold_value: number; cycle_key: string | null; last_value: number | null; armed: number }, [SqlBinding]>("select threshold_value, cycle_key, last_value, armed from subscription_usage_thresholds where provider_id = $provider and instance_id = $instance and subject_digest = $subject and metric_name = $metric order by threshold_value").all({ ...bindings(key), $metric: metric.metricKey });
    const fraction = metricUsedFraction(metric);
    for (const raw of rows) {
      const threshold = requireNumber(raw.threshold_value, "threshold.threshold_value");
      let episode = raw.cycle_key ?? randomUUID();
      let armed = raw.armed === 1;
      if (fraction === undefined) {
        opened.query("update subscription_usage_thresholds set cycle_key = $cycle, last_value = null, armed = $armed where provider_id = $provider and instance_id = $instance and subject_digest = $subject and metric_name = $metric and threshold_value = $threshold").run({ ...bindings(key), $metric: metric.metricKey, $threshold: threshold, $cycle: episode, $armed: armed ? 1 : 0 });
        continue;
      }
      const crossed = fraction >= threshold / 100;
      const crossedFromBelow = raw.last_value !== null && raw.last_value < threshold && crossed;
      if (crossed && addedThresholds?.has(threshold)) armed = false;
      if (!crossed && !armed) {
        episode = randomUUID();
        armed = true;
      }
      if (armed && crossedFromBelow) {
        const resetAtMs = metric.timing.kind === "exact" ? metric.timing.endMs : metric.timing.resetAtMs;
        opened.query("insert or ignore into subscription_usage_alerts (id, provider_id, instance_id, subject_digest, metric_name, account_label, metric_label, distinct_window, reset_at, threshold_value, value, observed_at, cycle_key, state, fence, claim_owner, claim_expires_at) values ($id, $provider, $instance, $subject, $metric, $accountLabel, $metricLabel, $distinctWindow, $resetAt, $threshold, $value, $observedAt, $cycle, 'open', 0, null, 0)").run({ ...bindings(key), $id: randomUUID(), $metric: metric.metricKey, $accountLabel: accountLabel ?? null, $metricLabel: metric.label, $distinctWindow: distinctWindow ? 1 : 0, $resetAt: resetAtMs ?? null, $threshold: threshold, $value: fraction * 100, $observedAt: observedAtMs, $cycle: episode });
      }
      opened.query("update subscription_usage_thresholds set cycle_key = $cycle, last_value = $value, armed = $armed where provider_id = $provider and instance_id = $instance and subject_digest = $subject and metric_name = $metric and threshold_value = $threshold").run({ ...bindings(key), $metric: metric.metricKey, $threshold: threshold, $cycle: episode, $value: fraction * 100, $armed: crossed ? 0 : 1 });
    }
  }

  function pruneHistory(): void {
    if (inFlightCleanup !== undefined) return;
    const cutoff = now() - SUBSCRIPTION_USAGE_HISTORY_RETENTION_MS;
    const opened = db;
    if (opened === undefined || disposed) return;
    inFlightCleanup = (async () => {
      for (;;) {
        if (disposed) return;
        try {
          const result = opened.query("delete from subscription_usage_history where rowid in (select rowid from subscription_usage_history where hour_start < $cutoff limit $batch)").run({ $cutoff: cutoff, $batch: HISTORY_PRUNE_BATCH_SIZE });
          if (result.changes === 0) return;
          await sleepFor(0);
        } catch (error) {
          if (!isSqliteBusyError(error)) return;
          await sleepFor(FETCH_WAIT_MS);
        }
      }
    })().finally(() => {
      inFlightCleanup = undefined;
    });
  }

  function alertForId(opened: Database, alertId: string): SubscriptionUsageAlert | undefined {
    const raw = opened.query<RawAlert, [SqlBinding]>("select id, provider_id, instance_id, subject_digest, metric_name, account_label, metric_label, distinct_window, reset_at, threshold_value, value, observed_at, cycle_key, state, fence, claim_owner, claim_expires_at, project_root from subscription_usage_alerts where id = $id").get({ $id: alertId });
    return raw === null ? undefined : decodeAlert(raw);
  }

  const store: SubscriptionUsageStore = {
    dbFile,
    profileId,
    revision: () => run("reading authority revision", (opened) => readMetadata(opened).revision),
    accountKey(account, providerId) {
      if (providerId === undefined) {
        if ("providerId" in account && account.identity !== undefined) return accountKeyFromIdentity(account.providerId, account.instanceId, account.identity);
        throw new Error("providerId is required for a credential account");
      }
      if ("instanceId" in account) {
        if (!(("identity" in account) && account.identity !== undefined)) throw new Error("subscription usage account identity is unavailable");
        return accountKeyFromIdentity(providerId, account.instanceId, account.identity);
      }
      throw new Error("invalid subscription usage account");
    },
    current(account) {
      return currentForKey(accountKeyFromRef(account));
    },
    history(account, bounds, metricName) {
      const key = accountKeyFromRef(account);
      return run("reading usage history", (opened) => {
        const rows = opened.query<RawHistory, [SqlBinding]>("select provider_id, instance_id, subject_digest, hour_start, label, plan, tier, provider_status, metrics_json, spend_sources_json, 'null' as reset_credits_json, observed_at, reader_generation from subscription_usage_history where provider_id = $provider and instance_id = $instance and subject_digest = $subject and hour_start >= $start and hour_start < $end order by hour_start desc").all({ ...bindings(key), $start: bounds.startMs, $end: bounds.endMs });
        const entries = rows.map((row) => decodeHistory(row));
        return metricName === undefined ? entries : entries.filter((entry) => entry.metrics.some((metric) => metric.metricKey === metricName));
      });
    },
    threshold(account, metricName, value) {
      const key = accountKeyFromRef(account);
      return run("reading usage threshold", (opened) => {
        const rows = opened.query<RawThreshold, [SqlBinding]>("select provider_id, instance_id, subject_digest, metric_name, threshold_value, cycle_key, last_value, armed from subscription_usage_thresholds where provider_id = $provider and instance_id = $instance and subject_digest = $subject and metric_name = $metric order by threshold_value").all({ ...bindings(key), $metric: metricName });
        const raw = value === undefined ? rows[0] : rows.find((row) => row.threshold_value === value);
        return raw === undefined ? undefined : decodeThreshold(raw);
      });
    },
    thresholds(account) {
      const key = accountKeyFromRef(account);
      return run("reading usage thresholds", (opened) => opened.query<RawThreshold, [SqlBinding]>("select provider_id, instance_id, subject_digest, metric_name, threshold_value, cycle_key, last_value, armed from subscription_usage_thresholds where provider_id = $provider and instance_id = $instance and subject_digest = $subject order by metric_name, threshold_value").all(bindings(key)).map(decodeThreshold));
    },
    setThreshold(account, metricName, value) {
      store.setThresholds(account, metricName, [value]);
    },
    setThresholds(account, metricName, values) {
      const key = accountKeyFromRef(account);
      requireText(metricName, "threshold.metricName");
      const normalized = [...new Set(values)];
      if (normalized.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) throw new Error("threshold values must be between zero and one hundred");
      run("writing usage thresholds", (opened) => opened.transaction((): void => {
        const retained = new Set(opened.query<{ threshold_value: number }, [SqlBinding]>("select threshold_value from subscription_usage_thresholds where provider_id = $provider and instance_id = $instance and subject_digest = $subject and metric_name = $metric").all({ ...bindings(key), $metric: metricName }).map((row) => row.threshold_value));
        syncThresholds(opened, key, metricName, normalized);
        const metric = snapshotForOpened(opened, key)?.metrics.find((candidate) => candidate.metricKey === metricName);
        const fraction = metric === undefined ? undefined : metricUsedFraction(metric);
        for (const value of normalized) {
          if (retained.has(value)) continue;
          const crossed = fraction !== undefined && fraction >= value / 100;
          opened.query("update subscription_usage_thresholds set cycle_key = $cycle, last_value = $lastValue, armed = $armed where provider_id = $provider and instance_id = $instance and subject_digest = $subject and metric_name = $metric and threshold_value = $threshold").run({ ...bindings(key), $metric: metricName, $threshold: value, $cycle: randomUUID(), $lastValue: fraction === undefined ? null : fraction * 100, $armed: crossed ? 0 : 1 });
        }
      }).immediate());
    },
    crossedThresholds(account) {
      const key = accountKeyFromRef(account);
      return run("reading crossed usage thresholds", (opened) => {
        const snapshot = snapshotForOpened(opened, key);
        if (snapshot === undefined) return [];
        const thresholds = opened.query<RawThreshold, [SqlBinding]>("select provider_id, instance_id, subject_digest, metric_name, threshold_value, cycle_key, last_value, armed from subscription_usage_thresholds where provider_id = $provider and instance_id = $instance and subject_digest = $subject order by metric_name, threshold_value").all(bindings(key)).map(decodeThreshold);
        return thresholds.flatMap((threshold) => {
          const metric = snapshot.metrics.find((candidate) => candidate.metricKey === threshold.metricName);
          const fraction = metric === undefined ? undefined : metricUsedFraction(metric);
          return fraction !== undefined && fraction >= threshold.value / 100 ? [{ metricName: threshold.metricName, threshold: threshold.value }] : [];
        });
      });
    },
    alerts(account, metricName) {
      const key = accountKeyFromRef(account);
      return run("reading usage alerts", (opened) => {
        const rows = metricName === undefined
          ? opened.query<RawAlert, [SqlBinding]>("select id, provider_id, instance_id, subject_digest, metric_name, account_label, metric_label, distinct_window, reset_at, threshold_value, value, observed_at, cycle_key, state, fence, claim_owner, claim_expires_at, project_root from subscription_usage_alerts where provider_id = $provider and instance_id = $instance and subject_digest = $subject order by observed_at desc").all(bindings(key))
          : opened.query<RawAlert, [SqlBinding]>("select id, provider_id, instance_id, subject_digest, metric_name, account_label, metric_label, distinct_window, reset_at, threshold_value, value, observed_at, cycle_key, state, fence, claim_owner, claim_expires_at, project_root from subscription_usage_alerts where provider_id = $provider and instance_id = $instance and subject_digest = $subject and metric_name = $metric order by observed_at desc").all({ ...bindings(key), $metric: metricName });
        return rows.map(decodeAlert);
      });
    },
    pendingAlerts(account, limit) {
      const key = accountKeyFromRef(account);
      if (!Number.isInteger(limit) || limit < 1) throw new Error("pending alert limit must be a positive integer");
      return run("reading pending usage alerts", (opened) => opened.query<RawAlert, [SqlBinding]>("select id, provider_id, instance_id, subject_digest, metric_name, account_label, metric_label, distinct_window, reset_at, threshold_value, value, observed_at, cycle_key, state, fence, claim_owner, claim_expires_at, project_root from subscription_usage_alerts where provider_id = $provider and instance_id = $instance and subject_digest = $subject and state != 'delivered' order by observed_at, id limit $limit").all({ ...bindings(key), $limit: limit }).map(decodeAlert));
    },
    claimAlert(input) {
      const nowMs = input.nowMs ?? now();
      const leaseMs = input.leaseMs ?? FETCH_LEASE_MS;
      const claimOwner = input.owner ?? owner;
      const projectRoot = input.projectRoot === undefined ? undefined : path.resolve(requireText(input.projectRoot, "claimAlert.projectRoot"));
      return run("claiming usage alert", (opened) => opened.transaction((): SubscriptionUsageAlertClaim => {
        const current = alertForId(opened, input.alertId);
        if (current === undefined) throw new Error(`usage alert does not exist: ${input.alertId}`);
        if (current.projectRoot !== undefined && current.projectRoot !== projectRoot) return { kind: "lost", alert: current };
        if (current.state === "delivered") return { kind: "lost", alert: current };
        if (current.state === "claimed" && current.claimExpiresAtMs > nowMs) return { kind: "lost", alert: current };
        const nextFence = current.fence + 1;
        if (projectRoot === undefined) {
          opened.query("update subscription_usage_alerts set state = 'claimed', fence = $fence, claim_owner = $owner, claim_expires_at = $expires where id = $id and fence = $oldFence and project_root is null and (state = 'open' or claim_expires_at <= $now)").run({ $id: input.alertId, $fence: nextFence, $owner: claimOwner, $expires: nowMs + leaseMs, $oldFence: current.fence, $now: nowMs });
        } else {
          opened.query("update subscription_usage_alerts set state = 'claimed', fence = $fence, claim_owner = $owner, claim_expires_at = $expires, project_root = coalesce(project_root, $projectRoot) where id = $id and fence = $oldFence and (project_root is null or project_root = $projectRoot) and (state = 'open' or claim_expires_at <= $now)").run({ $id: input.alertId, $fence: nextFence, $owner: claimOwner, $expires: nowMs + leaseMs, $oldFence: current.fence, $now: nowMs, $projectRoot: projectRoot });
        }
        const claimed = alertForId(opened, input.alertId);
        if (claimed === undefined) throw new SubscriptionUsageCorruptError(`alert/${input.alertId}`, "claim disappeared");
        return claimed.fence === nextFence && claimed.claimOwner === claimOwner && (projectRoot === undefined || claimed.projectRoot === projectRoot)
          ? { kind: "won", alert: claimed }
          : { kind: "lost", alert: claimed };
      }).immediate());
    },
    completeAlert(input) {
      return run("completing usage alert", (opened) => {
        const result = opened.query("update subscription_usage_alerts set state = 'delivered', claim_owner = null, claim_expires_at = 0 where id = $id and state = 'claimed' and fence = $fence and claim_expires_at > $now and ($owner is null or claim_owner = $owner)").run({ $id: input.alertId, $fence: input.fence, $now: input.nowMs ?? now(), $owner: input.owner ?? null });
        return result.changes === 1;
      });
    },
    releaseAlert(input) {
      return run("releasing usage alert", (opened) => {
        const result = opened.query("update subscription_usage_alerts set state = 'open', claim_owner = null, claim_expires_at = 0 where id = $id and state = 'claimed' and fence = $fence and claim_expires_at > $now and ($owner is null or claim_owner = $owner)").run({ $id: input.alertId, $fence: input.fence, $now: input.nowMs ?? now(), $owner: input.owner ?? null });
        return result.changes === 1;
      });
    },
    record(report, thresholds) {
      const result = run("committing usage report", (opened) => opened.transaction(() => {
        const normalized = normalizeSubscriptionUsageReport(report);
        const key = accountKeyFromIdentity(normalized.providerId, normalized.instanceId, normalized.identity);
        const previous = snapshotForOpened(opened, key);
        return commitReport(opened, normalized, (previous?.readerGeneration ?? 0) + 1, thresholds);
      }).immediate());
      if (result.kind === "committed") pruneHistory();
      return result;
    },
    recordOutcome(outcome, thresholds) {
      if (outcome.kind !== "success") return { kind: "ignored" };
      return store.record(outcome.report, thresholds);
    },
    claimFetch(account, input = {}) {
      const key = accountKeyFromRef(account);
      const nowMs = input.nowMs ?? now();
      const leaseMs = input.leaseMs ?? options.fetchLeaseMs ?? FETCH_LEASE_MS;
      const claimOwner = input.owner ?? owner;
      return run("claiming usage fetch lease", (opened) => opened.transaction((): SubscriptionUsageFetchClaim => {
        const raw = opened.query<RawLease, [SqlBinding]>("select provider_id, instance_id, subject_digest, owner, reader_generation, fence, lease_expires_at from subscription_usage_fetch_leases where provider_id = $provider and instance_id = $instance and subject_digest = $subject").get(bindings(key));
        const current = raw === null ? undefined : decodeLease(raw);
        if (current !== undefined && current.leaseExpiresAtMs > nowMs) return { kind: "lost", lease: current };
        const snapshot = snapshotForOpened(opened, key);
        const generation = Math.max(current?.readerGeneration ?? 0, snapshot?.readerGeneration ?? 0) + 1;
        const fence = (current?.fence ?? 0) + 1;
        opened.query("insert into subscription_usage_fetch_leases (provider_id, instance_id, subject_digest, owner, reader_generation, fence, lease_expires_at) values ($provider, $instance, $subject, $owner, $generation, $fence, $expires) on conflict(provider_id, instance_id, subject_digest) do update set owner = excluded.owner, reader_generation = excluded.reader_generation, fence = excluded.fence, lease_expires_at = excluded.lease_expires_at").run({ ...bindings(key), $owner: claimOwner, $generation: generation, $fence: fence, $expires: nowMs + leaseMs });
        return { kind: "won", lease: { ...key, owner: claimOwner, readerGeneration: generation, fence, leaseExpiresAtMs: nowMs + leaseMs } };
      }).immediate());
    },
    async acquireFetch(account, input = {}) {
      const signal = input.signal ?? new AbortController().signal;
      const configuredDeadline = input.deadlineMs ?? options.fetchDeadlineMs ?? FETCH_DEADLINE_MS;
      const deadline = configuredDeadline <= now() ? now() + configuredDeadline : configuredDeadline;
      const leaseMs = input.leaseMs ?? options.fetchLeaseMs ?? FETCH_LEASE_MS;
      while (true) {
        throwIfAborted(signal);
        const claimed = store.claimFetch(account, { leaseMs });
        if (claimed.kind === "won") return claimed.lease;
        const remaining = deadline - now();
        if (remaining <= 0) return undefined;
        await sleepFor(Math.min(FETCH_WAIT_MS, remaining, Math.max(1, claimed.lease.leaseExpiresAtMs - now())));
        const current = store.current(account);
        if (current !== undefined && current.readerGeneration >= claimed.lease.readerGeneration) return undefined;
      }
    },
    completeFetch(lease, outcome, thresholds) {
      const result = run("completing usage fetch lease", (opened) => opened.transaction((): SubscriptionUsageFetchCompletion => {
        const raw = opened.query<RawLease, [SqlBinding]>("select provider_id, instance_id, subject_digest, owner, reader_generation, fence, lease_expires_at from subscription_usage_fetch_leases where provider_id = $provider and instance_id = $instance and subject_digest = $subject").get(bindings(lease));
        const current = raw === null ? undefined : decodeLease(raw);
        if (current === undefined || current.owner !== lease.owner || current.fence !== lease.fence || current.readerGeneration !== lease.readerGeneration || current.leaseExpiresAtMs <= now()) return { kind: "rejected", snapshot: snapshotForOpened(opened, lease) };
        if (outcome.kind !== "success") {
          opened.query("update subscription_usage_fetch_leases set lease_expires_at = 0 where provider_id = $provider and instance_id = $instance and subject_digest = $subject and owner = $owner and fence = $fence").run({ ...bindings(lease), $owner: lease.owner, $fence: lease.fence });
          return { kind: "failed", snapshot: snapshotForOpened(opened, lease) };
        }
        const reportKey = accountKeyFromIdentity(outcome.report.providerId, outcome.report.instanceId, outcome.report.identity);
        if (keyString(reportKey) !== keyString(lease)) return { kind: "rejected", snapshot: snapshotForOpened(opened, lease) };
        const committed = commitReport(opened, normalizeSubscriptionUsageReport(outcome.report), lease.readerGeneration, thresholds);
        opened.query("update subscription_usage_fetch_leases set lease_expires_at = 0 where provider_id = $provider and instance_id = $instance and subject_digest = $subject and owner = $owner and fence = $fence").run({ ...bindings(lease), $owner: lease.owner, $fence: lease.fence });
        return committed;
      }).immediate());
      if (result.kind === "committed") pruneHistory();
      return result;
    },
    async fetch(account, read, input = {}) {
      const key = accountKeyFromRef(account);
      const freshness = input.freshnessMs ?? options.freshnessMs ?? 5 * 60_000;
      const existing = store.current(key);
      if (!input.forceRefresh && existing !== undefined && now() - existing.observedAtMs <= freshness) return existing;
      const joined = inFlight.get(keyString(key));
      if (joined !== undefined) return joined;
      const signal = input.signal ?? new AbortController().signal;
      const promise = (async (): Promise<SubscriptionUsageSnapshot | undefined> => {
        const lease = await store.acquireFetch(key, { signal, deadlineMs: input.deadlineMs, leaseMs: input.leaseMs });
        if (lease === undefined) return store.current(key);
        let outcome: SubscriptionUsageOutcome;
        try {
          outcome = await read(signal);
        } catch {
          outcome = { kind: "fetch-failure" };
        }
        const completed = store.completeFetch(lease, outcome);
        return completed.snapshot;
      })();
      inFlight.set(keyString(key), promise);
      try {
        return await promise;
      } finally {
        inFlight.delete(keyString(key));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      inFlight.clear();
      if (ownsDatabase) db?.close();
      db = undefined;
    },
  };
  return store;
}
