import { Schema } from "effect";
import type { QuotaExhaustionObservation } from "./provider-availability-types.js";
import type { ProviderErrorCopy, ProviderRecovery } from "../../../infra/llm/provider-error-copy.js";
import type { ModelRefusal } from "../../../infra/auth/provider-model-catalog-store.js";
import type { RefusedPart } from "../../../infra/llm/content-repair.js";

type RetryableErrorKind = "rate_limit" | "overload" | "transient" | "unknown";

export class ContextLengthExceededError extends Error {
  constructor(message = "Context length exceeded", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContextLengthExceededError";
  }
}

/** The provider's content filter stopped the response. The request was accepted, so the content streamed before
 *  the stop stays, and the loop nudges the model to continue. It is not a refusal of the conversation content. */
export class ContentFilteredError extends Error {
  constructor(message = "Content filtered", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContentFilteredError";
  }
}

export class OutputLengthExceededError extends Error {
  readonly truncatedContent: string;

  constructor(message = "Output length exceeded", truncatedContent = "", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OutputLengthExceededError";
    this.truncatedContent = truncatedContent;
  }
}

/** The account cannot pay for the request: quota, credit, or plan entitlement
 *  is exhausted. Terminal - only a plan or billing change clears it. */
export class QuotaExhaustedError extends Error {
  readonly quotaObservation: QuotaExhaustionObservation | undefined;

  constructor(message = "Provider quota exhausted", options?: { cause?: unknown; quotaObservation?: QuotaExhaustionObservation }) {
    super(message, options);
    this.name = "QuotaExhaustedError";
    this.quotaObservation = options?.quotaObservation;
  }
}

/** The context window, in tokens, that every Anthropic account grants a model whose extended window it refuses. */
export const ANTHROPIC_STANDARD_CONTEXT_WINDOW = 200_000;

/** The account does not grant one model, or that model above a context window. It says nothing about the
 *  provider's health or the account's quota: the account's other models stay usable, so the request is never
 *  retried on this candidate and leaves no outage mark and no quota mark. The walk records the refusal for the
 *  account and tries the next candidate, which can be another account that grants the model. */
export class ModelAccessRefusedError extends Error {
  readonly refusal: ModelRefusal;

  constructor(message: string, refusal: ModelRefusal, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelAccessRefusedError";
    this.refusal = refusal;
  }
}

/** The candidate's route cannot run on this machine: a program that it needs is missing or unusable, such as a
 *  missing or too-old Claude CLI. No request reached the provider, so the provider's health and the account's quota
 *  are unknown, and a retry on this candidate meets the same machine. The walk tries the next candidate. */
export class RouteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteUnavailableError";
  }
}

/** The texts Anthropic sends with a 429 when the account must buy usage
 *  credits for a long-context request ("Extra usage is required for long
 *  context requests", "Usage credits are required for long context
 *  requests"), and the Claude CLI's own form of them ("Usage credits required
 *  for 1M context"). The status alone reads as a rate limit. */
const EXTENDED_CONTEXT_REFUSAL_PATTERN = /(?:extra usage|usage credits) (?:is |are )?required for (?:long|1M) context/i;

/** The refusal of the extended window that `message` states, or undefined when it states none. */
export function extendedContextRefusal(message: string, options?: { cause?: unknown }): ModelAccessRefusedError | undefined {
  if (!EXTENDED_CONTEXT_REFUSAL_PATTERN.test(message)) return undefined;
  return new ModelAccessRefusedError(message, { kind: "extended-context", contextLimit: ANTHROPIC_STANDARD_CONTEXT_WINDOW }, options);
}

/** Terminal provider quota evidence whose durable routing effect is owned by
 * the caller after it saves the failed turn. The bound settlement targets the
 * exact candidate, including its spend mode. */
/** A quota decision this process could not coordinate with the other
 *  processes spending from the account: a suppression the durable authority
 *  did not record, an authority it could not read, or a meter lease it could
 *  not claim. Serving the request from another provider on process-local
 *  state alone would spend a second account while every other process still
 *  believes the first one can serve, so the request fails instead - never
 *  retried, never treated as a connection blip. */
export class QuotaCoordinationError extends Schema.TaggedErrorClass<QuotaCoordinationError>()("QuotaCoordination", {
  message: Schema.String,
  /** The provider whose account could not be coordinated, or every provider
   *  the binding names when the authority itself is what failed. */
  provider: Schema.String,
  reason: Schema.String,
}) {}

