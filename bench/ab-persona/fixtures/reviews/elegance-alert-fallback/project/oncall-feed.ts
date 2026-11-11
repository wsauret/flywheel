import type { Alert, AlertDispatcher } from "./alerts.ts";

/** Dispatch an alert and return the line the on-call feed shows for it. */
export async function dispatchForFeed(dispatcher: AlertDispatcher, alert: Alert): Promise<string> {
  const result = await dispatcher.dispatch(alert);
  const failed = result.failures.map((failure) => `${failure.channel} (${failure.error})`).join(", ");
  if (result.deliveredBy === undefined) return `${alert.monitor}: NOT DELIVERED to ${alert.userId}; tried ${failed}`;
  const fallback = failed === "" ? "" : ` after ${failed} failed`;
  return `${alert.monitor}: delivered to ${alert.userId} by ${result.deliveredBy}${fallback}`;
}
