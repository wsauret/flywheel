import { Redacted } from "effect";
import type { StoredTokens } from "../../../infra/auth/openai-auth-types.js";
import { isRecord, type UnknownRecord } from "../../../infra/record.js";
import { unsupportedSubscriptionUsageOutcome, type SubscriptionUsageMetric, type SubscriptionUsageReader, type SubscriptionUsageReaderContext, type SubscriptionUsageSpendSource } from "../../../infra/llm/subscription-usage.js";
import { malformed, oauthTokens, percent, prepaidBalance, readerIdentity, requiredNumber, requiredRecord, requiredString, usageJson, usageReport, usageRequest, type FetchLike } from "../../../infra/llm/subscription-usage-reader.js";
import { ensureFreshXaiTokens, XaiTokenRefreshError } from "./token-refresh.js";

const SUPERGROK_USAGE_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SUPERGROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";

type FreshTokens = (context: SubscriptionUsageReaderContext) => Promise<StoredTokens>;

function permanentRefreshFailure(error: unknown): boolean {
  return error instanceof XaiTokenRefreshError && (
    error.reason.kind === "no_refresh_token"
    || (error.reason.kind === "http" && (error.reason.status === 401 || error.reason.code === "invalid_grant"))
  );
}

function optionalMoney(raw: unknown, field: string): NonNullable<SubscriptionUsageMetric["used"]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = requiredNumber(requiredRecord(raw, "SuperGrok", field), "val", "SuperGrok");
  return { kind: "money", value: value / 100, currency: "USD", provenance: "provider", precision: "exact" };
}

function superGrokSpendSources(payload: UnknownRecord, enablement: "enabled" | "disabled" | "unknown"): SubscriptionUsageSpendSource[] {
  const sources: SubscriptionUsageSpendSource[] = [];
  const prepaid = optionalMoney(payload.prepaidBalance, "prepaidBalance");
  if (prepaid) sources.push(prepaidBalance(prepaid));
  const used = optionalMoney(payload.onDemandUsed, "onDemandUsed");
  const limit = optionalMoney(payload.onDemandCap, "onDemandCap");
  if (used || limit || enablement !== "unknown") {
    sources.push({ kind: "automatic-billing", enablement, ...(used ? { used } : {}), ...(limit ? { limit } : {}) });
  }
  return sources;
}

