/**
 * Anthropic streaming adapter.
 *
 * Reasoning: maps ReasoningEffort to `output_config.effort` for a model with adaptive
 * thinking, and to extended thinking `budget_tokens` for every other reasoning model.
 * Caching: up to 4 ephemeral cache_control breakpoints, Anthropic's limit: the
 * last tool, the stable and session system tiers, and the last user message -
 * captures the stable prefix (tools + system) plus a rolling anchor (last
 * message) that grows with the conversation.
 * Intentionally cohesive provider adapter. Request building, stream
 * decoding, and normalized event mapping stay together to keep one protocol path
 * and avoid indirection tax.
 */

import Anthropic from "@anthropic-ai/sdk";
import { Redacted } from "effect";
import { isAbortError } from "../../../infra/abort.js";
import { errorDetail, errorMessage } from "../../../infra/error-message.js";
import type { AccessProviderCandidate, AccessProviderId } from "../../../infra/llm/access-provider.js";
import { dashedModelId } from "../../../infra/llm/model-id.js";
import { computeUsagePrice } from "../../../infra/llm/llm-helpers.js";
import { providerRequestHeaders } from "../../../infra/llm/provider-request-identity.js";
import type { ModelInfo, ReasoningEffort } from "../../../infra/llm/models.js";
import { ANTHROPIC_RESERVED_BODY_KEYS, applyProviderExtraBody, type AnthropicThinkingDisplay } from "../../../infra/llm/provider-options.js";
import { Log } from "../../../infra/log.js";
import { ContextLengthExceededError, LlmStreamError, OutputLengthExceededError } from "./errors.js";
import type { CompletedStopReason } from "./messages.js";
import { anthropicThinkingMode } from "./model-compat.js";
import { withStreamAttempt, type StreamAttempt } from "./stream-attempt.js";
import { invokeProviderAttempt } from "./provider-attempt-boundary.js";
import { normalizeProviderAttemptFailure } from "./provider-failure.js";
import { ANTHROPIC_CACHE_RATES, ANTHROPIC_PROMPT_NOTES } from "./provider-description.js";
import {
  ANTHROPIC_STALL_THRESHOLDS,
  buildBetaHeaders,
  cacheControlFor,
  classifyAnthropicError,
  anthropicHistoryTarget,
  convertMessages,
  ANTHROPIC_SDK_HEADER_TIMEOUT_MS,
  anthropicBodyOptIns,
  streamsToolInputEagerly,
  type AnthropicWireMessage,
} from "./anthropic-adapter-helpers.js";
import { anthropicContentRefusal, type PreparedBlockLocation } from "./anthropic-content-refusal.js";
import type { BlockOrigins } from "./conversions/anthropic-messages.js";
import { anthropicProviderMetadata } from "./anthropic-provider-metadata.js";
import { observeProviderTelemetry } from "./stream-observe.js";
import { armStreamLiveness, throwIfLivenessFailure } from "./stream-liveness.js";
import { STREAM_IDLE_TIMEOUT_PATIENT_MS } from "./stream-watchdog.js";
import { resolveAdapterTransport, sendStreamingRequest } from "./request-timing.js";
import type { ProviderAvailability } from "./provider-availability-types.js";
import { ensureEventLoopLagSampler } from "../../../infra/event-loop-lag.js";
import type { RawContentBlockDelta, ThinkingDelta } from "@anthropic-ai/sdk/resources/messages.js";
import { anthropicThinkingBudget, anthropicThinkingDisplay, mapAnthropicAdaptiveEffort } from "./anthropic-options.js";
import { parseAnthropicToolInput } from "./anthropic-tool-input.js";
import { anthropicUsageEvent, emptyAnthropicUsage, foldAnthropicMessageDeltaUsage, foldAnthropicMessageStartUsage } from "./anthropic-usage.js";
import { definitionText, definitionValue } from "./tool-definition-text.js";
import type { ProviderHistoryTarget } from "./provider-history.js";
import { FUNCTION_TOOL_PRESENTATION, immutablePreparedRequest, presentToolHistory, resolveCacheRetention, trailingRuntimeNotices, type Claim, type LLMClient, type PreparedProviderRequest, type ProviderStreamEvent, type StreamOptions, type ToolChoice, type ToolPresentation, type TransportContextFrame } from "./types.js";
const log = Log.create({ service: "llm-anthropic" });

interface StringHeaders {
  [key: string]: string;
}

interface AdditionalRequestFields {
  [key: string]: unknown;
}
/** The thinking field that Flywheel sends. Its display also takes the `updates` value of the progress-updates beta,
 *  which the SDK's non-beta type lacks. */
type ThinkingConfig =
  | { type: "adaptive"; display?: AnthropicThinkingDisplay }
  | { type: "enabled"; budget_tokens: number; display?: AnthropicThinkingDisplay }
  | Anthropic.ThinkingConfigDisabled;
/** The request that Flywheel sends: the SDK's streaming request with Flywheel's own thinking field, messages, and
 *  function tools. */
type AnthropicStreamRequest = Omit<Anthropic.MessageCreateParamsStreaming, "thinking" | "messages" | "tools"> & {
  thinking?: ThinkingConfig;
  messages: AnthropicWireMessage[];
  tools?: Anthropic.Tool[];
};
type MutableRequestBody = AnthropicStreamRequest & AdditionalRequestFields;

