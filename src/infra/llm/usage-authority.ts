import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { Schema } from "effect";
import { Log } from "../log.js";
import { applySqliteDurabilityPragmas } from "../sqlite-durability.js";
import { subscriptionUsageAuthorityDbFile } from "../paths.js";
import { createSubscriptionUsageStore, type SubscriptionUsageAccount, type SubscriptionUsageStore } from "./subscription-usage-store.js";
import { decodeUsageEntry, type UsageEntry } from "./usage-entry.js";
import { selectSubscriptionUsageResetCredit, SubscriptionUsageMetricSchema } from "./subscription-usage.js";
import { CREATE_USAGE_LEDGER, CREATE_USAGE_LEDGER_HOURLY, CREATE_USAGE_LEDGER_HOURLY_BACKLOG, CREATE_USAGE_LEDGER_HOURLY_TRIGGER, CREATE_USAGE_QUOTA_INDEX, CREATE_USAGE_RANGE_INDEX, CREATE_USAGE_RESET_IN_FLIGHT, FOLD_USAGE_LEDGER_HOURLY_BACKLOG, ledgerRowFlags, type RawUsageLedgerEntry, RETIRED_USAGE_LEDGER_HOURLY, USAGE_AUTHORITY_PROTOCOL_VERSION, USAGE_LEDGER_HOURLY, USAGE_LEDGER_HOURLY_BACKLOG, usageRangeBounds } from "./usage-authority-codec.js";
import { canonicalUsageEntry, currentLedgerEntryJson, ensureCanonicalLedger, INSERT_USAGE_LEDGER_ROW, usageLedgerRow } from "./usage-authority-migration.js";
import { migrateSubscriptionUsageAuthority } from "./subscription-usage-store-migration.js";
export type { SubscriptionUsageAccount, SubscriptionUsageAccountRef, SubscriptionUsageAlert, SubscriptionUsageSnapshot } from "./subscription-usage-store.js";

const log = Log.create({ service: "usage-authority" });

export class UsageEntryConflictError extends Error {
  readonly _tag = "UsageEntryConflictError" as const;
  constructor(readonly attemptId: string) { super(`Usage attempt ${attemptId} conflicts with its existing ledger entry`); }
}

export interface UsageAuthorityOptions { readonly profileDir?: string; readonly dbFile?: string; readonly profileId?: string; readonly now?: () => number }
/** Coverage of a set of settled attempts: `attempts` counts the measured ones, whose tokens the sums hold;
 *  `unmeasuredAttempts` were served with no usage report and add no tokens or money; `partialAttempts` are measured
 *  attempts whose report ended early, so their tokens are lower bounds; `cacheComplete` is false when a measured
 *  attempt did not report cache reads. */
interface UsageCoverage { readonly attempts: number; readonly unmeasuredAttempts: number; readonly partialAttempts: number; readonly cacheComplete: boolean }
export interface UsageLedgerGroup extends UsageCoverage { readonly attributionKind: "candidate" | "unattributed"; readonly providerId?: string; readonly instanceId?: string; readonly spendMode: UsageEntry["spendMode"]; readonly credentialLineage: string; readonly model: string; readonly classification: UsageEntry["classification"]; readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number; readonly reasoningTokens: number; readonly estimatedUsd: number; readonly priceUnavailable: boolean }
export interface UsageRangeEntries { readonly start: string; readonly end: string; readonly groups: readonly UsageLedgerGroup[] }
/** A ledger group cut by the hour its attempts occurred in, for spend over time. */
type UsageHourlySpendGroup = UsageLedgerGroup & { readonly hourStartMs: number }
export interface UsageHourlySpend { readonly start: string; readonly end: string; readonly groups: readonly UsageHourlySpendGroup[] }
interface UsageQuotaSummary extends UsageCoverage { readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number; readonly cacheWriteTokens: number; readonly reasoningTokens: number; readonly includedValueUsd: number; readonly priceUnavailable: boolean }
type UsageQuotaWindowAccounting =
  | ({ readonly state: "available"; readonly metricKey: string; readonly startMs: number; readonly endMs: number; readonly trackingStartMs: number; readonly partial: boolean } & UsageQuotaSummary)
  | { readonly state: "window-unavailable"; readonly metricKey: string }
