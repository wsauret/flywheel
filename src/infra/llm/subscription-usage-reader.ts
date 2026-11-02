import type { RuntimeOAuthCredential } from "../auth/auth-context.js";
import type { StoredTokens } from "../auth/openai-auth-types.js";
import { isRecord, type UnknownRecord } from "../record.js";
import {
  boundedProviderText,
  normalizeSubscriptionUsageReport,
  readBoundedSubscriptionUsageJson,
  unsupportedSubscriptionUsageOutcome,
  type SubscriptionUsageMetric,
  type SubscriptionUsageOutcome,
  type SubscriptionUsageReaderContext,
  type SubscriptionUsageResetCredits,
  type SubscriptionUsageSpendSource,
} from "./subscription-usage.js";

/** The reader toolkit every provider's usage reader is built from: strict
 *  field readers over a provider's JSON, the one request shape that maps
 *  HTTP status to a usage outcome, and the report envelope. A provider module
 *  owns only its own field layout. */

export type FetchLike = typeof fetch;

export interface UsageJsonResult {
  readonly kind: "parsed";
  readonly value: unknown;
}

export interface UsageJsonFailure {
  readonly kind: "failed";
  readonly outcome: SubscriptionUsageOutcome;
}

export function malformed(provider: string, detail: string): Error {
  return new Error(`Malformed ${provider} usage response: ${detail}`);
}

export function requiredRecord(value: unknown, provider: string, field: string): UnknownRecord {
  if (!isRecord(value)) throw malformed(provider, `${field} is missing or invalid`);
  return value;
}

export function requiredString(record: UnknownRecord, key: string, provider: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw malformed(provider, `${key} is missing or invalid`);
  const normalized = boundedProviderText(value);
  if (normalized.length === 0) throw malformed(provider, `${key} is missing or invalid`);
  return normalized;
}

export function requiredNumber(record: UnknownRecord, key: string, provider: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw malformed(provider, `${key} is missing or invalid`);
  return value;
}

export function percent(record: UnknownRecord, key: string, provider: string): number {
  const value = requiredNumber(record, key, provider);
  if (value > 100) throw malformed(provider, `${key} must be between 0 and 100`);
  return value / 100;
}

export function readerIdentity(context: SubscriptionUsageReaderContext): string | undefined {
  const value = context.account.identity;
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function usageReport(context: SubscriptionUsageReaderContext, metrics: readonly SubscriptionUsageMetric[], options: { plan?: string; status?: "ok" | "warning" | "exhausted"; spendSources?: readonly SubscriptionUsageSpendSource[]; resetCredits?: SubscriptionUsageResetCredits } = {}): SubscriptionUsageOutcome {
  const subject = readerIdentity(context);
  if (subject === undefined) return { kind: "identity-unavailable" };
  return { kind: "success", report: normalizeSubscriptionUsageReport({ providerId: context.providerId, instanceId: context.account.instanceId, identity: subject, ...(context.account.label === undefined ? {} : { label: context.account.label }), ...(options.plan === undefined ? {} : { plan: options.plan }), providerStatus: options.status ?? "ok", observedAtMs: Date.now(), ...(options.spendSources === undefined ? {} : { spendSources: options.spendSources }), ...(options.resetCredits === undefined ? {} : { resetCredits: options.resetCredits }), metrics }) };
}

function forbiddenOutcome(kind: "expired-auth" | "unsupported"): SubscriptionUsageOutcome {
  return kind === "expired-auth" ? { kind: "expired-auth" } : unsupportedSubscriptionUsageOutcome();
}

export async function usageRequest(fetchImpl: FetchLike, url: string, headers: HeadersInit, signal: AbortSignal, forbidden: "expired-auth" | "unsupported" = "expired-auth"): Promise<Response | SubscriptionUsageOutcome> {
  try {
    const response = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
    if (response.status === 401) return { kind: "expired-auth" };
    if (response.status === 403) return forbiddenOutcome(forbidden);
    if (response.status === 429) return { kind: "quota-error", status: 429 };
    if (!response.ok) return { kind: "fetch-failure" };
    return response;
  } catch {
    return { kind: "fetch-failure" };
  }
}

export async function usageJson(response: Response): Promise<UsageJsonResult | UsageJsonFailure> {
  try {
    return { kind: "parsed", value: await readBoundedSubscriptionUsageJson(response) };
  } catch {
    return { kind: "failed", outcome: { kind: "fetch-failure" } };
  }
}

export function prepaidBalance(remaining: NonNullable<SubscriptionUsageMetric["used"]>): SubscriptionUsageSpendSource {
  return remaining.value === 0
    ? { kind: "prepaid", availability: "empty" }
    : { kind: "prepaid", availability: "funded", remaining };
}

/** The OAuth tokens a reader refreshes from, taken from the captured credential. */
export function oauthTokens(credential: RuntimeOAuthCredential): StoredTokens {
  return {
    accessToken: credential.access,
    refreshToken: credential.refresh,
    expiresAtMs: credential.expires,
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }),
  };
}
