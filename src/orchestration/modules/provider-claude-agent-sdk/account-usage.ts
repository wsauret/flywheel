import { boundedProviderText, type SubscriptionUsageMetric, type SubscriptionUsageReport } from "../../../infra/llm/subscription-usage.js";

/** One plan window of a Claude account: the share of it used, and when it resets in epoch ms when the source says. */
interface UsageWindow {
  readonly usedFraction: number;
  readonly resetsAtMs?: number;
}

/** A weekly window that spends the allowance of one model only, such as Fable, under the provider's name of the
 *  model. A rate-limit event carries the window without a name. The source that states the window sets its metric
 *  key, so the key never depends on which other windows are on view. */
interface ModelWindow extends UsageWindow {
  readonly model?: string;
  readonly metricKey: string;
}

/** The plan windows that Flywheel shows for a Claude account: the five-hour and the all-models weekly window, which
 *  cover every model, and the weekly windows of one model each. */
export interface UsageWindows {
  readonly fiveHour?: UsageWindow;
  readonly sevenDay?: UsageWindow;
  /** Absent when the source states nothing about model windows; empty when it states that there are none. */
  readonly models?: readonly ModelWindow[];
}

/** The metric key of the all-models seven-day window, which is also its field name in both CLI sources. */
export const SEVEN_DAY_METRIC = "seven_day";

/** The two windows that cover every model, by the field names of both CLI sources, in display order. */
const WINDOWS = [
  { key: "sevenDay", field: SEVEN_DAY_METRIC, label: "Seven days (all models)" },
  { key: "fiveHour", field: "five_hour", label: "Five hours" },
] as const;

/** The metric key of an account's one model window, which is also the window's field name in a rate-limit event. The
 *  key carries no model name, so the meter keeps one history when a reply names the window that an event stated. */
const MODEL_WINDOW_METRIC = "seven_day_overage_included";

/** What a model window shows in place of the model's name until a reply of the CLI names it. */
const UNNAMED_MODEL = "one model";

/** The longest model name that a meter shows, so its label and metric key stay within the bound of provider text. */
const MODEL_NAME_LENGTH = 64;

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A share used, as a fraction. A window past its limit reads as full. */
function fraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function windowsOf(read: (window: typeof WINDOWS[number]) => UsageWindow | undefined, models: readonly ModelWindow[] | undefined): UsageWindows | undefined {
  const entries = WINDOWS.flatMap((entry) => {
    const window = read(entry);
    return window === undefined ? [] : [[entry.key, window] as const];
  });
  if (entries.length === 0 && (models ?? []).length === 0) return undefined;
  return { ...Object.fromEntries(entries), ...(models === undefined ? {} : { models }) };
}

function eventWindow(window: unknown): UsageWindow | undefined {
  if (!isRecord(window) || typeof window.utilization !== "number" || !Number.isFinite(window.utilization)) return undefined;
  if (typeof window.resetsAt !== "number" || !Number.isSafeInteger(window.resetsAt * 1000)) return undefined;
  return { usedFraction: fraction(window.utilization), resetsAtMs: window.resetsAt * 1000 };
}

/**
 * The windows that one rate-limit event carries in the CLI's internal `unifiedWindows` field (CLI 2.1.295): each
 * window's utilization as a fraction and its reset in epoch seconds, read from the service's usage headers of the
 * response before the event. The CLI leaves out a window whose reset has passed. `seven_day_overage_included` is the
 * weekly window of one model, which the event does not name. A window that is not well formed states nothing, and an
 * event without a window is no reading.
 */
export function eventUsageWindows(info: { readonly [key: string]: unknown }): UsageWindows | undefined {
  const unified = info.unifiedWindows;
  if (!isRecord(unified)) return undefined;
  const model = eventWindow(unified[MODEL_WINDOW_METRIC]);
  return windowsOf(({ field }) => eventWindow(unified[field]), model === undefined ? undefined : [{ ...model, metricKey: MODEL_WINDOW_METRIC }]);
}

/** What the CLI's usage reply states about the account's plan windows. */
export type UsageReply =
  | { readonly kind: "windows"; readonly windows: UsageWindows }
  /** The plan's usage states no five-hour, seven-day, or model window, so it has no meter to show. */
  | { readonly kind: "no-windows" }
  /** The login has no plan windows, such as a Console login that bills the API. */
  | { readonly kind: "no-plan" }
  /** The reply has another shape, or the CLI could not read the plan's usage. */
  | { readonly kind: "unreadable" };

function replyWindow(window: unknown): UsageWindow | undefined {
  if (!isRecord(window) || typeof window.utilization !== "number" || !Number.isFinite(window.utilization)) return undefined;
  const resetsAtMs = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : Number.NaN;
  return { usedFraction: fraction(window.utilization / 100), ...(Number.isSafeInteger(resetsAtMs) && resetsAtMs >= 0 ? { resetsAtMs } : {}) };
}

/** The named weekly windows of one model each in the reply's `model_scoped` list. The CLI leaves the list out when
 *  it could not read the model windows, which states nothing about them. An entry without a printable name or a
 *  numeric utilization states nothing. One window takes the metric key of the event's window; several take their keys
 *  from their names. */
function replyModelWindows(entries: unknown): ModelWindow[] | undefined {
  if (!Array.isArray(entries)) return undefined;
  const named = entries.flatMap((entry) => {
    const window = replyWindow(entry);
    const model = isRecord(entry) && typeof entry.display_name === "string" ? boundedProviderText(entry.display_name).slice(0, MODEL_NAME_LENGTH) : "";
    return window === undefined || model === "" ? [] : [{ ...window, model }];
  });
  return named.map((window) => ({ ...window, metricKey: named.length === 1 ? MODEL_WINDOW_METRIC : `${MODEL_WINDOW_METRIC}:${window.model}` }));
}

