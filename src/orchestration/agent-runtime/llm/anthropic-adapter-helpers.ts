import Anthropic from "@anthropic-ai/sdk";
import { errorMessage } from "../../../infra/error-message.js";
import type { AccessProviderId } from "../../../infra/llm/access-provider.js";
import type { ModelInfo } from "../../../infra/llm/models.js";
import { toAnthropicMessagesRequest } from "./conversions/anthropic-messages.js";
import { ANTHROPIC_STANDARD_CONTEXT_WINDOW, classifyQuotaError, ContentFilteredError, ContextLengthExceededError, extendedContextRefusal, LlmStreamError, ModelAccessRefusedError, QuotaExhaustedError } from "./errors.js";
import { supportsAdaptiveThinking, supportsEagerToolStreamingOnCopilot, supportsPerTurnEffort } from "./model-compat.js";
import { isTransientNetworkError } from "./provider-failure.js";
import { STREAM_TTFT_TIMEOUT_MS } from "./stream-watchdog.js";
import type { ConversationMessage, StreamOptions } from "./types.js";
import type { SystemPromptTiers } from "./system-prompt-tiers.js";
import type { ProviderHistoryTarget } from "./provider-history.js";

interface PayloadRecord {
  [key: string]: unknown;
}
/** The SDK only bounds response headers. Keep it behind Flywheel's owned TTFT deadline so timeout classification is deterministic. */
export const ANTHROPIC_SDK_HEADER_TIMEOUT_MS = STREAM_TTFT_TIMEOUT_MS + 30_000;

const CACHE_CONTROL = { type: "ephemeral" } as const satisfies Anthropic.CacheControlEphemeral;
const CACHE_CONTROL_1H = { type: "ephemeral", ttl: "1h" } as const satisfies Anthropic.CacheControlEphemeral;
/** Progressive stall warnings (ms from last chunk) emitted before the deadline. */
export const ANTHROPIC_STALL_THRESHOLDS = [15_000, 30_000, 60_000, 120_000] as const;

export function cacheControlFor(retention: StreamOptions["cacheRetention"]) {
  return retention === "1h" ? CACHE_CONTROL_1H : CACHE_CONTROL;
}

export function classifyAnthropicError(cause: unknown): Error {
  if (cause instanceof Anthropic.APIConnectionError) return new LlmStreamError(cause.message, "transient", undefined, { cause });
  if (cause instanceof Anthropic.APIError) {
    const fromApi = classifyAnthropicApiError(cause);
    if (fromApi) return fromApi;
  }

  if (cause instanceof Error) {
    const fromPayload = classifyAnthropicErrorPayload(cause.message, cause);
    if (fromPayload) return fromPayload;
  }

  if (cause instanceof Error && cause.cause) {
    const classified = classifyAnthropicError(cause.cause);
    if (classified instanceof LlmStreamError || classified instanceof QuotaExhaustedError || classified instanceof ModelAccessRefusedError) return classified;
  }

  if (isTransientNetworkError(cause)) {
    return new LlmStreamError(errorMessage(cause), "transient", undefined, { cause });
  }

  return cause instanceof Error ? cause : new Error(String(cause));
}

/** What decides the betas of one Anthropic request. */
export interface AnthropicBetaRequest {
  readonly model: string;
  readonly accessProvider: AccessProviderId;
  readonly info: ModelInfo | null;
  readonly hasTools: boolean;
  /** The request's context window. Undefined when no catalog states one. */
  readonly contextLimit: number | undefined;
  readonly speed?: "fast" | undefined;
  readonly thinkingDisplay?: string | undefined;
}

interface BetaFacts {
  readonly firstParty: boolean;
  readonly copilot: boolean;
  readonly adaptiveThinking: boolean;
  readonly extendedContext: boolean;
  readonly eagerInputStreaming: boolean;
  readonly request: AnthropicBetaRequest;
}

