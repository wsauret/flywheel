import { errorMessage } from "../../../../../infra/diagnostics/error-message.js";
import { classifyQuotaError, ContextLengthExceededError, LlmStreamError, ModelAccessRefusedError, QuotaExhaustedError } from "../../errors.js";
import { isTransientNetworkError } from "../../stream/provider-failure.js";

/** The typed failure that a Gemini API error stands for, from its HTTP status (`apiErrorStatus`, else the status
 *  that its message names) and its message. Another route that receives the Gemini API's own error text, such as
 *  the Antigravity engine, classifies it here, so the same response fails the same way on every Gemini route. An
 *  error that no rule names is returned unchanged for the shared provider-failure classifier. */
export function classifyGoogleError(error: unknown, apiErrorStatus: (error: Error) => number | undefined): Error {
  const message = errorMessage(error);
  const cause = error;
  const providerError = error instanceof Error ? error : new Error(String(error));
  // The SDK's ApiError states the HTTP status; other shapes state it only in
  // the message. The shared classifier must run before the rate-limit branch:
  // a 402 or a spent-quota 429 is terminal for the account, and reading it as
  // a rate limit would burn the retry schedule instead of advancing the chain.
  const status = apiErrorStatus(providerError);
  const quotaStatus = status ?? (/402/.test(message) ? 402
    : /429/.test(message) ? 429
      : undefined);
  const throttle = quotaStatus === 429 ? googleRateLimit(message, cause) : undefined;
  if (throttle) return throttle;
  const quota = classifyQuotaError(quotaStatus, message, cause);
  if (quota) return quota;
  if (/quota.?exceeded|billing (?:account|quota)|credit (?:balance|quota)/i.test(message)) return new QuotaExhaustedError(message, { cause });
  if (/context|token.*exceed|too\s+long/i.test(message)) return new ContextLengthExceededError(message, { cause });
  if (status === 404 && /\bmodels?\b/i.test(message)) return new ModelAccessRefusedError(message, { kind: "model" }, { cause });
  if (status === 429) return new LlmStreamError(message, "rate_limit", undefined, { cause });
  if (status !== undefined && status >= 500) return new LlmStreamError(message, "overload", undefined, { cause });
  if (status === undefined) {
    if (/429|rate.?limit/i.test(message)) return new LlmStreamError(message, "rate_limit", undefined, { cause });
    if (/5\d\d|overload|unavailable|temporar/i.test(message)) return new LlmStreamError(message, "overload", undefined, { cause });
  }
  // Network tears (ECONNRESET, socket hang up, Premature close) that the Google
  // SDK doesn't classify. Without this, the retry policy can't recover them.
  if (isTransientNetworkError(error)) return new LlmStreamError(message, "transient", undefined, { cause });
  return error instanceof Error ? error : new Error(String(error));
}

/** A Google quota that a wait of moments cannot clear: a per-day limit, a
 *  limit of zero, which the plan does not grant, or a billing or credit limit. */
const GOOGLE_SPENT_QUOTA_TEXT = /PerDay|per.?day|limit: 0\b|"quotaValue":\s*"0"|billing (?:account|quota)|credit (?:balance|quota)/i;

/** Google states every 429 as RESOURCE_EXHAUSTED and "Quota exceeded for
 *  metric", also a per-minute request or token limit that clears in seconds.
 *  Such a limit names a per-minute quota id or states when to retry, in a
 *  RetryInfo detail or as "Please retry in 52.7s". It is a rate limit with
 *  that delay, never a spent quota, unless it also names a spent quota. The
 *  RetryInfo detail is JSON from the SDK and Go's map form
 *  (`retryDelay:12s`) from the Antigravity engine. */
function googleRateLimit(message: string, cause: unknown): LlmStreamError | undefined {
  if (GOOGLE_SPENT_QUOTA_TEXT.test(message)) return undefined;
  const delay = /"?retryDelay"?:\s*"?(\d+(?:\.\d+)?)s\b/.exec(message) ?? /Please retry in (\d+(?:\.\d+)?)s\b/i.exec(message);
  if (delay === null && !/PerMinute|per.?minute/i.test(message)) return undefined;
  const retryDelayMs = delay === null ? undefined : Math.ceil(Number(delay[1]) * 1_000);
  return new LlmStreamError(message, "rate_limit", retryDelayMs, { cause });
}