/**
 * The plan windows of the CLI's reply to its experimental usage request (`get_usage`, CLI 2.1.306): each window's
 * utilization in percent and its reset as an ISO time, either of which can be null, and in `model_scoped` the weekly
 * windows of one model each under the model's `display_name`. The SDK states that the request may change in any
 * release, so the reply is read as data of unknown shape.
 */
export function usageReplyWindows(reply: unknown): UsageReply {
  if (!isRecord(reply)) return { kind: "unreadable" };
  if (reply.rate_limits_available === false) return { kind: "no-plan" };
  const limits = reply.rate_limits;
  if (reply.rate_limits_available !== true || !isRecord(limits)) return { kind: "unreadable" };
  const windows = windowsOf(({ field }) => replyWindow(limits[field]), replyModelWindows(limits.model_scoped));
  return windows === undefined ? { kind: "no-windows" } : { kind: "windows", windows };
}

function usageMetric(window: UsageWindow, metricKey: string, label: string, rank: number, scope: SubscriptionUsageMetric["scope"]): SubscriptionUsageMetric {
  const timing = { kind: "unavailable" as const, ...(window.resetsAtMs === undefined ? {} : { resetAtMs: window.resetsAtMs }) };
  return { metricKey, label, rank, scope, timing, usedFraction: window.usedFraction, used: { kind: "percentage", value: window.usedFraction, provenance: "provider", precision: "exact" } };
}

/** The usage meters of the windows, as the retired native reader showed them: a reset date never implies a window's
 *  start. The windows that cover every model come first; each model window follows under the model's name. */
export function usageMetrics(windows: UsageWindows | undefined): SubscriptionUsageMetric[] {
  const account = WINDOWS.flatMap(({ key, field, label }, rank) => {
    const window = windows?.[key];
    return window === undefined ? [] : [usageMetric(window, field, label, rank, { kind: "account" })];
  });
  return [...account, ...(windows?.models ?? []).map((window, index) => {
    const model = window.model ?? UNNAMED_MODEL;
    return usageMetric(window, window.metricKey, `Seven days (${model})`, WINDOWS.length + index, { kind: "feature", featureKey: model });
  })];
}

/** The account's state that the windows show: spent when a window that covers every model is full. A full model
 *  window spends that model's allowance only. */
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
 * The latest windows that a rate-limit event reported for each account in this process, and the model windows that
 * the CLI's last usage reply named for it. A bridge records each event, and the usage reader reads the record, so no
 * request for usage starts a CLI while the account serves requests here. The bridges and the usage reader of one
 * runtime share a process.
 */
export interface UsageReadings {
  record(account: UsageAccount, windows: UsageWindows, observedAtMs: number): void;
  /** Records the model windows that a usage reply stated, which name the unnamed model window of later events. A
   *  reply that states nothing about them keeps the last ones. Returns the account's model windows at `nowMs`. */
  recordModels(account: UsageAccount, models: readonly ModelWindow[] | undefined, nowMs: number): readonly ModelWindow[];
  /** The account's reading if it is recent at `nowMs`, without the windows whose reset has passed. */
  recent(account: UsageAccount, nowMs: number): UsageReading | undefined;
}

/**
 * The model windows of an event reading, given the windows that the last reply named. The event's one window takes
 * the name of the reply's one window; with no name known it stays unnamed. With several named windows the event
 * cannot say which one it states, and an event without the window states nothing about it, so the reply's windows
 * stand.
 */
function eventModelWindows(stated: readonly ModelWindow[] | undefined, named: readonly ModelWindow[]): readonly ModelWindow[] {
  const [window] = stated ?? [];
  const [only] = named;
  if (window === undefined || named.length > 1) return named;
  return [only === undefined ? window : { ...only, ...window }];
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
  const namedModels = new Map<string, readonly ModelWindow[]>();
  const key = ({ configDir, accountId }: UsageAccount) => `${configDir}\0${accountId}`;
  // A reply can state a model window without its reset, so only a reset that is known to have passed removes one.
  const expired = (window: UsageWindow, nowMs: number) => window.resetsAtMs !== undefined && window.resetsAtMs <= nowMs;
  return {
    record: (account, windows, observedAtMs) => { readings.set(key(account), { windows, observedAtMs }); },
    recordModels: (account, models, nowMs) => {
      if (models !== undefined) namedModels.set(key(account), models);
      return (namedModels.get(key(account)) ?? []).filter((window) => !expired(window, nowMs));
    },
    recent: (account, nowMs) => {
      const reading = readings.get(key(account));
      if (reading === undefined || nowMs - reading.observedAtMs > RECENT_READING_MS) return undefined;
      const current = (window: UsageWindow | undefined) => window?.resetsAtMs !== undefined && window.resetsAtMs > nowMs;
      const models = eventModelWindows(reading.windows.models, namedModels.get(key(account)) ?? []).filter((window) => !expired(window, nowMs));
      const windows = windowsOf(({ key: name }) => current(reading.windows[name]) ? reading.windows[name] : undefined, models);
      return windows === undefined ? undefined : { windows, observedAtMs: reading.observedAtMs };
    },
  };
}

/** The readings of this process, which its bridges record and its usage reader reads. */
export const processUsageReadings = usageReadings();