export type UsageQuotaAccounting =
  | { readonly state: "available"; readonly windows: readonly UsageQuotaWindowAccounting[] }
  | { readonly state: "window-unavailable" }
  | { readonly state: "ledger-unavailable" };
interface UsageQuotaAccountIdentity { readonly sourceId: string; readonly providerId: string; readonly instanceId: string; readonly identity: string }
interface UsageAccountsQuotaRead { readonly asOf: number; readonly revision: number; readonly results: readonly { readonly sourceId: string; readonly quotaAccounting: UsageQuotaAccounting }[] }
type AppendResult = { readonly kind: "appended" | "duplicate" };
interface UsageResetCheckpoint { readonly providerId: string; readonly instanceId: string; readonly subjectDigest: string; readonly actionId: string; readonly creditId: string; readonly providerKey: string; readonly reviewedIncarnation: string; readonly reviewedRevision: number }
type UsageResetPreparation = { readonly kind: "prepared"; readonly checkpoint: UsageResetCheckpoint } | { readonly kind: "stale" } | { readonly kind: "no-credit" };

export interface UsageAuthority extends Omit<SubscriptionUsageStore, "dbFile" | "profileId" | "revision" | "dispose"> {
  readonly dbFile: string;
  readonly profileId: string;
  readonly trackingStart: string;
  revision(): number;
  incarnation(): string;
  append(entry: UsageEntry): AppendResult;
  rangeEntries(bounds: { readonly startMs: number; readonly endMs: number }): UsageRangeEntries;
  /** The same groups as `rangeEntries`, cut by hour, so spend can be drawn over time. */
  hourlySpend(bounds: { readonly startMs: number; readonly endMs: number }): UsageHourlySpend;
  accountsQuotaAccounting(input: { readonly accounts: readonly UsageQuotaAccountIdentity[]; readonly asOf: number }): UsageAccountsQuotaRead;
  prepareReset(input: { readonly account: SubscriptionUsageAccount; readonly expectedIncarnation: string; readonly expectedRevision: number; readonly actionId: string; readonly providerKey: string }): UsageResetPreparation;
  completeReset(checkpoint: UsageResetCheckpoint): boolean;
  dispose(): void;
}



/** Opens the profile-local usage authority and migrates its established database in one immediate transaction. */
type LedgerCoverageRow = { attempts: number; unmeasured_attempts: number; partial_attempts: number; cache_read_unreported_attempts: number }
type LedgerGroupRow = LedgerCoverageRow & { attribution_kind: "candidate" | "unattributed"; provider_id: string | null; instance_id: string | null; spend_mode: UsageEntry["spendMode"]; credential_lineage: string; model: string; classification: UsageEntry["classification"]; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number; estimated_usd: number; price_unavailable: number ; hour_start_ms: number }

/** The grouped ledger read behind `rangeEntries` and `hourlySpend`: one SQL
 *  text, with the hour bucket added to the select and the grouping when
 *  asked, so the two reads cannot drift apart in what they attribute. */
function ledgerCoverage(row: LedgerCoverageRow): UsageCoverage {
  return { attempts: row.attempts - row.unmeasured_attempts, unmeasuredAttempts: row.unmeasured_attempts, partialAttempts: row.partial_attempts, cacheComplete: row.cache_read_unreported_attempts === 0 };
}

function ledgerGroup(row: LedgerGroupRow): UsageLedgerGroup {
  return { attributionKind: row.attribution_kind, ...(row.provider_id === null ? {} : { providerId: row.provider_id }), ...(row.instance_id === null ? {} : { instanceId: row.instance_id }), spendMode: row.spend_mode, credentialLineage: row.credential_lineage, model: row.model, classification: row.classification, ...ledgerCoverage(row), inputTokens: row.input_tokens, outputTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens, cacheWriteTokens: row.cache_write_tokens, reasoningTokens: row.reasoning_tokens, estimatedUsd: row.estimated_usd, priceUnavailable: row.price_unavailable === 1 }
}

