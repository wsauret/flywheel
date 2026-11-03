import { Schema } from "effect";
import { AuthStoreMutationError } from "../../../infra/auth/auth-store-mutations.js";
import type { AuthStoreCondition } from "../../../infra/auth/auth-store.js";
import { isAbortError } from "../../../infra/abort.js";
import type { ProviderRecovery } from "../../../infra/llm/provider-error-copy.js";
import { ChatGptAdapterApiError } from "./chatgpt-adapter/sse.js";
import { classifyQuotaError, ContextLengthExceededError, LlmStreamError, ModelAccessRefusedError, OutputLengthExceededError, ProviderRequestValidationError, QuotaCoordinationError, QuotaExhaustedError, RouteUnavailableError } from "./errors.js";
import { ThinkingStallError } from "./thinking-stall.js";

// Raw SDK/HTTP errors are classified ONCE here, at the shared LLM boundary,
// into typed failures; retry policy dispatches on tags only. All duck-typing of
// statuses, headers, and message patterns lives in this module so the schedule
// keeps pure policy (caps, backoff, jitter).

const failureFields = {
  message: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  /** Provider-supplied backoff hint (retry-after / retry-after-ms headers, or a
   *  pre-classified LlmStreamError.retryDelayMs). Present only when the
   *  provider genuinely said how long to wait; the in-place retry of this
   *  request waits that long. */
  retryAfterMs: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Unknown),
};
/** Provider adapter authentication failed without an HTTP status. */
export class ProviderAuthenticationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderAuthenticationError";
  }
}

/** Provider says back off (429 or a rate-limit frame): prefers the carried hint. */
class RateLimitFailure extends Schema.TaggedError<RateLimitFailure>()("RateLimitFailure", failureFields) {}
/** Adapter-classified saturation (LlmStreamError kind "overload"): terminal for
 *  the in-stream retry loop; the outer resilience layer owns recovery. */
class OverloadedFailure extends Schema.TaggedError<OverloadedFailure>()("OverloadedFailure", failureFields) {}
/** Network resets, torn streams, timeouts: retryable with exponential backoff. */
class TransientNetworkFailure extends Schema.TaggedError<TransientNetworkFailure>()("TransientNetworkFailure", failureFields) {}
/** 401/403: credentials are wrong or expired; retrying cannot help. */
class AuthFailure extends Schema.TaggedError<AuthFailure>()("AuthFailure", failureFields) {}
/** 400/404 or provider-declared do-not-retry: the request itself is malformed. */
class InvalidRequestFailure extends Schema.TaggedError<InvalidRequestFailure>()("InvalidRequestFailure", failureFields) {}
class ContextOverflowFailure extends Schema.TaggedError<ContextOverflowFailure>()("ContextOverflowFailure", failureFields) {}
class OutputOverflowFailure extends Schema.TaggedError<OutputOverflowFailure>()("OutputOverflowFailure", failureFields) {}
/** The account does not grant this model, or this model at its extended
 *  context window. A retry on the same candidate would repeat it, and the
 *  provider's other models are unaffected, so nothing retries and nothing
 *  marks. Another account can grant the model, so the walk tries the next
 *  candidate. */
class ModelAccessFailure extends Schema.TaggedError<ModelAccessFailure>()("ModelAccessFailure", failureFields) {}
/** The candidate's route cannot run on this machine, such as a provider whose local program is missing. Nothing
 *  reached the provider, so nothing retries on this candidate and nothing marks; the walk tries the next one. */
class RouteUnavailableFailure extends Schema.TaggedError<RouteUnavailableFailure>()("RouteUnavailableFailure", failureFields) {}
/** Quota, credit, or plan entitlement is spent: retrying cannot pay for it. */
class QuotaExhaustedFailure extends Schema.TaggedError<QuotaExhaustedFailure>()("QuotaExhaustedFailure", failureFields) {}
/** The account's availability could not be coordinated across processes:
 *  retrying would spend an account the other processes are still metering. */
class QuotaCoordinationFailure extends Schema.TaggedError<QuotaCoordinationFailure>()("QuotaCoordinationFailure", failureFields) {}
/** A strict credential-store mutation refused bytes that this request captured. */
class AuthConditionFailure extends Error {
  readonly _tag = "AuthConditionFailure" as const;
  constructor(readonly conditions: readonly AuthStoreCondition[], override readonly cause: AuthStoreMutationError) {
    super(cause.message, { cause });
  }
}
class RequestAbortedFailure extends Schema.TaggedError<RequestAbortedFailure>()("RequestAbortedFailure", failureFields) {}
/** Unrecognized failures stay outside the automatic provider failover walk. */
class UnknownProviderFailure extends Schema.TaggedError<UnknownProviderFailure>()("UnknownProviderFailure", failureFields) {}

