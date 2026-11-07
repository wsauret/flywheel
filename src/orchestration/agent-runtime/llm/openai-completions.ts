/**
 * OpenAI chat-completions streaming adapter.
 *
 * Used for Copilot models that are served via `/chat/completions` (gpt-4o,
 * gpt-4.1, gemini-*, grok-*) rather than the Responses API (`/responses`;
 * gpt-5*, o-series). The wire format differs:
 *
 *   Responses API:        `output_item.added`, `function_call_arguments.delta`
 *   Chat-completions API: `choices[].delta`, `tool_calls[].function.arguments`
 *
 * Faithful to pi's `openai-completions.ts` streaming/tool-call/error
 * handling. This adapter serves both Copilot chat-completions models and
 * OpenRouter, so OpenRouter-specific wire behaviors (encrypted
 * `reasoning_details` round-trip) live here gated on the access provider.
 */

import OpenAI from "openai";
import type { ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions.js";
import type { AccessProviderCandidate, AccessProviderId } from "../../../infra/llm/access-provider.js";
import { computeUsagePrice, createModelInfoCache } from "../../../infra/llm/llm-helpers.js";
import { providerRequestHeaders } from "../../../infra/llm/provider-request-identity.js";
import type { ModelInfo, ModelsClient, ReasoningEffort } from "../../../infra/llm/models.js";
import { Log } from "../../../infra/log.js";
import { asRecord } from "../../../infra/record.js";
import { classifyQuotaError, ContentFilteredError, ContentRefusedError, ContextLengthExceededError, LlmStreamError, OutputLengthExceededError } from "./errors.js";
import type { CompletedStopReason } from "./messages.js";
import { parseToolArguments } from "./json-parse.js";
import { normalizeProviderAttemptFailure } from "./provider-failure.js";
import { invokeProviderAttempt, normalizeProviderAttemptIterator } from "./provider-attempt-boundary.js";
import { withStreamAttempt } from "./stream-attempt.js";
import { OPENAI_CACHE_RATES, openAIOutputLimit } from "./provider-description.js";
import { CHAT_COMPLETIONS_REASONING_FIELDS, applyAnthropicCacheControl, mapChatCompletionsToolChoice, toChatCompletionsMessages } from "./openai-completions-messages.js";
import { isOpenAIContextLengthMessage } from "./openai-helpers.js";
import { cacheWriteTokens } from "./openai-usage-normalization.js";
import { cacheControlFor } from "./anthropic-adapter-helpers.js";
import { openAIReasoningEffort, supportsThinkingDisable } from "./model-compat.js";
import type { ProviderAvailability } from "./provider-availability-types.js";
import { SHARED_PROMPT_NOTES } from "./prompt-notes.js";
import { armStreamLiveness, throwIfLivenessFailure } from "./stream-liveness.js";
import { observeProviderTelemetry } from "./stream-observe.js";
import { FUNCTION_TOOL_PRESENTATION, immutablePreparedRequest, type LLMClient, type PreparedProviderRequest, type ProviderStreamEvent, type StreamOptions } from "./types.js";
import { renderSystemPrompt } from "./system-prompt-tiers.js";
import type { ProviderHistoryTarget } from "./provider-history.js";

const log = Log.create({ service: "llm-openai-completions" });

interface UnknownFields { [key: string]: unknown }
interface StringFields { [key: string]: string }

export type PreparedOpenAICompletionsRequest = PreparedProviderRequest<"openai-completions", ChatCompletionCreateParamsStreaming>;

function readReasoningDelta(delta: UnknownFields): { field: string; text: string } | undefined {
  for (const field of CHAT_COMPLETIONS_REASONING_FIELDS) {
    const value = delta[field];
    if (typeof value === "string" && value.length > 0) return { field, text: value };
  }
  return undefined;
}

/** OpenRouter's encrypted-reasoning stream detail. Reasoning models served
 *  through OpenRouter (Claude, Gemini mirrors) bind encrypted reasoning to
 *  tool calls via `delta.reasoning_details`; the continuation request must
 *  replay the detail on the assistant message or the provider rejects the
 *  tool-result turn with a 400. pi `openai-completions.ts:127-139`. */
interface EncryptedReasoningDetail {
  type: "reasoning.encrypted";
  id: string;
  data: string;
}

function isEncryptedReasoningDetail<Detail>(detail: Detail): detail is Detail & EncryptedReasoningDetail {
  if (typeof detail !== "object" || detail === null) return false;
  // SAFETY: narrowed to a non-null object above; Record is the structural read
  // view for the field checks that complete the type-guard proof.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: validate nonstandard provider fields on an SDK delta
  const candidate = detail as UnknownFields;
  return (
    candidate.type === "reasoning.encrypted" &&
    typeof candidate.id === "string" && candidate.id.length > 0 &&
    typeof candidate.data === "string" && candidate.data.length > 0
  );
}

/** Folds a delta's `reasoning_details` entries into the per-tool-call map,
 *  serialized for replay as the tool call's `thoughtSignature`. */
function captureEncryptedReasoningDetails(
  delta: UnknownFields,
  out: Map<string, string>,
): void {
  const reasoningDetails = delta.reasoning_details;
  if (!Array.isArray(reasoningDetails)) return;
  for (const detail of reasoningDetails) {
    if (isEncryptedReasoningDetail(detail)) out.set(detail.id, JSON.stringify(detail));
  }
}

/** Map our canonical effort to the chat-completions wire value. `off`/`undefined`
 *  omit the param (caller gates on this). A model that declares its tiers gets
 *  the nearest declared tier, as on the Responses path: DeepSeek declares
 *  low, high, and max, so a max request goes out as max. Without a declaration,
 *  `max` and `ultra` fold into `xhigh`, the strongest tier the OpenAI wire knows. */
function chatCompletionsReasoningEffort(
  effort: ReasoningEffort | undefined,
  info: ModelInfo | null,
): ChatCompletionCreateParamsStreaming["reasoning_effort"] {
  if (effort === undefined || effort === "off") return undefined;
  const declared = openAIReasoningEffort(effort, info);
  // SAFETY: models.dev declares provider wire tiers that can lead the SDK union.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: models.dev provider tiers lead the narrower SDK wire union
  if (declared) return declared as NonNullable<ChatCompletionCreateParamsStreaming["reasoning_effort"]>;
  return effort === "max" || effort === "ultra" ? "xhigh" : effort;
}

/** Classifies a failure of the chat-completions request whose prepared message list is `wire`, or of its stream.
 *  An error frame inside a 200 stream reaches here as an `APIError` with no status. */
function classifyChatCompletionsError(err: unknown, wire: readonly ChatCompletionMessageParam[]): Error {
  if (err instanceof OpenAI.APIConnectionError) return new LlmStreamError(err.message, "transient", undefined, { cause: err });
  if (err instanceof OpenAI.APIError) {
    // A spent account is terminal: Copilot serves this wire too and rejects an
    // exhausted premium allowance with 402, which must advance the provider
    // chain rather than retry against the spent account.
    const quota = classifyQuotaError(err.status, err.message, err);
    if (quota) return quota;
    if (err.status === 408 || err.status === 409) return new LlmStreamError(err.message, "transient", undefined, { cause: err });
    const statesContextLength = (typeof err.code === "string" && isOpenAIContextLengthMessage(err.code)) || isOpenAIContextLengthMessage(err.message);
    if ((err.status === undefined || err.status === 400 || err.status === 413) && statesContextLength) {
      return new ContextLengthExceededError(err.message, { cause: err });
    }
    if (err.status === undefined && err.code === "content_filter") return new ContentFilteredError(err.message, { cause: err });
    const imageRefusal = chatCompletionsImageRefusal(err, wire);
    if (imageRefusal) return imageRefusal;
  }
  if (err instanceof OpenAI.APIError && err.status !== undefined && err.status >= 500) {
    return new LlmStreamError(err.message, "overload", undefined, { cause: err });
  }
  if (err instanceof OpenAI.APIError && err.status === 429) {
    return new LlmStreamError(err.message, "rate_limit", undefined, { cause: err });
  }
  // A raw transient network error passes through: `classifyProviderFailure`
  // types it as transient and keeps the raw error as the cause.
  return err instanceof Error ? err : new Error(String(err));
}

const IMAGE_DECODE_FAILURE = /\bdecod\w*\b[^.]*\bimage|\bimage\b[^.]*\bdecod/i;

/** A content refusal when a request that carries images fails with 415, or with a 400 whose message or upstream
 *  detail names image decoding; otherwise undefined. The host that could not decode an image refuses every later
 *  request with the same bytes. A 404 is never one, because OpenRouter answers a provider pin that cannot serve the
 *  model at all with the same 404 text as one that cannot take the images. The refusal names no part, because the
 *  provider names none and one tool batch can carry several new images; the loop repairs it without a locator. */
function chatCompletionsImageRefusal(err: InstanceType<typeof OpenAI.APIError>, wire: readonly ChatCompletionMessageParam[]): ContentRefusedError | undefined {
  if (err.status !== 415 && err.status !== 400) return undefined;
  const carriesImage = wire.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
  if (!carriesImage) return undefined;
  const upstream = upstreamDetail(err);
  if (err.status === 400 && !IMAGE_DECODE_FAILURE.test(err.message) && !(upstream !== undefined && IMAGE_DECODE_FAILURE.test(upstream))) return undefined;
  return new ContentRefusedError("OpenAI", err, { reason: upstream === undefined ? err.message : `${err.message}: ${upstream}`, part: undefined });
}

/** OpenRouter's upstream-provider error (`error.metadata.raw`): its message when the raw body is a JSON error,
 *  else the raw text. */
function upstreamDetail(err: InstanceType<typeof OpenAI.APIError>): string | undefined {
  const raw = asRecord(asRecord(err.error)?.metadata)?.raw;
  if (typeof raw !== "string") return undefined;
  try {
    const message: unknown = asRecord(asRecord(JSON.parse(raw))?.error)?.message;
    return typeof message === "string" ? message : raw;
  } catch {
    return raw;
  }
}

interface StreamingToolCall {
  id: string;
  name: string;
  argumentsBuffer: string;
  generationTiming?: { first: number; last: number; chunks: number };
}

function mapChatCompletionsStopReason(finishReason: string): CompletedStopReason {
  switch (finishReason) {
    case "tool_calls": return "tool_use";
    // The output-length cap is an overflow, as on every other wire: the loop
    // resumes the response instead of finalizing a cut one as a turn whose
    // last tool call, flushed above from a partial buffer, was refused.
    case "length": throw new OutputLengthExceededError("Response truncated: length");
    case "stop": return "end_turn";
    case "content_filter": return "content_filter";
    default:
      // "error", "network_error", and future values: silently mapping them to
      // end_turn would finalize a broken response as a successful turn and
      // skip retry (pi `openai-completions.ts:1364-1388,:577-579`
      // fixed this class deliberately). Consistent with the existing
      // missing-finish_reason throw above.
      throw new LlmStreamError(`stream finished with unexpected finish_reason: ${finishReason}`, "transient");
  }
}

/** Builds the per-attempt reasoning request fields. OpenRouter normalizes
 *  reasoning across vendors via a nested `reasoning` object and needs an
 *  explicit off because several mirrors (gemini, gpt) default reasoning on
 *  (pi `openai-completions.ts:784-793`); always-thinking models
 *  that reject off get the param omitted. Other endpoints take the flat
 *  OpenAI `reasoning_effort`, omitted when off. Copilot's chat-completions
 *  models reject the param entirely. DeepSeek thinks by default, so off needs
 *  an explicit `thinking: disabled`; it also rejects a named or required
 *  `tool_choice` in thinking mode with a 400, so a forced tool turns thinking
 *  off whatever the effort. */
function chatCompletionsReasoningParams(
  accessProvider: AccessProviderId,
  modelId: string,
  info: ModelInfo | null,
  effort: ReasoningEffort | undefined,
  toolChoice: ChatCompletionCreateParamsStreaming["tool_choice"] | undefined,
): UnknownFields {
  if (!(info?.reasoning ?? false) || accessProvider === "github_copilot") return {};
  const wireEffort = chatCompletionsReasoningEffort(effort, info);
  if (accessProvider === "deepseek") {
    const forcedTool = toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "none";
    return wireEffort && !forcedTool ? { thinking: { type: "enabled" }, reasoning_effort: wireEffort } : { thinking: { type: "disabled" } };
  }
  if (accessProvider === "openrouter") {
    if (wireEffort) return { reasoning: { effort: wireEffort } };
    return supportsThinkingDisable(modelId) ? { reasoning: { effort: "none" } } : {};
  }
  return wireEffort ? { reasoning_effort: wireEffort } : {};
}

/** Anthropic served through proxies requires the `tools` param whenever the
 *  conversation carries tool traffic, even when no tools are offered this turn
 *  (pi `openai-completions.ts:730-733`). */
function hasToolHistory(messages: ChatCompletionMessageParam[]): boolean {
  return messages.some((m) => m.role === "tool" || (m.role === "assistant" && m.tool_calls !== undefined));
}

/** The replay identity that this adapter stamps on its turns and lowers history for. Chat completions shares the
 *  Responses API's identity: an access provider serves each model through one endpoint, so the access provider and the
 *  model tell the two apart. */
function chatCompletionsTarget(accessProvider: AccessProviderId, model: string): ProviderHistoryTarget {
  return { accessProvider, provider: "openai", api: "openai-responses", model, sharedHost: false };
}

export function prepareOpenAICompletionsRequest(input: {
  accessProvider: AccessProviderId;
  model: string;
  wireModel: string;
  info: ModelInfo | null;
  options: StreamOptions;
  providerOutputCap?: number;
}): PreparedOpenAICompletionsRequest {
  const { accessProvider, model, wireModel, info, options, providerOutputCap } = input;
  const messages = toChatCompletionsMessages(options.messages, info?.modalities?.input?.includes("image") ?? false, chatCompletionsTarget(accessProvider, model), info?.interleavedReasoningField);
  const systemPrompt = renderSystemPrompt(options.systemPrompt);
  if (systemPrompt) {
    const role = accessProvider === "openrouter" && wireModel.startsWith("openai/") && info?.reasoning ? "developer" : "system"; // provider-model-literal-allow: payload -- OpenRouter system-role wire compatibility
    messages.unshift({ role, content: systemPrompt });
  }
  const tools: ChatCompletionTool[] = options.tools.map((tool) => {
    const presented = FUNCTION_TOOL_PRESENTATION.present(tool);
    return { type: "function", function: { name: tool.name, description: presented.description, parameters: presented.inputFormat } };
  });
  if (accessProvider === "openrouter" && wireModel.startsWith("anthropic/") && options.cacheRetention !== "none") { // provider-model-literal-allow: payload -- OpenRouter Anthropic cache-control wire compatibility
    applyAnthropicCacheControl(messages, tools, cacheControlFor(options.cacheRetention));
  }
  const outputCap = options.outputTokenLimit
    ?? (accessProvider === "github_copilot" ? undefined : providerOutputCap ?? info?.outputLimit);
  const toolChoice = mapChatCompletionsToolChoice(options.toolChoice);
  const params: ChatCompletionCreateParamsStreaming = {
    model: wireModel,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools, tool_choice: toolChoice ?? "auto" } : hasToolHistory(messages) ? { tools: [] } : {}),
    // DeepSeek ignores `max_completion_tokens` and caps output only by `max_tokens`.
    ...(outputCap ? accessProvider === "deepseek" ? { max_tokens: outputCap } : { max_completion_tokens: outputCap } : {}),
    ...(accessProvider === "openrouter" && options.providerOptions?.openrouter ? { provider: options.providerOptions.openrouter } : {}),
    ...chatCompletionsReasoningParams(accessProvider, model, info, options.reasoningEffort, toolChoice),
  };
  return immutablePreparedRequest({
    endpoint: "openai-completions",
    params,
    systemPrompt: systemPrompt || undefined,
    messages: params.messages,
    tools: params.tools,
    providerOptions: options.providerOptions?.openrouter,
    cacheRetention: options.cacheRetention,
    tokenClasses: { estimatedPromptTokens: options.estimatedContextTokens, cacheRetention: options.cacheRetention },
    outputCap,
  });
}