interface RequestTelemetryMetadata {
  [key: string]: unknown;
}

export type PreparedAnthropicRequest = PreparedProviderRequest<"anthropic-messages", MutableRequestBody> & {
  readonly telemetryMetadata: RequestTelemetryMetadata;
  readonly betaHeader: string;
  /** Each canonical tool call id and the id that `params` sends for it, which the content-refusal locator reads. */
  readonly wireIds: ReadonlyMap<string, string>;
  /** The history target that `params.messages` were lowered for (`lowerProviderHistory`). */
  readonly historyTarget: ProviderHistoryTarget;
  /** The origin of each block of `params.messages` (ARCH-PROVIDERS-067). The effort's system message holds none. */
  readonly origins: BlockOrigins;
};

/** One streaming tool_use block: its input text so far, and the input schema
 *  that the request declared for its tool. */
interface ToolInputBuffer {
  id: string;
  name: string;
  json: string;
  schema?: Anthropic.Tool["input_schema"];
}

interface AnthropicErrorFrame {
  type: "error";
  error: { type?: string; message?: string };
}

/** Margin between the prompt estimate and the context window when clamping
 *  max_tokens: absorbs estimator drift versus Anthropic's own token count
 *  (pi `simple-options.ts:12`). */
const CONTEXT_SAFETY_TOKENS = 4_096;

/** The output cap of every request that a shared engine agent host serves, for every Claude model. The host's
 *  engine fixes max_tokens when it starts, so a per-model or per-agent value starts another engine process. A new
 *  difference belongs in `HOST_SPLIT_EXCEPTIONS` (provider-claude-agent-sdk/agent-host/host-registry.ts) with its
 *  reason. A hosted request near the context window keeps this cap: the API stops the output at the window
 *  (`model_context_window_exceeded`), and the loop recovers from the overflow as on every route. */
export const HOSTED_MAX_TOKENS = 64_000;

interface AnthropicRequestInput {
  accessProvider: AccessProviderId;
  model: string;
  info: ModelInfo;
  options: StreamOptions;
  /** The client runs its agent on a shared engine host: send `HOSTED_MAX_TOKENS`, bounded only by the model's output
   *  limit, instead of the cap that this request's context, throughput, and output limit set, and let the host serve
   *  the request when it can (`historyTarget.sharedHost`). */
  hosted?: boolean;
}

/** The thinking of a request and the history target that it lowers for. The host's engine sends thinking in every
 *  request and lets the agent choose its tool, so a hosted client's shared host serves only such a request. Every
 *  other request of a hosted client runs on its agent's own engine (agent-host/agent-bridge.ts), and its history
 *  leaves out the host's framing. */
function anthropicRequestThinking({ accessProvider, model, info, options, hosted }: AnthropicRequestInput) {
  const reasoning = options.reasoningEffort ?? "medium";
  const thinkingMode = anthropicThinkingMode(model, info, reasoning, info.reasoning);
  const sharedHost = hosted === true && (thinkingMode === "adaptive" || thinkingMode === "enabled") && (options.toolChoice === undefined || options.toolChoice === "auto");
  return { reasoning, thinkingMode, historyTarget: anthropicHistoryTarget(accessProvider, model, sharedHost) };
}

