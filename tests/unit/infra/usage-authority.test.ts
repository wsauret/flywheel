import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createUsageAuthority, UsageEntryConflictError, type UsageLedgerGroup } from "../../../src/infra/llm/usage-authority.js";
import type { MeasuredUsageEntry, UsageEntry } from "../../../src/infra/llm/usage-entry.js";
import { subscriptionUsageAuthorityDbFile } from "../../../src/infra/paths.js";
import * as subscriptionUsageMigration from "../../../src/infra/llm/subscription-usage-store-migration.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function entry(overrides: Partial<MeasuredUsageEntry> = {}): MeasuredUsageEntry {
  return {
    attemptId: "00000000-0000-4000-8000-000000000001",
    occurredAt: "2025-01-15T12:00:00.000Z",
    profileId: "default",
    currency: "USD", coverage: "complete",
    attribution: { kind: "candidate", providerId: "anthropic_api" },
    spendMode: "direct_api",
    credentialLineage: "00000000-0000-4000-8000-000000000002",
    model: "claude-sonnet-4",
    tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 0 },
    classification: "real_spend",
    price: { kind: "priced", estimatedUsd: 0.25, rateCard: { inputPerMillionUsd: 3, outputPerMillionUsd: 15 }, provenance: "live" },
    ...overrides,
  };
}

/** A served attempt with no usage report. */
function unmeasured(attemptId: string, occurredAt: string): UsageEntry {
  const { tokens: _tokens, price: _price, currency: _currency, ...attempt } = entry({ attemptId, occurredAt });
  return { ...attempt, coverage: "unmeasured" };
}

/** The protocol 6 ledger that every build before coverage wrote, with its hourly summary. */
function writeProtocol6Ledger(file: string, entries: readonly MeasuredUsageEntry[]): void {
  const db = new Database(file, { create: true });
  db.exec("create table subscription_usage_authority (id integer primary key check(id = 0), protocol_version integer not null, profile_id text not null, revision integer not null, tracking_start text not null, incarnation text not null); insert into subscription_usage_authority values (0, 6, 'default', 1, '2025-01-01T00:00:00.000Z', '00000000-0000-4000-8000-0000000000aa')");
  db.exec("create table usage_ledger (attempt_id text primary key, occurred_at_ms integer not null, profile_id text not null, attribution_kind text not null, provider_id text, instance_id text, spend_mode text not null, credential_lineage text not null, model text not null, classification text not null, input_tokens integer not null, output_tokens integer not null, cache_read_tokens integer not null, cache_write_tokens integer not null, reasoning_tokens integer not null, price_available integer not null, estimated_usd real, entry_json text not null)");
  db.exec("create index usage_ledger_range_idx on usage_ledger (profile_id, occurred_at_ms); create table usage_ledger_hourly_v1 (profile_id text); create trigger usage_ledger_hourly_v1_insert after insert on usage_ledger begin insert into usage_ledger_hourly_v1 values (new.profile_id); end");
  const insert = db.query("insert into usage_ledger values ($attempt,$occurred,$profile,'candidate',$provider,null,$mode,$lineage,$model,$classification,$input,$output,$cacheRead,$cacheWrite,$reasoning,$available,$usd,$json)");
  for (const prior of entries) {
    if (prior.attribution.kind !== "candidate" || prior.tokens.cacheRead === null) throw new Error("fixture needs a candidate with cache reads");
    // The key order of the protocol 6 `canonicalUsageEntry`, which an appended checkpoint replay compares byte for byte.
    const uncovered = { attemptId: prior.attemptId, occurredAt: prior.occurredAt, profileId: prior.profileId, currency: prior.currency, attribution: prior.attribution, spendMode: prior.spendMode, credentialLineage: prior.credentialLineage, model: prior.model, tokens: prior.tokens, classification: prior.classification, price: prior.price };
    insert.run({ $attempt: prior.attemptId, $occurred: Date.parse(prior.occurredAt), $profile: prior.profileId, $provider: prior.attribution.providerId, $mode: prior.spendMode, $lineage: prior.credentialLineage, $model: prior.model, $classification: prior.classification, $input: prior.tokens.input, $output: prior.tokens.output, $cacheRead: prior.tokens.cacheRead, $cacheWrite: prior.tokens.cacheWrite, $reasoning: prior.tokens.reasoning, $available: prior.price.kind === "priced" ? 1 : 0, $usd: prior.price.kind === "priced" ? prior.price.estimatedUsd : null, $json: JSON.stringify(uncovered) });
  }
  db.close();
}

/** Resolves once the hourly summary holds every ledger row, which the authority builds in steps after it opens. */
async function hourlySummaryBuilt(file: string): Promise<void> {
  const db = new Database(file, { readonly: true });
  try {
    while (db.query("select 1 from usage_ledger_hourly_v2_backlog").get() !== null) await Bun.sleep(1);
  } finally {
    db.close();
  }
}

function authority(now = Date.parse("2025-01-20T00:00:00.000Z")) {
  const root = mkdtempSync(join(tmpdir(), "usage-authority-"));
  roots.push(root);
  return { root, store: createUsageAuthority({ profileDir: root, profileId: "default", now: () => now }) };
}