interface StreamingToolCallRegistry {
  byIndex: Map<number, StreamingToolCall>;
  byId: Map<string, StreamingToolCall>;
  ordered: StreamingToolCall[];
}

/** Folds one tool-call delta into the registry, keyed by stream index with an
 *  id fallback for providers that omit the index. Arguments that precede the
 *  name remain buffered until the named start can be emitted.
 *  @yields {ProviderStreamEvent} one named tool-input start, then every argument byte in order. */
function* handleToolCallDelta(
  toolDelta: { index?: number; id?: string | null; function?: { name?: string | null; arguments?: string | null } },
  registry: StreamingToolCallRegistry,
  at: number,
): Generator<ProviderStreamEvent> {
  const idx = typeof toolDelta.index === "number" ? toolDelta.index : undefined;
  let entry = idx !== undefined ? registry.byIndex.get(idx) : undefined;
  if (!entry && toolDelta.id) entry = registry.byId.get(toolDelta.id);
  const previousName = entry?.name ?? "";
  if (!entry) {
    entry = {
      id: toolDelta.id ?? `call_${Date.now()}_${idx ?? registry.ordered.length}`,
      name: toolDelta.function?.name ?? "",
      argumentsBuffer: "",
    };
    if (idx !== undefined) registry.byIndex.set(idx, entry);
    if (toolDelta.id) registry.byId.set(toolDelta.id, entry);
    registry.ordered.push(entry);
  } else if (!entry.name && toolDelta.function?.name) {
    entry.name = toolDelta.function.name;
  }
  const argumentDelta = toolDelta.function?.arguments;
  if (argumentDelta) {
    entry.argumentsBuffer += argumentDelta;
    const previous = entry.generationTiming;
    entry.generationTiming = { first: previous?.first ?? at, last: at, chunks: (previous?.chunks ?? 0) + 1 };
  }
  if (!previousName && entry.name) {
    yield { kind: "tool_input_start", toolUseId: entry.id, name: entry.name } as const;
    if (entry.argumentsBuffer) {
      yield { kind: "tool_input_delta", toolUseId: entry.id, partialJson: entry.argumentsBuffer, generationTiming: entry.generationTiming } as const;
      entry.generationTiming = undefined;
    }
  } else if (previousName && argumentDelta) {
    yield { kind: "tool_input_delta", toolUseId: entry.id, partialJson: argumentDelta, generationTiming: entry.generationTiming } as const;
    entry.generationTiming = undefined;
  }
}

