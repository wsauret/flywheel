import OpenAI, { APIConnectionError, APIError, BadRequestError } from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import type { ReasoningEffort as OpenAIReasoningEffort } from "openai/resources/shared.js";
import type { AccessProviderId } from "../../../infra/llm/access-provider.js";
import type { ModelInfo, ReasoningEffort } from "../../../infra/llm/models.js";
import { ChatGptAdapterApiError } from "./chatgpt-adapter/sse.js";
import { ChatGptAdapterTransportError } from "./chatgpt-adapter/types.js";
import { classifyQuotaError, ContentRefusedError, ContextLengthExceededError, LlmStreamError, OutputLengthExceededError, ProviderRequestValidationError, QUOTA_CODES, QuotaCoordinationError, QuotaExhaustedError } from "./errors.js";
import type { CompletedStopReason } from "./messages.js";
import { clampReasoningEffort, openAIReasoningEffort, type ReasoningEffortTier, supportsReasoningOff } from "./model-compat.js";
import { applyOpenAIResponsesOptions, openAIReasoningSummary } from "./openai-options.js";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";
import { cacheWriteTokens } from "./openai-usage-normalization.js";
import { getRetryAfterMs, isTransientNetworkError, normalizeProviderAttemptFailure } from "./provider-failure.js";
import type { ConversationMessage, ProviderStreamEvent, StreamOptions, ToolChoice } from "./types.js";

/** Map canonical ToolChoice to OpenAI Responses wire form. `any` becomes
 *  `"required"` (Responses' name for "must call some tool"). */
function mapOpenAIResponsesToolChoice(
  choice: ToolChoice | undefined,
): ResponseCreateParamsStreaming["tool_choice"] | undefined {
  if (!choice) return undefined;
  if (choice === "auto") return "auto";
  if (choice === "any") return "required";
  if (choice === "none") return "none";
  return { type: "function", name: choice.name };
}

interface UnknownFields { [key: string]: unknown }
interface StringFields { [key: string]: string }

// OpenAI's `prompt_cache_options` field is not declared on the SDK's
// ResponseCreateParamsStreaming; this widening is the one place we name that gap.
type OpenAIResponseParamsWithCacheOptions = ResponseCreateParamsStreaming & {
  prompt_cache_options?: { mode: "explicit" } | { ttl: "30m" };
};

/** Whether the route takes `prompt_cache_options`: the OpenAI API, for a model whose
 *  rate card prices cache writes (GPT-5.6 and later). */
function openAIAcceptsPromptCacheOptions(accessProvider: AccessProviderId, info: ModelInfo | null): boolean {
  return accessProvider === "openai_api" && (info?.cost.cacheWrite ?? 0) > 0;
}

/** The minimum lifetime that OpenAI states for the served request's cache entry, in
 *  milliseconds, or null when the response states none (ARCH-CONTEXT-012). The echoed
 *  `prompt_cache_retention` policy bounds only the maximum, so it is never evidence. */
function promptCacheTtlMs(options: unknown): number | null {
  const ttl: unknown = typeof options === "object" && options !== null && "ttl" in options ? options.ttl : undefined;
  return ttl === "30m" ? 1_800_000 : ttl === "12h" ? 43_200_000 : null;
}

const RETRY_AFTER_RE = /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i;

function parseRetryAfterMs(message: string): number | undefined {
  const match = RETRY_AFTER_RE.exec(message);
  const rawValue = match?.[1];
  const rawUnit = match?.[2];
  if (rawValue === undefined || rawUnit === undefined) return undefined;
  const value = Number(rawValue);
  const unit = rawUnit.toLowerCase();
  if (unit === "ms") return Math.round(value);
  return Math.round(value * 1000);
}

const REQUEST_VALIDATION_CODES: ReadonlySet<string> = new Set(["invalid_prompt", "invalid_request_error", "bad_request_error", "missing_required_parameter", "unsupported_parameter"]);

/** Classify a Responses failure frame. `error` is the frame's error payload, or the SDK `APIError` that a
 *  streamed error frame became: its `type` stands in for a missing `code`, its response headers supply the
 *  retry delay, and it stays the `cause` of the classified error. */