function superGrokMetrics(raw: unknown) {
  const response = requiredRecord(raw, "SuperGrok", "response");
  const payload = requiredRecord(response.config, "SuperGrok", "config");
  const metrics: SubscriptionUsageMetric[] = [];
  if (payload.creditUsagePercent !== undefined || payload.currentPeriod !== undefined) {
    const period = requiredRecord(payload.currentPeriod, "SuperGrok", "currentPeriod");
    const reset = requiredString(period, "end", "SuperGrok");
    const endMs = Date.parse(reset);
    if (!Number.isSafeInteger(endMs) || endMs < 0) throw malformed("SuperGrok", "currentPeriod.end is invalid");
    let timing: SubscriptionUsageMetric["timing"] = { kind: "unavailable", resetId: reset, resetAtMs: endMs };
    if (period.start !== undefined) {
      const start = requiredString(period, "start", "SuperGrok");
      const startMs = Date.parse(start);
      if (!Number.isSafeInteger(startMs) || startMs < 0 || startMs >= endMs) throw malformed("SuperGrok", "currentPeriod bounds are invalid");
      timing = { kind: "exact", startMs, endMs };
    }
    let usedFraction: number;
    if (payload.creditUsagePercent === undefined) {
      const nowMs = Date.now();
      if (
        requiredString(period, "type", "SuperGrok") !== "USAGE_PERIOD_TYPE_WEEKLY"
        || timing.kind !== "exact"
        || timing.startMs > nowMs
        || endMs <= nowMs
      ) {
        throw malformed("SuperGrok", "creditUsagePercent is missing outside an active weekly period");
      }
      usedFraction = 0;
    } else {
      usedFraction = percent(payload, "creditUsagePercent", "SuperGrok");
    }
    metrics.push({ metricKey: "credits", label: "Credits", scope: { kind: "account" }, rank: 0, usedFraction, timing });
    if (payload.productUsage !== undefined) {
      if (!Array.isArray(payload.productUsage)) throw malformed("SuperGrok", "productUsage is invalid");
      for (const [index, rawProduct] of payload.productUsage.entries()) {
        const product = requiredRecord(rawProduct, "SuperGrok", "productUsage entry");
        const productKey = requiredString(product, "product", "SuperGrok");
        metrics.push({ metricKey: `product:${productKey}`, label: productKey, scope: { kind: "feature", featureKey: productKey }, rank: 100 + index, usedFraction: percent(product, "usagePercent", "SuperGrok"), timing });
      }
    }
  }
  if (payload.monthlyLimit !== undefined || payload.used !== undefined) {
    const used = optionalMoney(payload.used, "used");
    const limit = optionalMoney(payload.monthlyLimit, "monthlyLimit");
    if (!used || !limit) throw malformed("SuperGrok", "legacy monthly used and limit must appear together");
    const reset = requiredString(payload, "billingPeriodEnd", "SuperGrok");
    const resetAtMs = Date.parse(reset);
    if (!Number.isSafeInteger(resetAtMs) || resetAtMs < 0) throw malformed("SuperGrok", "billingPeriodEnd is invalid");
    metrics.push({ metricKey: "monthly", label: "Monthly", scope: { kind: "account" }, rank: 1, used, limit, timing: { kind: "unavailable", resetId: reset, resetAtMs } });
  }
  if (metrics.length === 0) throw malformed("SuperGrok", "no supported usage fields are present");
  return { metrics, payload };
}

async function superGrokEnablement(fetchImpl: FetchLike, headers: HeadersInit, signal: AbortSignal): Promise<"enabled" | "disabled" | "unknown"> {
  const response = await usageRequest(fetchImpl, SUPERGROK_SETTINGS_URL, headers, signal, "unsupported");
  if (!(response instanceof Response)) return "unknown";
  const decoded = await usageJson(response);
  if (decoded.kind === "failed" || !isRecord(decoded.value) || typeof decoded.value.on_demand_enabled !== "boolean") return "unknown";
  return decoded.value.on_demand_enabled ? "enabled" : "disabled";
}

const freshXai: FreshTokens = async (context) => {
  if (context.account.credential.type !== "oauth") throw new Error("OAuth credentials are required");
  return ensureFreshXaiTokens(oauthTokens(context.account.credential), { compareAndSet: context.compareAndSetTokens }, context.signal);
};

/** Reads exact SuperGrok percentages, periods, and monetary fields through the shared xAI refresh seam. */
export function createSuperGrokUsageReader(fetchImpl: FetchLike = fetch, fresh: FreshTokens = freshXai): SubscriptionUsageReader {
  return async (context) => {
    if (readerIdentity(context) === undefined) return { kind: "identity-unavailable" };
    if (context.account.credential.type !== "oauth") return unsupportedSubscriptionUsageOutcome();
    let tokens: StoredTokens;
    try { tokens = await fresh(context); } catch (error) { return permanentRefreshFailure(error) ? { kind: "expired-auth" } : { kind: "fetch-failure" }; }
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${Redacted.value(tokens.accessToken)}`,
      "X-XAI-Token-Auth": "xai-grok-cli",
    };
    const response = await usageRequest(fetchImpl, SUPERGROK_USAGE_URL, headers, context.signal, "unsupported");
    if (!(response instanceof Response)) return response;
    const decoded = await usageJson(response);
    if (decoded.kind === "failed") return decoded.outcome;
    try {
      const normalized = superGrokMetrics(decoded.value);
      const enablement = await superGrokEnablement(fetchImpl, headers, context.signal);
      return usageReport(context, normalized.metrics, { spendSources: superGrokSpendSources(normalized.payload, enablement) });
    } catch { return { kind: "fetch-failure" }; }
  };
}