/**
 * The betas of an Anthropic request, in the order that the Claude engine sends them. This table is the one source of
 * the request opt-ins that the first-party API route (`anthropic_api`) shares with the claude-agent-sdk route.
 * On the first-party route the rules give the betas that the Claude engine (CLI 2.1.321) sends from the Agent SDK, so
 * both routes ask the API for the same behavior. The CLI's credential and identity betas stay out:
 * `claude-code-20250219`, `oauth-2025-04-20`, and `extended-cache-ttl-2025-04-11`, which the CLI sends only with
 * a subscription login. Eager tool input streaming is a field of each tool, not a beta, and both routes send it
 * (`streamsToolInputEagerly`). The GitHub Copilot proxy accepts only the betas that its rules name.
 */
const ANTHROPIC_BETAS: ReadonlyArray<{ readonly beta: string; readonly when: (facts: BetaFacts) => boolean }> = [
  { beta: "context-1m-2025-08-07", when: ({ copilot, extendedContext }) => !copilot && extendedContext },
  { beta: "interleaved-thinking-2025-05-14", when: ({ firstParty, adaptiveThinking }) => firstParty || !adaptiveThinking },
  { beta: "context-management-2025-06-27", when: ({ firstParty }) => firstParty },
  { beta: "prompt-caching-scope-2026-01-05", when: ({ copilot }) => !copilot },
  // Opens the effort copy inside the conversation (`withPerTurnEffort`). The API takes a system message there with
  // no other beta: the engine stopped sending `mid-conversation-system-2026-04-07` in CLI 2.1.306.
  { beta: "per-turn-control-2026-07-01", when: ({ firstParty, request }) => firstParty && supportsPerTurnEffort(request.model) },
  // Streams `thinking_delta` frames that carry `estimated_tokens` while no thinking text arrives, so the live
  // token count moves.
  { beta: "thinking-token-count-2026-05-13", when: ({ copilot }) => !copilot },
  { beta: "effort-2025-11-24", when: ({ copilot }) => !copilot },
  { beta: "fine-grained-tool-streaming-2025-05-14", when: ({ eagerInputStreaming, request }) => request.hasTools && !eagerInputStreaming },
  // Fast mode is first-party API only, as in the Claude engine, so the Copilot path never sends it.
  { beta: "fast-mode-2026-02-01", when: ({ copilot, request }) => request.speed === "fast" && !copilot },
  { beta: "thinking-display-updates-2026-08-18", when: ({ request }) => request.thinkingDisplay === "updates" },
];

function isFirstPartyAnthropicRoute(accessProvider: AccessProviderId): boolean {
  return accessProvider === "anthropic_api";
}

/** What decides the body fields that the betas above opt into. */
interface BodyOptInRequest {
  readonly accessProvider: AccessProviderId;
  readonly model: string;
  readonly thinking: boolean;
  readonly messages: readonly Anthropic.MessageParam[];
  readonly effort: Anthropic.OutputConfig["effort"] | undefined;
}

/** The body fields that the betas above opt into. On the first-party route while thinking is on, the Claude engine
 *  sends the context edit that keeps every earlier thinking block, and its per-turn control copies the effort into
 *  the conversation (`withPerTurnEffort`). */
export function anthropicBodyOptIns(request: BodyOptInRequest): { context_management?: { edits: Array<{ type: string; keep: string }> }; messages: AnthropicWireMessage[] } {
  const messages = withPerTurnEffort(request.messages, request.effort, request.accessProvider, request.model);
  return request.thinking && isFirstPartyAnthropicRoute(request.accessProvider) ? { context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] }, messages } : { messages };
}

/** A system message inside the conversation that carries only an effort. The SDK's message type predates a system
 *  role inside the conversation and the `output_config` that the `per-turn-control-2026-07-01` beta opens on it. */
interface AnthropicEffortMessage {
  readonly role: "system";
  readonly content: [];
  readonly output_config: { readonly effort: NonNullable<Anthropic.OutputConfig["effort"]> };
}

/** One message of an Anthropic request. */
export type AnthropicWireMessage = Anthropic.MessageParam | AnthropicEffortMessage;