export function prepareAnthropicRequest(input: AnthropicRequestInput & {
  wireModel: string;
  contextLimit?: number;
  presentation?: ToolPresentation;
}): PreparedAnthropicRequest {
  const { accessProvider, model, wireModel, info } = input;
  const options = { ...input.options, cacheRetention: resolveCacheRetention(accessProvider, input.options) };
  const cachingEnabled = options.cacheRetention !== "none";
  const presentation = input.presentation ?? FUNCTION_TOOL_PRESENTATION;
  const { reasoning, thinkingMode, historyTarget } = anthropicRequestThinking(input);
  // Each tool definition travels in the Claude engine's text form, so every Anthropic route sends the same bytes.
  // A replayed call names its tool as the definition does.
  const wireName = (name: string) => definitionText(presentation.wireName?.(name) ?? name);
  const anthropicRequest = convertMessages({ ...options, messages: presentToolHistory(options.messages, { ...presentation, wireName }), target: historyTarget, supportsImages: supportsImageInput(info) });
  const eagerInput = streamsToolInputEagerly(accessProvider, model);
  const anthropicTools: Anthropic.Tool[] = options.tools.map((tool, index) => {
    const presented = presentation.present(tool);
    return {
      name: wireName(tool.name),
      description: definitionText(presented.description),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: convert the validated internal schema to the SDK's equivalent schema type.
      input_schema: definitionValue(presented.inputFormat) as Anthropic.Tool["input_schema"], // SAFETY: The validated registry schema loses only the SDK's literal discriminator.
      ...(eagerInput ? { eager_input_streaming: true } : {}),
      ...(cachingEnabled && index === options.tools.length - 1 ? { cache_control: cacheControlFor(options.cacheRetention) } : {}),
    };
  });
  const apiMax = info.outputLimit;
  const throughputCap = Math.min(apiMax, Math.max(apiMax >> 1, 32_000));
  const remainingContext = options.estimatedContextTokens === undefined || input.contextLimit === undefined
    ? Number.POSITIVE_INFINITY
    : input.contextLimit - options.estimatedContextTokens - CONTEXT_SAFETY_TOKENS;
  const outputCap = input.hosted === true
    ? Math.min(HOSTED_MAX_TOKENS, apiMax)
    : Math.max(1, Math.min(throughputCap, remainingContext, options.outputTokenLimit ?? Number.POSITIVE_INFINITY));
  const params: MutableRequestBody = {
    ...buildAnthropicParams(
      wireModel,
      thinkingMode,
      info,
      outputCap,
      anthropicRequest,
      anthropicTools,
      reasoning,
      anthropicThinkingDisplay(options.providerOptions?.anthropic?.thinking_display, model, accessProvider),
      typeof options.toolChoice === "object" ? { ...options.toolChoice, name: wireName(options.toolChoice.name) } : options.toolChoice,
      options.stopSequences,
    ),
  };
  const thinking = params.thinking?.type === "disabled" ? undefined : params.thinking;
  Object.assign(params, anthropicBodyOptIns({ accessProvider, model, thinking: thinking !== undefined, messages: anthropicRequest.messages, effort: params.output_config?.effort }));
  const lowered = anthropicRequest.origins.values();
  const origins = params.messages.map((message) => message.role === "system" ? [] : lowered.next().value ?? []);
  const userId = options.providerOptions?.anthropic?.user_id;
  if (userId) params.metadata = { user_id: userId };
  applyProviderExtraBody(params, options.providerOptions?.anthropic?.extra_body, ANTHROPIC_RESERVED_BODY_KEYS);
  const speed = accessProvider === "github_copilot" ? undefined : options.providerOptions?.anthropic?.speed;
  if (speed) params.speed = speed;
  const betaHeader = buildBetaHeaders({ model, accessProvider, info, hasTools: options.tools.length > 0, contextLimit: input.contextLimit, speed, thinkingDisplay: thinking?.display ?? undefined });
  return immutablePreparedRequest({
    endpoint: "anthropic-messages",
    params,
    systemPrompt: anthropicRequest.system,
    messages: params.messages,
    tools: params.tools,
    providerOptions: options.providerOptions?.anthropic,
    cacheRetention: options.cacheRetention,
    tokenClasses: { estimatedPromptTokens: options.estimatedContextTokens, cacheRetention: options.cacheRetention },
    outputCap,
    telemetryMetadata: buildRequestTelemetryMetadata(params, betaHeader, [], anthropicTools.length),
    betaHeader,
    wireIds: anthropicRequest.wireIds,
    historyTarget,
    origins,
  });
}

function supportsImageInput(info: ModelInfo): boolean {
  return info.modalities.input.includes("image");
}

export interface AnthropicOperations {
  createStream: (
    params: AnthropicStreamRequest,
    /** `origins` holds the origin of each block of `params.messages` (`PreparedAnthropicRequest.origins`).
     *  `requestContext` is the request's request-only text (`StreamOptions.requestContext`), which ends the last
     *  message of `params`. `runtimeNotices` is the text of the request's trailing runtime notices
     *  (`trailingRuntimeNotices`), present only when the tail holds one. `sharedHost` says whether the client's shared
     *  engine host serves the request (`PreparedAnthropicRequest.historyTarget`). A request whose `signal` is aborted
     *  at admission or after the transport's awaited preparation starts nothing. The adapter aborts `data.controller`
     *  after every request: before the response's terminal event the abort stops that request and nothing else, and
     *  after it the abort only releases the request. `onProgress` hears each piece of the response that the transport
     *  read but holds back from `data` for now, which the adapter counts as the stream's progress; a transport that
     *  yields each piece as it reads it never calls it. */
    options: { signal: AbortSignal; headers: StringHeaders; origins: BlockOrigins; requestContext?: string; runtimeNotices?: readonly string[]; sharedHost: boolean; onProgress?: () => void },
  ) => Promise<{
    data: AsyncIterable<Anthropic.RawMessageStreamEvent | AnthropicErrorFrame | TransportContextFrame> & { controller: AbortController };
    response: Response;
  }>;
  isBadRequestError: (error: Error) => boolean;
  /** A stream of `params` follows (`LLMClient.anticipate`): once its request leaves a wait, or when a session that a
   *  client shows sends its next message. `sharedHost` says whether the client's shared engine host would serve it
   *  (`PreparedAnthropicRequest.historyTarget`), and `origins` is the origin of each block of `params.messages`.
   *  Resolves with the claim on what it holds for the request, or undefined when it holds nothing, and never rejects. */
  anticipate?: (params: AnthropicStreamRequest, options: { readonly sharedHost: boolean; readonly origins: BlockOrigins }) => Promise<Claim | undefined>;
  /** Where the provider's request holds each prepared block, for a route that sends more than `params.messages`.
   *  Absent: the provider receives `params.messages` as they are. */
  preparedBlock?: PreparedBlockLocation;
}

/** The Messages API version that Flywheel states. SDK 1.x defaults to 2026-10-21, which rejects `top_p` and `top_k`
 *  with a 400; a user's `extra_body` can still send them, so the request keeps the version that accepts them. */
