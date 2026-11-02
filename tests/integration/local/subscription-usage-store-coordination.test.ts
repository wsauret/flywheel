import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSubscriptionUsageStore,
  quotaSubjectDigest,
  type SubscriptionUsageAccount,
} from "../../../src/infra/llm/subscription-usage-store.js";
import { Database } from "bun:sqlite";
import { subscriptionUsageAuthorityDbFile } from "../../../src/infra/paths.js";
import type { SubscriptionUsageOutcome, SubscriptionUsageReport } from "../../../src/infra/llm/subscription-usage.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const account: SubscriptionUsageAccount = { providerId: "github_copilot", instanceId: "account-a", identity: "example-user" };

function success(observedAtMs: number, remaining: number): Extract<SubscriptionUsageOutcome, { kind: "success" }> {
  const report: SubscriptionUsageReport = {
    providerId: account.providerId,
    instanceId: account.instanceId,
    identity: account.identity ?? "",
    providerStatus: "ok",
    observedAtMs,
    metrics: [{ metricKey: "premium_interactions", label: "Premium interactions", scope: { kind: "account" }, rank: 0, timing: { kind: "unavailable" }, remaining: { kind: "count", value: remaining, unit: "interactions", provenance: "provider", precision: "exact" }, limit: { kind: "count", value: 100, unit: "interactions", provenance: "provider", precision: "exact" }, usedFraction: 1 - remaining / 100 }],
  };
  return { kind: "success", report };
}

async function awaitChildren(children: Bun.Subprocess<"pipe", "pipe", "pipe">[]): Promise<Array<{ exitCode: number; stdout: string; stderr: string }>> {
  const timeout = Bun.sleep(2_000).then(() => "timeout" as const);
  const completed = Promise.all(children.map(async (child) => ({
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  })));
  const result = await Promise.race([completed, timeout]);
  if (result === "timeout") {
    for (const child of children) child.kill(9);
    await Promise.all(children.map((child) => child.exited));
    throw new Error("subscription usage schema evolution children timed out");
  }
  return result;
}