export type ProviderFailure =
  | RateLimitFailure
  | OverloadedFailure
  | TransientNetworkFailure
  | AuthFailure
  | InvalidRequestFailure
  | ContextOverflowFailure
  | OutputOverflowFailure
  | ModelAccessFailure
  | RouteUnavailableFailure
  | QuotaExhaustedFailure
  | QuotaCoordinationFailure
  | AuthConditionFailure
  | RequestAbortedFailure
  | UnknownProviderFailure;

/** The failures the access-provider chain may answer by trying the next
 *  candidate: this candidate cannot serve the request right now because its
 *  own quota is spent, it is throttling, it is saturated, it is unreachable,
 *  or its account does not grant the model. Every other failure is about the
 *  request and would repeat on any candidate, so the chain never sees it and
 *  the request surfaces it under its own name. */
export type FailoverFailure = RateLimitFailure | OverloadedFailure | TransientNetworkFailure | QuotaExhaustedFailure | AuthConditionFailure | ModelAccessFailure | RouteUnavailableFailure;

export function isFailoverFailure(failure: ProviderFailure): failure is FailoverFailure {
  switch (failure._tag) {
    case "RateLimitFailure":
    case "OverloadedFailure":
    case "TransientNetworkFailure":
    case "QuotaExhaustedFailure":
    case "AuthConditionFailure":
    case "ModelAccessFailure":
    case "RouteUnavailableFailure":
      return true;
    case "AuthFailure":
    case "InvalidRequestFailure":
    case "ContextOverflowFailure":
    case "OutputOverflowFailure":
    case "QuotaCoordinationFailure":
    case "RequestAbortedFailure":
    case "UnknownProviderFailure":
      return false;
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

/** A failure raised by the provider SDK during one request attempt.
 *
 * `failure` is the canonical classification used by policy. `cause` is the
 * exact value raised at the SDK boundary, including non-Error values.
 */
export class ProviderAttemptFailure extends Error {
  readonly failure: Exclude<ProviderFailure, QuotaCoordinationFailure | RequestAbortedFailure>;
  override readonly cause: unknown;

  constructor(failure: Exclude<ProviderFailure, QuotaCoordinationFailure | RequestAbortedFailure>, cause: unknown) {
    super(failure.message, { cause });
    this.name = "ProviderAttemptFailure";
    this.failure = failure;
    this.cause = cause;
  }
}

export function isRetryableFailure(failure: ProviderFailure): boolean {
  switch (failure._tag) {
    case "RateLimitFailure":
    case "TransientNetworkFailure":
    case "UnknownProviderFailure":
      return true;
    case "OverloadedFailure":
    case "AuthFailure":
    case "InvalidRequestFailure":
    case "ContextOverflowFailure":
    case "OutputOverflowFailure":
    case "ModelAccessFailure":
    case "RouteUnavailableFailure":
    case "QuotaExhaustedFailure":
    case "QuotaCoordinationFailure":
    case "AuthConditionFailure":
    case "RequestAbortedFailure":
      return false;
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

/** What a later run can do after a request failed with `failure`, which is the
 *  normalized classification of its attempt. A rejected request, a rejected
 *  credential, and a model the account does not grant need a person; every
 *  other failure can clear, so a later run may send again. */
export function providerRecovery(failure: ProviderFailure): ProviderRecovery {
  switch (failure._tag) {
    case "InvalidRequestFailure":
    case "AuthFailure":
    case "ModelAccessFailure":
      return { kind: "none" };
    default:
      return { kind: "retry" };
  }
}

/** Positive evidence that the provider's service itself failed. The default
 *  stance is that a failure is NOT an outage: a durable suppression holds
 *  back every session on this machine, so it must rest on something the
 *  provider actually stated. That evidence is an HTTP failure status, a
 *  provider-declared backoff, or a backend error frame, read directly or
 *  through the stream error an adapter wrapped it in. A connection that went
 *  away states nothing: a reset, a timeout, an abnormal WebSocket close, an
 *  idle watchdog, a thinking stall. Each can equally be this machine's own
 *  doing (a sleeping laptop, a flaky proxy, a user abort, a local defect),
 *  so none of them marks. Distinct from `isFailoverFailure` advancing the
 *  walk, which is request-local and stays liberal. */
export function isProviderAttributedFailure(failure: ProviderFailure): boolean {
  switch (failure._tag) {
    case "RateLimitFailure":
    case "OverloadedFailure":
    case "TransientNetworkFailure":
      break;
    default:
      return false;
  }
  if (failure.status !== undefined || failure.retryAfterMs !== undefined) return true;
  return isProviderStated(failure.cause instanceof LlmStreamError ? failure.cause.cause : failure.cause);
}

/** Whether a wire error is the provider's own word: an HTTP status or a
 *  ChatGPT backend error frame, as opposed to the transport reporting that
 *  the connection is gone. */
function isProviderStated(wire: unknown): boolean {
  return hasStatus(wire) || wire instanceof ChatGptAdapterApiError || providerServiceCode(wire) !== undefined;
}

/** Streaming SDK errors can retain the provider's code or type without a status. */
function providerServiceCode(error: unknown): "rate_limit_exceeded" | "overloaded_error" | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  for (const value of ["code" in error ? error.code : undefined, "type" in error ? error.type : undefined]) {
    if (value === "rate_limit_exceeded" || value === "overloaded_error") return value;
  }
  return undefined;
}

function hasStatus<Failure>(error: Failure): error is Failure & { status: number } {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  );
}

function hasHeaders<Failure>(error: Failure): error is Failure & { headers: { get(name: string): string | null } } {
  if (typeof error !== "object" || error === null || !("headers" in error)) return false;
  const headers = error.headers;
  return (
    typeof headers === "object" &&
    headers !== null &&
    "get" in headers &&
    typeof headers.get === "function"
  );
}

function isOverloadedEnvelope(error: unknown): boolean {
  return (hasStatus(error) && error.status === 529) ||
    (error instanceof Error && error.message.includes('"type":"overloaded_error"'));
}

// Network resets and torn streams are transient; a torn JSON stream can surface
// as a SyntaxError.
const NETWORK_ERROR_PATTERN =
  /Premature close|request ended without sending any chunks|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket hang up|Connection reset by peer|connection.?refused|connection.?lost|websocket.?closed|other side closed|fetch failed|upstream.?connect|reset before headers|http2 request did not get a response|terminated/i;

export function isTransientNetworkError(error: unknown): boolean {
  // The runtime's fetch ends a response that stays silent for 300 s with a TimeoutError, also after its first bytes.
  // That is the same stall as a response that sends only headers, which the Anthropic client reports as a connection
  // timeout, so both retry in place.
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  if (!(error instanceof Error)) return false;
  if ("code" in error && (error.code === "ERR_STREAM_PREMATURE_CLOSE" || (!hasStatus(error) && error.code === "ECONNRESET"))) return true;
  if (error instanceof SyntaxError) return true; // torn stream → broken JSON
  return NETWORK_ERROR_PATTERN.test(error.message);
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (!hasHeaders(error)) return undefined;

  // Anthropic and OpenAI/ChatGPT backend both emit `retry-after-ms` for millisecond-resolution
  // backoff hints. Prefer it over `retry-after` (which rounds to seconds).
  const msValue = error.headers.get("retry-after-ms");
  if (msValue) {
    const ms = Number(msValue);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }

  const value = error.headers.get("retry-after");
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  const delayMs = dateMs - Date.now();
  return delayMs > 0 ? delayMs : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Classify a raw provider error into exactly one typed failure. Pre-classified
 *  LlmStreamError kinds map 1:1; raw SDK/HTTP errors are probed here and
 *  nowhere else. Unrecognized errors remain UnknownProviderFailure. */
export function classifyProviderFailure(error: unknown): ProviderFailure {
  if (isAbortError(error)) {
    return new RequestAbortedFailure({ message: messageOf(error), cause: error });
  }

  if (error instanceof LlmStreamError) {
    const base = {
      message: error.message,
      ...(error.retryDelayMs !== undefined ? { retryAfterMs: error.retryDelayMs } : {}),
      cause: error,
    };
    switch (error.kind) {
      case "rate_limit": return new RateLimitFailure(base);
      case "overload": return new OverloadedFailure(base);
      case "transient": return new TransientNetworkFailure(base);
      case "unknown": return new UnknownProviderFailure(base);
    }
  }

  if (error instanceof ContextLengthExceededError) {
    return new ContextOverflowFailure({ message: error.message, cause: error });
  }
  if (error instanceof OutputLengthExceededError) {
    return new OutputOverflowFailure({ message: error.message, cause: error });
  }
  if (error instanceof ModelAccessRefusedError) {
    return new ModelAccessFailure({ message: error.message, cause: error });
  }
  if (error instanceof RouteUnavailableError) {
    return new RouteUnavailableFailure({ message: error.message, cause: error });
  }
  if (error instanceof QuotaExhaustedError) {
    return new QuotaExhaustedFailure({ message: error.message, cause: error });
  }
  if (error instanceof QuotaCoordinationError) {
    return new QuotaCoordinationFailure({ message: error.message, cause: error });
  }
  if (error instanceof AuthStoreMutationError) {
    return new AuthConditionFailure(error.conditions, error);
  }
  if (error instanceof ProviderRequestValidationError) {
    return new InvalidRequestFailure({ message: error.message, cause: error });
  }
  if (error instanceof ProviderAuthenticationError) {
    return new AuthFailure({ message: error.message, cause: error });
  }
  // The watchdog's inference that the provider stopped delivering mid-turn:
  // another candidate is the remedy, exactly as for an outage, but silence is
  // not wire evidence, so `isProviderAttributedFailure` never marks on it.
  if (error instanceof ThinkingStallError) {
    return new TransientNetworkFailure({ message: error.message, cause: error });
  }

  const status = hasStatus(error) ? error.status : undefined;
  const base = {
    message: messageOf(error),
    ...(status !== undefined ? { status } : {}),
    cause: error,
  };

  // The provider's explicit do-not-retry/do-retry header wins over status
  // heuristics: "false" below 500 is a terminal request defect; "true" forces
  // an otherwise-terminal status back into the retryable lane.
  let forceRetryable = false;
  if (hasHeaders(error)) {
    const shouldRetry = error.headers.get("x-should-retry");
    if (shouldRetry === "false" && status !== undefined && status < 500) {
      return new InvalidRequestFailure(base);
    }
    if (shouldRetry === "true") forceRetryable = true;
  }

  if (classifyQuotaError(status, base.message, error)) {
    return new QuotaExhaustedFailure(base);
  }

  const serviceCode = status === undefined ? providerServiceCode(error) : undefined;
  if (status === 429 || serviceCode === "rate_limit_exceeded") {
    const retryAfterMs = getRetryAfterMs(error);
    return new RateLimitFailure({ ...base, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  }
  if (isOverloadedEnvelope(error) || serviceCode === "overloaded_error") {
    const retryAfterMs = getRetryAfterMs(error);
    return new OverloadedFailure({ ...base, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  }

  if (!forceRetryable && status !== undefined) {
    if (status === 401 || status === 403) return new AuthFailure(base);
    if (status === 400 || status === 404) return new InvalidRequestFailure(base);
    // 501 states a permanent condition (not implemented), unlike its 5xx siblings.
    if (status === 501) return new InvalidRequestFailure(base);
  }

  // Every other 5xx is a transient upstream failure. Gateway and edge errors
  // often arrive with no recognizable body, and an unclassified status-bearing
  // failure would land in UnknownProviderFailure, which the outage policy
  // treats as unattributable - wrong for a status the wire itself stated.
  if (status !== undefined && status >= 500) {
    return new TransientNetworkFailure(base);
  }

  if (isTransientNetworkError(error)) {
    return new TransientNetworkFailure(base);
  }

  return new UnknownProviderFailure(base);
}

/** Normalize one SDK failure while retaining both its outer provenance and the
 * first typed failure in its cause chain. Abort and quota-coordination failures
 * take precedence because they are strict stops even when an SDK wraps them. */
export function normalizeProviderAttemptFailure(error: unknown): ProviderAttemptFailure {
  if (error instanceof ProviderAttemptFailure) return error;

  const outerFailure = classifyProviderFailure(error);
  if (outerFailure._tag === "RequestAbortedFailure" || outerFailure._tag === "QuotaCoordinationFailure") {
    throw error;
  }

  const visited = new Set<unknown>([error]);
  let current = error instanceof Error ? error.cause : undefined;
  let knownFailure = outerFailure._tag === "UnknownProviderFailure" ? undefined : outerFailure;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const failure = classifyProviderFailure(current);
    if (failure._tag === "RequestAbortedFailure" || failure._tag === "QuotaCoordinationFailure") {
      throw current;
    }
    if (knownFailure === undefined && failure._tag !== "UnknownProviderFailure") {
      knownFailure = failure;
    }
    current = current instanceof Error ? current.cause : undefined;
  }

  return new ProviderAttemptFailure(knownFailure ?? outerFailure, error);
}
