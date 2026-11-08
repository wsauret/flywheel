import OpenAI, { APIConnectionError, APIError } from "openai";
import { Redacted } from "effect";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import type { OpenAIAuth } from "../../../infra/auth/openai-auth-types.js";
import type { AccessProviderCandidate, AccessProviderId } from "../../../infra/llm/access-provider.js";
import { computeUsagePrice, createModelInfoCache } from "../../../infra/llm/llm-helpers.js";
import type { ModelInfo, ModelsClient } from "../../../infra/llm/models.js";
import { Log } from "../../../infra/log.js";
import { LlmStreamError } from "./errors.js";
import { parseToolArguments } from "./json-parse.js";
import { withStreamAttempt } from "./stream-attempt.js";
import { isHeartbeatStreamEvent } from "./stream-watchdog.js";
import { mapChatGptAdapterEvents } from "./chatgpt-adapter/sse.js";
import { tryChatGptAdapterTransport } from "./chatgpt-adapter/transport.js";
import { createServiceTierTracker, openAIResponsesTarget } from "./openai-adapter-helpers.js";
import { OPENAI_CACHE_RATES, OPENAI_RESPONSES_TOOL_PRESENTATION, openAIOutputLimit, supportsOpenAIReasoning } from "./provider-description.js";
import { createChatGPTClient } from "./chatgpt-client.js";
import { createChatGPTTokenAccessor, logRejectedChatGptRequest, type ChatGPTTokenAccessor } from "./openai-chatgpt.js";
import { classifyOpenAIStreamError, classifyResponseFailed, createOpenAIStream, handleOpenAICompleted, handleOpenAIUsage, openAISessionAffinityHeaders } from "./openai-helpers.js";
import { prepareOpenAIResponsesRequest } from "./openai-responses.js";
import { resolveOpenAIServiceTier } from "../../../infra/llm/provider-options.js";
import { providerRequestHeaders } from "../../../infra/llm/provider-request-identity.js";
import { observeChatGptQuotaFrame } from "./provider-availability.js";
import type { ProviderAvailability } from "./provider-availability-types.js";
import { SHARED_PROMPT_NOTES } from "./prompt-notes.js";
import { observeProviderTelemetry } from "./stream-observe.js";
import { resolveAdapterTransport } from "./request-timing.js";
import { armStreamLiveness, throwIfLivenessFailure } from "./stream-liveness.js";
import { normalizeProviderAttemptFailure } from "./provider-failure.js";
import { invokeProviderAttempt, normalizeProviderAttemptIterator } from "./provider-attempt-boundary.js";
import { yieldOpenAIReasoningItem } from "./openai-reasoning-events.js";
import type { LLMClient, ProviderStreamEvent, StreamOptions } from "./types.js";
const log = Log.create({ service: "llm-openai" });

interface UnknownFields { [key: string]: unknown }
interface StringFields { [key: string]: string }