describe("profile-local subscription usage coordination", () => {
  test("serializes concurrent additive evolution of one old-shape v2 authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "subscription-usage-evolution-"));
    roots.push(root);
    const now = 1_700_000_000_000;
    const seeded = createSubscriptionUsageStore({ profileDir: root, now: () => now });
    seeded.record(success(now, 20).report, [90]);
    seeded.record(success(now + 1, 10).report, [90]);
    seeded.dispose();

    const authorityFile = subscriptionUsageAuthorityDbFile(root);
    const blocker = new Database(authorityFile);
    blocker.exec("alter table subscription_usage_snapshots drop column spend_sources_json; alter table subscription_usage_history drop column spend_sources_json; alter table subscription_usage_alerts drop column project_root; alter table subscription_usage_alerts drop column account_label; alter table subscription_usage_alerts drop column metric_label; alter table subscription_usage_alerts drop column distinct_window; alter table subscription_usage_alerts drop column reset_at; begin immediate");

    const storeUrl = new URL("../../../src/infra/llm/subscription-usage-store.ts", import.meta.url).href;
    const childScript = `
      const { createSubscriptionUsageStore } = await import(process.env.STORE_URL);
      await Bun.write(process.env.READY_FILE, "ready");
      await Bun.stdin.text();
      const store = createSubscriptionUsageStore({ profileDir: process.env.PROFILE_DIR });
      const current = store.current({ providerId: "github_copilot", instanceId: "account-a", identity: "example-user" });
      store.dispose();
      console.log(JSON.stringify({ opened: true, remaining: current?.metrics[0]?.remaining?.value, spendSources: current?.spendSources }));
    `;
    const children = Array.from({ length: 2 }, (_, index) => Bun.spawn({
      cmd: [process.execPath, "--conditions=browser", "-e", childScript],
      env: { ...process.env, PROFILE_DIR: root, READY_FILE: join(root, `child-${index}.ready`), STORE_URL: storeUrl },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    }));
    const readinessDeadline = Date.now() + 1_000;
    while (![0, 1].every((index) => existsSync(join(root, `child-${index}.ready`)))) {
      if (Date.now() >= readinessDeadline) {
        for (const child of children) child.kill(9);
        await Promise.all(children.map((child) => child.exited));
        throw new Error("subscription usage schema evolution children did not become ready");
      }
      await Bun.sleep(5);
    }
    for (const child of children) child.stdin.end();
    await Bun.sleep(50);
    blocker.exec("commit");
    blocker.close();

    const results = await awaitChildren(children);
    expect(results.map(({ exitCode }) => exitCode)).toEqual([0, 0]);
    for (const result of results) {
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ opened: true, remaining: 10, spendSources: [] });
    }

    const source = new Database(authorityFile);
    for (const [table, column] of [
      ["subscription_usage_snapshots", "spend_sources_json"],
      ["subscription_usage_history", "spend_sources_json"],
      ["subscription_usage_alerts", "project_root"],
      ["subscription_usage_alerts", "account_label"],
      ["subscription_usage_alerts", "metric_label"],
      ["subscription_usage_alerts", "distinct_window"],
      ["subscription_usage_alerts", "reset_at"],
    ] as const) {
      const columns = source.query<{ name: string }, []>(`pragma table_info(${table})`).all();
      expect(columns.filter(({ name }) => name === column)).toHaveLength(1);
    }
    expect(source.query<{ spend_sources_json: string }, []>("select spend_sources_json from subscription_usage_snapshots").get()?.spend_sources_json).toBe("[]");
    expect(source.query<{ spend_sources_json: string }, []>("select spend_sources_json from subscription_usage_history").get()?.spend_sources_json).toBe("[]");
    expect(source.query<{ project_root: string | null }, []>("select project_root from subscription_usage_alerts").get()?.project_root).toBeNull();
    expect(source.query<{ account_label: string | null; metric_label: string | null; distinct_window: number | null; reset_at: number | null }, []>("select account_label, metric_label, distinct_window, reset_at from subscription_usage_alerts").get()).toEqual({ account_label: null, metric_label: null, distinct_window: null, reset_at: null });
    source.close();
    expect(existsSync(join(root, "subscription-usage-authority-v3.sqlite"))).toBe(false);

    const reopened = createSubscriptionUsageStore({ profileDir: root });
    expect(reopened.current(account)?.metrics[0]?.remaining?.value).toBe(10);
    reopened.dispose();
  });

  test("joins same-process refreshes and performs one provider read", async () => {
    const root = mkdtempSync(join(tmpdir(), "subscription-usage-join-"));
    roots.push(root);
    let reads = 0;
    const first = createSubscriptionUsageStore({ profileDir: root, freshnessMs: 0 });
    const second = first.fetch(account, async () => {
      reads += 1;
      await Bun.sleep(10);
      return success(1_700_000_000_000, 40);
    }, { forceRefresh: true });
    const joined = first.fetch(account, async () => {
      reads += 1;
      return success(1_700_000_000_001, 30);
    }, { forceRefresh: true });

    expect(await Promise.all([second, joined])).toEqual([await first.current(first.accountKey(account)), await first.current(first.accountKey(account))]);
    expect(reads).toBe(1);
    first.dispose();
  });

  test("a waiting process adopts the committed reader generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "subscription-usage-wait-"));
    roots.push(root);
    const nowMs = 1_700_000_000_000;
    const first = createSubscriptionUsageStore({ profileDir: root, now: () => nowMs, freshnessMs: 0 });
    const second = createSubscriptionUsageStore({ profileDir: root, now: () => nowMs, freshnessMs: 0 });
    const key = first.accountKey(account);
    const lease = first.claimFetch(key, { nowMs, leaseMs: 100 });
    if (lease.kind !== "won") throw new Error("first claim did not win");
    const waiting = second.acquireFetch(key, { deadlineMs: nowMs + 1_000, leaseMs: 100 });
    expect(first.completeFetch(lease.lease, success(nowMs, 40)).kind).toBe("committed");
    expect(await waiting).toBeUndefined();
    expect(second.current(key)?.readerGeneration).toBe(1);
    first.dispose();
    second.dispose();
  });

  test("applies the same monotonic comparison to direct and leased writes", () => {
    const root = mkdtempSync(join(tmpdir(), "subscription-usage-monotonic-"));
    roots.push(root);
    const nowMs = 1_700_000_000_000;
    const store = createSubscriptionUsageStore({ profileDir: root, now: () => nowMs });
    const key = store.accountKey(account);
    expect(store.record(success(nowMs, 40).report).kind).toBe("committed");
    const revision = store.revision();

    const olderLease = store.claimFetch(key, { nowMs, leaseMs: 100 });
    if (olderLease.kind !== "won") throw new Error("older lease did not win");
    expect(store.completeFetch(olderLease.lease, success(nowMs - 1, 30)).kind).toBe("unchanged");
    expect(store.revision()).toBe(revision);

    const conflictLease = store.claimFetch(key, { nowMs, leaseMs: 100 });
    if (conflictLease.kind !== "won") throw new Error("conflict lease did not win");
    expect(store.completeFetch(conflictLease.lease, success(nowMs, 30)).kind).toBe("conflict");
    expect(store.revision()).toBe(revision);
    expect(store.current(key)?.metrics[0]?.remaining?.value).toBe(40);
    store.dispose();
  });

  test("losing process waits outside the write transaction and fenced stale results cannot publish", async () => {
    const root = mkdtempSync(join(tmpdir(), "subscription-usage-fence-"));
    roots.push(root);
    let nowMs = 1_700_000_000_000;
    const first = createSubscriptionUsageStore({ profileDir: root, now: () => nowMs, freshnessMs: 0 });
    const second = createSubscriptionUsageStore({ profileDir: root, now: () => nowMs, freshnessMs: 0 });
    const key = first.accountKey(account);
    const lease = first.claimFetch(key, { nowMs, leaseMs: 5 });
    expect(lease.kind).toBe("won");
    if (lease.kind !== "won") throw new Error("first claim did not win");

    nowMs += 6;
    const replacement = second.claimFetch(key, { nowMs, leaseMs: 1_000 });
    expect(replacement.kind).toBe("won");
    if (replacement.kind !== "won") throw new Error("replacement claim did not win");

    expect(first.completeFetch(lease.lease, success(nowMs, 1)).kind).toBe("rejected");
    expect(second.completeFetch(replacement.lease, success(nowMs, 40)).kind).toBe("committed");
    expect(second.current(key)?.metrics[0]?.remaining?.value).toBe(40);
    expect(quotaSubjectDigest(account.identity ?? "")).toBe(key.subjectDigest);
    first.dispose();
    second.dispose();
  });

  test("threshold alerts are fenced across success, release, expiry, and retry", () => {
    const root = mkdtempSync(join(tmpdir(), "subscription-usage-alert-flow-"));
    roots.push(root);
    let nowMs = 1_700_000_000_000;
    const store = createSubscriptionUsageStore({ profileDir: root, now: () => nowMs });
    store.recordOutcome(success(nowMs, 30), [75]);
    store.recordOutcome(success(++nowMs, 10), [75]);
    const firstAlert = store.alerts(account)[0];
    expect(firstAlert?.threshold).toBe(75);
    if (!firstAlert) throw new Error("threshold alert was not committed");

    const delivered = store.claimAlert({ alertId: firstAlert.id, projectRoot: "/project-a", nowMs, leaseMs: 10, owner: "runtime" });
    expect(delivered.kind).toBe("won");
    if (delivered.kind !== "won") throw new Error("alert claim did not win");
    expect(store.completeAlert({ alertId: firstAlert.id, fence: delivered.alert.fence, owner: "runtime", nowMs })).toBe(true);
    expect(store.alerts(account)[0]?.state).toBe("delivered");

    store.recordOutcome(success(++nowMs, 100), [75]);
    store.recordOutcome(success(++nowMs, 10), [75]);
    const retryAlert = store.alerts(account).find((alert) => alert.state === "open");
    if (!retryAlert) throw new Error("retry alert was not committed");
    const failed = store.claimAlert({ alertId: retryAlert.id, projectRoot: "/project-a", nowMs, leaseMs: 10, owner: "runtime" });
    if (failed.kind !== "won") throw new Error("failed alert claim did not win");
    expect(store.releaseAlert({ alertId: retryAlert.id, fence: failed.alert.fence, owner: "runtime", nowMs })).toBe(true);
    expect(store.alerts(account).find((alert) => alert.id === retryAlert.id)?.state).toBe("open");

    const leased = store.claimAlert({ alertId: retryAlert.id, projectRoot: "/project-a", nowMs, leaseMs: 5, owner: "first-runtime" });
    if (leased.kind !== "won") throw new Error("leased alert claim did not win");
    nowMs += 6;
    const reclaimed = store.claimAlert({ alertId: retryAlert.id, projectRoot: "/project-a", nowMs, leaseMs: 10, owner: "second-runtime" });
    expect(reclaimed.kind).toBe("won");
    if (reclaimed.kind !== "won") throw new Error("expired alert was not reclaimed");
    expect(reclaimed.alert.fence).toBeGreaterThan(leased.alert.fence);
    expect(store.completeAlert({ alertId: retryAlert.id, fence: leased.alert.fence, owner: "first-runtime", nowMs })).toBe(false);
    expect(store.completeAlert({ alertId: retryAlert.id, fence: reclaimed.alert.fence, owner: "second-runtime", nowMs })).toBe(true);
    expect(store.claimAlert({ alertId: retryAlert.id, projectRoot: "/project-b", nowMs: nowMs + 20, owner: "other-project" }).kind).toBe("lost");
    store.dispose();
  });
});