const ANTHROPIC_API_VERSION = "2023-06-01";

export function operationsFromAnthropicClient(client: Anthropic): AnthropicOperations {
  return {
    async createStream(params, { signal, headers }) {
      // SAFETY: the public updates beta extends display; the SDK declares that value only on its beta request type.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the SDK serializes the documented updates display unchanged.
      const response = await client.messages.create(params as Anthropic.MessageCreateParamsStreaming, { signal, headers: { ...headers, "anthropic-version": ANTHROPIC_API_VERSION } }).withResponse();
      return { data: response.data, response: response.response };
    },
    isBadRequestError: (error: Error): boolean => error instanceof Anthropic.BadRequestError,
  };
}


export async function createAnthropicAdapter(
  apiKey: Redacted.Redacted<string>,
  defaultModel: string,
  info: ModelInfo,
  overrides?: {
    /** Narrow provider operations for direct adapter dependency injection. */ operations?: AnthropicOperations;
    toolPresentation?: ToolPresentation;
    /** Anthropic-protocol endpoint of a non-first-party plan (e.g. OpenCode Go). */ baseURL?: string;
    /** Override the reported `accessProvider` (default: `"anthropic_api"`). */ accessProvider?: AccessProviderId;
    /** models.dev namespace selected by the provider contribution. */ catalogId?: string;
    /** The client runs its agent on a shared engine host (`prepareAnthropicRequest`). */ hosted?: boolean;
    /** Per-request additional headers (e.g. Copilot's `X-Initiator`). */ extraHeaders?: (options: StreamOptions) => StringHeaders | Promise<StringHeaders>;
    /** Transport hook used to reset idle sockets. */ resetIdleConnections?: () => void | Promise<void>;
    candidate?: AccessProviderCandidate;
    /** The availability owner bound to the account this adapter spends from.
     *  The Anthropic API's rate-limit headers fold into it, so a throttled
     *  account holds back every request until its stated reset. An adapter
     *  built outside the composition root records none. */
    availability?: ProviderAvailability;
  },
): Promise<LLMClient> {
  const transport = resolveAdapterTransport({ client: overrides?.operations, resetIdleConnections: overrides?.resetIdleConnections });
  // SDK 1.x sends `apiKey` as `Authorization: Bearer`; OpenCode Go rejects that with a 401, so the key keeps its
  // `x-api-key` header. Null credentials stop the SDK from reading ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.
  const operations = overrides?.operations ?? operationsFromAnthropicClient(
    new Anthropic({ apiKey: null, authToken: null, defaultHeaders: { "x-api-key": Redacted.value(apiKey) }, maxRetries: 0, timeout: ANTHROPIC_SDK_HEADER_TIMEOUT_MS, fetch: transport.fetch, ...(overrides?.baseURL ? { baseURL: overrides.baseURL } : {}) }),
  );
  const accessProvider = overrides?.accessProvider ?? "anthropic_api";
  const extraHeaders = overrides?.extraHeaders;
  const { availability, candidate } = overrides ?? {};
  // Only Anthropic's own API states its rate limits in these headers; a proxy that speaks this protocol meters its own.
  const observeRateLimit = accessProvider === "anthropic_api" && availability !== undefined && candidate !== undefined
    ? (headers: Headers) => availability.observeAnthropicRateLimit(candidate, headers)
    : undefined;
  let requestCount = 0;
  ensureEventLoopLagSampler();

  /** The request that `options` describe, as this adapter sends it. */
  const describeRequest = async (options: StreamOptions) => {
    const model = options.model ?? defaultModel;
    // Anthropic counts `max_tokens` against the org's TPM bucket as if the request
    // produced the full output. Halving the cap roughly doubles throughput under
    // TPM pressure; the 32k floor preserves full output budget on smaller models.
    const wireModel = accessProvider === "anthropic_api" ? dashedModelId(model) : model;
    return { model, descriptor: prepareAnthropicRequest({ accessProvider, model, wireModel, info, contextLimit: info.contextLimit, options, presentation: overrides?.toolPresentation, hosted: overrides?.hosted }) };
  };

  const adapter = {
    accessProvider,
    modelFamily: "anthropic",
    model: defaultModel,
    toolPresentation: overrides?.toolPresentation ?? FUNCTION_TOOL_PRESENTATION,
    promptNotes: ANTHROPIC_PROMPT_NOTES,
    // No availableModels constraint: any model the API key can call works.
    contextLimit: info.contextLimit,
    outputLimit: info.outputLimit,
    supportsReasoning: info.reasoning,

    priceFor(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; reasoning: number; promptTokens?: number }) {
      return computeUsagePrice(tokens, info.pricing, ANTHROPIC_CACHE_RATES);
    },

    historyTarget(options: StreamOptions) {
      return anthropicRequestThinking({ accessProvider, model: options.model ?? defaultModel, info, options, hosted: overrides?.hosted }).historyTarget;
    },

    async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
      const turnStart = performance.now();
      const coldAdapter = requestCount === 0;
      requestCount += 1;
      const { model, descriptor } = await describeRequest(options);
      if ((options.reasoningEffort ?? "medium") !== "off" && !info.reasoning) {
        log.warn(`Model ${model} does not support reasoning - proceeding without extended thinking`);
      }

      yield* withStreamAttempt<ProviderStreamEvent>(async function* (attempt) {
        const runId = crypto.randomUUID();
        let releaseStream: (() => Promise<void>) | undefined;
        const streamLiveness = armStreamLiveness(attempt, {
          label: "llm-anthropic",
          provider: "Anthropic",
          telemetry: options.telemetry,
          idleTimeoutMs: STREAM_IDLE_TIMEOUT_PATIENT_MS,
          stallThresholds: ANTHROPIC_STALL_THRESHOLDS,
          timeoutMessage: () => "Anthropic stream idle timeout",
        });

        // Usage state lives above the try so the catch can report what a failed
        // attempt was billed before rethrowing.
        let sawMessageStart = false;
        let sawUsage = false;
        const usage = emptyAnthropicUsage();
        const usageEvent = () => anthropicUsageEvent(usage);
        // The failure that `surfaced` (today's classification of the provider's error) becomes, typed as a content
        // refusal when the provider refused the conversation's content.
        const failure = (surfaced: Error, body: unknown) => normalizeProviderAttemptFailure(anthropicContentRefusal(surfaced, body, {
          wireMessages: descriptor.params.messages, canonicalMessages: options.messages, wireIds: descriptor.wireIds, wireOrigins: descriptor.origins, supportsImages: supportsImageInput(info), preparedBlock: operations.preparedBlock,
        }));
        // The failure for an error that the SDK throws: a context overflow first, then the provider's classification.
        const thrownFailure = (error: unknown) => {
          if (error instanceof Error && operations.isBadRequestError(error) && /prompt is too long|context/i.test(error.message)) {
            return normalizeProviderAttemptFailure(new ContextLengthExceededError(error.message, { cause: error }));
          }
          const surfaced = classifyAnthropicError(error);
          if (surfaced instanceof LlmStreamError && surfaced.kind === "rate_limit" && error instanceof Anthropic.APIError && error.headers !== undefined) {
            observeRateLimit?.(error.headers);
          }
          return failure(surfaced, error);
        };
        try {
          const params = descriptor.params;
          const requestHeaders = {
            ...(accessProvider === "github_copilot" ? {} : await providerRequestHeaders()),
            "anthropic-beta": descriptor.betaHeader,
            ...(extraHeaders ? await extraHeaders(options) : {}),
          };
          // Resolved wire shape (betas + body params) for diffing against a real
          // Anthropic request: `request`/`params` fact, query `--request`.
          options.telemetry?.observe({
            source: "request",
            kind: "params",
            metadata: { ...descriptor.telemetryMetadata, extraHeaderNames: Object.keys(requestHeaders).filter((header) => header !== "anthropic-beta") },
          });
          // Arm the pre-stream deadline before the request goes out (OpenAI
          // adapter convention): the watchdog is inert until its first reset,
          // which used to happen only after headers arrived.
          streamLiveness.preStream();
          // Instrumented send: in-flight, fetch connect/header timing, loop lag.
          await options.onDispatch?.();
          const runtimeNotices = trailingRuntimeNotices(options.messages);
          const sent = await sendStreamingRequest(
            async () => {
              try {
                return await operations.createStream(params, { signal: attempt.signal, headers: requestHeaders, origins: descriptor.origins, sharedHost: descriptor.historyTarget.sharedHost, onProgress: () => { streamLiveness.frame(); }, ...(options.requestContext === undefined ? {} : { requestContext: options.requestContext }), ...(runtimeNotices.length === 0 ? {} : { runtimeNotices }) });
              } catch (error) {
                throw thrownFailure(error);
              }
            },
            { telemetry: options.telemetry, turnStart, coldAdapter },
          );
          const rawStream = sent.data;
          const streamResponse: Response | undefined = sent.response;
          releaseStream = async () => {
            sent.endInFlight();
            try { if (!rawStream.controller.signal.aborted) rawStream.controller.abort(); } catch (err) { log.warn("anthropic raw stream abort failed", { error: errorMessage(err), errorDetail: errorDetail(err) }); }
            // The abort above already rejects the body with an AbortError; only another failure is news.
            try { await streamResponse?.body?.cancel(); } catch (err) { if (!isAbortError(err)) log.warn("anthropic response body cancel failed", { error: errorMessage(err), errorDetail: errorDetail(err) }); }
          };

          const toolInputBuffers = new Map<number, ToolInputBuffer>();
          // The prepared tools keep the order of `options.tools`, so each wire name maps to the tool at its index.
          const canonicalNames = new Map(descriptor.params.tools?.map((tool, index) => [tool.name, options.tools[index]?.name ?? tool.name]));
          // Keyed by the canonical name, so a call by the tool's own name, which the claude-agent-sdk engine takes as
          // an alias of the presented name, is read against the same schema.
          const inputSchemas = new Map(descriptor.params.tools?.map((tool) => [canonicalNames.get(tool.name) ?? tool.name, tool.input_schema]));
          const thinkingBuffers = new Map<number, { thinking: string; signature: string; redacted?: boolean }>();
          let receivedMessageStop = false;
          let stopReason: CompletedStopReason = "unknown";
          let responseId = "";


          const providerEvents = rawStream[Symbol.asyncIterator]();
          while (true) {
            let result: IteratorResult<Anthropic.RawMessageStreamEvent | AnthropicErrorFrame | TransportContextFrame>;
            try {
              result = await invokeProviderAttempt(async () => {
                try {
                  return await providerEvents.next();
                } catch (error) {
                  throw thrownFailure(error);
                }
              });
            } catch (error) {
              if (sawUsage) yield usageEvent();
              throwIfLivenessFailure(error, attempt, options.signal);
              throw error;
            }
            if (result.done) break;
            const event = result.value;
            if (event.type === "transport_context") {
              yield { kind: "transport_context", context: event.context } as const;
              continue;
            }
            streamLiveness.frame();
            if (event.type === "error") {
              observeProviderTelemetry(options.telemetry, event.type, { errorType: event.error.type });
              if (sawUsage) yield usageEvent();
              const payload = JSON.stringify({ type: "error", error: event.error });
              throw failure(classifyAnthropicError(new Error(payload)), event.error);
            }
            observeProviderTelemetry(options.telemetry, event.type, anthropicProviderMetadata(event));

            if (event.type === "content_block_start") {
              const block = event.content_block;
              if (block.type === "tool_use") {
                const name = canonicalNames.get(block.name) ?? overrides?.toolPresentation?.canonicalName?.(block.name) ?? block.name;
                toolInputBuffers.set(event.index, { id: block.id, name, json: "", schema: inputSchemas.get(name) });
                yield { kind: "tool_input_start", toolUseId: block.id, name } as const;
              } else if (block.type === "thinking") {
                streamLiveness.begin(`${runId}:${event.index}`);
                thinkingBuffers.set(event.index, { thinking: "", signature: "" });
                yield { kind: "thinking_delta", text: "", blockKey: `${runId}:${event.index}` } as const;
              } else if (block.type === "redacted_thinking") {
                streamLiveness.begin(`${runId}:${event.index}`);
                // Encrypted reasoning blob from the safety classifier. Preserve the opaque
                // `data` as the signature so replay can re-send it as `redacted_thinking`.
                thinkingBuffers.set(event.index, { thinking: "[Reasoning redacted]", signature: block.data, redacted: true });
              }
            } else if (event.type === "message_start") {
              sawMessageStart = true;
              yield { kind: "provider_response_started" } as const;
              if (event.message?.id) responseId = event.message.id;
              if (event.message?.usage) {
                sawUsage = true;
                foldAnthropicMessageStartUsage(event.message.usage, usage);
                const promptTokens = usage.input + usage.cacheRead + usage.cacheCreate;
                if (promptTokens > 0) {
                  yield { kind: "context_update", promptTokens, contextWindow: info.contextLimit } as const;
                }
              }
            } else if (event.type === "content_block_delta") {
              if (event.delta.type === "thinking_delta" && typeof event.delta.thinking === "string") streamLiveness.append(event.delta.thinking);
              yield* handleAnthropicDelta(event, toolInputBuffers, thinkingBuffers, runId, params.thinking?.type !== "disabled" && params.thinking?.display === "updates");
            } else if (event.type === "content_block_stop") {
              if (thinkingBuffers.has(event.index)) streamLiveness.complete(`${runId}:${event.index}`);
              yield* handleAnthropicBlockStop(event, toolInputBuffers, thinkingBuffers, runId, params.thinking?.type !== "disabled" && params.thinking?.display === "updates");
            } else if (event.type === "message_delta") {
              // Anthropic emits cumulative deltas of all usage counters here; keep
              // the latest for accurate cost accounting (pi captures all fields).
              if (event.usage) {
                sawUsage = true;
                foldAnthropicMessageDeltaUsage(event.usage, usage);
              }
              if (event.delta?.stop_reason) {
                // Widen via String() rather than a cast: proxies emit `sensitive`, a wire value
                // outside the SDK's StopReason union, so equality checks need a plain string.
                const resolved = resolveAnthropicStopReason(String(event.delta.stop_reason));
                if (resolved.truncated) {
                  if (sawUsage) yield usageEvent();
                  throw normalizeProviderAttemptFailure(new OutputLengthExceededError("Response truncated"));
                }
                stopReason = resolved.stopReason;
                if (resolved.refusal) {
                  // The refusal's stop_details.explanation names what was refused
                  // (pi `anthropic-messages.ts:1336-1340`); surface it
                  // as a transcript notice, never as model-visible content.
                  // SAFETY: narrow read of the refusal wire field the SDK's
                  // MessageDeltaEvent delta type omits; string-checked before use.
                  const refusalDelta: { stop_details?: { explanation?: string | null } | null } = event.delta;
                  const explanation = refusalDelta.stop_details?.explanation;
                  if (typeof explanation === "string" && explanation.length > 0) {
                    yield { kind: "provider_status", message: `Model refused to continue: ${explanation}`, level: "error" } as const;
                  }
                }
              }
            } else if (event.type === "message_stop") {
              receivedMessageStop = true;
            }

          }
          throwIfAnthropicStreamAborted(attempt, options.signal);

          // A body that closes without message_stop is a dropped connection,
          // whether it died mid-message or never carried a message_start at
          // all: a 200 with an empty SSE body is what a proxy sends when the
          // upstream went away, not an answer. Passing it through would settle
          // the turn as a completed empty response; failing it transient lets
          // the walk retry in place and fail over.
          if (!receivedMessageStop) {
            if (sawUsage) yield usageEvent();
            throw normalizeProviderAttemptFailure(new LlmStreamError(
              sawMessageStart ? "Anthropic stream closed before message_stop" : "Anthropic stream closed before message_start",
              "transient",
            ));
          }

          if (sawUsage) yield usageEvent();

          yield {
            kind: "done",
            stopReason,
            metadata: {
              api: "anthropic-messages",
              provider: "anthropic",
              model,
              timestamp: Date.now(),
              responseId,
              stopReason,
            },
          } as const;
        } finally {
          await releaseStream?.();
        }
        }, options);
    },

    // An anticipation never rejects, because its callers do not wait for it: a request that cannot be described, or
    // whose transport fails to anticipate it, fails the same way when it streams, which reports it.
    ...(operations.anticipate === undefined ? {} : {
      anticipate: (options: StreamOptions) => describeRequest(options)
        .then(({ descriptor }) => operations.anticipate?.(descriptor.params, { sharedHost: descriptor.historyTarget.sharedHost, origins: descriptor.origins }))
        .catch(() => undefined),
    }),
  } satisfies LLMClient;

  return adapter;
}