export async function createOpenAIChatCompletionsAdapter(
  client: OpenAI,
  defaultModel: string,
  modelsClient: ModelsClient,
  overrides?: {
    accessProvider?: AccessProviderId; extraHeaders?: (options: StreamOptions) => StringFields | Promise<StringFields>; resetIdleConnections?: () => void | Promise<void>;
    candidate?: AccessProviderCandidate;
    /** Exact catalog transport ID, distinct from canonical model metadata. */
    wireModelId?: string;
    /** models.dev provider key for cost/limit lookup (defaults to "openai"). */
    providerHint?: string;
    /** Provider-owned cap already used for pre-dispatch admission. */
    providerOutputCap?: number;
    resolvedModelMetadata?: ModelInfo | null;
    /** The availability owner bound to the account this adapter spends from.
     *  Copilot's billed totals are folded into it, so they meter the same
     *  account selection reads. An adapter built outside the composition root
     *  records none. */
    availability?: ProviderAvailability;
  },
): Promise<LLMClient> {
  const modelCache = createModelInfoCache(
    { model: defaultModel, info: overrides?.resolvedModelMetadata ?? null },
  );
  const accessProvider = overrides?.accessProvider ?? "openai_api";
  const extraHeaders = overrides?.extraHeaders;

  const adapter = {
    accessProvider,
    // Wire family, not catalog family: a Claude or Gemini model served over
    // this endpoint replays as an OpenAI-family turn (`chatCompletionsTarget`).
    modelFamily: "openai",
    model: defaultModel,
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    promptNotes: SHARED_PROMPT_NOTES,
    get contextLimit() { return modelCache.contextLimit(); },
    get outputLimit() { return openAIOutputLimit(modelCache.getCached()?.info ?? null); },
    get supportsReasoning() {
      return modelCache.getCached()?.info?.reasoning ?? false;
    },

    priceFor(tokens) {
      return computeUsagePrice(tokens, modelCache.getCached()?.info?.pricing ?? { status: "unavailable", reason: "missing-rate-card" }, OPENAI_CACHE_RATES);
    },

    historyTarget: (options: StreamOptions) => chatCompletionsTarget(accessProvider, options.model ?? defaultModel),

    async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
      const modelId = options.model ?? defaultModel;
      // A provider that serves models under its own wire ids passes the fold
      // in (the same pattern as Copilot's dotted-Claude fold in anthropic.ts),
      // so adapter identity and metadata stay canonical.
      const wireModel = overrides?.wireModelId ?? modelId;
      const info = await modelCache.resolveModelInfo(modelId);

      const descriptor = prepareOpenAICompletionsRequest({
        accessProvider, model: modelId, wireModel, info, options,
        ...(overrides?.providerOutputCap === undefined ? {} : { providerOutputCap: overrides.providerOutputCap }),
      });
      const headers = {
        ...(accessProvider === "github_copilot" ? {} : await providerRequestHeaders()),
        ...await extraHeaders?.(options),
      };

      const throwChatCompletionsFailure = (error: unknown): never => {
        throw normalizeProviderAttemptFailure(classifyChatCompletionsError(error, descriptor.params.messages));
      };

      // oxlint-disable-next-line eslint/complexity -- boundary: one generator owns the ordered chat-completions stream state machine.
      yield* withStreamAttempt<ProviderStreamEvent>(async function* (attempt) {
        const runId = crypto.randomUUID();
        const params = descriptor.params;
        const requestOpts = headers ? { signal: attempt.signal, headers } : { signal: attempt.signal };
        const streamLiveness = armStreamLiveness(attempt, {
          label: "llm-openai-completions",
          provider: "OpenAI chat-completions",
          telemetry: options.telemetry,
          timeoutMessage: (event) => `OpenAI chat-completions stream ${event.phase === "pre-stream" ? "pre-stream timeout" : "idle timeout"}`,
        });
        let usage: { input: number; output: number; cacheRead: number | null; cacheWrite: number; reasoning: number } | undefined;
        // The usage chunk is the stream's terminal report, so any usage seen is final.
        const usageEvent = () => usage ? ({
          kind: "usage",
          final: true,
          inputTokens: Math.max(0, usage.input - (usage.cacheRead ?? 0) - usage.cacheWrite),
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheCreateTokens: usage.cacheWrite,
          reasoningTokens: usage.reasoning,
        } as const) : undefined;
        streamLiveness.preStream();
        await options.onDispatch?.();
        const stream = await invokeProviderAttempt(() => client.chat.completions.create(params, requestOpts), throwChatCompletionsFailure);

        try {
          let hasText = false;
          let textCompleteEmitted = false;
          let textRunOrdinal = 0;
          let thinkingRunOrdinal = 0;
          let thinkingBuf = "";
          let thinkingField: string | undefined;
          const toolCalls: StreamingToolCallRegistry = { byIndex: new Map(), byId: new Map(), ordered: [] };
          // Encrypted reasoning keyed by the tool-call id it is bound to. Tool
          // calls flush at stream end, so a detail arriving before or after its
          // tool-call delta resolves the same way.
          const reasoningDetailsByToolCallId = new Map<string, string>();
          let finishReason: string | undefined;
          let responseStarted = false;

          for await (const chunk of normalizeProviderAttemptIterator(stream, throwChatCompletionsFailure)) {
            const receivedAt = performance.now();
            streamLiveness.frame();
            if (!responseStarted) {
              responseStarted = true;
              yield { kind: "provider_response_started" } as const;
            }
            observeProviderTelemetry(options.telemetry, "chunk", {
              choiceCount: chunk.choices?.length ?? 0,
              finishReason: chunk.choices?.[0]?.finish_reason ?? undefined,
              hasUsage: chunk.usage !== undefined,
            });
            const choice = chunk.choices?.[0];
            const delta = choice?.delta;

            if (typeof delta?.content === "string" && delta.content.length > 0) {
              hasText = true;
              yield { kind: "text_delta", text: delta.content, blockKey: `${runId}:text:${textRunOrdinal}` } as const;
            }

            // Reasoning streams via `reasoning_content` (llama.cpp), `reasoning`
            // (most OpenAI-compatible endpoints, including Copilot for Grok/Gemini),
            // or `reasoning_text`. Use the first non-empty field; chutes.ai etc.
            // sometimes return both with identical content. runtime pattern.
            if (delta) {
              // SAFETY: reasoning_content / reasoning / reasoning_text are non-standard
              // delta fields the SDK's ChatCompletionChunk.Choice.Delta does not declare;
              // OpenAI-compatible endpoints (llama.cpp, Copilot's Grok/Gemini) add them.
              // readReasoningDelta type-checks each field is a string before use.
              // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: read nonstandard reasoning fields from the SDK delta
              const reasoningDelta = readReasoningDelta(delta as UnknownFields);
              if (reasoningDelta) {
                if (!thinkingBuf) {
                  streamLiveness.begin(`${runId}:thinking:${thinkingRunOrdinal}`);
                  yield { kind: "thinking_delta", text: "", blockKey: `${runId}:thinking:${thinkingRunOrdinal}` } as const;
                }
                thinkingField ??= reasoningDelta.field;
                thinkingBuf += reasoningDelta.text;
                streamLiveness.append(reasoningDelta.text);
                yield { kind: "thinking_delta", text: reasoningDelta.text, blockKey: `${runId}:thinking:${thinkingRunOrdinal}` } as const;
              }
            }

            if (delta?.tool_calls) {
              // First tool-call delta after streamed text marks the text-block
              // boundary. Flush text_complete so downstream can exit "generating"
              // before the tool flow starts.
              if (hasText && !textCompleteEmitted) {
                textCompleteEmitted = true;
                yield { kind: "text_complete", blockKey: `${runId}:text:${textRunOrdinal}` } as const;
                textRunOrdinal += 1;
              }
              for (const toolDelta of delta.tool_calls) {
                yield* handleToolCallDelta(toolDelta, toolCalls, receivedAt);
              }
            }

            // SAFETY: reasoning_details is an OpenRouter extension field the SDK's
            // delta type does not declare; the capture validates each entry's shape.
            // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: read OpenRouter reasoning details from the SDK delta
            if (delta) captureEncryptedReasoningDetails(delta as UnknownFields, reasoningDetailsByToolCallId);

            if (choice?.finish_reason) finishReason = choice.finish_reason;

            if (chunk.usage) {
              // Servers that omit the cache detail did not report cache reads; that is unknown, not zero.
              const cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens ?? null;
              const reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
              // OpenRouter reports Anthropic cache writes on this extension field.
              const cacheWrite = cacheWriteTokens(chunk.usage.prompt_tokens_details);
              usage = {
                input: chunk.usage.prompt_tokens ?? 0,
                output: chunk.usage.completion_tokens ?? 0,
                cacheRead,
                cacheWrite: typeof cacheWrite === "number" ? cacheWrite : 0,
                reasoning,
              };
            }
          }

          // Flush accumulated reasoning as a thinking block. The signature is
          // the reasoning field name the endpoint streamed it on; the converter
          // replays same-API thinking on that field and degrades anything else
          // to text (pi `openai-completions.ts:502-506,:1120-1127`).
          if (thinkingBuf) {
            streamLiveness.complete(`${runId}:thinking:${thinkingRunOrdinal}`);
            yield { kind: "thinking_complete", thinking: thinkingBuf, blockKey: `${runId}:thinking:${thinkingRunOrdinal}`, ...(thinkingField ? { signature: thinkingField } : {}) } as const;
            thinkingBuf = ""; thinkingRunOrdinal += 1;
          }
          // End of stream: flush text_complete if text was streamed and we
          // didn't already emit it at a tool-call boundary.
          if (hasText && !textCompleteEmitted) {
            textCompleteEmitted = true;
            yield { kind: "text_complete", blockKey: `${runId}:text:${textRunOrdinal}` } as const;
            textRunOrdinal += 1;
          }

          for (const tc of toolCalls.ordered) {
            const { input, parseError } = parseToolArguments(tc.argumentsBuffer);
            const thoughtSignature = reasoningDetailsByToolCallId.get(tc.id);
            yield {
              kind: "tool_use",
              toolCall: {
                id: tc.id,
                name: tc.name,
                input,
                providerCallId: tc.id,
                ...(thoughtSignature ? { thoughtSignature } : {}),
                ...(parseError ? { inputParseError: parseError } : {}),
              },
            } as const;
          }

          const finalUsage = usageEvent();
          if (finalUsage) yield finalUsage;

          // pi `openai-completions.ts:400-402`: throw on stream close without
          // a finish_reason; proxies (Copilot in particular) drop connections
          // mid-stream non-trivially; silently mapping to `end_turn` would
          // treat a truncated response as a successful turn.
          if (!finishReason) {
            throw normalizeProviderAttemptFailure(new LlmStreamError("stream closed before finish_reason", "transient"));
          }

          let stopReason: CompletedStopReason;
          try {
            stopReason = mapChatCompletionsStopReason(finishReason);
          } catch (error) {
            throw normalizeProviderAttemptFailure(error);
          }

          const { api, provider, model } = chatCompletionsTarget(accessProvider, modelId);
          yield { kind: "done", stopReason, metadata: { api, provider, model, timestamp: Date.now(), stopReason } } as const;
        } catch (err) {
          const finalUsage = usageEvent();
          if (finalUsage) yield finalUsage;
          throwIfLivenessFailure(err, attempt, options.signal);
          log.warn("OpenAI chat-completions stream error", { err: String(err) });
          throw err;
        } }, { signal: options.signal });
    },

  } satisfies LLMClient;

  await modelCache.resolveModelInfo(defaultModel);
  return adapter;
}
