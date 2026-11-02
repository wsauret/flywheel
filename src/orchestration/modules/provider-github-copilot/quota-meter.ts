/** Normalizes Copilot's provider-owned usage observation and billed request totals. */

import { Redacted } from "effect";
import { COPILOT_STATIC_HEADERS } from "./auth-types.js";
import { boundedProviderText, normalizeSubscriptionUsageReport, readBoundedSubscriptionUsageJson, unsupportedSubscriptionUsageOutcome, type SubscriptionUsageMetric, type SubscriptionUsageOutcome, type SubscriptionUsageReader, type SubscriptionUsageReaderContext, type SubscriptionUsageReport, type SubscriptionUsageSpendSource } from "../../../infra/llm/subscription-usage.js";
import { isRecord } from "../../../infra/record.js";
import { getCopilotAuthUrls } from "./base-url.js";

interface UnknownFields { [key: string]: unknown }


export type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;


/** The GitHub token (not the exchanged Copilot token) authenticates the quota
 *  endpoint, so the credential is passed in rather than read from the store. */
interface CopilotQuotaAuth {
  readonly githubToken: Redacted.Redacted<string>;
  readonly enterpriseDomain?: string;
}


/** Parses reset evidence without treating Copilot's date-only value as an exact quota bound. */
function copilotResetsAtMs(resetsOn: string | undefined): number | undefined {
  if (resetsOn === undefined) return undefined;
  const parsed = Date.parse(resetsOn);
  return Number.isFinite(parsed) ? parsed : undefined;
}


