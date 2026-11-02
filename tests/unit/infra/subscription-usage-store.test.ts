import { afterEach, describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SUBSCRIPTION_USAGE_HISTORY_HOUR_MS,
  SUBSCRIPTION_USAGE_HISTORY_RETENTION_MS,
  SubscriptionUsageProtocolError,
  createSubscriptionUsageStore,
  quotaSubjectDigest,
} from "../../../src/infra/llm/subscription-usage-store.js";
import { subscriptionUsageAuthorityDbFile } from "../../../src/infra/paths.js";
import { SubscriptionUsageSpendSourceSchema, type SubscriptionUsageReport, CHATGPT_RATE_LIMIT_RESET_TYPE } from "../../../src/infra/llm/subscription-usage.js";
import { CREATE_USAGE_LEDGER } from "../../../src/infra/llm/usage-authority-codec.js";
import { createUsageAuthority } from "../../../src/infra/llm/usage-authority.js";

const roots: string[] = [];
const ALL_HISTORY = { startMs: 0, endMs: Number.MAX_SAFE_INTEGER } as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function report(observedAtMs: number, remaining: number, resetsOn?: string, label?: string): SubscriptionUsageReport {
  return {
    providerId: "github_copilot",
    instanceId: "account-a",
    identity: "example-user",
    ...(label === undefined ? {} : { label }),
    providerStatus: "ok",
    observedAtMs,
    spendSources: [
      { kind: "prepaid", availability: "funded", remaining: { kind: "money", value: 12.5, currency: "USD", provenance: "provider", precision: "exact" }, resetId: "monthly", resetAtMs: observedAtMs + 1_000 },
      { kind: "automatic-billing", enablement: "enabled", used: { kind: "money", value: 2.5, currency: "USD", provenance: "provider", precision: "exact" }, limit: { kind: "money", value: 50, currency: "USD", provenance: "provider", precision: "exact" } },
    ],
    metrics: [{ metricKey: "premium_interactions", label: "Premium interactions", scope: { kind: "account" }, rank: 0, timing: { kind: "unavailable", ...(resetsOn === undefined ? {} : { resetId: resetsOn }) }, remaining: { kind: "count", value: remaining, unit: "interactions", provenance: "provider", precision: "exact" }, limit: { kind: "count", value: 100, unit: "interactions", provenance: "provider", precision: "exact" }, usedFraction: 1 - remaining / 100 }],
  };
}

function makeStore(now = 1_700_000_000_000) {
  const root = mkdtempSync(join(tmpdir(), "subscription-usage-unit-"));
  roots.push(root);
  return { root, now: () => now, store: createSubscriptionUsageStore({ profileDir: root, now: () => now }) };
}