const HOUR_MS = 3_600_000;
// A type alias, because bun:sqlite bindings need the implicit index signature an interface lacks.
type LedgerGroupBindings = { readonly $profile: string; readonly $start: number; readonly $end: number; readonly $wholeStart: number; readonly $wholeEnd: number }
const LEDGER_FLAGS = ledgerRowFlags("usage_ledger");
const RAW_LEDGER_PART = `select attribution_kind, provider_id, instance_id, spend_mode, credential_lineage, model, classification, (occurred_at_ms / ${HOUR_MS}) * ${HOUR_MS} hour_start_ms, 1 attempts, ${LEDGER_FLAGS.unmeasured} unmeasured_attempts, ${LEDGER_FLAGS.partial} partial_attempts, ${LEDGER_FLAGS.cacheReadUnreported} cache_read_unreported_attempts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, coalesce(estimated_usd, 0) estimated_usd, ${LEDGER_FLAGS.priceUnavailable} price_unavailable from usage_ledger where profile_id = $profile`;
/** Ledger rows the summary folds per step: about 5 ms of work, measured on a 355k-row ledger. */
const HOURLY_FOLD_ROWS = 2048;

/** Whole hours inside the range come from the hourly summary and the partial
 *  hour at each edge from the ledger, so the cost follows the hours in the
 *  range, not the ledger rows. Each summary compensation enters the one
 *  compensated `sum()` as its own USD part, which gives the same USD as
 *  `sum()` over the ledger rows; adding the compensations afterwards does not.
 *  While the summary still has a backlog, every hour comes from the ledger. */
function ledgerGroups(db: Database, profileId: string, bounds: { readonly startMs: number; readonly endMs: number }, hourColumn: "" | "hour_start_ms"): LedgerGroupRow[] {
  const hourSelect = hourColumn === "" ? "" : ", hour_start_ms";
  const wholeStartMs = Math.ceil(bounds.startMs / HOUR_MS) * HOUR_MS;
  const wholeEndMs = Math.floor(bounds.endMs / HOUR_MS) * HOUR_MS;
  const summaryComplete = db.query(`select 1 from ${USAGE_LEDGER_HOURLY_BACKLOG}`).get() === null;
  // An empty whole span at the range end makes the leading ledger part cover the whole range.
  const whole = !summaryComplete || wholeStartMs > wholeEndMs ? { startMs: bounds.endMs, endMs: bounds.endMs } : { startMs: wholeStartMs, endMs: wholeEndMs };
  return db.query<LedgerGroupRow, LedgerGroupBindings>(`with whole as (
    select attribution_kind, nullif(provider_id, '') provider_id, nullif(instance_id, '') instance_id, spend_mode, credential_lineage, model, classification, hour_start_ms, attempts, unmeasured_attempts, partial_attempts, cache_read_unreported_attempts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_usd, estimated_usd_compensation, price_unavailable
      from ${USAGE_LEDGER_HOURLY} where profile_id = $profile and hour_start_ms >= $wholeStart and hour_start_ms < $wholeEnd
  ), parts as (
    select attribution_kind, provider_id, instance_id, spend_mode, credential_lineage, model, classification, hour_start_ms, attempts, unmeasured_attempts, partial_attempts, cache_read_unreported_attempts, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_usd, price_unavailable from whole
    union all select attribution_kind, provider_id, instance_id, spend_mode, credential_lineage, model, classification, hour_start_ms, 0, 0, 0, 0, 0, 0, 0, 0, 0, estimated_usd_compensation, 0 from whole
    union all ${RAW_LEDGER_PART} and occurred_at_ms >= $start and occurred_at_ms < $wholeStart
    union all ${RAW_LEDGER_PART} and occurred_at_ms >= $wholeEnd and occurred_at_ms < $end
  )
  select attribution_kind, provider_id, instance_id, spend_mode, credential_lineage, model, classification, sum(attempts) attempts, sum(unmeasured_attempts) unmeasured_attempts, sum(partial_attempts) partial_attempts, sum(cache_read_unreported_attempts) cache_read_unreported_attempts, sum(input_tokens) input_tokens, sum(output_tokens) output_tokens, sum(cache_read_tokens) cache_read_tokens, sum(cache_write_tokens) cache_write_tokens, sum(reasoning_tokens) reasoning_tokens, sum(estimated_usd) estimated_usd, max(price_unavailable) price_unavailable${hourSelect}
  from parts group by attribution_kind, provider_id, instance_id, spend_mode, credential_lineage, model, classification${hourSelect}
  order by attribution_kind, provider_id, instance_id, credential_lineage, model, classification, spend_mode${hourSelect}`).all({ $profile: profileId, $start: bounds.startMs, $end: bounds.endMs, $wholeStart: whole.startMs, $wholeEnd: whole.endMs });
}