export function classifyResponseFailed(
  error: { code?: string | null; type?: string | null; message?: string | null; headers?: Headers } | undefined,
  incompleteReason: string | undefined,
  quotaObservation?: QuotaExhaustedError["quotaObservation"],
): Error {
  if (!error) {
    const msg = incompleteReason ? `incomplete: ${incompleteReason}` : "Unknown error";
    return new LlmStreamError(msg, "transient");
  }

  const code = error.code ?? error.type ?? undefined;
  const message = error.message ?? "Unknown error";
  // Preserve the original response.failed payload so downstream rendering /
  // logging can inspect `.cause` for response.id, model, etc.
  const cause = error;

  if (code === "context_length_exceeded") return new ContextLengthExceededError(message, { cause });
  // A request the backend rejects as malformed (an invalid prompt, an orphaned
  // function_call, a broken item chain) is deterministic: a retry replays the
  // same transcript and fails identically, so it must not enter the
  // transient-retry path.
  if (code !== undefined && REQUEST_VALIDATION_CODES.has(code)) {
    const rejected = new ProviderRequestValidationError("OpenAI", message, { cause });
    // The ChatGPT backend names a refused tool result image only in its message (probe g: no param, no index).
    return /\binput_image\b/.test(message) ? new ContentRefusedError("OpenAI", rejected, { reason: message, part: undefined }) : rejected;
  }

  if (code === "rate_limit_exceeded") {
    return new LlmStreamError(message, "rate_limit", getRetryAfterMs(error) ?? parseRetryAfterMs(message), { cause });
  }
  // A spent quota, a plan that does not include the model, or a hit usage
  // ceiling cannot clear within any retry window: only billing or a plan change
  // pays for the next request. `usage_limit_reached` is the ChatGPT backend's
  // name for the ceiling.
  if (code !== undefined && QUOTA_CODES.has(code)) return new QuotaExhaustedError(message, { cause, quotaObservation });
  if (code === "server_is_overloaded" || code === "slow_down" || code === "overloaded_error") {
    return new LlmStreamError(message, "overload", undefined, { cause });
  }
  // OpenAI's capacity failures also arrive as a response.failed frame with
  // code "server_error" and an overloaded message ("Our servers are currently
  // overloaded. Please try again later."). Observed in production flattening
  // to a fatal ApiError that killed the turn instead of failing over.
  if (code === "server_error" || /overloaded/i.test(message)) {
    return new LlmStreamError(message, "overload", undefined, { cause });
  }

  return new LlmStreamError(`${code ?? "unknown"}: ${message}`, "unknown", undefined, { cause });
}

export function extractSystemPrompt(messages: ConversationMessage[]): string {
  for (const m of messages) {
    if (m.kind === "system") return m.content;
  }
  return "";
}

function openAIStopReason(
  status: string | null | undefined,
  output: ReadonlyArray<{ type?: string }> | undefined,
): CompletedStopReason {
  if (status !== "completed") return "unknown";
  // K6: OpenAI returns status="completed" even when the response output
  // contains function_call items. Override so the agent loop knows to
  // continue iterating instead of finalizing the turn as `end_turn`. pi
  // `openai-responses-shared.ts:514-516`.
  const hasToolCall = output?.some((item) => item.type === "function_call") ?? false;
  return hasToolCall ? "tool_use" : "end_turn";
}

interface ReasoningParams {
  reasoning?: ResponseCreateParamsStreaming["reasoning"];
  include?: ResponseCreateParamsStreaming["include"];
}

/** Assumed tiers when a Responses model has no models.dev effort declaration:
 *  most gpt-5.X / o-series accept up to xhigh. */
const OPENAI_EFFORT_FALLBACK = ["low", "medium", "high", "xhigh"] as const satisfies readonly ReasoningEffortTier[];

function buildReasoningParams(
  effort: ReasoningEffort,
  info: ModelInfo | null,
  providerOptions: StreamOptions["providerOptions"],
): ReasoningParams {
  // K1: "off" means the user disabled reasoning. Models that declare "none" in
  // their models.dev `reasoning_options` get `effort: "none"` sent explicitly
  // so gpt-5.1+ don't fall through to their default reasoning level; everything
  // else omits the `reasoning` param.
  if (effort === "off") {
    if (supportsReasoningOff(info)) {
      const reasoning: ReasoningParams["reasoning"] = { effort: "none" };
      return { reasoning };
    }
    return {};
  }
  // Clamp to the model's declared tiers (pi `models.ts:clampThinkingLevel`):
  // gpt-5.1 declares no xhigh and gets "high"; newer tiers can declare "max".
  const clamped = openAIReasoningEffort(effort, info) ?? clampReasoningEffort(effort, info, OPENAI_EFFORT_FALLBACK);
  // SAFETY: models.dev declares provider wire tiers that can lead the SDK union.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: models.dev provider tiers lead the narrower SDK wire union
  const wireEffort = clamped as NonNullable<OpenAIReasoningEffort>;
  const summary = openAIReasoningSummary(providerOptions);
  return {
    reasoning: {
      effort: wireEffort,
      ...(summary ? { summary } : {}),
    },
    include: ["reasoning.encrypted_content"],
  };
}