function throwIfAnthropicStreamAborted(attempt: StreamAttempt, callerSignal: AbortSignal | undefined): void {
  if (!attempt.signal.aborted) return;
  const abortReason = callerSignal?.reason ?? new Error("Anthropic stream aborted");
  throwIfLivenessFailure(abortReason, attempt, callerSignal);
  throw abortReason;
}

// Request building and stream-event mapping (formerly anthropic-helpers.ts;
// single consumer, merged back per this file's cohesion note).
// handleAnthropicDelta stays exported for the assistant-turn-stream unit tests.

/** Map the canonical Flywheel ToolChoice shape to Anthropic's wire form.
 *  pi `anthropic.ts:981-988`. */
function toAnthropicToolChoice(choice: ToolChoice | undefined): Anthropic.MessageCreateParams["tool_choice"] | undefined {
  if (!choice) return undefined;
  return typeof choice === "string" ? { type: choice } : { type: "tool", name: choice.name };
}

function buildAnthropicParams(
  wireModel: string,
  thinkingMode: ReturnType<typeof anthropicThinkingMode>,
  info: ModelInfo,
  maxTokens: number,
  anthropicRequest: { system?: Anthropic.MessageCreateParams["system"]; messages: Anthropic.MessageParam[] },
  anthropicTools: Anthropic.Tool[],
  reasoning: ReasoningEffort,
  thinkingDisplay: ReturnType<typeof anthropicThinkingDisplay> | undefined,
  toolChoice: ToolChoice | undefined,
  stopSequences: readonly string[] | undefined,
): AnthropicStreamRequest {
  const params: AnthropicStreamRequest = {
    model: wireModel,
    max_tokens: maxTokens,
    stream: true,
    system: anthropicRequest.system,
    messages: anthropicRequest.messages,
    tools: anthropicTools,
  };
  const anthropicToolChoice = toAnthropicToolChoice(toolChoice);
  if (anthropicToolChoice) params.tool_choice = anthropicToolChoice;
  if (stopSequences?.length) params.stop_sequences = [...stopSequences];
  if (thinkingMode === "adaptive") {
    params.thinking = { type: "adaptive", display: thinkingDisplay };
    const effort = mapAnthropicAdaptiveEffort(info, reasoning);
    if (effort) params.output_config = { effort };
  } else if (thinkingMode === "enabled") {
    params.thinking = {
      type: "enabled",
      budget_tokens: anthropicThinkingBudget(reasoning, maxTokens),
      display: thinkingDisplay,
    };
  } else if (thinkingMode === "disabled") {
    params.thinking = { type: "disabled" };
  }
  // No `temperature` here: 1 is the API default, and Opus 4.7+ rejects the field outright.
  return params;
}