describe("usage authority", () => {
  test("appends idempotently, rejects conflicts, and aggregates the runtime local month", () => {
    const { store } = authority();
    expect(store.append(entry())).toEqual({ kind: "appended" });
    expect(store.append(entry())).toEqual({ kind: "duplicate" });
    expect(() => store.append(entry({ model: "different" }))).toThrow(UsageEntryConflictError);
    expect(store.rangeEntries({ startMs: Date.parse("2025-01-01T00:00:00.000Z"), endMs: Date.parse("2025-02-01T00:00:00.000Z") }).groups).toEqual([expect.objectContaining({ model: "claude-sonnet-4", attempts: 1, inputTokens: 10, outputTokens: 5, estimatedUsd: 0.25, providerId: "anthropic_api", priceUnavailable: false })]);
    store.dispose();
  });

  test("preserves legacy rows and the immutable ledger while an older writer stays open", () => {
    const { root, store } = authority();
    store.append(entry());
    const incarnation = store.incarnation();
    const trackingStart = store.trackingStart;
    const revision = store.revision();
    const observation = {
      providerId: "chatgpt", instanceId: "account-a", identity: "subject-a", providerStatus: "ok",
      observedAtMs: Date.parse("2025-01-20T01:00:00.000Z"),
      metrics: [{ metricKey: "primary_window", label: "Primary window", scope: { kind: "account" }, rank: 0, timing: { kind: "unavailable" }, usedFraction: 0.5 }],
    } as const;
    const key = store.accountKey(observation);
    const old = new Database(store.dbFile);
    const ledger = old.query<unknown, []>("select *, hex(entry_json) as entry_bytes from usage_ledger order by attempt_id");
    const ledgerBefore = ledger.all();
    expect(ledgerBefore).toHaveLength(1);
    expect(old.query<{ protocol_version: number }, []>("select protocol_version from subscription_usage_authority").get()?.protocol_version).toBe(7);
    const deleteCurrent = old.query("delete from subscription_usage_current where provider_id = $provider and instance_id = $instance and subject_digest = $subject");
    const insertCurrent = old.query("insert into subscription_usage_current (provider_id, instance_id, subject_digest, label, metric_name, unit, used, \"limit\", remaining, resets_on, observed_at, reader_generation) values ($provider, $instance, $subject, $label, $metric, $unit, $used, $limit, $remaining, $resetsOn, $observedAt, $generation)");
    const accountBindings = { $provider: key.providerId, $instance: key.instanceId, $subject: key.subjectDigest };
    const sentinel = { ...accountBindings, $label: "older writer", $metric: "primary_window", $unit: "count", $used: 20, $limit: 100, $remaining: 80, $resetsOn: "legacy-cycle", $observedAt: observation.observedAtMs - 1, $generation: 1 };
    insertCurrent.run(sentinel);
    const legacyRows = old.query<unknown, []>("select * from subscription_usage_current");
    const before = legacyRows.all();
    store.dispose();

    const reopened = createUsageAuthority({ profileDir: root, profileId: "default", now: () => observation.observedAtMs });
    try {
      expect(reopened.dbFile).toBe(subscriptionUsageAuthorityDbFile(root));
      expect(reopened.incarnation()).toBe(incarnation);
      expect(reopened.trackingStart).toBe(trackingStart);
      expect(reopened.revision()).toBe(revision);
      expect(ledger.all()).toEqual(ledgerBefore);
      expect(legacyRows.all()).toEqual(before);
      expect(reopened.current(observation)).toBeUndefined();
      expect(reopened.record(observation).kind).toBe("committed");
      expect(legacyRows.all()).toEqual(before);
      expect(reopened.current(observation)?.metrics).toEqual(observation.metrics);
      expect(reopened.revision()).toBe(revision + 1);

      old.transaction(() => {
        old.query("update subscription_usage_snapshots set label = 'overlapping older report'").run();
        expect(deleteCurrent.run(accountBindings).changes).toBe(1);
        expect(insertCurrent.run({ ...sentinel, $remaining: 70 }).changes).toBe(1);
      }).immediate();
      expect(reopened.current(observation)?.label).toBe("overlapping older report");
      const afterOldWrite = legacyRows.all();
      expect(afterOldWrite).toEqual([expect.objectContaining({ remaining: 70 })]);
      expect(reopened.record({ ...observation, observedAtMs: observation.observedAtMs + 1 }).kind).toBe("committed");
      expect(legacyRows.all()).toEqual(afterOldWrite);
      expect(reopened.current(observation)?.label).toBeUndefined();
      expect(reopened.revision()).toBe(revision + 2);
      expect(ledger.all()).toEqual(ledgerBefore);
      expect(reopened.incarnation()).toBe(incarnation);
      expect(reopened.trackingStart).toBe(trackingStart);
      expect(reopened.append(entry())).toEqual({ kind: "duplicate" });
      expect(() => reopened.append(entry({ model: "different" }))).toThrow(UsageEntryConflictError);
    } finally {
      reopened.dispose();
      old.close();
    }
  });

  test("captures every current account window independently and uses the source-local quota index", () => {
    const { root, store } = authority(Date.parse("2025-01-20T00:00:00.000Z"));
    expect(() => store.append(entry({ attribution: { kind: "candidate", providerId: "chatgpt" }, spendMode: "included", classification: "subscription_equivalent" }))).toThrow("instance");
    store.append(entry({ occurredAt: "2025-01-02T12:00:00.000Z", attribution: { kind: "candidate", providerId: "chatgpt", instanceId: "account-a" }, spendMode: "included", classification: "subscription_equivalent", tokens: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 0 } }));
    store.append(entry({ attemptId: "00000000-0000-4000-8000-000000000003", attribution: { kind: "candidate", providerId: "chatgpt", instanceId: "account-a" }, spendMode: "included", classification: "subscription_equivalent", tokens: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 1 }, price: { kind: "unavailable", reason: "missing catalog price" } }));
    store.append(entry({ attemptId: "00000000-0000-4000-8000-000000000004", attribution: { kind: "candidate", providerId: "chatgpt", instanceId: "account-b" }, spendMode: "included", classification: "subscription_equivalent" }));
    store.record({ providerId: "chatgpt", instanceId: "account-a", identity: "subject-a", providerStatus: "ok", observedAtMs: Date.parse("2025-01-01T00:00:00.000Z"), metrics: [
      { metricKey: "short", label: "Short", scope: { kind: "account" }, rank: 0, timing: { kind: "exact", startMs: Date.parse("2025-01-10T00:00:00.000Z"), endMs: Date.parse("2025-01-21T00:00:00.000Z") }, usedFraction: 0.5 },
      { metricKey: "long", label: "Long", scope: { kind: "account" }, rank: 1, timing: { kind: "exact", startMs: Date.parse("2025-01-01T00:00:00.000Z"), endMs: Date.parse("2025-02-01T00:00:00.000Z") }, usedFraction: 0.25 },
      { metricKey: "unknown", label: "Unknown", scope: { kind: "account" }, rank: 2, timing: { kind: "unavailable", resetAtMs: Date.parse("2025-02-01T00:00:00.000Z") }, usedFraction: 0.1 },
      { metricKey: "feature", label: "Feature", scope: { kind: "feature", featureKey: "spark" }, rank: 3, timing: { kind: "exact", startMs: Date.parse("2025-01-01T00:00:00.000Z"), endMs: Date.parse("2025-02-01T00:00:00.000Z") }, usedFraction: 0.2 },
    ] });
    const result = store.accountsQuotaAccounting({ accounts: [{ sourceId: "chatgpt:a", providerId: "chatgpt", instanceId: "account-a", identity: "subject-a" }], asOf: Date.parse("2025-01-20T00:00:00.000Z") });
    expect(result).toMatchObject({ asOf: Date.parse("2025-01-20T00:00:00.000Z"), results: [{ sourceId: "chatgpt:a", quotaAccounting: { state: "available", windows: [
      { state: "available", metricKey: "short", attempts: 1, cacheReadTokens: 3, includedValueUsd: 0, priceUnavailable: true },
      { state: "available", metricKey: "long", attempts: 2, cacheReadTokens: 4, includedValueUsd: 0.25, priceUnavailable: true },
      { state: "window-unavailable", metricKey: "unknown" },
    ] } }] });
    expect(store.rangeEntries({ startMs: Date.parse("2025-01-15T12:00:00.000Z"), endMs: Date.parse("2025-01-15T12:00:00.001Z") }).groups.reduce((attempts, group) => attempts + group.attempts, 0)).toBe(2);
    expect(() => store.rangeEntries({ startMs: 1, endMs: 1 })).toThrow("range");

    const db = new Database(subscriptionUsageAuthorityDbFile(root));
    const plan = db.query<{ detail: string }, []>("explain query plan select count(*), sum(input_tokens) from usage_ledger where profile_id = 'default' and attribution_kind = 'candidate' and provider_id = 'chatgpt' and instance_id = 'account-a' and spend_mode = 'included' and classification = 'subscription_equivalent' and occurred_at_ms >= 0 and occurred_at_ms < 2000000000000").all().map(({ detail }) => detail).join(" ");
    expect(plan).toContain("usage_ledger_quota_idx");
    for (const term of ["profile_id=?", "attribution_kind=?", "provider_id=?", "instance_id=?", "spend_mode=?", "classification=?", "occurred_at_ms>?"]) expect(plan).toContain(term);
    db.close();
    store.dispose();
  });

  test("rejects non-finite estimated prices and rate-card values", () => {
    const { store } = authority();
    for (const invalid of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      expect(() => store.append(entry({ price: { kind: "priced", estimatedUsd: invalid, rateCard: { inputPerMillionUsd: 3 }, provenance: "live" } }))).toThrow();
      expect(() => store.append(entry({ price: { kind: "priced", estimatedUsd: 0.25, rateCard: { inputPerMillionUsd: invalid }, provenance: "live" } }))).toThrow();
    }
    expect(store.rangeEntries({ startMs: Date.parse("2025-01-01T00:00:00.000Z"), endMs: Date.parse("2025-02-01T00:00:00.000Z") }).groups).toEqual([]);
    store.dispose();
  });

  test("releases partial acquisition resources before a retry", () => {
    const root = mkdtempSync(join(tmpdir(), "usage-authority-retry-"));
    roots.push(root);
    expect(() => createUsageAuthority({
      profileDir: root,
      profileId: "default",
      now: () => { throw new Error("forced ledger acquisition failure"); },
    })).toThrow("forced ledger acquisition failure");

    rmSync(root, { recursive: true });
    mkdirSync(root, { recursive: true });
    const reopened = createUsageAuthority({ profileDir: root, profileId: "default" });
    expect(reopened.pendingAlerts({ providerId: "provider", instanceId: "instance", subjectDigest: `v1:${"0".repeat(64)}` }, 1)).toEqual([]);
    reopened.dispose();
  });

  test("runs the subscription migration once when opening the composed authority", () => {
    const migration = spyOn(subscriptionUsageMigration, "migrateSubscriptionUsageAuthority");
    const root = mkdtempSync(join(tmpdir(), "usage-authority-single-migration-"));
    roots.push(root);
    const store = createUsageAuthority({ profileDir: root, profileId: "default" });
    store.dispose();
    expect(migration).toHaveBeenCalledTimes(1);
    migration.mockRestore();
  });

  test("migrates the established v2 file in place and preserves profile observations", () => {
    const root = mkdtempSync(join(tmpdir(), "usage-authority-migration-"));
    roots.push(root);
    const file = subscriptionUsageAuthorityDbFile(root);
    const db = new Database(file, { create: true });
    db.exec("create table subscription_usage_authority (id integer primary key, protocol_version integer not null, profile_id text not null, revision integer not null); insert into subscription_usage_authority values (0, 2, 'default', 7); create table subscription_usage_snapshots (provider_id text, instance_id text, subject_digest text, primary key(provider_id, instance_id, subject_digest)); insert into subscription_usage_snapshots values ('p','i','s')");
    db.close();
    const trackingStart = Date.parse("2025-03-04T05:06:07.000Z");
    const store = createUsageAuthority({ profileDir: root, profileId: "default", now: () => trackingStart });
    store.dispose();
    const migrated = new Database(file);
    expect(migrated.query<{ protocol_version: number; revision: number; tracking_start: string }, []>("select protocol_version, revision, tracking_start from subscription_usage_authority").get()).toEqual({ protocol_version: 7, revision: 7, tracking_start: "2025-03-04T05:06:07.000Z" });
    expect(migrated.query<{ n: number }, []>("select count(*) as n from subscription_usage_snapshots").get()?.n).toBe(1);
    expect(migrated.query<{ name: string }, []>("select name from sqlite_master where type = 'table' and name = 'usage_in_flight'").get()).toBeNull();
    migrated.close();
  });

  test("migrates intermediate v3 ledger rows and removes the dead in-flight table", () => {
    const root = mkdtempSync(join(tmpdir(), "usage-authority-v3-"));
    roots.push(root);
    const file = subscriptionUsageAuthorityDbFile(root);
    const db = new Database(file, { create: true });
    const priorEntry = entry();
    const { currency: _currency, coverage: _coverage, ...v3Entry } = priorEntry;
    db.exec("create table subscription_usage_authority (id integer primary key, protocol_version integer not null, profile_id text not null, revision integer not null, tracking_start text not null); insert into subscription_usage_authority values (0, 3, 'default', 1, '2025-01-01T00:00:00.000Z'); create table usage_in_flight (attempt_id text primary key, owner text not null, lease_expires_at_ms integer not null)");
    db.exec(`create table usage_ledger (attempt_id text primary key, occurred_at_ms integer not null, profile_id text not null, classification text not null, input_tokens integer not null, output_tokens integer not null, cache_read_tokens integer not null, cache_write_tokens integer not null, reasoning_tokens integer not null, estimated_usd real, entry_json text not null)`);
    db.query("insert into usage_ledger values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(priorEntry.attemptId, Date.parse(priorEntry.occurredAt), priorEntry.profileId, priorEntry.classification, priorEntry.tokens.input, priorEntry.tokens.output, priorEntry.tokens.cacheRead, priorEntry.tokens.cacheWrite, priorEntry.tokens.reasoning, priorEntry.price.kind === "priced" ? priorEntry.price.estimatedUsd : null, JSON.stringify(v3Entry));
    db.close();

    const store = createUsageAuthority({ profileDir: root, profileId: "default", now: () => Date.parse("2025-01-20T00:00:00.000Z") });
    expect(store.append(priorEntry)).toEqual({ kind: "duplicate" });
    const incarnation = store.incarnation();
    expect(incarnation).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.rangeEntries({ startMs: Date.parse("2025-01-01T00:00:00.000Z"), endMs: Date.parse("2025-02-01T00:00:00.000Z") }).groups).toEqual([expect.objectContaining({ attempts: 1, estimatedUsd: 0.25 })]);
    store.dispose();

    const migrated = new Database(file);
    expect(migrated.query<{ protocol_version: number }, []>("select protocol_version from subscription_usage_authority").get()?.protocol_version).toBe(7);
    expect(migrated.query<{ name: string }, []>("select name from sqlite_master where type = 'table' and name = 'usage_in_flight'").get()).toBeNull();
    expect(JSON.parse(migrated.query<{ entry_json: string }, []>("select entry_json from usage_ledger").get()?.entry_json ?? "{}")).toMatchObject({ currency: "USD" });
    migrated.close();
    const reopened = createUsageAuthority({ profileDir: root, profileId: "default" });
    expect(reopened.incarnation()).toBe(incarnation);
    reopened.dispose();
  });

  test("migrates more than one page of v3 ledger rows", () => {
    const root = mkdtempSync(join(tmpdir(), "usage-authority-v3-pages-"));
    roots.push(root);
    const file = subscriptionUsageAuthorityDbFile(root);
    const db = new Database(file, { create: true });
    db.exec("create table subscription_usage_authority (id integer primary key, protocol_version integer not null, profile_id text not null, revision integer not null, tracking_start text not null); insert into subscription_usage_authority values (0, 3, 'default', 1, '2025-01-01T00:00:00.000Z')");
    db.exec("create table usage_ledger (attempt_id text primary key, occurred_at_ms integer not null, profile_id text not null, classification text not null, input_tokens integer not null, output_tokens integer not null, cache_read_tokens integer not null, cache_write_tokens integer not null, reasoning_tokens integer not null, estimated_usd real, entry_json text not null)");
    const insert = db.query("insert into usage_ledger values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (let index = 0; index < 129; index++) {
      const prior = entry({ attemptId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}` });
      const { currency: _currency, coverage: _coverage, ...v3Entry } = prior;
      insert.run(prior.attemptId, Date.parse(prior.occurredAt), prior.profileId, prior.classification, prior.tokens.input, prior.tokens.output, prior.tokens.cacheRead, prior.tokens.cacheWrite, prior.tokens.reasoning, prior.price.kind === "priced" ? prior.price.estimatedUsd : null, JSON.stringify(v3Entry));
    }
    db.close();

    const store = createUsageAuthority({ profileDir: root, profileId: "default" });
    store.dispose();
    const migrated = new Database(file);
    expect(migrated.query<{ count: number }, []>("select count(*) as count from usage_ledger where attribution_kind = 'candidate' and entry_json like '%\"currency\":\"USD\"%'").get()?.count).toBe(129);
    migrated.close();
  });

  test("rolls back the v3 ledger rebuild when a row is malformed", () => {
    const root = mkdtempSync(join(tmpdir(), "usage-authority-v3-rollback-"));
    roots.push(root);
    const file = subscriptionUsageAuthorityDbFile(root);
    const db = new Database(file, { create: true });
    const prior = entry();
    db.exec("create table subscription_usage_authority (id integer primary key, protocol_version integer not null, profile_id text not null, revision integer not null, tracking_start text not null); insert into subscription_usage_authority values (0, 3, 'default', 1, '2025-01-01T00:00:00.000Z')");
    db.exec("create table usage_ledger (attempt_id text primary key, occurred_at_ms integer not null, profile_id text not null, classification text not null, input_tokens integer not null, output_tokens integer not null, cache_read_tokens integer not null, cache_write_tokens integer not null, reasoning_tokens integer not null, estimated_usd real, entry_json text not null)");
    const { currency: _currency, coverage: _coverage, ...v3Entry } = prior;
    db.query("insert into usage_ledger values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(prior.attemptId, Date.parse(prior.occurredAt), prior.profileId, prior.classification, prior.tokens.input, prior.tokens.output, prior.tokens.cacheRead, prior.tokens.cacheWrite, prior.tokens.reasoning, 999, JSON.stringify(v3Entry));
    db.close();

    expect(() => createUsageAuthority({ profileDir: root, profileId: "default" })).toThrow("does not match its canonical entry");
    const unchanged = new Database(file);
    expect(unchanged.query<{ protocol_version: number }, []>("select protocol_version from subscription_usage_authority").get()?.protocol_version).toBe(3);
    expect(unchanged.query<{ name: string }, []>("select name from pragma_table_info('usage_ledger') where name = 'attribution_kind'").get()).toBeNull();
    expect(unchanged.query<{ estimated_usd: number }, []>("select estimated_usd from usage_ledger").get()?.estimated_usd).toBe(999);
    unchanged.close();
  });

  const HOUR_MS = 3_600_000;
  const at = (time: string) => Date.parse(`2025-01-15T${time}Z`);
  const ledgerEntries: UsageEntry[] = [
    entry({ attemptId: "00000000-0000-4000-8000-000000000101", occurredAt: "2025-01-15T10:00:00.000Z" }),
    entry({ attemptId: "00000000-0000-4000-8000-000000000102", occurredAt: "2025-01-15T10:45:00.000Z", price: { kind: "priced", estimatedUsd: 0.5, rateCard: {}, provenance: "live" } }),
    entry({ attemptId: "00000000-0000-4000-8000-000000000103", occurredAt: "2025-01-15T11:15:00.000Z", attribution: { kind: "unattributed" }, price: { kind: "unavailable", reason: "no rate card" } }),
    entry({ attemptId: "00000000-0000-4000-8000-000000000104", occurredAt: "2025-01-15T11:20:00.000Z", attribution: { kind: "unattributed" }, price: { kind: "priced", estimatedUsd: 0.125, rateCard: {}, provenance: "live" } }),
    entry({ attemptId: "00000000-0000-4000-8000-000000000105", occurredAt: "2025-01-15T12:30:00.000Z", attribution: { kind: "candidate", providerId: "chatgpt", instanceId: "account-a" }, spendMode: "included", classification: "subscription_equivalent" }),
    entry({ attemptId: "00000000-0000-4000-8000-000000000106", occurredAt: "2025-01-15T13:59:59.999Z", tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 4 } }),
    entry({ attemptId: "00000000-0000-4000-8000-000000000107", occurredAt: "2025-01-15T14:00:00.000Z", attribution: { kind: "unattributed" }, price: { kind: "unavailable", reason: "no rate card" } }),
    // Plain addition makes 0.1 + 0.1 + 0.1 + 0.005 into 0.30500000000000005, which shows a cent less than the compensated sum().
    ...([["108", "10:05", 0.1], ["109", "10:15", 0.1], ["110", "10:25", 0.1], ["111", "10:35", 0.005], ["112", "11:40", 0.1], ["113", "11:50", 0.005], ["114", "13:10", 0.1]] as const).map(([id, time, estimatedUsd]) =>
      entry({ attemptId: `00000000-0000-4000-8000-000000000${id}`, occurredAt: `2025-01-15T${time}:00.000Z`, model: "claude-haiku-4", price: { kind: "priced", estimatedUsd, rateCard: {}, provenance: "live" } })),
    unmeasured("00000000-0000-4000-8000-000000000115", "2025-01-15T10:20:00.000Z"),
    entry({ attemptId: "00000000-0000-4000-8000-000000000116", occurredAt: "2025-01-15T12:10:00.000Z", coverage: "partial" }),
    entry({ attemptId: "00000000-0000-4000-8000-000000000117", occurredAt: "2025-01-15T12:20:00.000Z", tokens: { input: 12, output: 5, cacheRead: null, cacheWrite: 0, reasoning: 0 } }),
  ];
  const ranges = [
    { name: "hour-aligned", startMs: at("10:00:00.000"), endMs: at("14:00:00.000") },
    { name: "non-aligned", startMs: at("10:30:00.000"), endMs: at("13:30:00.000") },
    { name: "sub-hour", startMs: at("10:10:00.000"), endMs: at("10:50:00.000") },
    { name: "two partial hours", startMs: at("10:30:00.000"), endMs: at("11:30:00.000") },
    { name: "whole day", startMs: at("00:00:00.000"), endMs: at("23:59:59.999") },
  ];

  interface ExpectedGroup {
    hourStartMs?: number; attributionKind: string; providerId?: string; instanceId?: string; spendMode: string; credentialLineage: string; model: string; classification: string;
    attempts: number; unmeasuredAttempts: number; partialAttempts: number; cacheComplete: boolean;
    inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; estimatedUsd: number; priceUnavailable: boolean;
  }

  /** The groups a plain GROUP BY over the given entries yields. Counts are
   *  summed here from the entries; USD is SQLite `sum()` over the group's
   *  ledger rows, which is what the read returned before the hourly summary. */
  function expectedGroups(dbFile: string, entries: readonly UsageEntry[], startMs: number, endMs: number, hourly: boolean): ExpectedGroup[] {
    const groups = new Map<string, { readonly group: Omit<ExpectedGroup, "estimatedUsd">; readonly attemptIds: string[] }>();
    for (const item of entries) {
      const occurredMs = Date.parse(item.occurredAt);
      if (occurredMs < startMs || occurredMs >= endMs) continue;
      const attribution = item.attribution.kind === "candidate"
        ? { providerId: item.attribution.providerId, ...(item.attribution.instanceId === undefined ? {} : { instanceId: item.attribution.instanceId }) }
        : {};
      const key = { ...(hourly ? { hourStartMs: Math.floor(occurredMs / HOUR_MS) * HOUR_MS } : {}), attributionKind: item.attribution.kind, ...attribution, spendMode: item.spendMode, credentialLineage: item.credentialLineage, model: item.model, classification: item.classification };
      const id = JSON.stringify(key);
      const found = groups.get(id) ?? { group: { ...key, attempts: 0, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, priceUnavailable: false }, attemptIds: [] };
      found.attemptIds.push(item.attemptId);
      groups.set(id, found);
      if (item.coverage === "unmeasured") {
        found.group.unmeasuredAttempts += 1;
        continue;
      }
      found.group.attempts += 1;
      if (item.coverage === "partial") found.group.partialAttempts += 1;
      if (item.tokens.cacheRead === null) found.group.cacheComplete = false;
      found.group.inputTokens += item.tokens.input;
      found.group.outputTokens += item.tokens.output;
      found.group.cacheReadTokens += item.tokens.cacheRead ?? 0;
      found.group.cacheWriteTokens += item.tokens.cacheWrite;
      found.group.reasoningTokens += item.tokens.reasoning;
      if (item.price.kind === "unavailable") found.group.priceUnavailable = true;
    }
    const ledger = new Database(dbFile, { readonly: true });
    const usd = ledger.query<{ usd: number }, [string]>("select coalesce(sum(estimated_usd), 0) usd from usage_ledger where attempt_id in (select value from json_each(?))");
    const expected = [...groups.values()].map(({ group, attemptIds }) => ({ ...group, estimatedUsd: usd.get(JSON.stringify(attemptIds))!.usd }));
    ledger.close();
    return byKey(expected);
  }
  function byKey(groups: readonly ExpectedGroup[]): ExpectedGroup[] {
    const key = (group: ExpectedGroup) => JSON.stringify([group.hourStartMs, group.attributionKind, group.providerId, group.instanceId, group.spendMode, group.model]);
    return groups.toSorted((left, right) => key(left).localeCompare(key(right)));
  }
  function expectReadsMatch(store: ReturnType<typeof createUsageAuthority>, entries: readonly UsageEntry[]) {
    for (const range of ranges) {
      const reads: readonly { readonly hourly: boolean; readonly groups: readonly UsageLedgerGroup[] }[] = [{ hourly: false, groups: store.rangeEntries(range).groups }, { hourly: true, groups: store.hourlySpend(range).groups }];
      for (const read of reads) {
        expect({ range: range.name, hourly: read.hourly, groups: byKey(read.groups) }).toEqual({ range: range.name, hourly: read.hourly, groups: expectedGroups(store.dbFile, entries, range.startMs, range.endMs, read.hourly) });
      }
    }
  }

  test("migrates a protocol 6 ledger without rewriting a row, to complete entries that a pre-upgrade checkpoint replays as duplicates", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-authority-v6-"));
    roots.push(root);
    const file = subscriptionUsageAuthorityDbFile(root);
    const priors = [entry(), entry({ attemptId: "00000000-0000-4000-8000-000000000009", occurredAt: "2025-01-15T13:00:00.000Z" })];
    writeProtocol6Ledger(file, priors);
    const storedRows = (db: Database) => db.query<unknown, []>("select rowid, attempt_id, hex(entry_json) entry_bytes from usage_ledger order by rowid").all();
    const protocol6 = new Database(file);
    const before = storedRows(protocol6);
    protocol6.close();

    const store = createUsageAuthority({ profileDir: root, profileId: "default", now: () => Date.parse("2025-01-20T00:00:00.000Z") });
    try {
      const opened = new Database(file, { readonly: true });
      expect(storedRows(opened)).toEqual(before);
      opened.close();
      // A settlement checkpoint written before the upgrade decodes to the same complete entry, so its replay is idempotent.
      for (const prior of priors) expect(store.append(prior)).toEqual({ kind: "duplicate" });
      expect(store.append(unmeasured("00000000-0000-4000-8000-00000000000a", "2025-01-15T14:00:00.000Z"))).toEqual({ kind: "appended" });
      const range = { startMs: Date.parse("2025-01-01T00:00:00.000Z"), endMs: Date.parse("2025-02-01T00:00:00.000Z") };
      expect(store.rangeEntries(range).groups).toEqual([expect.objectContaining({ attempts: 2, unmeasuredAttempts: 1, partialAttempts: 0, cacheComplete: true, inputTokens: 20 })]);
      expect(store.hourlySpend(range).groups.reduce((sum, group) => sum + group.unmeasuredAttempts, 0)).toBe(1);
      const unreported = entry({ attemptId: "00000000-0000-4000-8000-00000000000b", occurredAt: "2025-01-15T14:30:00.000Z", tokens: { input: 1, output: 1, cacheRead: null, cacheWrite: 0, reasoning: 0 } });
      expect(store.append(unreported)).toEqual({ kind: "appended" });
      expect(store.append(unreported)).toEqual({ kind: "duplicate" });
      const ledgerReads = { range: store.rangeEntries(range), hourly: store.hourlySpend(range) };
      expect(ledgerReads.range.groups).toEqual([expect.objectContaining({ attempts: 3, unmeasuredAttempts: 1, cacheComplete: false, inputTokens: 21, cacheReadTokens: 4 })]);
      await hourlySummaryBuilt(file);
      expect({ range: store.rangeEntries(range), hourly: store.hourlySpend(range) }).toEqual(ledgerReads);
    } finally {
      store.dispose();
    }
    const migrated = new Database(file);
    expect(migrated.query<{ protocol_version: number }, []>("select protocol_version from subscription_usage_authority").get()?.protocol_version).toBe(7);
    expect(migrated.query<{ coverage: string }, []>("select coverage from usage_ledger order by attempt_id").all().map(({ coverage }) => coverage)).toEqual(["complete", "complete", "unmeasured", "complete"]);
    expect(JSON.parse(migrated.query<{ entry_json: string }, []>("select entry_json from usage_ledger where attempt_id = '00000000-0000-4000-8000-00000000000b'").get()!.entry_json).tokens.cacheRead).toBeNull();
    expect(migrated.query<{ name: string }, []>("select name from sqlite_master where name like 'usage_ledger_hourly_v1%'").all()).toEqual([]);
    expect(migrated.query<{ name: string }, []>("select name from sqlite_master where type = 'index' and tbl_name = 'usage_ledger' and name like 'usage_ledger_%_idx' order by name").all().map(({ name }) => name)).toEqual(["usage_ledger_quota_idx", "usage_ledger_range_idx"]);
    migrated.close();
  });

  test("quota windows count unmeasured and partial attempts and report missing cache detail", () => {
    const { store } = authority(Date.parse("2025-01-20T00:00:00.000Z"));
    const included = { attribution: { kind: "candidate", providerId: "chatgpt", instanceId: "account-a" }, spendMode: "included", classification: "subscription_equivalent" } as const;
    store.append(entry({ ...included, tokens: { input: 4, output: 2, cacheRead: null, cacheWrite: 0, reasoning: 0 } }));
    store.append(entry({ ...included, attemptId: "00000000-0000-4000-8000-000000000003", coverage: "partial" }));
    store.append({ ...unmeasured("00000000-0000-4000-8000-000000000004", "2025-01-15T12:00:00.000Z"), ...included });
    store.record({ providerId: "chatgpt", instanceId: "account-a", identity: "subject-a", providerStatus: "ok", observedAtMs: Date.parse("2025-01-01T00:00:00.000Z"), metrics: [
      { metricKey: "long", label: "Long", scope: { kind: "account" }, rank: 0, timing: { kind: "exact", startMs: Date.parse("2025-01-01T00:00:00.000Z"), endMs: Date.parse("2025-02-01T00:00:00.000Z") }, usedFraction: 0.25 },
    ] });
    const result = store.accountsQuotaAccounting({ accounts: [{ sourceId: "chatgpt:a", providerId: "chatgpt", instanceId: "account-a", identity: "subject-a" }], asOf: Date.parse("2025-01-20T00:00:00.000Z") });
    expect(result.results[0]?.quotaAccounting).toMatchObject({ state: "available", windows: [{ metricKey: "long", attempts: 2, unmeasuredAttempts: 1, partialAttempts: 1, cacheComplete: false, inputTokens: 14 }] });
    store.dispose();
  });

  test("range and hourly reads equal a plain grouping of the ledger at whole and partial hours", () => {
    const { store } = authority();
    for (const item of ledgerEntries) store.append(item);
    expectReadsMatch(store, ledgerEntries);
    store.dispose();
  });

  test("range reads include a ledger row that an older writer inserts directly", () => {
    const { store } = authority();
    const [direct, ...appended] = ledgerEntries;
    for (const item of appended) store.append(item);
    const older = new Database(store.dbFile);
    older.query("insert into usage_ledger values ($attempt,$occurred,$profile,'candidate','anthropic_api',null,'direct_api',$lineage,$model,'real_spend',10,5,2,1,0,1,0.25,$json,'complete',0)").run({ $attempt: direct!.attemptId, $occurred: Date.parse(direct!.occurredAt), $profile: direct!.profileId, $lineage: direct!.credentialLineage, $model: direct!.model, $json: JSON.stringify(direct) });
    older.close();
    expectReadsMatch(store, ledgerEntries);
    store.dispose();
  });

  test("opening an authority whose ledger predates the hourly summary reads every recorded row before and after the summary is built", async () => {
    const { root, store } = authority();
    for (const item of ledgerEntries) store.append(item);
    const file = store.dbFile;
    store.dispose();
    const prior = new Database(file);
    prior.exec("drop trigger usage_ledger_hourly_v2_insert; drop table usage_ledger_hourly_v2; drop table usage_ledger_hourly_v2_backlog");
    prior.close();

    const reopened = createUsageAuthority({ profileDir: root, profileId: "default" });
    expectReadsMatch(reopened, ledgerEntries);
    await hourlySummaryBuilt(file);
    expectReadsMatch(reopened, ledgerEntries);
    reopened.dispose();
  });

  test("builds the hourly summary of a ledger larger than one build step to equal the ledger reads", async () => {
    const { root, store } = authority();
    store.append(entry());
    const file = store.dbFile;
    store.dispose();
    const prior = new Database(file);
    prior.exec("drop trigger usage_ledger_hourly_v2_insert; drop table usage_ledger_hourly_v2; drop table usage_ledger_hourly_v2_backlog");
    prior.exec("with recursive n(i) as (select 1 union all select i + 1 from n where i < 5000) insert into usage_ledger select printf('%s-%d', attempt_id, i), occurred_at_ms + i * 60000, profile_id, attribution_kind, provider_id, instance_id, spend_mode, credential_lineage, model, classification, input_tokens + i, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, price_available, estimated_usd * i / 7, entry_json, coverage, i % 2 from usage_ledger, n");
    prior.close();

    const reopened = createUsageAuthority({ profileDir: root, profileId: "default" });
    const range = { startMs: at("11:59:00.000"), endMs: Date.parse("2025-01-19T00:30:00.000Z") };
    const ledgerReads = { range: reopened.rangeEntries(range), hourly: reopened.hourlySpend(range) };
    expect(ledgerReads.range.groups).toEqual([expect.objectContaining({ attempts: 5001, cacheComplete: false })]);
    await hourlySummaryBuilt(file);
    expect({ range: reopened.rangeEntries(range), hourly: reopened.hourlySpend(range) }).toEqual(ledgerReads);
    reopened.dispose();
  });
});