function copilotQuotaRequest(fetchImpl: FetchLike, auth: CopilotQuotaAuth, disposal: AbortSignal): Promise<Response> {
  const url = getCopilotAuthUrls(auth.enterpriseDomain).quotaUrl;
  return fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${Redacted.value(auth.githubToken)}`,
      ...COPILOT_STATIC_HEADERS,
    },
    signal: disposal,
  });
}

function malformedUsageSnapshot(detail: string): Error {
  return new Error(`Malformed Copilot usage snapshot: ${detail}`);
}

function requiredNonNegative(record: UnknownFields, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw malformedUsageSnapshot(`${key} is missing or invalid`);
  return value;
}

function optionalNonNegative(record: UnknownFields, key: string): number | undefined {
  if (!(key in record)) return undefined;
  return requiredNonNegative(record, key);
}

/** GitHub reports a negative remaining value when the last request of a
 *  finite seat cost more than what was left. Nothing remains in that case, so
 *  the value is zero. A negative value is valid evidence of an exhausted seat;
 *  if the reader refused it as malformed, every check of the account would fail. */
function optionalRemaining(record: UnknownFields): number | undefined {
  if (!("remaining" in record)) return undefined;
  const value = record.remaining;
  if (typeof value !== "number" || !Number.isFinite(value)) throw malformedUsageSnapshot("remaining is missing or invalid");
  return Math.max(0, value);
}

function countValue(value: number, unit: string): NonNullable<SubscriptionUsageMetric["used"]> {
  return { kind: "count", value, unit, provenance: "provider", precision: "exact" };
}

function copilotAutomaticBilling(premium: UnknownFields, reset: string | undefined): SubscriptionUsageSpendSource {
  const permission = premium.overage_permitted;
  if (permission !== undefined && typeof permission !== "boolean") throw malformedUsageSnapshot("overage_permitted is invalid");
  const used = optionalNonNegative(premium, "overage_count");
  return {
    kind: "automatic-billing",
    enablement: permission === true ? "enabled" : permission === false ? "disabled" : "unknown",
    ...(used === undefined ? {} : { used: countValue(used, "interactions") }),
    ...(reset === undefined ? {} : { resetId: reset, resetAtMs: copilotResetsAtMs(reset) }),
  };
}

function normalizedCopilotUsageReport(raw: unknown, context: SubscriptionUsageReaderContext): SubscriptionUsageReport {
  const identity = context.account.identity;
  if (identity === undefined || identity.trim() === "") throw malformedUsageSnapshot("account identity is unavailable");
  if (!isRecord(raw) || !isRecord(raw.quota_snapshots)) throw malformedUsageSnapshot("quota_snapshots is missing");
  const reset = raw.quota_reset_date;
  if (reset !== undefined && (typeof reset !== "string" || reset.length === 0)) throw malformedUsageSnapshot("quota_reset_date is invalid");
  const premium = raw.quota_snapshots.premium_interactions;
  const metrics: SubscriptionUsageMetric[] = [];
  const spendSources: SubscriptionUsageSpendSource[] = [];
  if (premium !== undefined) {
    if (!isRecord(premium) || typeof premium.unlimited !== "boolean") throw malformedUsageSnapshot("premium_interactions is invalid");
    const tokenBasedBilling = premium.token_based_billing;
    if (tokenBasedBilling !== undefined && typeof tokenBasedBilling !== "boolean") throw malformedUsageSnapshot("token_based_billing is invalid");
    const entitlement = optionalNonNegative(premium, "entitlement");
    const remaining = optionalRemaining(premium);
    const creditsUsed = optionalNonNegative(premium, "credits_used");
    const overagePermitted = premium.overage_permitted;
    if (overagePermitted !== undefined && typeof overagePermitted !== "boolean") throw malformedUsageSnapshot("overage_permitted is invalid");
    if (tokenBasedBilling === true) {
      if (creditsUsed === undefined) throw malformedUsageSnapshot("credits_used is missing or invalid");
      const finite = premium.unlimited === false && overagePermitted === false && entitlement !== undefined && remaining !== undefined;
      const pooled = premium.unlimited === true && entitlement === 0 && remaining === 0;
      metrics.push({
        metricKey: "ai_credits",
        label: "AI Credits",
        scope: { kind: "account" },
        rank: 0,
        timing: reset === undefined ? { kind: "unavailable" } : { kind: "unavailable", resetId: reset, resetAtMs: copilotResetsAtMs(reset) },
        allowanceMode: finite ? "finite" : pooled ? "pooled" : "unclassified",
        used: countValue(creditsUsed, "AI Credits"),
        ...(finite ? { limit: countValue(entitlement, "AI Credits"), remaining: countValue(remaining, "AI Credits") } : {}),
      });
    } else if (!premium.unlimited) {
      if (remaining === undefined) throw malformedUsageSnapshot("remaining is missing or invalid");
      metrics.push({
        metricKey: "premium_interactions",
        label: "Premium interactions",
        scope: { kind: "account" },
        rank: 0,
        timing: reset === undefined ? { kind: "unavailable" } : { kind: "unavailable", resetId: reset, resetAtMs: copilotResetsAtMs(reset) },
        remaining: countValue(remaining, "interactions"),
        ...(entitlement === undefined ? {} : { limit: countValue(entitlement, "interactions") }),
      });
    }
    spendSources.push(copilotAutomaticBilling(premium, reset));
  }
  if (metrics.length === 0 && spendSources.length === 0) throw malformedUsageSnapshot("no readable quota meter is present");
  // GitHub names the plan in copilot_plan and the seat kind in access_type_sku, such as free_limited_copilot for Copilot Free.
  const plan = typeof raw.copilot_plan === "string" && raw.copilot_plan.length > 0 ? boundedProviderText(raw.copilot_plan) || undefined : undefined;
  const tier = typeof raw.access_type_sku === "string" && raw.access_type_sku.length > 0 ? boundedProviderText(raw.access_type_sku) || undefined : undefined;
  return normalizeSubscriptionUsageReport({
    providerId: context.providerId,
    instanceId: context.account.instanceId,
    identity,
    ...(context.account.label === undefined ? {} : { label: context.account.label }),
    ...(plan === undefined ? {} : { plan }),
    ...(tier === undefined ? {} : { tier }),
    providerStatus: "ok",
    observedAtMs: Date.now(),
    metrics,
    spendSources,
  });
}

/** Reads provider-owned Copilot usage without applying local caps or routing policy. */
export function createCopilotUsageReader(fetchImpl: FetchLike = fetch): SubscriptionUsageReader {
  return async (context): Promise<SubscriptionUsageOutcome> => {
    const identity = context.account.identity;
    if (identity === undefined || identity.trim() === "") return { kind: "identity-unavailable" };
    if (context.account.credential.type !== "oauth") return unsupportedSubscriptionUsageOutcome();
    const credential = context.account.credential;
    if (credential.refresh === undefined) return { kind: "expired-auth" };
    let response: Response;
    try {
      response = await copilotQuotaRequest(fetchImpl, { githubToken: credential.refresh, ...(credential.enterpriseDomain === undefined ? {} : { enterpriseDomain: credential.enterpriseDomain }) }, context.signal);
    } catch {
      return { kind: "fetch-failure" };
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) return { kind: "expired-auth" };
      if (response.status === 429) return { kind: "quota-error", status: response.status };
      return { kind: "fetch-failure" };
    }
    let raw: unknown;
    try {
      raw = await readBoundedSubscriptionUsageJson(response);
    } catch {
      return { kind: "fetch-failure" };
    }
    try {
      return { kind: "success", report: normalizedCopilotUsageReport(raw, context) };
    } catch {
      return { kind: "fetch-failure" };
    }
  };
}