/** Resolved Anthropic wire shape (betas + body params) captured at request
 *  time for the `model.stream.event_observed` "request" telemetry fact, so the
 *  Opus TTFB dead zone can be diffed field-for-field against a real Claude
 *  Code request. Mirrors the proxy addon's `req` record fields. */
function buildRequestTelemetryMetadata(
  params: AnthropicStreamRequest,
  betaHeader: string,
  extraHeaderNames: readonly string[],
  toolCount: number,
): RequestTelemetryMetadata {
  const thinking = params.thinking;
  const effort = params.output_config?.effort;
  return {
    betas: betaHeader ? betaHeader.split(",") : [],
    extraHeaderNames: [...extraHeaderNames],
    model: params.model,
    maxTokens: params.max_tokens,
    bodyKeys: Object.keys(params).sort(),
    toolCount,
    ...(thinking ? { thinkingType: thinking.type, thinkingBudget: thinking.type === "enabled" ? thinking.budget_tokens : undefined } : {}),
    ...(effort != null ? { effort } : {}),
    ...(params.tool_choice ? { toolChoiceType: params.tool_choice.type } : {}),
  };
}

type AnthropicStopResolution =
  | { readonly truncated: true }
  | { readonly truncated?: undefined; readonly stopReason: CompletedStopReason; readonly refusal?: true };