export async function createOpenAIAdapter(
  auth: OpenAIAuth,
  defaultModel: string,
  modelsClient: ModelsClient,
  overrides: {
    oauthPersistence?: import("../../../infra/auth/auth-context.js").OAuthPersistencePolicy;
    tokenAccessor?: ChatGPTTokenAccessor;
    client?: OpenAI; accessProvider?: AccessProviderId;
    candidate?: AccessProviderCandidate;
    resolvedModelMetadata?: ModelInfo | null;
    /** models.dev namespace selected by the provider contribution. */ catalogId?: string;
    /** Captured ChatGPT compatibility. Null states that admission found no listed models. */
    availableModels?: ReadonlySet<string> | null;
    extraHeaders?: (options: StreamOptions) => StringFields | Promise<StringFields>; resetIdleConnections?: () => void | Promise<void>;
    /** The availability binding every observation this adapter makes is folded
     *  into: ChatGPT usage headers, ChatGPT terminal frames, and Copilot's
     *  billed totals. The composition root injects the binding that request
     *  selection also reads; an adapter built outside it names no account and
     *  states nothing. */
    availability?: ProviderAvailability;
    /** Startup-selected project root (ARCH-DIRECTORIES-003), injected by the composition
     *  root. The ChatGPT transport writes an opted-in failed-request dump under
     *  it and never rediscovers a directory of its own. */
    projectRoot?: string;
  } = {},
): Promise<LLMClient> {
  const isChatGPT = auth.kind === "chatgpt";
  const transport = resolveAdapterTransport(overrides);
  const chatGPTTokenAccessor = auth.kind === "chatgpt"
    ? overrides.tokenAccessor ?? createChatGPTTokenAccessor({ seed: auth, persistence: overrides.oauthPersistence ?? "profile" })
    : undefined;
  // The runtime owns retries; SDK retries would stack multiplicatively.
  const client = overrides.client ?? (isChatGPT
    ? createChatGPTClient({ auth, oauthPersistence: overrides.oauthPersistence ?? "profile", tokenAccessor: chatGPTTokenAccessor, transportFetch: transport.fetch, ...(overrides.availability && overrides.candidate ? { availability: overrides.availability, candidate: overrides.candidate } : {}), ...(overrides.projectRoot ? { projectRoot: overrides.projectRoot } : {}) })
    : new OpenAI({ apiKey: Redacted.value(auth.apiKey), fetch: transport.fetch, maxRetries: 0 }));
  const accessProvider = overrides.accessProvider ?? (isChatGPT ? "chatgpt" : "openai_api");
  const extraHeaders = overrides.extraHeaders;

  // A proxy (Copilot, OpenCode Go) serves these models with its own context
  // windows; the provider's models.dev entry carries the proxy limits and
  // API-equivalent pricing (same rationale as the Anthropic adapter).
  const modelCache = createModelInfoCache(
    { model: defaultModel, info: overrides.resolvedModelMetadata ?? null },
  );
  const serviceTier = createServiceTierTracker(isChatGPT);

  const availableModels = isChatGPT ? overrides.availableModels ?? undefined : undefined;

  const adapter = {
    accessProvider,
    modelFamily: "openai",
    model: defaultModel,
    toolPresentation: OPENAI_RESPONSES_TOOL_PRESENTATION,
    promptNotes: SHARED_PROMPT_NOTES,
    get availableModels() {
      return availableModels;
    },
    get contextLimit() {
      return modelCache.contextLimit();
    },
    get outputLimit() {
      return openAIOutputLimit(modelCache.getCached()?.info ?? null);
    },
    get supportsReasoning() {
      return supportsOpenAIReasoning(modelCache.getCached()?.model ?? defaultModel, modelCache.getCached()?.info ?? null);
    },

    priceFor(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; promptTokens?: number }) {
      const result = computeUsagePrice({ ...tokens, reasoning: 0 }, modelCache.getCached()?.info?.pricing ?? { status: "unavailable", reason: "missing-rate-card" }, OPENAI_CACHE_RATES);
      const multiplier = serviceTier.multiplier(modelCache.getCached()?.model ?? defaultModel);
      if (result.status === "unavailable" || multiplier === 1) return result;
      const scale = (tier: typeof result.rateCard.standard) => Object.freeze({
        input: tier.input * multiplier,
        output: tier.output * multiplier,
        cacheRead: tier.cacheRead * multiplier,
        cacheWrite: tier.cacheWrite * multiplier,
        cacheWrite1h: tier.cacheWrite1h * multiplier,
        reasoning: tier.reasoning * multiplier,
      });
      return Object.freeze({
        ...result,
        amountUsd: result.amountUsd * multiplier,
        rateCard: Object.freeze({
          standard: scale(result.rateCard.standard),
          ...(result.rateCard.highContext ? { highContext: scale(result.rateCard.highContext) } : {}),
        }),
      });
    },

    historyTarget: (options: StreamOptions) => openAIResponsesTarget(accessProvider, options.model ?? defaultModel),

    async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
      const model = options.model ?? defaultModel;
      const info = await modelCache.resolveModelInfo(model);
      const requestedReasoning = options.reasoningEffort ?? "medium";
      // Track the tier the caller asked for, so cost accounting can fall
      // back to it when the server's response.service_tier is "default".
      serviceTier.setRequested(resolveOpenAIServiceTier(options.providerOptions));

      const modelSupportsReasoning = supportsOpenAIReasoning(model, info);
      if (requestedReasoning !== "off" && !modelSupportsReasoning) {
        log.warn(`Model ${model} does not support reasoning - proceeding without reasoning`);
      }

      const descriptor = prepareOpenAIResponsesRequest({ accessProvider, model, info, isChatGPT, options });
      if (chatGPTTokenAccessor) {
        await chatGPTTokenAccessor.fresh({ signal: options.signal, caller: "model request" });
      }
      // oxlint-disable-next-line eslint/complexity -- boundary: one generator owns the ordered Responses stream state machine.
      yield* withStreamAttempt<ProviderStreamEvent>(async function* (attempt) {
        const runId = crypto.randomUUID();
        const streamLiveness = armStreamLiveness(attempt, { label: "llm-openai", provider: "OpenAI", telemetry: options.telemetry });

        // Keep OpenAI Responses aligned across transports: instructions travel in
        // the top-level `instructions` field, not as a system/developer input item.
        const params = descriptor.params;

        streamLiveness.preStream();

        const requestHeaders = {
            ...(accessProvider === "github_copilot" ? {} : await providerRequestHeaders()),
            ...openAISessionAffinityHeaders(options, isChatGPT),
            ...await extraHeaders?.(options),
        };
        const sseHeaders = Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined;
        let stream: AsyncIterable<ResponseStreamEvent>;
        let wsCommitContinuation: ((items: import("openai/resources/responses/responses.js").ResponseInput | undefined, responseId: string | undefined) => void) | undefined;
        let dispatchRecorded = false;
        const recordDispatch = async (): Promise<void> => {
            if (dispatchRecorded) return;
            dispatchRecorded = true;
            await options.onDispatch?.();
        };
        const failProviderAttempt: (err: unknown) => never = (err) => {
          const availability = overrides.availability;
          const quotaObservation = availability && overrides.candidate
            ? observeChatGptQuotaFrame(err, overrides.candidate, availability)
            : undefined;
          throwIfLivenessFailure(err, attempt, options.signal);
          try {
            classifyOpenAIStreamError(err, quotaObservation);
          } catch (classified) {
            throw normalizeProviderAttemptFailure(classified);
          }
        };
          if (chatGPTTokenAccessor) {
            const wsResult = await tryChatGptAdapterTransport({
              tokenAccessor: chatGPTTokenAccessor,
              projectRoot: overrides.projectRoot,
              providerSessionKey: options.providerSessionKey,
              promptCacheKey: options.promptCacheKey,
              cacheRetention: options.cacheRetention,
              signal: attempt.signal,
              params,
              onDispatch: recordDispatch,
            });
            if (wsResult) {
              stream = normalizeProviderAttemptIterator(wsResult.events, failProviderAttempt);
              wsCommitContinuation = wsResult.commitContinuation;
            } else {
              await recordDispatch();
              const sse = await invokeProviderAttempt(() => createOpenAIStream(
                client,
                params,
                attempt.signal,
                sseHeaders,
              ), failProviderAttempt);
              // The backend SSE wire carries the same nonstandard terminal frames as
              // the WebSocket wire (legacy response.done, response.incomplete, error
              // envelopes), so both transports normalize through the one boundary
              // mapper. Without it a truncated response ends the stream with no
              // response.completed and surfaces as a bogus transient stream error.
              // SAFETY: boundary cast into the wire-frame mapper; ResponseStreamEvent
              // values are plain parsed JSON objects, which is exactly the record
              // shape the mapper reads field-by-field.
              // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: adapt SDK response events to the ChatGPT wire-frame mapper
              stream = normalizeProviderAttemptIterator(mapChatGptAdapterEvents(sse as AsyncIterable<UnknownFields>, (error) => {
                logRejectedChatGptRequest(params, "http");
                throw error;
              }), (error) => {
                // The SDK consumes `error` frames before the mapper sees them.
                if (error instanceof APIError && !(error instanceof APIConnectionError)) logRejectedChatGptRequest(params, "http");
                failProviderAttempt(error);
              });
            }
          } else {
            await recordDispatch();
            const sse = await invokeProviderAttempt(() => createOpenAIStream(
              client,
              params,
              attempt.signal,
              sseHeaders,
            ), failProviderAttempt);
            stream = normalizeProviderAttemptIterator(sse, failProviderAttempt);
          }

          const toolCallIdsByOutputIndex = new Map<number, string>();
          const customToolCallsByOutputIndex = new Map<number, { callId: string; itemId?: string; name: string; input: string; inputClosed: boolean }>();
          // Keyed by item id when the wire supplies one: some proxies
          // (OpenCode Go's grok) report streamed output_index values that
          // disagree with the completed response's array positions, so an
          // index-only key would re-yield the same item on the terminal refold.
          const terminalOutputItems = new Set<string>();
          // The call id is the identity every downstream reader keys on, and
          // the wire always carries it. The item keys above can both miss: a
          // provider that omits the item id and also reports a different array
          // position on the completed refold defeats the id key (absent) and
          // the index key (changed), and the same call yields twice.
          const emittedToolCallIds = new Set<string>();
          let reasoningBuf = "";
          let currentReasoningBlockKey = "";
          let receivedCompleted = false;
          let earlyResponseId: string | undefined;
          let responseStarted = false;
          const capturedReasoningIds = new Set<string>();
          // The key each reasoning item streamed under, by item id, so that a
          // refold at a different array position (see terminalOutputItems)
          // still settles the row that streamed.
          const streamedReasoningKeys = new Map<string, string>();
          const streamReasoning = (itemId: string, outputIndex: number): string => {
            currentReasoningBlockKey = `${runId}:${outputIndex}`;
            streamedReasoningKeys.set(itemId, currentReasoningBlockKey);
            return currentReasoningBlockKey;
          };
          const flushReasoning = function* (): Generator<ProviderStreamEvent> {
            if (!currentReasoningBlockKey) return;
            streamLiveness.complete(currentReasoningBlockKey);
            if (reasoningBuf) yield { kind: "thinking_complete", thinking: reasoningBuf, blockKey: currentReasoningBlockKey } as const;
            reasoningBuf = ""; currentReasoningBlockKey = "";
          };
          const yieldReasoningItem = (item: { type?: string; id?: string }, outputIndex: number) => yieldOpenAIReasoningItem(item, capturedReasoningIds, (item.id ? streamedReasoningKeys.get(item.id) : undefined) ?? `${runId}:${outputIndex}`);
          const finishOutputItem = function* (item: import("openai/resources/responses/responses.js").ResponseOutputItem, outputIndex: number): Generator<ProviderStreamEvent> {
            const itemKey = typeof item.id === "string" && item.id ? `id:${item.id}` : `index:${outputIndex}`;
            if (terminalOutputItems.has(itemKey)) return;
            terminalOutputItems.add(itemKey);
            yield* flushReasoning();
            if (item.type === "function_call") {
              if (item.call_id) {
                if (emittedToolCallIds.has(item.call_id)) return;
                emittedToolCallIds.add(item.call_id);
              }
              const { input: toolInput, parseError } = parseToolArguments(item.arguments);
              yield {
                kind: "tool_use",
                toolCall: {
                  id: item.call_id,
                  name: item.name,
                  input: toolInput,
                  ...(parseError ? { inputParseError: parseError } : {}),
                  ...(item.id ? { providerItemId: item.id } : {}),
                  providerCallId: item.call_id,
                },
              } as const;
              toolCallIdsByOutputIndex.delete(outputIndex);
              return;
            }
            if (item.type === "custom_tool_call") {
              if (emittedToolCallIds.has(item.call_id)) return;
              emittedToolCallIds.add(item.call_id);
              const buffered = customToolCallsByOutputIndex.get(outputIndex);
              if (buffered && !buffered.inputClosed) {
                yield { kind: "tool_input_delta", toolUseId: item.call_id, partialJson: '"}', generationText: "" } as const;
              }
              yield {
                kind: "tool_use",
                toolCall: {
                  id: item.call_id,
                  name: item.name,
                  input: { input: item.input || buffered?.input || "" },
                  ...(item.id ? { providerItemId: item.id } : {}),
                  providerCallId: item.call_id,
                },
              } as const;
              customToolCallsByOutputIndex.delete(outputIndex);
              return;
            }
            if (item.type === "message") {
              // SAFETY: ChatGPT adds phase to the SDK message item. The value is consumed only through this bounded wire extension.
              // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: ChatGPT adds phase to the SDK message item
              const phase = (item as { phase?: "commentary" | "final_answer" }).phase;
              const signature = item.id ? JSON.stringify({ v: 1, id: item.id, ...(phase ? { phase } : {}) }) : undefined;
              const content = item.content.map((part) => part.type === "output_text" ? part.text : part.refusal).join("");
              yield { kind: "text_terminal", content, blockKey: `${runId}:${outputIndex}`, ...(signature ? { signature } : {}) } as const;
              yield { kind: "text_complete", blockKey: `${runId}:${outputIndex}` } as const;
              return;
            }
            yield* yieldReasoningItem(item, outputIndex);
          };
          for await (const event of stream) {
            observeProviderTelemetry(options.telemetry, event.type, {
              responseId: "response" in event ? event.response?.id : undefined,
              itemType: "item" in event ? event.item?.type : undefined,
            });
            // Heartbeats re-arm the frame clock (connection is alive) but not
            // the progress clock: the model may still be stalled behind a warm
            // connection, so the PATIENT cap bounds real-event silence. They
            // also never mark the response started.
            if (isHeartbeatStreamEvent(event.type)) {
              streamLiveness.keepalive();
              continue;
            }
            streamLiveness.frame();
            if (!responseStarted) {
              responseStarted = true;
              yield { kind: "provider_response_started" } as const;
            }

            switch (event.type) {
              case "response.created":
                if (event.response?.id) earlyResponseId = event.response.id;
                break;

              case "response.reasoning_summary_text.delta":
                if (!currentReasoningBlockKey) streamLiveness.begin(`${runId}:${event.output_index}`);
                streamReasoning(event.item_id, event.output_index);
                reasoningBuf += event.delta;
                streamLiveness.append(event.delta);
                yield { kind: "thinking_delta", text: event.delta, blockKey: currentReasoningBlockKey } as const;
                break;

              // Preserve separators between multi-part reasoning summaries.
              case "response.reasoning_summary_part.done":
                if (reasoningBuf && !reasoningBuf.endsWith("\n\n")) {
                  currentReasoningBlockKey = `${runId}:${event.output_index}`;
                  reasoningBuf += "\n\n";
                  streamLiveness.append("\n\n");
                  yield { kind: "thinking_delta", text: "\n\n", blockKey: currentReasoningBlockKey } as const;
                }
                break;

              // Some gpt-5 variants emit raw reasoning text on this path.
              case "response.reasoning_text.delta":
                if (!currentReasoningBlockKey) streamLiveness.begin(`${runId}:${event.output_index}`);
                streamReasoning(event.item_id, event.output_index);
                reasoningBuf += event.delta;
                streamLiveness.append(event.delta);
                yield { kind: "thinking_delta", text: event.delta, blockKey: currentReasoningBlockKey } as const;
                break;

              case "response.output_text.delta":
              case "response.refusal.delta": {
                yield* flushReasoning();
                yield { kind: "text_delta", text: event.delta, blockKey: `${runId}:${event.output_index}` } as const;
                break;
              }

              case "response.output_item.added": {
                const addedItem = event.item;
                if (addedItem.type === "function_call") {
                  toolCallIdsByOutputIndex.set(event.output_index, addedItem.call_id);
                  yield { kind: "tool_input_start", toolUseId: addedItem.call_id, name: addedItem.name } as const;
                } else if (addedItem.type === "custom_tool_call") {
                  customToolCallsByOutputIndex.set(event.output_index, { callId: addedItem.call_id, itemId: addedItem.id, name: addedItem.name, input: addedItem.input ?? "", inputClosed: false });
                  yield { kind: "tool_input_start", toolUseId: addedItem.call_id, name: addedItem.name } as const;
                  yield { kind: "tool_input_delta", toolUseId: addedItem.call_id, partialJson: '{"input":"', generationText: "" } as const;
                } else if (addedItem.type === "reasoning") {
                  streamLiveness.begin(streamReasoning(addedItem.id, event.output_index));
                  yield { kind: "thinking_delta", text: "", blockKey: currentReasoningBlockKey } as const;
                }
                break;
              }

              case "response.function_call_arguments.delta": {
                const callId = toolCallIdsByOutputIndex.get(event.output_index);
                if (callId !== undefined) {
                  yield { kind: "tool_input_delta", toolUseId: callId, partialJson: event.delta } as const;
                }
                break;
              }

              case "response.custom_tool_call_input.delta": {
                const call = customToolCallsByOutputIndex.get(event.output_index);
                if (call) {
                  call.input += event.delta;
                  yield { kind: "tool_input_delta", toolUseId: call.callId, partialJson: JSON.stringify(event.delta).slice(1, -1), generationText: event.delta } as const;
                }
                break;
              }

              case "response.custom_tool_call_input.done": {
                const call = customToolCallsByOutputIndex.get(event.output_index);
                if (call) {
                  call.input = event.input;
                  call.inputClosed = true;
                  yield { kind: "tool_input_delta", toolUseId: call.callId, partialJson: '"}', generationText: "" } as const;
                }
                break;
              }

              case "response.output_item.done":
                yield* finishOutputItem(event.item, event.output_index);
                break;

              // response.incomplete is the API-key path's terminal frame for a
              // truncated or filtered response (the ChatGPT transports normalize it
              // to response.completed with status "incomplete" upstream); the shared
              // handler branches on response.status, so both cases route through it.
              case "response.completed":
              case "response.incomplete":
                receivedCompleted = true;
                yield* flushReasoning();
                for (let outputIndex = 0; outputIndex < (event.response.output?.length ?? 0); outputIndex++) {
                  const item = event.response.output?.[outputIndex];
                  if (item) yield* finishOutputItem(item, outputIndex);
                }
                yield* handleOpenAICompleted(event, yieldReasoningItem, model, (tier) => {
                  serviceTier.setObserved(tier);
                });
                // Backend WebSocket delta continuation: hand the response's output items + responseId to
                // the next turn so it rides the connection with previous_response_id + delta input.
                if (wsCommitContinuation) {
                  // SAFETY: the WS continuation replays this turn's output as the next request's
                  // input; response.output (ResponseOutputItem[]) and the continuation's
                  // ResponseInput are wire-compatible SDK arrays for replay.
                  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: replay SDK output items as the next SDK input
                  const finalResponse = event.response as { id?: string; output?: import("openai/resources/responses/responses.js").ResponseInput };
                  wsCommitContinuation(finalResponse?.output, finalResponse?.id);
                }
                break;

              case "response.failed": {
                if (event.response?.usage) yield* handleOpenAIUsage(event.response);
                const error = event.response?.error;
                const reason = event.response?.incomplete_details?.reason;
                return failProviderAttempt(classifyResponseFailed(
                  error ? { code: error.code, message: error.message } : undefined,
                  reason,
                ));
              }

              case "error": {
                // `event` is narrowed to ResponseErrorEvent by the discriminated-union switch.
                // The frame is the failure payload itself, so it carries the same
                // codes as `response.failed`: it goes through the one classifier
                // that separates a terminal quota from a transient blip.
                return failProviderAttempt(classifyResponseFailed({ code: event.code, message: event.message }, undefined));
              }

              default: {
                // OpenAI ships new Responses events between SDK versions
                // (`response.web_search.*`, `response.mcp.*`, etc.). Surface
                // unknown types at debug level so the gap is observable; the
                // stream itself is unaffected.
                log.debug("OpenAI stream: unknown event type", { type: event.type });
                break;
              }
            }
          }

          if (!receivedCompleted) {
            // A caller abort (user interrupt) tears the SDK stream down and
            // the loop above just ends. Fold custom freeform input into the
            // canonical object before the interrupted turn is persisted.
            if (options.signal?.aborted) {
              for (const [outputIndex, call] of customToolCallsByOutputIndex) {
                yield* finishOutputItem({
                  type: "custom_tool_call",
                  call_id: call.callId,
                  name: call.name,
                  input: call.input,
                  ...(call.itemId ? { id: call.itemId } : {}),
                }, outputIndex);
              }
              throw options.signal.reason;
            }
            if (earlyResponseId) log.warn("OpenAI stream closed before completion", { responseId: earlyResponseId });
            failProviderAttempt(new LlmStreamError("stream closed before response.completed", "transient"));
          }
        }, options);
    },

  } satisfies LLMClient;

  await modelCache.resolveModelInfo(defaultModel);
  return adapter;
}
