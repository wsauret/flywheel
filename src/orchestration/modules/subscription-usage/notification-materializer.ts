import { createHash } from "node:crypto";
import type { SubscriptionUsageAccountRef, UsageAuthority } from "../../../infra/llm/usage-authority.js";
import type { NotificationEpisodeInput } from "../../../infra/notification-episode.js";
import { createBackgroundLane } from "../../../infra/ordered-lane.js";
import type { OperationLogger } from "../../../infra/operation-log.js";

const MATERIALIZATION_BATCH_SIZE = 32;
const DAY_MS = 24 * 60 * 60_000;
type NotificationMaterializerUsageStore = Pick<UsageAuthority, "profileId" | "pendingAlerts" | "claimAlert" | "completeAlert">;

interface SubscriptionUsageNotificationMaterializerDeps {
  readonly usageStore?: NotificationMaterializerUsageStore;
  /** The notify seam (ARCH-STRUCTURE-040): it settles once the journal has committed the episode, and the alert completes only then. */
  readonly notify: (episode: NotificationEpisodeInput) => Promise<void>;
  readonly projectRoot: string;
  readonly owner: string;
  readonly providerName: (providerId: string) => string;
  readonly leaseMs?: number;
  readonly now?: () => number;
  /** Records the failure of a pending batch that no caller awaits. */
  readonly log: OperationLogger;
}

export interface SubscriptionUsageNotificationMaterializer {
  materialize(alertId: string): Promise<boolean>;
  materialize(usageStore: NotificationMaterializerUsageStore, alertId: string): Promise<boolean>;
  materializePending(usageStore: NotificationMaterializerUsageStore, account: SubscriptionUsageAccountRef): Promise<void>;
  closeAdmission(): void;
  settled(): Promise<void>;
}

function notificationSourceId(profileId: string, alertId: string): string {
  const digest = createHash("sha256").update(profileId, "utf8").update("\0").update(alertId, "utf8").digest("hex");
  return `subscription-usage:${digest}`;
}

function notificationCopy(alert: import("../../../infra/llm/usage-authority.js").SubscriptionUsageAlert, providerName: string, nowMs: number): string {
  const account = alert.accountLabel ? ` (${alert.accountLabel})` : "";
  const window = alert.distinctWindow === true && alert.metricLabel !== undefined ? ` for ${alert.metricLabel}` : "";
  const days = alert.resetAtMs === undefined ? undefined : Math.max(0, Math.ceil((alert.resetAtMs - nowMs) / DAY_MS));
  const reset = days === undefined ? "" : `, ${days} ${days === 1 ? "day" : "days"} until reset`;
  return `Your ${providerName} subscription${account} hit ${Math.round(alert.threshold)}% usage${window}${reset}.`;
}

/** Serializes raise-before-complete delivery and owns every admitted operation through shutdown. */
export function createSubscriptionUsageNotificationMaterializer(deps: SubscriptionUsageNotificationMaterializerDeps): SubscriptionUsageNotificationMaterializer {
  const now = deps.now ?? Date.now;
  let accepting = true;
  const lane = createBackgroundLane(deps.log, "subscription-usage-notifications");

  async function materializeOne(usageStore: NotificationMaterializerUsageStore, alertId: string): Promise<boolean> {
    const claim = usageStore.claimAlert({ alertId, projectRoot: deps.projectRoot, owner: deps.owner, leaseMs: deps.leaseMs });
    if (claim.kind === "lost") return false;
    const alert = claim.alert;
    const providerName = deps.providerName(alert.providerId);
    await deps.notify({ type: "raise", occurrence: {
      sourceId: notificationSourceId(usageStore.profileId, alert.id),
      title: `${providerName} usage`,
      message: notificationCopy(alert, providerName, now()),
      severity: "alert",
      action: { kind: "open-usage" },
    } });
    return usageStore.completeAlert({ alertId: alert.id, fence: alert.fence, owner: deps.owner });
  }

  function materialize(alertId: string): Promise<boolean>;
  function materialize(usageStore: NotificationMaterializerUsageStore, alertId: string): Promise<boolean>;
  function materialize(storeOrAlertId: NotificationMaterializerUsageStore | string, suppliedAlertId?: string): Promise<boolean> {
    if (!accepting) return Promise.resolve(false);
    const usageStore = typeof storeOrAlertId === "string" ? deps.usageStore : storeOrAlertId;
    const alertId = typeof storeOrAlertId === "string" ? storeOrAlertId : suppliedAlertId;
    if (!usageStore || alertId === undefined) return Promise.reject(new Error("subscription usage materialization requires a usage store and alert id"));
    return lane.run(() => materializeOne(usageStore, alertId));
  }

  /** A full batch can leave more alerts behind it, so it queues the next
   *  batch behind every operation admitted so far. */
  async function materializeBatch(usageStore: NotificationMaterializerUsageStore, account: SubscriptionUsageAccountRef): Promise<void> {
    const alerts = usageStore.pendingAlerts(account, MATERIALIZATION_BATCH_SIZE);
    for (const alert of alerts) await materializeOne(usageStore, alert.id);
    if (alerts.length === MATERIALIZATION_BATCH_SIZE && accepting) lane.runInBackground("pending batch", () => materializeBatch(usageStore, account));
  }

  function materializePending(usageStore: NotificationMaterializerUsageStore, account: SubscriptionUsageAccountRef): Promise<void> {
    if (!accepting) return Promise.resolve();
    return lane.run(() => materializeBatch(usageStore, account));
  }

  // After admission closes nothing joins the lane, so its settlement covers
  // every admitted operation.
  const closeAdmission = (): void => { accepting = false; };
  return {
    materialize,
    materializePending,
    closeAdmission,
    settled: () => {
      closeAdmission();
      return lane.settled();
    },
  };
}