/** Maps a raw Anthropic stop_reason wire value to the canonical completed
 *  stop reason plus the reactions the stream loop owes it: `truncated` throws
 *  the typed length-recovery error, `refusal` surfaces stop_details.explanation. */
function resolveAnthropicStopReason(raw: string): AnthropicStopResolution {
  // `model_context_window_exceeded` is truncation by the context ceiling
  // rather than by max_tokens; both get length semantics.
  if (raw === "max_tokens" || raw === "model_context_window_exceeded") return { truncated: true };
  // `pause_turn` (Anthropic paused; client should resubmit unchanged) maps to
  // `end_turn` so the agent loop treats it as a normal stop.
  if (raw === "pause_turn") return { stopReason: "end_turn" };
  // `refusal` / `sensitive` surface as `content_filter` so the loop doesn't
  // silently treat them like a successful end_turn.
  if (raw === "refusal" || raw === "sensitive") return { stopReason: "content_filter", refusal: true };
  if (raw === "end_turn" || raw === "stop_sequence" || raw === "tool_use") return { stopReason: raw };
  // A wire value this adapter does not know stays "unknown" instead of leaking
  // into the LlmStopReason union as a raw string.
  log.warn("Anthropic stream: unknown stop_reason", { stopReason: raw });
  return { stopReason: "unknown" };
}

