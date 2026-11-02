import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import { ContextLengthExceededError, LlmStreamError, ModelAccessRefusedError, OutputLengthExceededError, ProviderRequestValidationError, QuotaCoordinationError, QuotaExhaustedError, StreamIdleTimeoutError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { ChatGptAdapterApiError } from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/sse.js";
import { assertChatGptAccountUnchanged } from "../../../../../src/orchestration/agent-runtime/llm/openai-chatgpt.js";
import {
  classifyProviderFailure,
  isFailoverFailure,
  isProviderAttributedFailure,
  isRetryableFailure,
  normalizeProviderAttemptFailure,
  ProviderAttemptFailure,
  type ProviderFailure,
} from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { ThinkingStallError } from "../../../../../src/orchestration/agent-runtime/llm/thinking-stall.js";

interface StringRecord { [key: string]: string }

function statusError(status: number, headers?: StringRecord): Error {
  return Object.assign(new Error(`status ${status}`), {
    status,
    ...(headers ? { headers: new Headers(headers) } : {}),
  });
}

function tagOf(error: unknown): ProviderFailure["_tag"] {
  return classifyProviderFailure(error)._tag;
}
function retryAfterMs(error: unknown): number | undefined {
  const failure = classifyProviderFailure(error);
  return "retryAfterMs" in failure ? failure.retryAfterMs : undefined;
}

describe("classifyProviderFailure classification table", () => {
  test("pre-classified LlmStreamError kinds map 1:1", () => {
    expect(tagOf(new LlmStreamError("throttled", "rate_limit"))).toBe("RateLimitFailure");
    expect(tagOf(new LlmStreamError("saturated", "overload"))).toBe("OverloadedFailure");
    expect(tagOf(new LlmStreamError("blip", "transient"))).toBe("TransientNetworkFailure");
    expect(tagOf(new LlmStreamError("mystery", "unknown"))).toBe("UnknownProviderFailure");
  });

  test("LlmStreamError retryDelayMs is carried as retryAfterMs", () => {
    expect(retryAfterMs(new LlmStreamError("throttled", "rate_limit", 5_000))).toBe(5_000);
  });

  test("overflow errors are terminal", () => {
    expect(tagOf(new ContextLengthExceededError())).toBe("ContextOverflowFailure");
    expect(tagOf(new OutputLengthExceededError())).toBe("OutputOverflowFailure");
  });

  test.each([
    { name: "typed quota", error: new QuotaExhaustedError("You have hit your usage limit") },
    { name: "HTTP 402", error: Object.assign(new Error("Payment required"), { status: 402 }) },
    { name: "HTTP 400 depleted credit", error: Object.assign(new Error("Your credit balance is too low"), { status: 400 }) },
    { name: "HTTP 429 quota message", error: Object.assign(new Error("You have hit your usage limit"), { status: 429 }) },
    { name: "HTTP 429 quota code", error: Object.assign(new Error("You exceeded your current quota. Add credits."), { status: 429, code: "insufficient_quota" }) },
    { name: "statusless quota code", error: Object.assign(new Error("You exceeded your current quota. Add credits."), { code: "insufficient_quota" }) },
  ])("an exhausted quota is terminal: no retry can restore credit ($name)", ({ error }) => {
    const failure = classifyProviderFailure(error);
    expect(failure._tag).toBe("QuotaExhaustedFailure");
    expect(failure.cause).toBe(error);
    expect(isRetryableFailure(failure)).toBe(false);
    expect(isFailoverFailure(failure)).toBe(true);
    expect(isProviderAttributedFailure(failure)).toBe(false);
  });

  test.each([{ kind: "model" }, { kind: "extended-context", contextLimit: 200_000 }] as const)("a refused model access hands the request on without a retry or a mark (%o)", (refusal) => {
    const error = new ModelAccessRefusedError("Usage credits required for 1M context", refusal);
    const failure = normalizeProviderAttemptFailure(new Error("SDK request failed", { cause: error })).failure;
    expect(failure._tag).toBe("ModelAccessFailure");
    expect(failure.cause).toBe(error);
    expect(isRetryableFailure(failure)).toBe(false);
    expect(isFailoverFailure(failure)).toBe(true);
    expect(isProviderAttributedFailure(failure)).toBe(false);
  });

  test("aborts are terminal", () => {
    expect(tagOf(new DOMException("aborted", "AbortError"))).toBe("RequestAbortedFailure");
  });

  test("status-less ChatGPT account failures are authentication failures", () => {
    let authError: unknown;
    try {
      assertChatGptAccountUnchanged({ accessToken: Redacted.make("a"), refreshToken: Redacted.make("r-a"), expiresAtMs: 1, accountId: "account-a" }, { accessToken: Redacted.make("b"), refreshToken: Redacted.make("r-b"), expiresAtMs: 1, accountId: "account-b" });
    } catch (error) {
      authError = error;
    }
    expect(tagOf(authError)).toBe("AuthFailure");
  });

  test("HTTP status mapping", () => {
    expect(tagOf(statusError(400))).toBe("InvalidRequestFailure");
    expect(tagOf(statusError(401))).toBe("AuthFailure");
    expect(tagOf(statusError(403))).toBe("AuthFailure");
    expect(tagOf(statusError(404))).toBe("InvalidRequestFailure");
    expect(tagOf(statusError(429))).toBe("RateLimitFailure");
    expect(tagOf(statusError(529))).toBe("OverloadedFailure");
    for (const status of [400, 401, 403, 404, 501]) {
      const error = Object.assign(new Error("insufficient_quota"), { status, code: "insufficient_quota" });
      expect(tagOf(error)).toBe(status === 401 || status === 403 ? "AuthFailure" : "InvalidRequestFailure");
    }
    for (const status of [400, 401, 418, 501]) {
      for (const code of ["rate_limit_exceeded", "overloaded_error", "ECONNRESET"]) {
        const error = Object.assign(new Error("Provider rejected request"), { status, code, type: code });
        const failure = normalizeProviderAttemptFailure(new Error("SDK operation failed", { cause: error })).failure;
        expect(failure._tag).toBe(status === 401 ? "AuthFailure" : status === 418 ? "UnknownProviderFailure" : "InvalidRequestFailure");
        expect(isFailoverFailure(failure)).toBe(false);
      }
    }
  });

  test("5xx statuses are transient upstream failures, except 501 which states a permanent condition", () => {
    expect(tagOf(statusError(500))).toBe("TransientNetworkFailure");
    expect(tagOf(statusError(502))).toBe("TransientNetworkFailure");
    expect(tagOf(statusError(503))).toBe("TransientNetworkFailure");
    expect(tagOf(statusError(504))).toBe("TransientNetworkFailure");
    expect(tagOf(statusError(530))).toBe("TransientNetworkFailure");
    expect(tagOf(statusError(501))).toBe("InvalidRequestFailure");
  });

  test("429 carries retry-after headers, preferring millisecond resolution", () => {
    expect(retryAfterMs(statusError(429, { "retry-after": "3" }))).toBe(3_000);
    expect(retryAfterMs(statusError(429, { "retry-after-ms": "250", "retry-after": "3" }))).toBe(250);
  });

  test("x-should-retry false below 500 is a terminal request defect", () => {
    expect(tagOf(statusError(422, { "x-should-retry": "false" }))).toBe("InvalidRequestFailure");
  });

  test("x-should-retry true forces a terminal status back to retryable", () => {
    const failure = classifyProviderFailure(statusError(400, { "x-should-retry": "true" }));
    expect(isRetryableFailure(failure)).toBe(true);
  });

  test("network patterns and torn streams are transient", () => {
    expect(tagOf(new Error("socket hang up"))).toBe("TransientNetworkFailure");
    expect(tagOf(new SyntaxError("Unexpected end of JSON input"))).toBe("TransientNetworkFailure");
    expect(tagOf(Object.assign(new Error("closed"), { code: "ERR_STREAM_PREMATURE_CLOSE" }))).toBe("TransientNetworkFailure");
    // The runtime's fetch ends a response that stays silent for 300 s with this error, also after the first bytes.
    expect(tagOf(new DOMException("The operation timed out.", "TimeoutError"))).toBe("TransientNetworkFailure");
  });

  test("unrecognized errors default to retryable", () => {
    const failure = classifyProviderFailure(new Error("what even is this"));
    expect(failure._tag).toBe("UnknownProviderFailure");
    expect(isRetryableFailure(failure)).toBe(true);
    expect(tagOf(new Error("insufficient_quota"))).toBe("UnknownProviderFailure");
    expect(tagOf(Object.assign(new Error("Unknown error"), { code: "unrecognized_quota_code" }))).toBe("UnknownProviderFailure");
  });

  test("thinking stalls are outage-shaped: retryable, failover-eligible, never attributed", () => {
    const failure = classifyProviderFailure(new ThinkingStallError({ elapsedMs: 1, summary: "" }));
    expect(failure._tag).toBe("TransientNetworkFailure");
    expect(isRetryableFailure(failure)).toBe(true);
    expect(isFailoverFailure(failure)).toBe(true);
    expect(isProviderAttributedFailure(failure)).toBe(false);
  });
});

describe("normalizeProviderAttemptFailure", () => {
  test.each([
    { typed: new LlmStreamError("upstream reset", "transient"), tag: "TransientNetworkFailure" },
    { typed: Object.assign(new Error("Payment required"), { status: 402 }), tag: "QuotaExhaustedFailure" },
    { typed: Object.assign(new Error("usage limit reached"), { status: 429 }), tag: "QuotaExhaustedFailure" },
    { typed: Object.assign(new Error("You exceeded your current quota. Add credits."), { status: 429, code: "insufficient_quota" }), tag: "QuotaExhaustedFailure" },
    { typed: Object.assign(new Error("You exceeded your current quota. Add credits."), { code: "insufficient_quota" }), tag: "QuotaExhaustedFailure" },
  ])("retains the original failure and a nested classification ($tag)", ({ typed, tag }) => {
    const original = new Error("SDK request failed", { cause: typed });

    const normalized = normalizeProviderAttemptFailure(original);

    expect(normalized).toBeInstanceOf(ProviderAttemptFailure);
    expect(normalized.cause).toBe(original);
    expect(normalized.failure._tag).toBe(tag);
    expect(normalized.failure.cause).toBe(typed);
  });

  test("retains unknown thrown values as the original cause", () => {
    const original = { providerPayload: "unrecognized" };
    const normalized = normalizeProviderAttemptFailure(original);

    expect(normalized.cause).toBe(original);
    expect(normalized.failure._tag).toBe("UnknownProviderFailure");
    expect(normalized.failure.cause).toBe(original);
  });

  test("nested abort and quota coordination failures remain strict stops", () => {
    const abort = new DOMException("cancelled", "AbortError");
    const coordination = new QuotaCoordinationError({
      message: "meter unavailable",
      provider: "openai",
      reason: "locked",
    });

    for (const strict of [abort, coordination]) {
      const quota = Object.assign(new Error("Provider rejected request", {
        cause: new Error("transport wrapper", { cause: strict }),
      }), { status: 429, code: "insufficient_quota" });
      expect(() => normalizeProviderAttemptFailure(new Error("SDK wrapper", { cause: quota }))).toThrow(strict);
    }
  });

  test("does not re-wrap an existing attempt failure", () => {
    const normalized = normalizeProviderAttemptFailure(new Error("socket hang up"));
    expect(normalizeProviderAttemptFailure(normalized)).toBe(normalized);
  });
});

describe("isProviderAttributedFailure: durable suppression requires positive evidence", () => {
  function attributed(error: unknown): boolean {
    return isProviderAttributedFailure(classifyProviderFailure(error));
  }

  test("provider-stated failures are attributed: statuses, declared backoff, wrapped status errors, backend error frames", () => {
    expect(attributed(statusError(502))).toBe(true);
    expect(attributed(statusError(429, { "retry-after": "3" }))).toBe(true);
    expect(attributed(new LlmStreamError("throttled", "rate_limit", 5_000))).toBe(true);
    expect(attributed(new LlmStreamError("502 bad gateway", "transient", undefined, { cause: statusError(502) }))).toBe(true);
    expect(attributed(new LlmStreamError("overloaded", "overload", undefined, { cause: new ChatGptAdapterApiError("Our servers are currently overloaded.", { code: "server_error" }) }))).toBe(true);
  });

  test("a connection that went away is not attributed: the provider stated nothing", () => {
    expect(attributed(new LlmStreamError("WebSocket closed 1006 Connection ended", "transient", undefined, { cause: new Error("WebSocket closed 1006 Connection ended") }))).toBe(false);
    expect(attributed(new LlmStreamError("upstream reset", "transient", undefined, { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }))).toBe(false);
    expect(attributed(new Error("socket hang up"))).toBe(false);
    expect(attributed(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }))).toBe(false);
    expect(attributed(new DOMException("The operation timed out.", "TimeoutError"))).toBe(false);
  });

  test("adapter inferences from silence or closure are not attributed", () => {
    expect(attributed(new StreamIdleTimeoutError("OpenAI stream idle timeout", "idle"))).toBe(false);
    expect(attributed(new LlmStreamError("stream closed before response.completed", "transient"))).toBe(false);
    expect(attributed(new LlmStreamError("mystery frame", "unknown", undefined, { cause: new Error("payload") }))).toBe(false);
  });

  test("failures that never mean an outage are not attributed", () => {
    expect(attributed(new TypeError("undefined is not an object (evaluating 'this.enqueue')"))).toBe(false);
    expect(attributed(new QuotaExhaustedError("usage limit reached"))).toBe(false);
    expect(attributed(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(attributed(statusError(401))).toBe(false);
  });
});

describe("isFailoverFailure", () => {
  const advances = (error: unknown): boolean => isFailoverFailure(classifyProviderFailure(error));

  test("a candidate that cannot serve right now hands the request to the next one", () => {
    expect(advances(statusError(429))).toBe(true);
    expect(advances(new LlmStreamError("saturated", "overload"))).toBe(true);
    expect(advances(statusError(503))).toBe(true);
    expect(advances(new Error("ECONNRESET"))).toBe(true);
    expect(advances(new QuotaExhaustedError("usage limit reached"))).toBe(true);
  });

  test("a failure another candidate would repeat stops the request where it is", () => {
    expect(advances(statusError(400))).toBe(false);
    expect(advances(new ProviderRequestValidationError("openai", "input is required"))).toBe(false);
    expect(advances(new ContextLengthExceededError())).toBe(false);
    expect(advances(new OutputLengthExceededError())).toBe(false);
    expect(advances(statusError(401))).toBe(false);
    expect(advances(new Error("unrecognized provider frame"))).toBe(false);
    expect(advances(new LlmStreamError("mystery frame", "unknown"))).toBe(false);
    expect(advances(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(advances(new QuotaCoordinationError({ message: "no lease", provider: "chatgpt", reason: "lease" }))).toBe(false);
  });
});

