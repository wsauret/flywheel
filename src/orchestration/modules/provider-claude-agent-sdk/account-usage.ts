import type { SubscriptionUsageMetric, SubscriptionUsageReport } from "../../../infra/llm/subscription-usage.js";

/** One plan window of a Claude account: the share of it used, and when it resets in epoch ms when the source says. */
interface UsageWindow {
  readonly usedFraction: number;
  readonly resetsAtMs?: number;
}

/** The account-wide plan windows that Flywheel shows for a Claude account. */
export interface UsageWindows {
  readonly fiveHour?: UsageWindow;
  readonly sevenDay?: UsageWindow;
}

/** The metric key of the seven-day window, which is also its field name in both CLI sources. */
export const SEVEN_DAY_METRIC = "seven_day";

/** The two windows, by the field names of both CLI sources, in display order. */
const WINDOWS = [
  { key: "sevenDay", field: SEVEN_DAY_METRIC, label: "Seven days" },
  { key: "fiveHour", field: "five_hour", label: "Five hours" },
] as const;

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A share used, as a fraction. A window past its limit reads as full. */
function fraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function windowsOf(read: (window: typeof WINDOWS[number]) => UsageWindow | undefined): UsageWindows | undefined {
  const entries = WINDOWS.flatMap((entry) => {
    const window = read(entry);
    return window === undefined ? [] : [[entry.key, window] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/**
 * The windows that one rate-limit event carries in the CLI's internal `unifiedWindows` field (CLI 2.1.295): each
 * window's utilization as a fraction and its reset in epoch seconds, read from the service's usage headers of the
 * response before the event. The CLI leaves out a window whose reset has passed. A window that is not well formed
 * states nothing, and an event without a window is no reading.
 */
export function eventUsageWindows(info: { readonly [key: string]: unknown }): UsageWindows | undefined {
  const unified = info.unifiedWindows;
  if (!isRecord(unified)) return undefined;
  return windowsOf(({ field }) => {
    const window = unified[field];
    if (!isRecord(window) || typeof window.utilization !== "number" || !Number.isFinite(window.utilization)) return undefined;
    if (typeof window.resetsAt !== "number" || !Number.isSafeInteger(window.resetsAt * 1000)) return undefined;
    return { usedFraction: fraction(window.utilization), resetsAtMs: window.resetsAt * 1000 };
  });
}

/** What the CLI's usage reply states about the account's plan windows. */
export type UsageReply =
  | { readonly kind: "windows"; readonly windows: UsageWindows }
  /** The plan's usage states no five-hour or seven-day window, so it has no meter to show. */
  | { readonly kind: "no-windows" }
  /** The login has no plan windows, such as a Console login that bills the API. */
  | { readonly kind: "no-plan" }
  /** The reply has another shape, or the CLI could not read the plan's usage. */
  | { readonly kind: "unreadable" };

/**
 * The plan windows of the CLI's reply to its experimental usage request (`get_usage`, SDK 0.3.293): each window's
 * utilization in percent and its reset as an ISO time, either of which can be null. The SDK states that the request
 * may change in any release, so the reply is read as data of unknown shape.
 */
export function usageReplyWindows(reply: unknown): UsageReply {
  if (!isRecord(reply)) return { kind: "unreadable" };
  if (reply.rate_limits_available === false) return { kind: "no-plan" };
  const limits = reply.rate_limits;
  if (reply.rate_limits_available !== true || !isRecord(limits)) return { kind: "unreadable" };
  const windows = windowsOf(({ field }) => {
    const window = limits[field];
    if (!isRecord(window) || typeof window.utilization !== "number" || !Number.isFinite(window.utilization)) return undefined;
    const resetsAtMs = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : Number.NaN;
    return { usedFraction: fraction(window.utilization / 100), ...(Number.isSafeInteger(resetsAtMs) && resetsAtMs >= 0 ? { resetsAtMs } : {}) };
  });
  return windows === undefined ? { kind: "no-windows" } : { kind: "windows", windows };
}

/** The usage meters of the windows, as the retired native reader showed them: a reset date never implies a window's
 *  start. */
export function usageMetrics(windows: UsageWindows | undefined): SubscriptionUsageMetric[] {
  return WINDOWS.flatMap(({ key, field, label }, rank) => {
    const window = windows?.[key];
    if (window === undefined) return [];
    const timing = { kind: "unavailable" as const, ...(window.resetsAtMs === undefined ? {} : { resetAtMs: window.resetsAtMs }) };
    return [{ metricKey: field, label, rank, scope: { kind: "account" as const }, timing, usedFraction: window.usedFraction, used: { kind: "percentage" as const, value: window.usedFraction, provenance: "provider" as const, precision: "exact" as const } }];
  });
}

/** The account's state that the windows show: spent when a window is full. */
export function usageStatus(windows: UsageWindows | undefined): SubscriptionUsageReport["providerStatus"] {
  if (windows === undefined) return "unknown";
  return WINDOWS.some(({ key }) => (windows[key]?.usedFraction ?? 0) >= 1) ? "exhausted" : "ok";
}

/** One account's login: its config directory and the Claude account that the login there holds. */
interface UsageAccount {
  readonly configDir: string;
  readonly accountId: string;
}

/** The account's latest reading from a rate-limit event, and when the event came. */
interface UsageReading {
  readonly windows: UsageWindows;
  readonly observedAtMs: number;
}

/**
 * The latest windows that a rate-limit event reported for each account in this process. A bridge records each event,
 * and the usage reader reads the record, so no request for usage starts a CLI while the account serves requests here.
 * The bridges and the usage reader of one runtime share a process.
 */
export interface UsageReadings {
  record(account: UsageAccount, windows: UsageWindows, observedAtMs: number): void;
  /** The account's reading if it is recent at `nowMs`, without the windows whose reset has passed. */
  recent(account: UsageAccount, nowMs: number): UsageReading | undefined;
}

/**
 * How long a reading stands for the account's windows. The CLI reports an event only after its first response and
 * when its reading changes, so an older reading can still hold. But other clients of the account, such as the
 * person's own `claude` installation, spend the same windows and send no event here, so after this time the reader asks the
 * CLI. It equals the usage service's freshness, so a reading stands for one check at most.
 */
const RECENT_READING_MS = 5 * 60_000;

export function usageReadings(): UsageReadings {
  const readings = new Map<string, UsageReading>();
  const key = ({ configDir, accountId }: UsageAccount) => `${configDir}\0${accountId}`;
  return {
    record: (account, windows, observedAtMs) => { readings.set(key(account), { windows, observedAtMs }); },
    recent: (account, nowMs) => {
      const reading = readings.get(key(account));
      if (reading === undefined || nowMs - reading.observedAtMs > RECENT_READING_MS) return undefined;
      const windows = windowsOf(({ key: name }) => {
        const window = reading.windows[name];
        return window?.resetsAtMs !== undefined && window.resetsAtMs > nowMs ? window : undefined;
      });
      return windows === undefined ? undefined : { windows, observedAtMs: reading.observedAtMs };
    },
  };
}

/** The readings of this process, which its bridges record and its usage reader reads. */
export const processUsageReadings = usageReadings();