export function* handleAnthropicDelta(
  event: { index: number; delta: RawContentBlockDelta },
  toolInputBuffers: Map<number, ToolInputBuffer>,
  thinkingBuffers: Map<number, { thinking: string; signature: string; redacted?: boolean }>,
  runId: string,
  progressUpdates = false,
): Generator<ProviderStreamEvent> {
  const delta = event.delta;
  const blockKey = `${runId}:${event.index}`;
  if (delta.type === "text_delta") {
    yield { kind: "text_delta", text: delta.text, blockKey } as const;
  } else if (delta.type === "thinking_delta") {
    // Redacted thinking (thinking-token-count beta) sends `estimated_tokens`
    // frames with no `thinking` text; visible thinking sends text only.
    // SAFETY: the discriminator narrowed `delta` to ThinkingDelta; the intersection only
    // adds `estimated_tokens`, a beta-only wire field the SDK's ThinkingDelta type omits.
    const d: ThinkingDelta & { estimated_tokens?: number } = delta;
    const text = typeof d.thinking === "string" ? d.thinking : "";
    const buf = thinkingBuffers.get(event.index);
    if (buf) buf.thinking += text;
    const estimatedTokens = typeof d.estimated_tokens === "number" ? d.estimated_tokens : undefined;
    yield { kind: "thinking_delta", text, blockKey, ...(progressUpdates && text.length > 0 ? { presentation: "progress" as const } : {}), ...(estimatedTokens !== undefined ? { estimatedTokens } : {}) } as const;
  } else if (delta.type === "signature_delta") {
    const buf = thinkingBuffers.get(event.index);
    if (buf) buf.signature += delta.signature;
  } else if (delta.type === "input_json_delta") {
    const buf = toolInputBuffers.get(event.index);
    if (buf) {
      const partial = delta.partial_json;
      buf.json += partial;
      yield { kind: "tool_input_delta", toolUseId: buf.id, partialJson: partial } as const;
    }
  }
}

function* handleAnthropicBlockStop(
  event: { index: number },
  toolInputBuffers: Map<number, ToolInputBuffer>,
  thinkingBuffers: Map<number, { thinking: string; signature: string; redacted?: boolean }>,
  runId: string,
  progressUpdates = false,
): Generator<ProviderStreamEvent> {
  const toolBuf = toolInputBuffers.get(event.index);
  if (toolBuf) {
    const { input, parseError, repaired } = parseAnthropicToolInput(toolBuf.json, toolBuf.schema);
    if (repaired) log.info("tool input repeated parameters gathered", { tool: toolBuf.name, toolUseId: toolBuf.id, repeated: repaired.repeated, unquoted: repaired.unquoted });
    yield {
      kind: "tool_use",
      toolCall: {
        id: toolBuf.id,
        name: toolBuf.name,
        input,
        ...(parseError ? { inputParseError: parseError } : {}),
      },
    } as const;
    toolInputBuffers.delete(event.index);
    return;
  }
  const thinkBuf = thinkingBuffers.get(event.index);
  if (thinkBuf) {
    yield {
      kind: "thinking_complete",
      thinking: thinkBuf.thinking,
      ...(progressUpdates && !thinkBuf.redacted && thinkBuf.thinking.length > 0 ? { presentation: "progress" as const } : {}),
      blockKey: `${runId}:${event.index}`,
      signature: thinkBuf.signature || undefined,
      ...(thinkBuf.redacted ? { redacted: true as const } : {}),
    };
    thinkingBuffers.delete(event.index);
    return;
  }
  // Neither tool nor thinking; the block was a text block. Signal completion
  // so downstream can exit the "generating" phase at the actual block boundary,
  // not wait for the next block to flip it.
  yield { kind: "text_complete", blockKey: `${runId}:${event.index}` } as const;
}