/**
 * The messages with the Claude engine's copy of the effort inside the conversation. On the first-party route, for a model
 * with the `per_turn_effort` capability, the Claude engine (CLI 2.1.306) sends the effort of each turn on a system message
 * after the user run that starts it, whenever the level differs from the previous copy's. Flywheel states one effort
 * for the whole request, and the claude-agent-sdk route starts a new query when it changes, so every turn runs at the
 * request's effort and the engine sends one copy, directly after the first user run. Both routes then send the same
 * messages. A change of effort rewrites that copy, so the prompt cache holds only the system prompt and the tools.
 */
function withPerTurnEffort(messages: readonly Anthropic.MessageParam[], effort: Anthropic.OutputConfig["effort"] | undefined, accessProvider: AccessProviderId, model: string): AnthropicWireMessage[] {
  if (effort === undefined || effort === null || messages[0]?.role !== "user" || !isFirstPartyAnthropicRoute(accessProvider) || !supportsPerTurnEffort(model)) return [...messages];
  const end = messages.findIndex((message) => message.role !== "user");
  const at = end === -1 ? messages.length : end;
  return [...messages.slice(0, at), { role: "system", content: [], output_config: { effort } }, ...messages.slice(at)];
}

/**
 * Whether tool input streams as the model writes it. With it on, the API no longer validates tool input, and
 * Flywheel's reader in `anthropic-tool-input.ts` reads what arrives. The first-party route and the claude-agent-sdk
 * route both stream it: the bridge reads the field from the request's tools and turns on the engine's switch for it.
 * The engine refuses tool input text that is not JSON and answers that call itself, but Flywheel runs every call
 * from its own reading of the streamed text, so the bridge only stops that query. The Copilot proxy refuses the
 * field on some models.
 */
export function streamsToolInputEagerly(accessProvider: AccessProviderId, model: string): boolean {
  return accessProvider !== "github_copilot" || supportsEagerToolStreamingOnCopilot(model);
}

export function buildBetaHeaders(request: AnthropicBetaRequest): string {
  const facts: BetaFacts = {
    firstParty: isFirstPartyAnthropicRoute(request.accessProvider),
    copilot: request.accessProvider === "github_copilot",
    adaptiveThinking: supportsAdaptiveThinking(request.model, request.info),
    extendedContext: request.contextLimit === undefined || request.contextLimit > ANTHROPIC_STANDARD_CONTEXT_WINDOW,
    eagerInputStreaming: streamsToolInputEagerly(request.accessProvider, request.model),
    request,
  };
  return ANTHROPIC_BETAS.filter(({ when }) => when(facts)).map(({ beta }) => beta).join(",");
}

/** The replay identity that an Anthropic adapter stamps on its turns and lowers history for. */
export function anthropicHistoryTarget(accessProvider: AccessProviderId, model: string, sharedHost: boolean): ProviderHistoryTarget {
  return { accessProvider, provider: "anthropic", api: "anthropic-messages", model, sharedHost };
}

export function convertMessages(options: { messages: ConversationMessage[]; target: ProviderHistoryTarget; systemPrompt?: SystemPromptTiers; cacheRetention?: StreamOptions["cacheRetention"]; supportsImages?: boolean }) {
  const request = toAnthropicMessagesRequest({
    ...options.target,
    systemPrompt: options.systemPrompt,
    supportsImages: options.supportsImages ?? true,
    cacheRetention: options.cacheRetention === "none" ? "none" : options.cacheRetention === "1h" ? "1h" : "5m",
  }, options.messages);
  // SAFETY: toAnthropicMessagesRequest emits Flywheel's own AnthropicBlock union
  // (anthropic-messages.ts), which mirrors the SDK's TextBlockParam / MessageParam shapes
  // field-for-field but is a nominally distinct type; this is the single internal-shape ->
  // SDK boundary. `system` matches directly; `messages` needs `as unknown` because the internal
  // block union is a structural superset of the SDK's content blocks (tool_result/tool_use/
  // thinking/redacted_thinking), so this boundary uses one direct assertion.
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the internal Anthropic system shape mirrors the external SDK type
    system: request.system as Anthropic.MessageCreateParams["system"],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the internal Anthropic message union is a structural superset of the external SDK union
    messages: request.messages as Anthropic.MessageParam[],
    origins: request.origins,
    wireIds: request.wireIds,
  };
}