describe("subscription usage authority", () => {
  test.each(["record", "completeFetch"] as const)("%s updates report evidence without writing legacy current rows", (method) => {
    const { store, now } = makeStore();
    const db = new Database(store.dbFile);
    try {
      const revision = store.revision();
      for (const [index, remaining] of [40, 10].entries()) {
        const observation = { ...report(now() + index * SUBSCRIPTION_USAGE_HISTORY_HOUR_MS, remaining), resetCredits: { availableCount: 1, credits: [{ id: "credit", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available", expiresAtMs: null }] } } as const;
        const claim = method === "completeFetch" ? store.claimFetch(observation) : undefined;
        if (claim !== undefined && claim.kind !== "won") throw new Error("fetch claim did not win");
        const committed = claim === undefined ? store.record(observation, [75]) : store.completeFetch(claim.lease, { kind: "success", report: observation }, [75]);
        expect(committed.kind).toBe("committed");
        expect(store.current(observation)).toEqual(committed.snapshot);
        expect(committed.snapshot).toMatchObject({ observedAtMs: observation.observedAtMs, readerGeneration: index + 1, metrics: observation.metrics, spendSources: observation.spendSources, resetCredits: observation.resetCredits });
        expect(store.history(observation, ALL_HISTORY)).toHaveLength(index + 1);
        expect(store.history(observation, ALL_HISTORY)[0]?.metrics).toEqual(observation.metrics);
        expect(store.revision()).toBe(revision + index + 1);
        expect(store.threshold(observation, "premium_interactions", 75)).toMatchObject({ lastValue: 100 - remaining, armed: index === 0 });
        expect(store.alerts(observation).map(({ threshold }) => threshold)).toEqual(index === 0 ? [] : [75]);
        expect(db.query<{ count: number }, []>("select count(*) as count from subscription_usage_current").get()?.count).toBe(0);
        if (claim !== undefined) expect(db.query<{ lease_expires_at: number }, []>("select lease_expires_at from subscription_usage_fetch_leases").get()?.lease_expires_at).toBe(0);
      }
    } finally {
      db.close();
      store.dispose();
    }
  });

  test("derives a versioned digest and commits a complete successful snapshot", () => {
    const { root, store } = makeStore();
    const committed = store.record(report(1_700_000_000_123, 42, "2024-01-01", "Example Account"));
    const key = store.accountKey({ providerId: "github_copilot", instanceId: "account-a", identity: "example-user" });

    expect(key.subjectDigest).toBe(quotaSubjectDigest("example-user"));
    expect(committed.snapshot.readerGeneration).toBe(1);
    expect(committed.snapshot.label).toBe("Example Account");
    expect(store.current(key)).toEqual(committed.snapshot);
    expect(store.history(key, ALL_HISTORY)).toHaveLength(1);
    expect(existsSync(subscriptionUsageAuthorityDbFile(root))).toBe(true);
    const expectedSpendSources = report(1_700_000_000_123, 42, "2024-01-01", "Example Account").spendSources;
    if (expectedSpendSources === undefined) throw new Error("fixture spend sources missing");
    expect(committed.snapshot.spendSources).toEqual(expectedSpendSources);
    store.dispose();
  });

  test("persists reset evidence and resumes one exact checkpoint after reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "subscription-usage-reset-")); roots.push(root);
    const authority = createUsageAuthority({ profileDir: root, profileId: "profile" });
    const resetReport = { ...report(1_700_000_000_123, 0), providerId: "chatgpt", instanceId: "chat", identity: "chat-user", resetCredits: { availableCount: 2, credits: [{ id: "later", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available", expiresAtMs: null }, { id: "first", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available", expiresAtMs: 10 }] } } as const;
    authority.record(resetReport);
    const revision = authority.revision(); const incarnation = authority.incarnation();
    const prepared = authority.prepareReset({ account: resetReport, expectedIncarnation: incarnation, expectedRevision: revision, actionId: "client-a", providerKey: "provider-a" });
    expect(prepared).toEqual({ kind: "prepared", checkpoint: expect.objectContaining({ creditId: "first", providerKey: "provider-a", actionId: "client-a" }) });
    authority.dispose();

    const reopened = createUsageAuthority({ profileDir: root, profileId: "profile" });
    const resumed = reopened.prepareReset({ account: resetReport, expectedIncarnation: incarnation, expectedRevision: revision, actionId: "client-b", providerKey: "provider-b" });
    expect(resumed).toEqual(prepared);
    if (resumed.kind !== "prepared") throw new Error("reset checkpoint did not reopen");
    expect(reopened.completeReset(resumed.checkpoint)).toBe(true);
    reopened.dispose();
  });

  test("migrates a version 5 authority before persisting reset evidence", () => {
    const { root, store } = makeStore();
    const committed = store.record(report(1_700_000_000_123, 42));
    store.dispose();
    const legacy = new Database(subscriptionUsageAuthorityDbFile(root));
    legacy.exec("update subscription_usage_authority set protocol_version = 5; drop table if exists subscription_usage_reset_in_flight; alter table subscription_usage_snapshots drop column reset_credits_json");
    legacy.close();

    const migrated = createUsageAuthority({ profileDir: root, profileId: root });
    expect(migrated.current(committed.snapshot)?.metrics).toEqual(committed.snapshot.metrics);
    const resetReport = { ...report(1_700_000_000_124, 0), providerId: "chatgpt", instanceId: "chat", identity: "chat-user", resetCredits: { availableCount: 1, credits: [{ id: "credit", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available", expiresAtMs: 1_800_000_000_000 }] } } as const;
    migrated.record(resetReport);
    migrated.dispose();

    const hinted = new Database(subscriptionUsageAuthorityDbFile(root));
    hinted.exec("update subscription_usage_snapshots set reset_credits_json = json_set(reset_credits_json, '$.applicableCount', 0) where reset_credits_json != 'null'");
    hinted.close();

    const reopened = createUsageAuthority({ profileDir: root, profileId: root });
    expect(reopened.current(resetReport)?.resetCredits).toEqual(resetReport.resetCredits);
    reopened.dispose();
  });

  test("commits reports monotonically and leaves equal conflicts byte-identical", () => {
    const { store } = makeStore();
    const first = report(1_700_000_000_100, 40, "cycle-a");
    expect(store.record(first).kind).toBe("committed");
    const revision = store.revision();
    const before = new Database(store.dbFile);
    const snapshotBefore = before.query<{ value: string }, []>("select hex(provider_id || instance_id || subject_digest || coalesce(label, '') || coalesce(plan, '') || coalesce(tier, '') || provider_status || observed_at || reader_generation || metrics_json || spend_sources_json) as value from subscription_usage_snapshots").get()?.value;
    const historyBefore = before.query<{ value: string }, []>("select hex(group_concat(provider_id || instance_id || subject_digest || hour_start || metrics_json || spend_sources_json, '|')) as value from subscription_usage_history").get()?.value;
    before.close();

    expect(store.record(report(first.observedAtMs - 1, 90)).kind).toBe("unchanged");
    expect(store.record(first).kind).toBe("unchanged");
    expect(store.record(report(first.observedAtMs, 39, "cycle-a")).kind).toBe("conflict");
    expect(store.revision()).toBe(revision);

    const after = new Database(store.dbFile);
    expect(after.query<{ value: string }, []>("select hex(provider_id || instance_id || subject_digest || coalesce(label, '') || coalesce(plan, '') || coalesce(tier, '') || provider_status || observed_at || reader_generation || metrics_json || spend_sources_json) as value from subscription_usage_snapshots").get()?.value).toBe(snapshotBefore);
    expect(after.query<{ value: string }, []>("select hex(group_concat(provider_id || instance_id || subject_digest || hour_start || metrics_json || spend_sources_json, '|')) as value from subscription_usage_history").get()?.value).toBe(historyBefore);
    after.close();

    expect(store.record(report(first.observedAtMs + 1, 30)).kind).toBe("committed");
    expect(store.current(store.accountKey({ providerId: first.providerId, instanceId: first.instanceId, identity: first.identity }))?.metrics[0]?.remaining?.value).toBe(30);
    store.dispose();
  });

  test("preserves allowance mode and decodes legacy metrics as unclassified", () => {
    const { store } = makeStore();
    const observedAtMs = 1_700_000_000_123;
    const committed = store.record({
      ...report(observedAtMs, 42),
      metrics: [{ metricKey: "ai_credits", label: "AI Credits", scope: { kind: "account" }, rank: 0, timing: { kind: "unavailable" }, allowanceMode: "finite", used: { kind: "count", value: 370, unit: "AI Credits", provenance: "provider", precision: "exact" }, limit: { kind: "count", value: 7000, unit: "AI Credits", provenance: "provider", precision: "exact" }, remaining: { kind: "count", value: 6629, unit: "AI Credits", provenance: "provider", precision: "exact" } }],
    });
    expect(committed.snapshot.metrics[0]?.allowanceMode).toBe("finite");
    expect(store.history(committed.snapshot, ALL_HISTORY)[0]?.metrics[0]?.allowanceMode).toBe("finite");

    const db = new Database(store.dbFile);
    db.query("update subscription_usage_snapshots set metrics_json = $metrics").run({ $metrics: JSON.stringify([{ metricKey: "ai_credits", label: "AI Credits", scope: { kind: "account" }, rank: 0, timing: { kind: "unavailable" }, used: { kind: "count", value: 1, unit: "AI Credits", provenance: "provider", precision: "exact" } }]) });
    db.close();
    expect(store.current(committed.snapshot)?.metrics[0]?.allowanceMode).toBe("unclassified");
    store.dispose();
  });

  test("preserves the last success and keeps one latest sample per hour", () => {
    const { store } = makeStore();
    const first = 1_700_000_000_000;
    store.record(report(first, 80));
    const failed = store.recordOutcome({ kind: "fetch-failure" });
    store.record(report(first + 10_000, 70));
    store.record(report(first + SUBSCRIPTION_USAGE_HISTORY_HOUR_MS, 60));

    expect(failed).toEqual({ kind: "ignored" });
    expect(store.current({ providerId: "github_copilot", instanceId: "account-a", subjectDigest: quotaSubjectDigest("example-user") })?.metrics[0]?.remaining?.value).toBe(60);
    expect(store.history({ providerId: "github_copilot", instanceId: "account-a", subjectDigest: quotaSubjectDigest("example-user") }, ALL_HISTORY)).toHaveLength(2);
    store.dispose();
  });

  test("filters retained history by exact half-open bounds before decoding", () => {
    const { store } = makeStore();
    const startMs = Math.floor(1_700_000_000_000 / SUBSCRIPTION_USAGE_HISTORY_HOUR_MS) * SUBSCRIPTION_USAGE_HISTORY_HOUR_MS;
    const endMs = startMs + 24 * SUBSCRIPTION_USAGE_HISTORY_HOUR_MS;
    const account = { providerId: "github_copilot", instanceId: "account-a", subjectDigest: quotaSubjectDigest("example-user") } as const;
    store.record(report(startMs - SUBSCRIPTION_USAGE_HISTORY_HOUR_MS, 90));
    store.record(report(startMs, 80));
    store.record(report(endMs - SUBSCRIPTION_USAGE_HISTORY_HOUR_MS, 20));
    store.record(report(endMs, 10));

    const db = new Database(store.dbFile);
    db.query("update subscription_usage_history set metrics_json = 'not-json' where hour_start < $start").run({ $start: startMs });
    db.close();

    expect(store.history(account, { startMs, endMs }).map((entry) => entry.hourStartMs)).toEqual([
      Math.floor((endMs - SUBSCRIPTION_USAGE_HISTORY_HOUR_MS) / SUBSCRIPTION_USAGE_HISTORY_HOUR_MS) * SUBSCRIPTION_USAGE_HISTORY_HOUR_MS,
      Math.floor(startMs / SUBSCRIPTION_USAGE_HISTORY_HOUR_MS) * SUBSCRIPTION_USAGE_HISTORY_HOUR_MS,
    ]);
    store.dispose();
  });
  test("normalizes contradictory prepaid observations to their declared availability", () => {
    expect(Schema.decodeUnknownSync(SubscriptionUsageSpendSourceSchema)({
      kind: "prepaid",
      availability: "empty",
      remaining: { kind: "money", value: 1, currency: "USD", provenance: "provider", precision: "exact" },
    })).toEqual({ kind: "prepaid", availability: "empty" });
  });

  test("preserves hourly history after reopening the profile authority", () => {
    const now = 1_700_000_000_000;
    const { root, store } = makeStore(now);
    const yesterday = now - 24 * SUBSCRIPTION_USAGE_HISTORY_HOUR_MS;
    store.record(report(yesterday, 80));
    store.dispose();

    const reopened = createSubscriptionUsageStore({ profileDir: root, now: () => now });
    try {
      expect(reopened.history({ providerId: "github_copilot", instanceId: "account-a", subjectDigest: quotaSubjectDigest("example-user") }, ALL_HISTORY)).toEqual([
        expect.objectContaining({
          hourStartMs: Math.floor(yesterday / SUBSCRIPTION_USAGE_HISTORY_HOUR_MS) * SUBSCRIPTION_USAGE_HISTORY_HOUR_MS,
          observedAtMs: yesterday,
          readerGeneration: 1,
          providerStatus: "ok",
          metrics: [expect.objectContaining({ metricKey: "premium_interactions", label: "Premium interactions", scope: { kind: "account" }, rank: 0, timing: { kind: "unavailable" }, remaining: expect.objectContaining({ value: 80 }) })],
        }),
      ]);
    } finally {
      reopened.dispose();
    }
  });

  test("rearms each threshold only after observed usage falls below it", () => {
    const { store } = makeStore();
    const account = { providerId: "github_copilot", instanceId: "account-a", identity: "example-user" } as const;
    store.record(report(1_700_000_000_000, 31, "2024-01-01"), [75, 90]);
    store.record(report(1_700_000_000_500, 26, "2024-01-01"), [75, 90]);
    store.record(report(1_700_000_001_000, 10, "2024-01-01"), [75, 90]);
    expect(store.alerts(account).map((alert) => alert.threshold)).toEqual([75, 90]);

    store.record(report(1_700_000_002_000, 10, "2024-02-01"), [75, 90]);
    expect(store.alerts(account)).toHaveLength(2);

    store.record(report(1_700_000_003_000, 50, "2024-02-01"), [75, 90]);
    store.record(report(1_700_000_004_000, 10, "2024-02-01"), [75, 90]);
    expect(store.alerts(account)).toHaveLength(4);
    store.dispose();
  });

  test("persists immutable notification context at the threshold crossing", () => {
    const { store } = makeStore();
    const observedAtMs = 1_700_000_000_000;
    const initial = {
      ...report(observedAtMs, 30, undefined, "Original account"),
      metrics: [
        { metricKey: "premium_interactions", label: "Original window", scope: { kind: "account" as const }, rank: 0, timing: { kind: "exact" as const, startMs: observedAtMs - 1, endMs: observedAtMs + 4 * 86_400_000 }, usedFraction: 0.7 },
        { metricKey: "secondary", label: "Secondary", scope: { kind: "account" as const }, rank: 1, timing: { kind: "unavailable" as const }, usedFraction: 0 },
      ],
    };
    store.record(initial, [75]);
    store.record({ ...initial, observedAtMs: observedAtMs + 1, metrics: [{ ...initial.metrics[0]!, usedFraction: 0.8 }, initial.metrics[1]!] });
    store.record({ ...initial, label: "Renamed account", observedAtMs: observedAtMs + 2, metrics: [{ ...initial.metrics[0]!, label: "Renamed window", timing: { kind: "exact", startMs: observedAtMs, endMs: observedAtMs + 10 * 86_400_000 }, usedFraction: 0.9 }, initial.metrics[1]!] });

    expect(store.alerts(initial)[0]).toMatchObject({
      accountLabel: "Original account",
      metricLabel: "Original window",
      distinctWindow: true,
      resetAtMs: observedAtMs + 4 * 86_400_000,
    });
    store.dispose();
  });

  test("replaces live thresholds without retroactive alerts and preserves retained state", () => {
    const { store } = makeStore();
    const account = { providerId: "github_copilot", instanceId: "account-a", identity: "example-user" } as const;
    store.record(report(1_700_000_000_000, 30), [75]);
    store.record(report(1_700_000_000_500, 20), [75]);
    expect(store.alerts(account).map((alert) => alert.threshold)).toEqual([75]);

    store.setThresholds(account, "premium_interactions", [75, 70, 90]);
    store.record(report(1_700_000_001_000, 10));
    expect(store.alerts(account).map((alert) => alert.threshold)).toEqual([90, 75]);
    store.setThresholds(account, "premium_interactions", [75, 70, 90]);
    store.record(report(1_700_000_001_500, 10));
    expect(store.alerts(account).map((alert) => alert.threshold)).toEqual([90, 75]);

    store.record(report(1_700_000_002_000, 40));
    store.record(report(1_700_000_003_000, 5));
    expect(store.alerts(account).map((alert) => alert.threshold).sort((left, right) => left - right)).toEqual([70, 75, 75, 90, 90]);
    store.dispose();
  });

  test("does not rearm a removed threshold when it is re-added above the boundary", () => {
    const { store } = makeStore();
    const account = { providerId: "github_copilot", instanceId: "account-a", identity: "example-user" } as const;
    store.record(report(1_700_000_000_000, 30), [75]);
    store.record(report(1_700_000_000_500, 20), [75]);
    store.record(report(1_700_000_001_000, 19), []);
    store.record(report(1_700_000_002_000, 18), [75]);
    expect(store.alerts(account).map((alert) => alert.threshold)).toEqual([75]);
    store.dispose();
  });

  test("does not rearm a crossed threshold when exact quota boundaries drift", () => {
    const { store } = makeStore();
    const account = { providerId: "github_copilot", instanceId: "account-a", identity: "example-user" } as const;
    const exact = (observedAtMs: number, remaining: number): SubscriptionUsageReport => ({
      ...report(observedAtMs, remaining),
      metrics: [{ ...report(observedAtMs, remaining).metrics[0]!, timing: { kind: "exact", startMs: observedAtMs - 10_000, endMs: observedAtMs + 10_000 } }],
    });
    store.record(exact(1_700_000_000_000, 31), [70, 90]);
    store.record(exact(1_700_000_001_000, 29), [70, 90]);
    store.record(exact(1_700_000_002_000, 10), [70, 90]);
    expect(store.alerts(account).map((alert) => alert.threshold)).toEqual([90, 70]);
    store.dispose();
  });

  test("alerts only after an observed below-to-threshold crossing", () => {
    const { store } = makeStore();
    const account = { providerId: "github_copilot", instanceId: "account-a", identity: "example-user" } as const;

    store.record(report(1_700_000_000_000, 13), [70]);
    expect(store.alerts(account)).toEqual([]);
    store.record(report(1_700_000_001_000, 30), [70]);
    store.record(report(1_700_000_002_000, 30.001), [70]);
    expect(store.alerts(account)).toEqual([]);
    store.record(report(1_700_000_003_000, 30), [70]);
    expect(store.alerts(account).map(({ threshold }) => threshold)).toEqual([70]);

    store.dispose();
  });

  test("tracks crossing baselines independently by account, metric, and window", () => {
    const { store } = makeStore();
    const first = { providerId: "github_copilot", instanceId: "account-a", identity: "example-user" } as const;
    const second = { providerId: "github_copilot", instanceId: "account-b", identity: "other-user" } as const;
    const multiMetricReport = (account: typeof first | typeof second, observedAtMs: number, primary: number, secondary: number): SubscriptionUsageReport => ({
      ...account,
      providerStatus: "ok",
      observedAtMs,
      spendSources: [],
      metrics: [
        { metricKey: "primary", label: "Primary window", scope: { kind: "account" }, rank: 0, timing: { kind: "exact", startMs: 0, endMs: 10_000 }, usedFraction: primary },
        { metricKey: "secondary", label: "Secondary window", scope: { kind: "account" }, rank: 1, timing: { kind: "exact", startMs: 0, endMs: 20_000 }, usedFraction: secondary },
      ],
    });

    store.record(multiMetricReport(first, 1_000, 0.69, 0.87), [70]);
    store.record(multiMetricReport(second, 1_000, 0.87, 0.69), [70]);
    store.record(multiMetricReport(first, 2_000, 0.70, 0.88), [70]);
    store.record(multiMetricReport(second, 2_000, 0.88, 0.70), [70]);

    expect(store.alerts(first).map(({ metricName }) => metricName)).toEqual(["primary"]);
    expect(store.alerts(second).map(({ metricName }) => metricName)).toEqual(["secondary"]);
    store.dispose();
  });

  test("preserves a below baseline and alert deduplication after restart", () => {
    const { root, store } = makeStore();
    const account = { providerId: "github_copilot", instanceId: "account-a", identity: "example-user" } as const;
    store.record(report(1_700_000_000_000, 31), [70]);
    store.dispose();

    const reopened = createSubscriptionUsageStore({ profileDir: root });
    reopened.record(report(1_700_000_001_000, 30), [70]);
    reopened.record(report(1_700_000_002_000, 29), [70]);
    expect(reopened.alerts(account)).toHaveLength(1);
    reopened.dispose();
  });

  test("keeps unbounded provider balances visible without creating alert crossings", () => {
    const { store } = makeStore();
    const account = { providerId: "github_copilot", instanceId: "account-a", identity: "example-user" } as const;
    store.record({ providerId: account.providerId, instanceId: account.instanceId, identity: account.identity, providerStatus: "ok", observedAtMs: 1_700_000_000_000, spendSources: [], metrics: [{ metricKey: "credits", label: "Credits", scope: { kind: "account" }, rank: 0, timing: { kind: "unavailable" }, used: { kind: "count", value: 12.5, unit: "credits", provenance: "provider", precision: "exact" } }] }, [75]);
    expect(store.current(account)?.metrics[0]?.used?.value).toBe(12.5);
    expect(store.crossedThresholds(account)).toEqual([]);
    expect(store.alerts(account)).toEqual([]);
    store.dispose();
  });

  test("reads a bounded deterministic pending alert batch without decoding delivered history", () => {
    const { store } = makeStore();
    const account = { providerId: "github_copilot", instanceId: "account-a", identity: "example-user" } as const;
    const key = store.accountKey(account);
    const db = new Database(store.dbFile);
    const insert = db.query("insert into subscription_usage_alerts (id, provider_id, instance_id, subject_digest, metric_name, threshold_value, value, observed_at, cycle_key, state, fence, claim_owner, claim_expires_at) values ($id, $provider, $instance, $subject, 'premium_interactions', 75, 90, $observedAt, $cycle, $state, 0, $owner, 0)");
    for (let index = 0; index < 100; index += 1) insert.run({ $id: `delivered-${index}`, $provider: key.providerId, $instance: key.instanceId, $subject: key.subjectDigest, $observedAt: index, $cycle: `delivered-${index}`, $state: "delivered", $owner: index === 0 ? new Uint8Array([1]) : null });
    for (const [id, observedAt] of [["pending-c", 3], ["pending-b", 2], ["pending-a", 2]] as const) insert.run({ $id: id, $provider: key.providerId, $instance: key.instanceId, $subject: key.subjectDigest, $observedAt: observedAt, $cycle: id, $state: "open", $owner: null });
    db.close();

    expect(store.pendingAlerts(account, 2).map(({ id }) => id)).toEqual(["pending-a", "pending-b"]);
    const source = new Database(store.dbFile);
    expect(source.query<{ name: string }, []>("select name from sqlite_master where type = 'index' and name = 'subscription_usage_alerts_pending_idx'").get()?.name).toBe("subscription_usage_alerts_pending_idx");
    source.close();
    store.dispose();
  });

  test("evolves old-shape v2 state in place and preserves exact rows", () => {
    const now = 1_700_000_000_000;
    const { root, store } = makeStore(now);
    const account = { providerId: "github_copilot", instanceId: "account-a", identity: "example-user" } as const;
    store.record(report(now - 1, 20, "cycle"), [90]);
    store.record(report(now, 10, "cycle"), [90]);
    const lease = store.claimFetch(account, { nowMs: now, leaseMs: 10_000, owner: "legacy-owner" });
    expect(lease.kind).toBe("won");
    store.dispose();

    const v2File = subscriptionUsageAuthorityDbFile(root);
    const legacy = new Database(v2File);
    legacy.exec("alter table subscription_usage_snapshots drop column spend_sources_json; alter table subscription_usage_history drop column spend_sources_json; alter table subscription_usage_alerts drop column project_root");
    legacy.close();

    const evolved = createSubscriptionUsageStore({ profileDir: root, now: () => now });
    const key = evolved.accountKey(account);
    expect(evolved.current(key)?.spendSources).toEqual([]);
    expect(evolved.history(key, ALL_HISTORY)[0]?.spendSources).toEqual([]);
    expect(evolved.thresholds(key)).toHaveLength(1);
    expect(evolved.alerts(key)).toHaveLength(1);
    expect(evolved.claimFetch(key, { nowMs: now, owner: "other" }).kind).toBe("lost");
    evolved.dispose();

    const source = new Database(v2File);
    expect(source.query<{ protocol_version: number }, []>("select protocol_version from subscription_usage_authority").get()?.protocol_version).toBe(7);
    expect(source.query<{ spend_sources_json: string }, []>("select spend_sources_json from subscription_usage_snapshots").get()?.spend_sources_json).toBe("[]");
    expect(source.query<{ spend_sources_json: string }, []>("select spend_sources_json from subscription_usage_history").get()?.spend_sources_json).toBe("[]");
    expect(source.query<{ project_root: string | null }, []>("select project_root from subscription_usage_alerts").get()?.project_root).toBeNull();
    source.exec(`
      insert into subscription_usage_snapshots (provider_id, instance_id, subject_digest, label, plan, tier, provider_status, observed_at, reader_generation, metrics_json)
      select provider_id, instance_id, 'legacy-writer', label, plan, tier, provider_status, observed_at, reader_generation, metrics_json from subscription_usage_snapshots limit 1;
      insert into subscription_usage_history (provider_id, instance_id, subject_digest, hour_start, label, plan, tier, provider_status, metrics_json, observed_at, reader_generation)
      select provider_id, instance_id, 'legacy-writer', hour_start, label, plan, tier, provider_status, metrics_json, observed_at, reader_generation from subscription_usage_history limit 1
    `);
    expect(source.query<{ spend_sources_json: string }, []>("select spend_sources_json from subscription_usage_snapshots where subject_digest = 'legacy-writer'").get()?.spend_sources_json).toBe("[]");
    expect(source.query<{ spend_sources_json: string }, []>("select spend_sources_json from subscription_usage_history where subject_digest = 'legacy-writer'").get()?.spend_sources_json).toBe("[]");
    source.close();
    expect(existsSync(join(root, "subscription-usage-authority-v3.sqlite"))).toBe(false);
  });

  test("migrates provider-owned metric identities and preserves unknown names", () => {
    const now = 1_700_000_000_000;
    const { root, store } = makeStore(now);
    const accounts = [
      { providerId: "chatgpt", instanceId: "chat", identity: "chat-user" },
      { providerId: "opencode_go", instanceId: "go", identity: "go-user" },
      { providerId: "github_copilot", instanceId: "copilot", identity: "copilot-user" },
      { providerId: "supergrok", instanceId: "grok", identity: "grok-user" },
    ] as const;
    for (const account of accounts) store.record({ ...account, providerStatus: "ok", observedAtMs: now, metrics: [{ metricKey: "placeholder", label: "Placeholder", scope: { kind: "account" }, rank: 0, timing: { kind: "unavailable" }, usedFraction: 0 }] });
    store.dispose();

    const legacyMetrics = (names: readonly string[]) => JSON.stringify(names.map((name) => ({ name, usedFraction: 0 })));
    const source = new Database(subscriptionUsageAuthorityDbFile(root));
    source.exec("update subscription_usage_authority set protocol_version = 4");
    const update = source.query("update subscription_usage_snapshots set metrics_json = ? where provider_id = ?");
    source.exec("delete from subscription_usage_history");
    update.run(legacyMetrics(["Primary window", "Secondary window", "reviews:primary_window", "reviews:secondary_window", "Odd / Meter"]), "chatgpt");
    update.run(legacyMetrics(["Rolling", "Weekly", "Monthly"]), "opencode_go");
    update.run(legacyMetrics(["Premium interactions", "AI Credits"]), "github_copilot");
    update.run(legacyMetrics(["Credits", "product:GrokBuild", "Monthly"]), "supergrok");
    source.close();

    const migrated = createSubscriptionUsageStore({ profileDir: root, now: () => now });
    expect(migrated.current(accounts[0])?.metrics).toEqual([
      expect.objectContaining({ metricKey: "primary_window", scope: { kind: "account" }, rank: 0 }),
      expect.objectContaining({ metricKey: "secondary_window", scope: { kind: "account" }, rank: 1 }),
      expect.objectContaining({ metricKey: "reviews:primary_window", scope: { kind: "feature", featureKey: "reviews" }, rank: 2 }),
      expect.objectContaining({ metricKey: "reviews:secondary_window", scope: { kind: "feature", featureKey: "reviews" }, rank: 3 }),
      expect.objectContaining({ metricKey: "legacy:Odd%20%2F%20Meter", scope: { kind: "account" }, rank: 4 }),
    ]);
    expect(migrated.current(accounts[1])?.metrics.map(({ metricKey }) => metricKey)).toEqual(["rolling", "weekly", "monthly"]);
    expect(migrated.current(accounts[2])?.metrics.map(({ metricKey }) => metricKey)).toEqual(["premium_interactions", "ai_credits"]);
    expect(migrated.current(accounts[3])?.metrics).toEqual([
      expect.objectContaining({ metricKey: "credits", scope: { kind: "account" } }),
      expect.objectContaining({ metricKey: "product:GrokBuild", scope: { kind: "feature", featureKey: "GrokBuild" } }),
      expect.objectContaining({ metricKey: "monthly", scope: { kind: "account" } }),
    ]);
    migrated.dispose();
  });

  test("fails strict reads for malformed spend sources after old-shape v2 evolution", () => {
    const now = 1_700_000_000_000;
    const { root, store } = makeStore(now);
    store.record(report(now, 10, "cycle"));
    store.dispose();

    const v2File = subscriptionUsageAuthorityDbFile(root);
    const legacy = new Database(v2File);
    legacy.exec("alter table subscription_usage_snapshots drop column spend_sources_json; alter table subscription_usage_history drop column spend_sources_json");
    legacy.close();

    const evolved = createSubscriptionUsageStore({ profileDir: root, now: () => now });
    evolved.dispose();
    const malformed = new Database(v2File);
    malformed.exec("update subscription_usage_snapshots set spend_sources_json = '{}'");
    malformed.close();

    const reopened = createSubscriptionUsageStore({ profileDir: root, now: () => now });
    expect(() => reopened.current({ providerId: "github_copilot", instanceId: "account-a", identity: "example-user" })).toThrow();
    reopened.dispose();
    expect(existsSync(join(root, "subscription-usage-authority-v3.sqlite"))).toBe(false);
  });

  test("fails closed on a foreign profile database", () => {
    const root = mkdtempSync(join(tmpdir(), "subscription-usage-foreign-"));
    roots.push(root);
    const dbFile = subscriptionUsageAuthorityDbFile(root);
    const db = new Database(dbFile);
    db.exec("create table foreign_writer (value text)");
    db.close();
    const store = createSubscriptionUsageStore({ profileDir: root });
    expect(() => store.current({ providerId: "github_copilot", instanceId: "account-a", subjectDigest: quotaSubjectDigest("example-user") })).toThrow(SubscriptionUsageProtocolError);
    store.dispose();
  });

  test("rejects an uninitialized supplied authority connection without migrating it", () => {
    const root = mkdtempSync(join(tmpdir(), "subscription-usage-embedded-empty-"));
    roots.push(root);
    const database = new Database(":memory:");
    const store = createSubscriptionUsageStore({ dbFile: join(root, "unused.sqlite"), profileId: "default", database });
    expect(() => store.revision()).toThrow("missing tables");
    expect(database.query<{ count: number }, []>("select count(*) as count from sqlite_master where type = 'table'").get()?.count).toBe(0);
    store.dispose();
    database.close();
  });

  test("rejects a wrong-version supplied authority connection without migrating it", () => {
    const root = mkdtempSync(join(tmpdir(), "subscription-usage-embedded-version-"));
    roots.push(root);
    const standalone = createSubscriptionUsageStore({ profileDir: root, profileId: "default" });
    standalone.dispose();
    const database = new Database(subscriptionUsageAuthorityDbFile(root));
    database.exec("update subscription_usage_authority set protocol_version = 4");
    const store = createSubscriptionUsageStore({ dbFile: join(root, "unused.sqlite"), profileId: "default", database });
    expect(() => store.revision()).toThrow(SubscriptionUsageProtocolError);
    expect(database.query<{ protocol_version: number }, []>("select protocol_version from subscription_usage_authority").get()?.protocol_version).toBe(4);
    store.dispose();
    database.close();
  });

  test("prunes only hourly history older than ninety days", () => {
    const now = 1_700_000_000_000;
    const { store } = makeStore(now);
    const ledger = new Database(store.dbFile);
    ledger.exec(CREATE_USAGE_LEDGER);
    ledger.query("insert into usage_ledger (attempt_id, occurred_at_ms, profile_id, attribution_kind, provider_id, instance_id, spend_mode, credential_lineage, model, classification, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, price_available, estimated_usd, entry_json) values ('old-attempt', 0, 'profile', 'unattributed', null, null, 'direct_api', 'credential', 'model', 'real_spend', 0, 0, 0, 0, 0, 0, null, '{}')").run();
    ledger.close();
    const old = now - SUBSCRIPTION_USAGE_HISTORY_RETENTION_MS - SUBSCRIPTION_USAGE_HISTORY_HOUR_MS;
    store.record(report(old, 90));
    store.record(report(now, 10));
    expect(store.history({ providerId: "github_copilot", instanceId: "account-a", subjectDigest: quotaSubjectDigest("example-user") }, ALL_HISTORY)).toHaveLength(1);
    const reopened = new Database(store.dbFile);
    expect(reopened.query<{ count: number }, []>("select count(*) as count from usage_ledger").get()?.count).toBe(1);
    reopened.close();
    store.dispose();
  });
});

describe("subscription usage alert project ownership", () => {
  test("binds a historical unbound alert once and preserves ownership after restart", () => {
    const projectA = resolve("/project-a");
    const projectB = resolve("/project-b");
    const { root, now, store } = makeStore();
    const account = { providerId: "github_copilot", instanceId: "account-a", identity: "example-user" };
    store.record(report(now() - 1, 30), [75]);
    store.record(report(now(), 10), [75]);
    const alert = store.alerts(account)[0];
    if (!alert) throw new Error("threshold alert was not committed");

    const first = store.claimAlert({ alertId: alert.id, projectRoot: projectA, owner: "first", nowMs: now(), leaseMs: 1 });
    expect(first.kind).toBe("won");
    if (first.kind !== "won") throw new Error("alert claim did not win");
    expect(first.alert.projectRoot).toBe(projectA);
    store.dispose();

    const reopened = createSubscriptionUsageStore({ profileDir: root, now });
    expect(reopened.claimAlert({ alertId: alert.id, projectRoot: projectB, owner: "second", nowMs: now() + 2 }).kind).toBe("lost");
    const reclaimed = reopened.claimAlert({ alertId: alert.id, projectRoot: projectA, owner: "replacement", nowMs: now() + 2 });
    expect(reclaimed.kind).toBe("won");
    if (reclaimed.kind !== "won") throw new Error("bound project did not reclaim alert");
    expect(reopened.completeAlert({ alertId: alert.id, fence: first.alert.fence, owner: "first", nowMs: now() + 2 })).toBe(false);
    expect(reopened.completeAlert({ alertId: alert.id, fence: reclaimed.alert.fence, owner: "replacement", nowMs: now() + 2 })).toBe(true);
    reopened.dispose();
  });
});
