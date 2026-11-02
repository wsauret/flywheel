import { Redacted } from "effect";
import { unsupportedSubscriptionUsageOutcome, type SubscriptionUsageMetric, type SubscriptionUsageReader } from "../../../infra/llm/subscription-usage.js";
import { malformed, percent, readerIdentity, requiredRecord, requiredString, usageJson, usageReport, usageRequest, type FetchLike } from "../../../infra/llm/subscription-usage-reader.js";
import { OPENCODE_GO_V1_BASE } from "./wire.js";

const OPENCODE_GO_USAGE_URL = `${OPENCODE_GO_V1_BASE}/usage`;

function openCodeGoMetrics(raw: unknown) {
  const payload = requiredRecord(raw, "OpenCode Go", "response");
  const usage = requiredRecord(payload.usage, "OpenCode Go", "usage");
  const metrics: SubscriptionUsageMetric[] = [];
  let providerStatus: "ok" | "warning" | "exhausted" = "ok";
  for (const [rank, name] of (["rolling", "weekly", "monthly"] as const).entries()) {
    const window = requiredRecord(usage[name], "OpenCode Go", `usage.${name}`);
    const status = window.status;
    if (status !== "ok" && status !== "rate-limited") throw malformed("OpenCode Go", `usage.${name}.status is invalid`);
    const usedFraction = percent(window, "percent", "OpenCode Go");
    const reset = requiredString(window, "resetsAt", "OpenCode Go");
    const resetAtMs = Date.parse(reset);
    if (!Number.isSafeInteger(resetAtMs) || resetAtMs < 0) throw malformed("OpenCode Go", `usage.${name}.resetsAt is invalid`);
    const metricStatus = status === "rate-limited" ? "exhausted" : "ok";
    if (metricStatus === "exhausted") providerStatus = "exhausted";
    metrics.push({ metricKey: name, label: name.charAt(0).toUpperCase() + name.slice(1), scope: { kind: "account" }, rank, usedFraction, timing: { kind: "unavailable", resetId: reset, resetAtMs }, providerStatus: metricStatus });
  }
  return { metrics, status: providerStatus };
}

/** Reads the three provider-owned OpenCode Go usage windows without deriving counts. */
export function createOpenCodeGoUsageReader(fetchImpl: FetchLike = fetch): SubscriptionUsageReader {
  return async (context) => {
    if (readerIdentity(context) === undefined) return { kind: "identity-unavailable" };
    if (context.account.credential.type !== "api_key") return unsupportedSubscriptionUsageOutcome();
    const response = await usageRequest(fetchImpl, OPENCODE_GO_USAGE_URL, { accept: "application/json", authorization: `Bearer ${Redacted.value(context.account.credential.key)}` }, context.signal, "unsupported");
    if (!(response instanceof Response)) return response;
    const decoded = await usageJson(response);
    if (decoded.kind === "failed") return decoded.outcome;
    try {
      const normalized = openCodeGoMetrics(decoded.value);
      return usageReport(context, normalized.metrics, { plan: "OpenCode Go", status: normalized.status, spendSources: [{ kind: "prepaid", availability: "balance-unavailable" }] });
    } catch {
      return { kind: "fetch-failure" };
    }
  };
}
