import { Redacted } from "effect";
import type { StoredTokens } from "../../../infra/auth/openai-auth-types.js";
import type { UnknownRecord } from "../../../infra/record.js";
import { boundedProviderText, readBoundedSubscriptionUsageJson, unsupportedSubscriptionUsageOutcome, type SubscriptionUsageMetric, type SubscriptionUsageReader, type SubscriptionUsageReaderContext, type SubscriptionUsageResetConsumer, type SubscriptionUsageResetCredits, type SubscriptionUsageSpendSource } from "../../../infra/llm/subscription-usage.js";
import { malformed, oauthTokens, percent, prepaidBalance, readerIdentity, requiredNumber, requiredRecord, requiredString, usageJson, usageReport, usageRequest, type FetchLike } from "../../../infra/llm/subscription-usage-reader.js";
import { ensureFreshChatGPTTokens } from "../../agent-runtime/llm/openai-chatgpt.js";
import { ChatGPTTokenRefreshError } from "../../auth/openai-oauth.js";

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CHATGPT_RESET_CONSUME_URL = `${CHATGPT_RESET_CREDITS_URL}/consume`;

type FreshTokens = (context: SubscriptionUsageReaderContext) => Promise<StoredTokens>;

const PERMANENT_CHATGPT_REFRESH_CODES = new Set(["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]);

function permanentRefreshFailure(error: unknown): boolean {
  return error instanceof ChatGPTTokenRefreshError && (error.status === 401 || (error.code !== undefined && PERMANENT_CHATGPT_REFRESH_CODES.has(error.code)));
}

/** Per-model windows are provider detail most readers never need; both
 *  clients hide them until asked. The backend marks each one with this token
 *  in the metered feature that leads its metric key. */
const MODEL_WINDOW_FEATURE_TOKEN = /(?:^|[^a-z0-9])codex(?:$|[^a-z0-9])/i;

export function isModelWindowMetric(metricKey: string): boolean {
  return MODEL_WINDOW_FEATURE_TOKEN.test(metricKey);
}

function chatGptWindow(raw: unknown, metricKey: string, label: string, scope: SubscriptionUsageMetric["scope"], rank: number): SubscriptionUsageMetric | undefined {
  if (raw === null || raw === undefined) return undefined;
  const window = requiredRecord(raw, "ChatGPT", label);
  const usedFraction = percent(window, "used_percent", "ChatGPT");
  const resetAt = requiredNumber(window, "reset_at", "ChatGPT");
  requiredNumber(window, "reset_after_seconds", "ChatGPT");
  const durationSeconds = requiredNumber(window, "limit_window_seconds", "ChatGPT");
  if (!Number.isSafeInteger(resetAt) || !Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) throw malformed("ChatGPT", `${label} timing is invalid`);
  const endMs = resetAt * 1_000;
  const durationMs = durationSeconds * 1_000;
  const startMs = endMs - durationMs;
  if (!Number.isSafeInteger(endMs) || !Number.isSafeInteger(durationMs) || !Number.isSafeInteger(startMs) || startMs < 0) throw malformed("ChatGPT", `${label} timing is invalid`);
  return { metricKey, label, scope, rank, usedFraction, timing: { kind: "exact", startMs, endMs } };
}

function exactCreditCount(raw: unknown, field: string): NonNullable<SubscriptionUsageMetric["used"]> {
  if (typeof raw !== "string" || raw.trim() === "") throw malformed("ChatGPT", `${field} is missing or invalid`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw malformed("ChatGPT", `${field} is missing or invalid`);
  return { kind: "count", value, unit: "credits", provenance: "provider", precision: "exact" };
}

function chatGptSpendSources(payload: UnknownRecord): SubscriptionUsageSpendSource[] {
  const sources: SubscriptionUsageSpendSource[] = [];
  if (payload.credits !== undefined && payload.credits !== null) {
    const credits = requiredRecord(payload.credits, "ChatGPT", "credits");
    if (typeof credits.has_credits !== "boolean" || typeof credits.unlimited !== "boolean") throw malformed("ChatGPT", "credits is invalid");
    if (credits.unlimited) {
      sources.push({ kind: "prepaid", availability: "unlimited" });
    } else if (credits.balance !== undefined && credits.balance !== null) {
      sources.push(prepaidBalance(exactCreditCount(credits.balance, "credits.balance")));
    } else if (credits.has_credits) {
      sources.push({ kind: "prepaid", availability: "available" });
    } else {
      sources.push({ kind: "prepaid", availability: "empty" });
    }
  }
  if (payload.spend_control !== undefined && payload.spend_control !== null) {
    const spendControl = requiredRecord(payload.spend_control, "ChatGPT", "spend_control");
    if (typeof spendControl.reached !== "boolean") throw malformed("ChatGPT", "spend_control.reached is missing or invalid");
    if (spendControl.individual_limit === undefined || spendControl.individual_limit === null) {
      sources.push({ kind: "automatic-billing", enablement: "unknown" });
    } else {
      const limit = requiredRecord(spendControl.individual_limit, "ChatGPT", "spend_control.individual_limit");
      const resetAt = requiredNumber(limit, "reset_at", "ChatGPT");
      requiredNumber(limit, "reset_after_seconds", "ChatGPT");
      sources.push({
        kind: "automatic-billing",
        enablement: "unknown",
        used: exactCreditCount(limit.used, "spend_control.individual_limit.used"),
        limit: exactCreditCount(limit.limit, "spend_control.individual_limit.limit"),
        remaining: exactCreditCount(limit.remaining, "spend_control.individual_limit.remaining"),
        resetId: String(resetAt),
        resetAtMs: resetAt * 1000,
      });
    }
  }
  return sources;
}

function chatGptMetrics(raw: unknown) {
  const payload = requiredRecord(raw, "ChatGPT", "response");
  const plan = requiredString(payload, "plan_type", "ChatGPT");
  const rateLimit = payload.rate_limit === undefined || payload.rate_limit === null ? undefined : requiredRecord(payload.rate_limit, "ChatGPT", "rate_limit");
  const accountScope = { kind: "account" } as const;
  const metrics = rateLimit === undefined ? [] : [
    chatGptWindow(rateLimit.primary_window, "primary_window", "Primary window", accountScope, 0),
    chatGptWindow(rateLimit.secondary_window, "secondary_window", "Secondary window", accountScope, 1),
  ].filter((metric): metric is SubscriptionUsageMetric => metric !== undefined);
  const additional = payload.additional_rate_limits;
  if (additional !== undefined && additional !== null) {
    if (!Array.isArray(additional)) throw malformed("ChatGPT", "additional_rate_limits is invalid");
    for (const [index, entry] of additional.entries()) {
      const item = requiredRecord(entry, "ChatGPT", "additional_rate_limits entry");
      const label = requiredString(item, "limit_name", "ChatGPT");
      const feature = requiredString(item, "metered_feature", "ChatGPT");
      const limit = requiredRecord(item.rate_limit, "ChatGPT", `additional_rate_limits.${feature}`);
      const scope = { kind: "feature", featureKey: feature } as const;
      const primary = chatGptWindow(limit.primary_window, `${feature}:primary_window`, `${label} primary window`, scope, 100 + index * 2);
      const secondary = chatGptWindow(limit.secondary_window, `${feature}:secondary_window`, `${label} secondary window`, scope, 101 + index * 2);
      if (primary) metrics.push(primary);
      if (secondary) metrics.push(secondary);
    }
  }
  return { metrics, plan, spendSources: chatGptSpendSources(payload) };
}

function optionalDate(record: UnknownRecord, key: string): number | null | undefined {
  if (!(key in record)) return undefined;
  if (record[key] === null) return null;
  if (typeof record[key] !== "string") throw malformed("ChatGPT", `${key} is invalid`);
  const value = Date.parse(record[key]);
  if (!Number.isSafeInteger(value) || value < 0) throw malformed("ChatGPT", `${key} is invalid`);
  return value;
}
function resetCreditCounts(raw: unknown): { availableCount: number } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = requiredRecord(raw, "ChatGPT", "rate_limit_reset_credits");
  const availableCount = requiredNumber(value, "available_count", "ChatGPT");
  if (!Number.isSafeInteger(availableCount)) throw malformed("ChatGPT", "reset credit counts are invalid");
  return { availableCount };
}
function resetCreditDetails(raw: unknown, counts: { availableCount: number }): SubscriptionUsageResetCredits {
  const payload = requiredRecord(raw, "ChatGPT", "reset credits response");
  const credits = Array.isArray(payload.credits) ? payload.credits.map((rawCredit) => {
    const credit = requiredRecord(rawCredit, "ChatGPT", "reset credit"); const grantedAtMs = optionalDate(credit, "granted_at"); const expiresAtMs = optionalDate(credit, "expires_at");
    return { id: requiredString(credit, "id", "ChatGPT"), resetType: requiredString(credit, "reset_type", "ChatGPT"), status: requiredString(credit, "status", "ChatGPT"), ...(grantedAtMs === undefined || grantedAtMs === null ? {} : { grantedAtMs }), ...(expiresAtMs === undefined ? {} : { expiresAtMs }), ...(typeof credit.title === "string" ? { title: boundedProviderText(credit.title) } : {}), ...(typeof credit.description === "string" ? { description: boundedProviderText(credit.description) } : {}) };
  }) : [];
  return { ...counts, credits };
}
export function createChatGPTResetConsumer(fetchImpl: FetchLike = fetch): SubscriptionUsageResetConsumer {
  return async (input) => {
    try {
      const response = await fetchImpl(CHATGPT_RESET_CONSUME_URL, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${Redacted.value(input.accessToken)}`, ...(input.accountId === undefined ? {} : { "ChatGPT-Account-Id": input.accountId }) }, body: JSON.stringify({ redeem_request_id: input.providerKey, credit_id: input.creditId }), signal: AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) return { kind: "uncertain" };
      const payload = requiredRecord(await readBoundedSubscriptionUsageJson(response), "ChatGPT", "consume response");
      const code = payload.code;
      if (code === "reset") return { kind: "reset" };
      if (code === "nothing_to_reset") return { kind: "nothingToReset" };
      if (code === "no_credit") return { kind: "noCredit" };
      if (code === "already_redeemed") return { kind: "alreadyRedeemed" };
      return { kind: "uncertain" };
    } catch { return { kind: "uncertain" }; }
  };
}

const freshChatGpt: FreshTokens = async (context) => {
  if (context.account.credential.type !== "oauth") throw new Error("OAuth credentials are required");
  return ensureFreshChatGPTTokens(oauthTokens(context.account.credential), { caller: "usage check", signal: context.signal, compareAndSet: context.compareAndSetTokens });
};

/** Reads provider-reported ChatGPT subscription windows after using the shared refresh seam. */
export function createChatGPTUsageReader(fetchImpl: FetchLike = fetch, fresh: FreshTokens = freshChatGpt): SubscriptionUsageReader {
  return async (context) => {
    if (readerIdentity(context) === undefined) return { kind: "identity-unavailable" };
    if (context.account.credential.type !== "oauth") return unsupportedSubscriptionUsageOutcome();
    let tokens: StoredTokens;
    try { tokens = await fresh(context); } catch (error) { return permanentRefreshFailure(error) ? { kind: "expired-auth" } : { kind: "fetch-failure" }; }
    const response = await usageRequest(fetchImpl, CHATGPT_USAGE_URL, {
      accept: "application/json",
      authorization: `Bearer ${Redacted.value(tokens.accessToken)}`,
      ...(tokens.accountId === undefined ? {} : { "ChatGPT-Account-Id": tokens.accountId }),
    }, context.signal);
    if (!(response instanceof Response)) return response;
    const decoded = await usageJson(response);
    if (decoded.kind === "failed") return decoded.outcome;
    try {
      const payload = requiredRecord(decoded.value, "ChatGPT", "response"); const normalized = chatGptMetrics(payload); const counts = resetCreditCounts(payload.rate_limit_reset_credits); let resetCredits;
      if (counts !== undefined) {
        if (counts.availableCount === 0) resetCredits = { ...counts, credits: [] };
        else {
          const detailResponse = await usageRequest(fetchImpl, CHATGPT_RESET_CREDITS_URL, { accept: "application/json", authorization: `Bearer ${Redacted.value(tokens.accessToken)}`, ...(tokens.accountId === undefined ? {} : { "ChatGPT-Account-Id": tokens.accountId }) }, context.signal);
          if (detailResponse instanceof Response && detailResponse.ok) { const detail = await usageJson(detailResponse); resetCredits = detail.kind === "parsed" ? resetCreditDetails(detail.value, counts) : { ...counts, credits: [] }; } else resetCredits = { ...counts, credits: [] };
        }
      }
      return usageReport(context, normalized.metrics, { plan: normalized.plan, spendSources: normalized.spendSources, ...(resetCredits === undefined ? {} : { resetCredits }) });
    } catch {
      return { kind: "fetch-failure" };
    }
  };
}
