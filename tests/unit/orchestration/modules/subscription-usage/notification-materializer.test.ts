import { describe, expect, test } from "bun:test";
import type { SubscriptionUsageAlert } from "../../../../../src/infra/llm/usage-authority.js";
import { createSubscriptionUsageNotificationMaterializer } from "../../../../../src/orchestration/modules/subscription-usage/notification-materializer.js";
import type { NotificationEpisodeInput, NotificationOccurrence } from "../../../../../src/infra/notification-episode.js";

const alert: SubscriptionUsageAlert = {
  id: "alert-1",
  providerId: "github_copilot",
  instanceId: "account-a",
  subjectDigest: "v1:private-subject",
  metricName: "premium_interactions",
  accountLabel: "Work",
  metricLabel: "Premium interactions",
  distinctWindow: false,
  resetAtMs: 1_700_000_000_000 + 2 * 86_400_000,
  threshold: 70,
  value: 90,
  observedAtMs: 1_700_000_000_000,
  cycleKey: "reset:cycle-1",
  state: "claimed",
  fence: 1,
  claimOwner: "materializer",
  claimExpiresAtMs: 1_700_000_030_000,
  projectRoot: "/project-a",
};
const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

describe("subscription usage notification materializer", () => {
  test("states the episode before completing the claimed alert with its fence", async () => {
    let fence = 0;
    const completions: number[] = [];
    const raised = new Map<string, NotificationOccurrence>();
    const usageStore = {
      profileId: "profile-authority-a",
      pendingAlerts: () => [alert],
      claimAlert: () => ({ kind: "won" as const, alert: { ...alert, fence: ++fence } }),
      completeAlert: (input: { readonly fence: number }) => {
        completions.push(input.fence);
        return input.fence === fence;
      },
    };
    const notify = async (episode: NotificationEpisodeInput): Promise<void> => {
      if (episode.type !== "raise") throw new Error(`unexpected ${episode.type}`);
      expect(completions).toEqual([]);
      if (!raised.has(episode.occurrence.sourceId)) raised.set(episode.occurrence.sourceId, episode.occurrence);
    };
    const materializer = createSubscriptionUsageNotificationMaterializer({ usageStore, notify, projectRoot: "/project-a", owner: "materializer", providerName: () => "Copilot", now: () => alert.observedAtMs + 86_400_000, log: quietLog });

    expect(await materializer.materialize(alert.id)).toBe(true);
    expect(completions).toEqual([1]);
    expect(raised.size).toBe(1);
    const notification = [...raised.values()][0];
    if (!notification) throw new Error("expected a raised notification");
    expect(notification).toMatchObject({
      title: "Copilot usage",
      message: "Your Copilot subscription (Work) hit 70% usage, 1 day until reset.",
      severity: "alert",
      action: { kind: "open-usage" },
    });
    expect(notification.sourceId).not.toContain("private-subject");
  });

  test("drains full pending batches through the serialized materialization path", async () => {
    const pending = Array.from({ length: 35 }, (_, index) => ({ ...alert, id: `alert-${String(index).padStart(2, "0")}`, state: "open" as const }));
    const reads: number[] = [];
    const raised: string[] = [];
    const completed = new Set<string>();
    const usageStore = {
      profileId: "profile-authority-a",
      pendingAlerts: (_account: typeof alert, limit: number) => {
        reads.push(limit);
        return pending.filter(({ id }) => !completed.has(id)).slice(0, limit);
      },
      claimAlert: ({ alertId }: { readonly alertId: string }) => ({ kind: "won" as const, alert: { ...pending.find(({ id }) => id === alertId)!, state: "claimed" as const, fence: 1 } }),
      completeAlert: ({ alertId }: { readonly alertId: string }) => { completed.add(alertId); return true; },
    };
    const materializer = createSubscriptionUsageNotificationMaterializer({ notify: async (episode) => { if (episode.type === "raise") raised.push(episode.occurrence.sourceId); }, projectRoot: "/project-a", owner: "materializer", providerName: () => "Copilot", log: quietLog });

    await materializer.materializePending(usageStore, alert);
    await materializer.settled();

    expect(reads).toEqual([32, 32]);
    expect(completed.size).toBe(35);
    expect(raised).toHaveLength(35);
  });

  test("records a failed follow-on batch instead of leaving its rejection unhandled", async () => {
    const pending = Array.from({ length: 32 }, (_, index) => ({ ...alert, id: `alert-${index}`, state: "open" as const }));
    let reads = 0;
    const usageStore = {
      profileId: "profile-authority-a",
      pendingAlerts: () => {
        reads += 1;
        if (reads > 1) throw new Error("usage store closed");
        return pending;
      },
      claimAlert: ({ alertId }: { readonly alertId: string }) => ({ kind: "won" as const, alert: { ...pending.find(({ id }) => id === alertId)!, state: "claimed" as const, fence: 1 } }),
      completeAlert: () => true,
    };
    const warnings: string[] = [];
    const log = { ...quietLog, warn: (message?: unknown) => { warnings.push(String(message)); } };
    const materializer = createSubscriptionUsageNotificationMaterializer({ notify: async () => {}, projectRoot: "/project-a", owner: "materializer", providerName: () => "Copilot", log });

    await materializer.materializePending(usageStore, alert);
    await materializer.settled();

    expect(reads).toBe(2);
    expect(warnings).toEqual(["subscription-usage-notifications pending batch failed"]);
  });

  test("uses ChatGPT naming, distinct window labels, integer thresholds, and optional reset clauses", async () => {
    const raised: NotificationOccurrence[] = [];
    const alerts = [
      { ...alert, id: "primary", providerId: "chatgpt", metricName: "primary_window", metricLabel: "Primary window", distinctWindow: true, resetAtMs: alert.observedAtMs + 1, threshold: 70, value: 90, accountLabel: undefined },
      { ...alert, id: "secondary", providerId: "chatgpt", metricName: "secondary_window", metricLabel: "Secondary window", distinctWindow: true, resetAtMs: undefined, threshold: 87, value: 90, accountLabel: undefined },
    ];
    const usageStore = {
      profileId: "profile-authority-a",
      pendingAlerts: () => alerts,
      claimAlert: ({ alertId }: { readonly alertId: string }) => ({ kind: "won" as const, alert: alerts.find(({ id }) => id === alertId)! }),
      completeAlert: () => true,
    };
    const materializer = createSubscriptionUsageNotificationMaterializer({
      usageStore,
      notify: async (episode) => { if (episode.type === "raise") raised.push(episode.occurrence); },
      projectRoot: "/project-a",
      owner: "materializer",
      providerName: () => "ChatGPT",
      now: () => alert.observedAtMs,
      log: quietLog,
    });

    await materializer.materialize("primary");
    await materializer.materialize("secondary");

    expect(raised.map(({ message }) => message)).toEqual([
      "Your ChatGPT subscription hit 70% usage for Primary window, 1 day until reset.",
      "Your ChatGPT subscription hit 87% usage for Secondary window.",
    ]);
  });

  test("shutdown settlement waits for a pending notification append", async () => {
    const append = Promise.withResolvers<void>();
    let completed = false;
    const usageStore = {
      profileId: "profile-authority-a",
      pendingAlerts: () => [],
      claimAlert: () => ({ kind: "won" as const, alert }),
      completeAlert: () => { completed = true; return true; },
    };
    const materializer = createSubscriptionUsageNotificationMaterializer({
      notify: async (episode) => {
        if (episode.type !== "raise") throw new Error(`unexpected ${episode.type}`);
        await append.promise;
      },
      projectRoot: "/project-a",
      owner: "materializer",
      providerName: () => "Copilot",
      now: () => alert.observedAtMs,
      log: quietLog,
    });

    void materializer.materialize(usageStore, alert.id);
    materializer.closeAdmission();
    const settled = materializer.settled();
    let shutdownSettled = false;
    void settled.then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(completed).toBe(false);
    append.resolve();
    await settled;
    expect(completed).toBe(true);
  });
});