/** Bodies that name a spent allowance rather than a rate window. Wire-agnostic:
 *  Copilot says "premium request", OpenAI says "insufficient_quota", proxies
 *  vary the phrasing of "usage limit". */
const QUOTA_MESSAGE_PATTERN = /usage.?limit|insufficient_quota|out of budget|quota.?exceeded|premium request/i;
const DEPLETED_CREDIT_PATTERN = /credit balance.*(?:too low|depleted|exhausted)/i;

/** The error codes with which OpenAI and the ChatGPT backend name a spent allowance. */
export const QUOTA_CODES: ReadonlySet<string> = new Set(["insufficient_quota", "usage_not_included", "usage_limit_reached"]);

/** Recognize spent-account evidence from HTTP rejections and SDK stream errors.
 * The OpenAI SDK preserves `insufficient_quota` in `code` on HTTP 429 and
 * statusless SSE errors. Message rules require their known HTTP statuses;
 * unrelated statuses and plain rate limits stay with the caller.
 * The returned quota error retains the original cause. */
export function classifyQuotaError(status: number | undefined, message: string, cause: unknown): QuotaExhaustedError | undefined {
  if (status === 402) return new QuotaExhaustedError(message, { cause });
  if ((status === undefined || status === 429) && typeof cause === "object" && cause !== null && "code" in cause && cause.code === "insufficient_quota") {
    return new QuotaExhaustedError(message, { cause });
  }
  if ((status === 400 || status === 429) && DEPLETED_CREDIT_PATTERN.test(message)) return new QuotaExhaustedError(message, { cause });
  if (status === 429 && QUOTA_MESSAGE_PATTERN.test(message)) return new QuotaExhaustedError(message, { cause });
  return undefined;
}

export const SUBSCRIPTION_PAID_REVIEW_DETAIL = "Subscription paid capacity requires review. Open Auth and select the account.";

/** The walk exhausted its candidates. Copy is request-local presentation;
 * message and detail retain their existing control and legacy contracts. */
export class AllCandidatesExhaustedError extends Schema.TaggedErrorClass<AllCandidatesExhaustedError>()("AllCandidatesExhausted", {
  message: Schema.String,
  detail: Schema.optional(Schema.String),
}) {
  readonly copy?: ProviderErrorCopy;
  /** What a later request can do, from the same evidence as the copy. An
   *  unattended caller, such as an agent of a workflow, waits or retries by it. */
  readonly recovery: ProviderRecovery;

  constructor(input: { message: string; detail?: string; copy?: ProviderErrorCopy; recovery: ProviderRecovery }) {
    super({ message: input.message, ...(input.detail === undefined ? {} : { detail: input.detail }) });
    this.copy = input.copy;
    this.recovery = input.recovery;
  }
}

export class ProviderRequestValidationError extends Error {
  readonly provider: string;
  readonly issue: string;

  constructor(provider: string, issue: string, options?: { cause?: unknown }) {
    super(`${provider} request validation failed: ${issue}`, options);
    this.name = "ProviderRequestValidationError";
    this.provider = provider;
    this.issue = issue;
  }
}

/** The provider refused the request because of conversation content. It is a request validation error, so the
 *  walk neither retries nor advances: every candidate receives the same content. `cause` is the error the adapter
 *  would throw without this classification, and its message is the failure text the person reads. `reason` is the
 *  provider's own message without a leading wire part path. `part` is the canonical tool result part the refusal
 *  names, or undefined when the refusal names no part that the adapter can locate. */
export class ContentRefusedError extends ProviderRequestValidationError {
  declare readonly cause: Error;
  readonly reason: string;
  readonly part: RefusedPart | undefined;

  constructor(provider: string, refused: Error, refusal: { readonly reason: string; readonly part: RefusedPart | undefined }) {
    super(provider, refusal.reason, { cause: refused });
    this.name = "ContentRefusedError";
    this.reason = refusal.reason;
    this.part = refusal.part;
  }
}

export class LlmStreamError extends Error {
  readonly retryDelayMs: number | undefined;
  readonly kind: RetryableErrorKind;

  constructor(
    message: string,
    kind: RetryableErrorKind = "unknown",
    retryDelayMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmStreamError";
    this.kind = kind;
    this.retryDelayMs = retryDelayMs;
  }
}

export class StreamIdleTimeoutError extends LlmStreamError {
  readonly phase: "pre-stream" | "idle";

  constructor(message: string, phase: "pre-stream" | "idle") {
    super(message, "transient");
    this.name = "StreamIdleTimeoutError";
    this.phase = phase;
  }
}