export function buildOpenAIParams(
  model: string,
  input: ResponseCreateParamsStreaming["input"],
  instructions: string | undefined,
  tools: ResponseCreateParamsStreaming["tools"],
  isChatGPT: boolean,
  modelSupportsReasoning: boolean,
  effort: ReasoningEffort,
  info: ModelInfo | null,
  options: StreamOptions,
  accessProvider: AccessProviderId,
): OpenAIResponseParamsWithCacheOptions {
  const isCopilot = accessProvider === "github_copilot";
  // pi `openai-responses.ts:249-251`: only send max_output_tokens when the
  // caller explicitly requests it. Forcing the model's outputLimit silently
  // truncates responses when models.dev metadata is stale (especially common
  // on Copilot's variable model lineup). API-key path keeps the behavior
  // because we control the model metadata there.
  const sendMaxOutputTokens = options.outputTokenLimit !== undefined || (!isChatGPT && !isCopilot);
  const toolChoice = mapOpenAIResponsesToolChoice(options.toolChoice);
  const params: OpenAIResponseParamsWithCacheOptions & UnknownFields = {
    model, input, instructions, tools,
    store: false,
    ...(sendMaxOutputTokens ? { max_output_tokens: options.outputTokenLimit ?? info?.outputLimit ?? 16_384 } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    stream: true,
  };
  if (modelSupportsReasoning) {
    const reasoning = buildReasoningParams(effort, info, options.providerOptions);
    if (reasoning.reasoning) params.reasoning = reasoning.reasoning;
    if (reasoning.include) params.include = reasoning.include;
    if (isChatGPT) params.include = ["reasoning.encrypted_content"];
  }
  const acceptsCacheOptions = openAIAcceptsPromptCacheOptions(accessProvider, info);
  // `cacheRetention: "none"` opts out of prompt caching entirely (privacy-sensitive flows).
  if (options.cacheRetention === "none") {
    if (acceptsCacheOptions) params.prompt_cache_options = { mode: "explicit" };
  } else {
    const clampedCacheKey = clampOpenAIPromptCacheKey(options.promptCacheKey);
    if (clampedCacheKey) params.prompt_cache_key = clampedCacheKey;
    // ChatGPT requests may reject `prompt_cache_retention`; only send it on the
    // plain OpenAI API path.
    if ((options.cacheRetention === "24h" || options.cacheRetention === "in_memory") && !isChatGPT && !isCopilot) {
      params.prompt_cache_retention = options.cacheRetention;
    }
    // The provider default lifetime, sent so that the response states it as
    // the evidence of the idle deadline (ARCH-CONTEXT-012).
    if (acceptsCacheOptions) params.prompt_cache_options = { ttl: "30m" };
  }
  applyOpenAIResponsesOptions(params, {
    model,
    hasTools: (tools?.length ?? 0) > 0,
    isChatGPT,
    providerOptions: options.providerOptions,
  });
  return params;
}

/** Session headers for the Responses API, or none for a sessionless request.
 *  `x-client-request-id` always carries the conversation identity. The ChatGPT
 *  backend groups its prompt cache by the session-id header and ignores the
 *  body `prompt_cache_key`, so there the session headers carry the request's
 *  cache group (ARCH-PROVIDERS-026). A cache-disabled ChatGPT request joins no
 *  shared group: its session headers carry its own identity. */
export function openAISessionAffinityHeaders(
  options: Pick<StreamOptions, "providerSessionKey" | "promptCacheKey" | "cacheRetention">,
  isChatGPT: boolean,
): StringFields {
  const identity = clampOpenAIPromptCacheKey(options.providerSessionKey);
  if (!identity) return {};
  if (!isChatGPT) return { session_id: identity, "x-client-request-id": identity };
  const affinity = options.cacheRetention === "none" ? identity : clampOpenAIPromptCacheKey(options.promptCacheKey) ?? identity;
  return { "session-id": affinity, session_id: affinity, "x-client-request-id": identity };
}

export async function createOpenAIStream(
  client: OpenAI,
  params: OpenAIResponseParamsWithCacheOptions,
  signal: AbortSignal,
  extraHeaders?: StringFields,
): Promise<AsyncIterable<ResponseStreamEvent>> {
  const requestOpts = extraHeaders ? { signal, headers: extraHeaders } : { signal };
  // create(params: ResponseCreateParamsStreaming) returns Stream<ResponseStreamEvent>,
  // itself an AsyncIterable, so the return needs no cast.
  return await client.responses.create(params, requestOpts);
}

type OpenAIResponseWithUsage = Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>["response"];

// `prompt_cache_options` is read as unknown: the SDK does not declare it on responses.
export function* handleOpenAIUsage(response: Pick<OpenAIResponseWithUsage, "usage"> & { prompt_cache_options?: unknown }): Generator<ProviderStreamEvent> {
  if (!response.usage) return;
  // A gateway that omits the cache detail did not report cache reads; that is unknown, not zero.
  const cachedTokens = response.usage.input_tokens_details?.cached_tokens ?? null;
  const reasoningTokens = response.usage.output_tokens_details?.reasoning_tokens ?? 0;
  // OpenAI and gateways can report cache writes on this extension field.
  const cacheWrite = cacheWriteTokens(response.usage.input_tokens_details);
  const cacheCreateTokens = typeof cacheWrite === "number" ? cacheWrite : 0;
  yield {
    kind: "usage",
    // Every caller passes a terminal response: completed, incomplete, or failed.
    final: true,
    inputTokens: Math.max(0, (response.usage.input_tokens ?? 0) - (cachedTokens ?? 0) - cacheCreateTokens),
    outputTokens: response.usage.output_tokens ?? 0,
    cacheReadTokens: cachedTokens,
    cacheCreateTokens,
    reasoningTokens,
    cacheRetentionMs: promptCacheTtlMs(response.prompt_cache_options),
  } as const;
}

export function* handleOpenAICompleted(
  event: Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>,
  yieldReasoningItem: (item: { type?: string }, outputIndex: number) => Generator<ProviderStreamEvent>,
  model: string,
  /** Callback to capture the response's actual service tier for cost accounting.
   *  OpenAI may serve a lower tier than requested, and pricing reflects the
   *  served tier, not the requested one. */
  onServiceTier?: (tier: string | undefined) => void,
): Generator<ProviderStreamEvent> {
  const response = event.response;
  const tier = response?.service_tier;
  onServiceTier?.(typeof tier === "string" ? tier : undefined);
  yield* handleOpenAIUsage(response);

  for (const [outputIndex, item] of (response?.output ?? []).entries()) yield* yieldReasoningItem(item, outputIndex);

  const status = response?.status;
  if (status === "incomplete") {
    // Distinguish max_output_tokens (truncation) from content_filter (safety) so
    // the loop can react differently: retry-with-more-tokens vs surface-to-user.
    const incompleteReason = response?.incomplete_details?.reason;
    if (incompleteReason === "content_filter") {
      yield {
        kind: "done",
        stopReason: "content_filter",
        metadata: { api: "openai-responses", provider: "openai", model, timestamp: Date.now(), responseId: response?.id, stopReason: "content_filter" },
      } as const;
      return;
    }
    throw normalizeProviderAttemptFailure(new OutputLengthExceededError(
      incompleteReason === "max_output_tokens" ? "Response truncated: max_output_tokens" : "Response truncated",
    ));
  }
  const stopReason = openAIStopReason(status, response?.output);
  yield {
    kind: "done",
    stopReason,
    metadata: {
      api: "openai-responses",
      provider: "openai",
      model,
      timestamp: Date.now(),
      responseId: response?.id,
      stopReason,
    },
  } as const;
}

export function classifyOpenAIStreamError(err: unknown, quotaObservation?: QuotaExhaustedError["quotaObservation"]): never {
  // Structural quota evidence survives worker and SDK boundaries that can discard a custom Error prototype.
  if (quotaObservation) {
    throw new QuotaExhaustedError(err instanceof Error ? err.message : "Provider quota exhausted", { cause: err, quotaObservation });
  }
  // The ChatGPT backend WebSocket transport surfaces backend `error` / `response.failed`
  // frames as ChatGptAdapterApiError carrying the same `{ code, message }` the OpenAI
  // Responses API uses, so reuse the one classifier: its extracted code (rate
  // limit / usage limit / context length) drives retry + backoff instead of
  // flattening to a generic, mis-retried ApiError.
  // The WebSocket transport wraps the frame it read in a transport error, so
  // the frame's code has to be read through that wrapper.
  const backendFrame = err instanceof ChatGptAdapterApiError ? err : err instanceof ChatGptAdapterTransportError && err.cause instanceof ChatGptAdapterApiError ? err.cause : undefined;
  if (backendFrame) {
    throw classifyResponseFailed({ code: backendFrame.code, message: backendFrame.message }, undefined, quotaObservation);
  }
  // The SDK throws an SSE `error` frame as an `APIError` with no HTTP status and
  // the frame as its `error` body; its connection and abort errors have no body.
  if (err instanceof APIError && err.status === undefined && err.error !== undefined) {
    throw classifyResponseFailed(err, undefined, quotaObservation);
  }
  // A 402, or a 429 whose body names a terminal quota code, cannot clear
  // within any retry window; retrying it at the HTTP level burns the whole
  // backoff schedule against a spent allowance.
  if (err instanceof APIError) {
    const code = typeof err.code === "string" ? err.code : undefined;
    // Responses rejects unreadable content with `param: "input"`, code `invalid_value`, and no index, so the
    // refused part stays unlocated. The code is required: Responses also names `param: "input"` on other 400s,
    // such as `context_length_exceeded`, which context-overflow recovery owns below.
    if (err.status === 400 && code === "invalid_value" && err.param?.startsWith("input")) {
      const body: { message?: unknown } | undefined = err.error;
      const reason = typeof body?.message === "string" ? body.message : err.message;
      throw new ContentRefusedError("OpenAI", err, { reason, part: undefined });
    }
    if (code && REQUEST_VALIDATION_CODES.has(code)) {
      throw new ProviderRequestValidationError("OpenAI", err.message, { cause: err });
    }
    if (err.status === 429 && code === "rate_limit_exceeded") {
      throw new LlmStreamError(err.message, "rate_limit", parseRetryAfterMs(err.message), { cause: err });
    }
    if (err.status === 429 && code !== undefined && QUOTA_CODES.has(code)) {
      throw new QuotaExhaustedError(err.message, { cause: err, quotaObservation });
    }
    const quota = classifyQuotaError(err.status, err.message, err);
    if (quota) throw quota;
  }
  if (err instanceof BadRequestError && isOpenAIContextLengthMessage(err.message)) {
    throw new ContextLengthExceededError(err.message, { cause: err });
  }
  if (err instanceof APIConnectionError) {
    // The ChatGPT transport's custom fetch throws QuotaCoordinationError when
    // a durable quota suppression could not land; the SDK wraps any rejecting
    // fetch in APIConnectionError. Unwrapped here so the coordination failure
    // fails the request under its own name instead of being retried against
    // the exhausted account as a connection blip.
    if (err.cause instanceof QuotaCoordinationError) throw err.cause;
    throw new LlmStreamError(err.message, "transient", undefined, { cause: err });
  }
  if (err instanceof APIError && (err.status === 408 || err.status === 409)) {
    throw new LlmStreamError(err.message, "transient", undefined, { cause: err });
  }
  if (err instanceof APIError && err.status !== undefined && err.status >= 500) {
    throw new LlmStreamError(err.message, "overload", undefined, { cause: err });
  }
  if (err instanceof Error && err.cause) {
    const cause = err.cause;
    if (cause instanceof APIConnectionError) {
      throw new LlmStreamError(cause.message, "transient", undefined, { cause });
    }
    if (cause instanceof APIError && cause.status !== undefined && cause.status >= 500) {
      throw new LlmStreamError(cause.message, "overload", undefined, { cause });
    }
  }
  // Network tears not classified by the SDK (Premature close, ECONNRESET, socket hang up).
  // isTransientNetworkError only returns true for Error instances, so the added
  // `instanceof` conjunct narrows `err` for `.message` without changing behavior.
  if (err instanceof Error && isTransientNetworkError(err)) {
    throw new LlmStreamError(err.message, "transient", undefined, { cause: err });
  }
  throw err;
}

/** Whether an OpenAI error text, or an error code passed as text, states that the request exceeds the model's
 *  context window. The Responses and chat-completions wires use the same words. */
export function isOpenAIContextLengthMessage(message: string): boolean {
  return message.includes("maximum context length") || message.includes("context_length_exceeded");
}