function classifyAnthropicApiError(err: InstanceType<typeof Anthropic.APIError>): LlmStreamError | QuotaExhaustedError | ModelAccessRefusedError | undefined {
  if (err.status === 529 || err.message?.includes('"type":"overloaded_error"')) {
    return new LlmStreamError(err.message, "overload", undefined, { cause: err });
  }
  // A spent account is terminal on this wire too: the Copilot proxy serves
  // Claude models over anthropic-messages and rejects an exhausted premium
  // allowance with 402, which must advance the provider chain rather than
  // burn the retry schedule as a rate limit.
  const quota = classifyQuotaError(err.status, err.message, err);
  if (quota) return quota;
  if (err.status === 429) {
    const refusal = extendedContextRefusal(err.message, { cause: err });
    if (refusal) return refusal;
  }
  // Anthropic answers a model that the account does not grant, or that does not exist, with a 404 whose
  // message names the model. A 404 about any other resource stays unclassified.
  const body = asPayloadRecord(asPayloadRecord(err.error)?.error);
  if (err.status === 404 && body?.type === "not_found_error" && typeof body.message === "string" && body.message.startsWith("model:")) {
    return new ModelAccessRefusedError(body.message, { kind: "model" }, { cause: err });
  }
  if (err.status === 429) {
    const retryAfter = err.headers?.get?.("retry-after");
    const delayMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
    return new LlmStreamError(err.message, "rate_limit", Number.isFinite(delayMs) ? delayMs : undefined, { cause: err });
  }
  if (err.status === 408 || err.status === 409) return new LlmStreamError(err.message, "transient", undefined, { cause: err });
  if (err.status !== undefined && err.status >= 500) return new LlmStreamError(err.message, "overload", undefined, { cause: err });
  return undefined;
}

// err.message may carry the raw provider JSON envelope (proxy behavior); non-JSON falls through to status-based classification.
function classifyAnthropicErrorPayload(message: string, cause?: unknown): LlmStreamError | ContextLengthExceededError | Error | undefined {
  if (!message || message[0] !== "{") return undefined;
  try {
    const parsed: unknown = JSON.parse(message);
    const root = asPayloadRecord(parsed);
    const error = asPayloadRecord(root?.error);
    if (root?.type !== "error" || !error) return undefined;
    const type = typeof error.type === "string" ? error.type : undefined;
    const msg = typeof error.message === "string" ? error.message : "";
    if (type === "overloaded_error" || /overloaded/i.test(msg)) {
      return new LlmStreamError(msg, "overload", undefined, { cause });
    }
    // A proxy can wrap a long-context refusal in a rate-limit envelope.
    const refusal = extendedContextRefusal(msg, { cause });
    if (refusal) return refusal;
    if (type === "rate_limit_error" || /model is getting throttled/i.test(msg)) {
      return new LlmStreamError(msg, "rate_limit", undefined, { cause });
    }
    if (/context length|prompt is too long|request size exceed|context window/i.test(msg)) {
      return new ContextLengthExceededError(msg, { cause });
    }
    if (type === "content_filter" || /output blocked by content filtering policy/i.test(msg)) {
      return new ContentFilteredError(msg, { cause });
    }
    if (type === "api_error" || type === "internal_error") {
      return new LlmStreamError(msg, "overload", undefined, { cause });
    }
    if (type === "bad_request_error" || type === "invalid_request_error" || type === "unauthorized_error" || type === "not_found_error") {
      return undefined;
    }
  } catch {
    // Malformed provider error envelopes fall through to generic handling.
  }
  return undefined;
}

// Narrows an unknown (from JSON.parse of a proxy-injected provider envelope) to a
// readable record without asserting field types - each field is checked at the use site.
function asPayloadRecord(cause: unknown): PayloadRecord | undefined {
  // SAFETY: the preceding typeof/null/Array guards prove `cause` is a non-array object;
  // TS won't structurally narrow `object` to an index signature, so the assertion only
  // adds the string key access and introduces no field-type claims (each field is re-checked).
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: JSON.parse returns an object without an index signature after runtime object guards
  return typeof cause === "object" && cause !== null && !Array.isArray(cause) ? cause as PayloadRecord : undefined;
}