export function createUsageAuthority(options: UsageAuthorityOptions): UsageAuthority {
  if (options.profileDir === undefined && options.dbFile === undefined) throw new Error("Usage authority requires profileDir or dbFile");
  const profileDir = options.profileDir === undefined ? path.dirname(options.dbFile ?? "") : path.resolve(options.profileDir);
  const dbFile = options.dbFile ?? subscriptionUsageAuthorityDbFile(profileDir);
  const profileId = options.profileId ?? profileDir;
  const now = options.now ?? Date.now;

  const { db, metadata } = (() => {
    try {
      fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      const opened = new Database(dbFile, { create: true });
      try {
      applySqliteDurabilityPragmas(opened, 250);
      const capturedTrackingStart = new Date(now()).toISOString();
      opened.transaction(() => {
        const authority = opened.query<{ name: string }, []>("select name from sqlite_master where type = 'table' and name = 'subscription_usage_authority'").get();
        let previousVersion: number | undefined;
        if (authority === null) {
          opened.exec("create table subscription_usage_authority (id integer primary key check(id = 0), protocol_version integer not null, profile_id text not null, revision integer not null check(revision >= 0), tracking_start text not null, incarnation text not null check(length(incarnation) > 0))");
          opened.query("insert into subscription_usage_authority values (0, $version, $profile, 0, $trackingStart, $incarnation)").run({ $version: USAGE_AUTHORITY_PROTOCOL_VERSION, $profile: profileId, $trackingStart: capturedTrackingStart, $incarnation: randomUUID() });
        } else {
          const columns = opened.query<{ name: string }, []>("pragma table_info(subscription_usage_authority)").all();
          const existing = opened.query<{ protocol_version: number; profile_id: string }, []>("select protocol_version, profile_id from subscription_usage_authority where id = 0").get();
          if (existing === null || existing.profile_id !== profileId || ![2, 3, 4, 5, 6, USAGE_AUTHORITY_PROTOCOL_VERSION].includes(existing.protocol_version)) throw new Error("Usage authority metadata does not match the active profile");
          previousVersion = existing.protocol_version;
          if (!columns.some(({ name }) => name === "tracking_start") || !columns.some(({ name }) => name === "incarnation")) {
            const prior = opened.query<{ id: number; profile_id: string; revision: number; tracking_start?: string; incarnation?: string }, []>("select * from subscription_usage_authority where id = 0").get();
            if (prior === null) throw new Error("Usage authority metadata is malformed");
            opened.exec("alter table subscription_usage_authority rename to subscription_usage_authority_legacy; create table subscription_usage_authority (id integer primary key check(id = 0), protocol_version integer not null, profile_id text not null, revision integer not null check(revision >= 0), tracking_start text not null, incarnation text not null check(length(incarnation) > 0))");
            opened.query("insert into subscription_usage_authority values (0, $version, $profile, $revision, $trackingStart, $incarnation)").run({ $version: previousVersion, $profile: prior.profile_id, $revision: prior.revision, $trackingStart: prior.tracking_start ?? capturedTrackingStart, $incarnation: prior.incarnation ?? randomUUID() });
            opened.exec("drop table subscription_usage_authority_legacy");
          }
        }
        migrateSubscriptionUsageAuthority(opened, profileId);
        for (const retired of RETIRED_USAGE_LEDGER_HOURLY) opened.exec(`drop trigger if exists ${retired}_insert; drop table if exists ${retired}`);
        opened.exec(CREATE_USAGE_LEDGER);
        ensureCanonicalLedger(opened, previousVersion);
        if (opened.query("select 1 from sqlite_master where type = 'table' and name = ?").get(USAGE_LEDGER_HOURLY) === null) {
          opened.exec(CREATE_USAGE_LEDGER_HOURLY);
          opened.exec(CREATE_USAGE_LEDGER_HOURLY_BACKLOG);
          // `max(rowid)` reads the last b-tree entry, so recording the backlog costs the same at any ledger size.
          opened.exec(`insert into ${USAGE_LEDGER_HOURLY_BACKLOG} select 0, 0, max(rowid) from usage_ledger having max(rowid) is not null`);
        }
        opened.exec(CREATE_USAGE_LEDGER_HOURLY_TRIGGER);
        opened.exec("drop table if exists usage_in_flight");
        opened.exec(CREATE_USAGE_RANGE_INDEX);
        opened.exec(CREATE_USAGE_QUOTA_INDEX);
        opened.exec(CREATE_USAGE_RESET_IN_FLIGHT);
        opened.query("update subscription_usage_authority set protocol_version = $version where id = 0").run({ $version: USAGE_AUTHORITY_PROTOCOL_VERSION });
        const required = ["subscription_usage_authority", "usage_ledger"];
        const names = new Set(opened.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all().map(({ name }) => name));
        if (required.some((name) => !names.has(name))) throw new Error("Usage authority schema migration did not settle");
      }).immediate();
      opened.exec("pragma busy_timeout = 100");
      const current = opened.query<{ revision: number; tracking_start: string; incarnation: string }, []>("select revision, tracking_start, incarnation from subscription_usage_authority where id = 0").get();
      if (current === null || typeof current.tracking_start !== "string" || typeof current.incarnation !== "string") throw new Error("Usage authority metadata is malformed");
      return { db: opened, metadata: current };
      } catch (error) {
        opened.close();
        throw error;
      }
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; Usage authority failed while acquiring the database`, { cause: error });
    }
  })();
  const observations = createSubscriptionUsageStore({ ...options, database: db });
  let disposed = false;
  const handle = (): Database => { if (disposed) throw new Error("Usage authority is disposed"); return db; };

  const foldStartedMs = performance.now();
  /** Folds one bounded step of the summary backlog in its own transaction, so appends and reads interleave with the
   *  build, and returns whether rows remain. */
  const foldHourlyBacklogStep = (): boolean => db.transaction(() => {
    const backlog = db.query<{ folded_through_rowid: number; through_rowid: number }, []>(`select folded_through_rowid, through_rowid from ${USAGE_LEDGER_HOURLY_BACKLOG}`).get();
    if (backlog === null) return false;
    const through = Math.min(backlog.folded_through_rowid + HOURLY_FOLD_ROWS, backlog.through_rowid);
    db.query(FOLD_USAGE_LEDGER_HOURLY_BACKLOG).run({ $after: backlog.folded_through_rowid, $through: through });
    if (through < backlog.through_rowid) {
      db.query(`update ${USAGE_LEDGER_HOURLY_BACKLOG} set folded_through_rowid = ?`).run(through);
      return true;
    }
    db.exec(`delete from ${USAGE_LEDGER_HOURLY_BACKLOG}`);
    log.info("Usage hourly summary built", { throughRowid: backlog.through_rowid, durationMs: Math.round(performance.now() - foldStartedMs) });
    return false;
  }).immediate();
  let foldTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleHourlyFold = (): void => {
    foldTimer = setTimeout(() => {
      foldTimer = undefined;
      try {
        if (foldHourlyBacklogStep()) scheduleHourlyFold();
      } catch (error) {
        // Reads stay exact from the ledger; the next open resumes the build from the recorded backlog.
        log.warn("Usage hourly summary build stopped", { error: error instanceof Error ? error.message : String(error) });
      }
    }, 0);
    foldTimer.unref();
  };
  if (db.query(`select 1 from ${USAGE_LEDGER_HOURLY_BACKLOG}`).get() !== null) scheduleHourlyFold();

  function appendTo(opened: Database, value: UsageEntry): AppendResult {
    const entry = decodeUsageEntry(value);
    if (entry.profileId !== profileId) throw new Error("Usage entry belongs to a different profile");
    const json = canonicalUsageEntry(entry);
    const existing = opened.query<RawUsageLedgerEntry, [string]>("select entry_json from usage_ledger where attempt_id = ?").get(entry.attemptId);
    if (existing !== null) {
      if (existing.entry_json === json || currentLedgerEntryJson(existing.entry_json) === json) return { kind: "duplicate" };
      throw new UsageEntryConflictError(entry.attemptId);
    }
    opened.query(INSERT_USAGE_LEDGER_ROW).run(usageLedgerRow(entry));
    opened.query("update subscription_usage_authority set revision = revision + 1 where id = 0").run();
    return { kind: "appended" };
  }

  const authority: UsageAuthority = {
    ...observations,
    dbFile, profileId, trackingStart: metadata.tracking_start,
    revision: () => handle().query<{ revision: number }, []>("select revision from subscription_usage_authority where id = 0").get()?.revision ?? 0,
    incarnation: () => metadata.incarnation,
    append: (entry) => handle().transaction(() => appendTo(handle(), entry)).immediate(),
    rangeEntries(input) {
      const bounds = usageRangeBounds(input.startMs, input.endMs);
      return { start: bounds.start, end: bounds.end, groups: ledgerGroups(handle(), profileId, bounds, "").map(ledgerGroup) };
    },
    hourlySpend(input) {
      const bounds = usageRangeBounds(input.startMs, input.endMs);
      return { start: bounds.start, end: bounds.end, groups: ledgerGroups(handle(), profileId, bounds, "hour_start_ms").map((row) => ({ hourStartMs: row.hour_start_ms, ...ledgerGroup(row) })) };
    },
    accountsQuotaAccounting(input) {
      if (!Number.isSafeInteger(input.asOf) || input.asOf < 0) throw new Error("Quota accounting asOf must be a non-negative safe integer");
      for (const account of input.accounts) if (!account.instanceId) throw new Error("Quota accounting requires an exact provider instance");
      return handle().transaction((): UsageAccountsQuotaRead => {
        const opened = handle();
        const captured = opened.query<{ revision: number; tracking_start: string }, []>("select revision, tracking_start from subscription_usage_authority where id = 0").get();
        if (captured === null) throw new Error("Usage authority metadata is malformed");
        const trackingStartMs = Date.parse(captured.tracking_start);
        if (!Number.isSafeInteger(trackingStartMs) || trackingStartMs < 0) throw new Error("Usage authority tracking start is malformed");
        const results = input.accounts.map((account) => {
          const key = observations.accountKey(account);
          const snapshot = opened.query<{ metrics_json: string }, [string, string, string]>("select metrics_json from subscription_usage_snapshots where provider_id = ? and instance_id = ? and subject_digest = ?").get(key.providerId, key.instanceId, key.subjectDigest);
          if (snapshot === null) return { sourceId: account.sourceId, quotaAccounting: { state: "window-unavailable" as const } };
          const metrics = Schema.decodeUnknownSync(Schema.Array(SubscriptionUsageMetricSchema), { onExcessProperty: "error" })(JSON.parse(snapshot.metrics_json));
          const currentMetrics = metrics.filter((metric) => metric.scope.kind === "account" && (metric.timing.kind === "unavailable" || (metric.timing.startMs <= input.asOf && input.asOf < metric.timing.endMs)))
            .toSorted((left, right) => left.rank - right.rank || left.metricKey.localeCompare(right.metricKey));
          if (currentMetrics.length === 0) return { sourceId: account.sourceId, quotaAccounting: { state: "window-unavailable" as const } };
          const windows: UsageQuotaWindowAccounting[] = [];
          for (const metric of currentMetrics) {
            if (metric.timing.kind === "unavailable") {
              windows.push({ state: "window-unavailable", metricKey: metric.metricKey });
              continue;
            }
            const { startMs, endMs } = metric.timing;
            const total = opened.query<LedgerCoverageRow & { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number; included_usd: number; price_unavailable: number }, [string, string, string, number, number]>(`select count(*) attempts, coalesce(sum(${LEDGER_FLAGS.unmeasured}),0) unmeasured_attempts, coalesce(sum(${LEDGER_FLAGS.partial}),0) partial_attempts, coalesce(sum(${LEDGER_FLAGS.cacheReadUnreported}),0) cache_read_unreported_attempts, coalesce(sum(input_tokens),0) input_tokens, coalesce(sum(output_tokens),0) output_tokens, coalesce(sum(cache_read_tokens),0) cache_read_tokens, coalesce(sum(cache_write_tokens),0) cache_write_tokens, coalesce(sum(reasoning_tokens),0) reasoning_tokens, coalesce(sum(estimated_usd),0) included_usd, coalesce(max(${LEDGER_FLAGS.priceUnavailable}),0) price_unavailable from usage_ledger where profile_id = ? and attribution_kind = 'candidate' and provider_id = ? and instance_id = ? and spend_mode = 'included' and classification = 'subscription_equivalent' and occurred_at_ms >= ? and occurred_at_ms < ?`).get(profileId, account.providerId, account.instanceId, startMs, endMs);
            if (total === null) return { sourceId: account.sourceId, quotaAccounting: { state: "ledger-unavailable" as const } };
            windows.push({ state: "available", metricKey: metric.metricKey, startMs, endMs, trackingStartMs, partial: trackingStartMs > startMs, ...ledgerCoverage(total), inputTokens: total.input_tokens, outputTokens: total.output_tokens, cacheReadTokens: total.cache_read_tokens, cacheWriteTokens: total.cache_write_tokens, reasoningTokens: total.reasoning_tokens, includedValueUsd: total.included_usd, priceUnavailable: total.price_unavailable === 1 });
          }
          return { sourceId: account.sourceId, quotaAccounting: { state: "available" as const, windows } };
        });
        return { asOf: input.asOf, revision: captured.revision, results };
      })();
    },
    prepareReset(input) {
      return handle().transaction((): UsageResetPreparation => {
        const opened = handle();
        const key = observations.accountKey(input.account);
        const existing = opened.query<{ provider_id: string; instance_id: string; subject_digest: string; action_id: string; credit_id: string; provider_key: string; reviewed_incarnation: string; reviewed_revision: number }, [string, string, string]>("select * from subscription_usage_reset_in_flight where provider_id = ? and instance_id = ? and subject_digest = ?").get(key.providerId, key.instanceId, key.subjectDigest);
        if (existing !== null) return { kind: "prepared", checkpoint: { providerId: existing.provider_id, instanceId: existing.instance_id, subjectDigest: existing.subject_digest, actionId: existing.action_id, creditId: existing.credit_id, providerKey: existing.provider_key, reviewedIncarnation: existing.reviewed_incarnation, reviewedRevision: existing.reviewed_revision } };
        const currentMetadata = opened.query<{ revision: number }, []>("select revision from subscription_usage_authority where id = 0").get();
        if (currentMetadata === null || metadata.incarnation !== input.expectedIncarnation || currentMetadata.revision !== input.expectedRevision) return { kind: "stale" };
        const snapshot = observations.current(key);
        const credit = selectSubscriptionUsageResetCredit(snapshot?.resetCredits);
        if (credit === undefined) return { kind: "no-credit" };
        const checkpoint: UsageResetCheckpoint = { ...key, actionId: input.actionId, creditId: credit.id, providerKey: input.providerKey, reviewedIncarnation: input.expectedIncarnation, reviewedRevision: input.expectedRevision };
        opened.query("insert into subscription_usage_reset_in_flight values (?, ?, ?, ?, ?, ?, ?, ?)").run(checkpoint.providerId, checkpoint.instanceId, checkpoint.subjectDigest, checkpoint.actionId, checkpoint.creditId, checkpoint.providerKey, checkpoint.reviewedIncarnation, checkpoint.reviewedRevision);
        return { kind: "prepared", checkpoint };
      }).immediate();
    },
    completeReset(checkpoint) {
      return handle().query("delete from subscription_usage_reset_in_flight where provider_id = ? and instance_id = ? and subject_digest = ? and provider_key = ? and credit_id = ?").run(checkpoint.providerId, checkpoint.instanceId, checkpoint.subjectDigest, checkpoint.providerKey, checkpoint.creditId).changes === 1;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(foldTimer);
      observations.dispose();
      db.close();
    },
  };
  return authority;
}
