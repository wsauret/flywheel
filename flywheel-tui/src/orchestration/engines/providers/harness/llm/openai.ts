// ADR-006: Intentionally cohesive provider adapter. Keeping protocol translation
// in one module preserves a single readable flow from provider stream to internal events.
// Pure helpers (message conversion, error classification) live in ./openai-helpers.js.
import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseErrorEvent,
  ResponseReasoningItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import type { ReasoningEffort as OpenAIReasoningEffort } from "openai/resources/shared.js";
import { Log } from "../../../../../infra/log.js";
import { contextWindowForModel } from "../../../engine-context.js";
import type { OpenAIAuth } from "../../../../../infra/auth/openai-auth-types.js";
import { createChatGPTClient } from "./openai-chatgpt.js";
import type { ModelsClient, ModelInfo } from "./models.js";
import { createModelInfoCache, computeCost } from "./llm-helpers.js";
import { CLIENT_TIMEOUT_MS, createIdleWatchdog, withRetry, withRetryStream } from "./retry.js";
import type { ContentBlock, LLMClient, Message, StreamEvent, StreamOptions } from "./types.js";
import { ContextLengthExceededError, OutputLengthExceededError, RetryableStreamError } from "./types.js";
import { classifyResponseFailed, REASONING_EFFORT, toResponseInput, extractSystemPrompt } from "./openai-helpers.js";

const log = Log.create({ service: "llm-openai" });

const STREAM_IDLE_TIMEOUT_MS = 120_000;



export function createOpenAIAdapter(
  auth: OpenAIAuth,
  defaultModel: string,
  modelsClient: ModelsClient,
): LLMClient {
  const isChatGPT = auth.kind === "chatgpt";
  const client = isChatGPT
    ? createChatGPTClient(auth)
    : new OpenAI({ apiKey: auth.apiKey, timeout: CLIENT_TIMEOUT_MS });

  const modelCache = createModelInfoCache(modelsClient, "openai");
  const OPENAI_CACHE_RATES = { cacheReadRatio: 0.5, cacheWriteRatio: 1.0 } as const;

  function supportsReasoning(model: string, info: ModelInfo | null): boolean { return info?.reasoning ?? /^(o\d|gpt-5)/.test(model); }
  function contextLimit(model: string, info: ModelInfo | null): number { return info?.contextLimit ?? contextWindowForModel(model); }
  function outputLimit(info: ModelInfo | null): number { return info?.outputLimit ?? 16_384; }

  const adapter: LLMClient = {
    accessProvider: isChatGPT ? "chatgpt" : "openai_api",
    modelFamily: "openai",
    model: defaultModel,
    get contextLimit() {
      return contextLimit(modelCache.getCached()?.model ?? defaultModel, modelCache.getCached()?.info ?? null);
    },
    get outputLimit() {
      return outputLimit(modelCache.getCached()?.info ?? null);
    },
    get supportsReasoning() {
      return supportsReasoning(modelCache.getCached()?.model ?? defaultModel, modelCache.getCached()?.info ?? null);
    },

    costFor(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; promptTokens?: number }): number {
      const info = modelCache.getCached()?.info ?? null;
      if (!info?.cost) return 0;
      return computeCost(tokens, info.cost, OPENAI_CACHE_RATES);
    },

    async *streamWithTools(options: StreamOptions): AsyncGenerator<StreamEvent> {
      const model = options.model ?? defaultModel;
      const info = await modelCache.resolveModelInfo(model);
      const reasoning = options.reasoningEffort ?? "max";

      const tools: ResponseCreateParamsStreaming["tools"] = options.tools.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: t.input_schema as Record<string, unknown>,
        strict: false,
      }));

      const effort = REASONING_EFFORT[reasoning];
      const hasReasoning = effort !== null && supportsReasoning(model, info);
      if (reasoning !== "off" && !supportsReasoning(model, info)) {
        log.warn(`Model ${model} does not support reasoning -- proceeding without reasoning`);
      }

      yield* withRetryStream(async function* () {
        const idleAbort = new AbortController();
        if (options.signal) {
          options.signal.addEventListener("abort", () => idleAbort.abort(), { once: true });
        }
        const watchdog = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS, () => {
          log.warn(`OpenAI stream idle for ${STREAM_IDLE_TIMEOUT_MS}ms, aborting`);
          idleAbort.abort();
        });

        try {
          const usePreviousResponse = !!options.previousResponseId;
          let messagesToSend = options.messages;
          if (usePreviousResponse) {
            const lastAsstIdx = options.messages.findLastIndex((m) => m.role === "assistant");
            messagesToSend = lastAsstIdx >= 0
              ? options.messages.slice(lastAsstIdx + 1)
              : options.messages.slice(-1);
          }
          const input = toResponseInput(messagesToSend);
          const instructions = options.systemPrompt || extractSystemPrompt(options.messages);

          const params = {
            model,
            input,
            instructions,
            tools,
            ...(isChatGPT ? { store: false } : { max_output_tokens: outputLimit(info) }),
            stream: true,
          } as ResponseCreateParamsStreaming;
          if (options.previousResponseId && !isChatGPT) {
            params.previous_response_id = options.previousResponseId;
          }
          if (hasReasoning) {
            params.reasoning = {
              effort: effort as OpenAIReasoningEffort,
              summary: "auto",
            };
            params.include = ["reasoning.encrypted_content"];
          }

          watchdog.reset();
          const stream = await client.responses.create(params, { signal: idleAbort.signal });

          let responseId: string | undefined;
          let toolArgsBuf = "";
          let reasoningBuf = "";
          let receivedCompleted = false;

          function* flushReasoning(): Generator<StreamEvent> {
            if (reasoningBuf) {
              yield { kind: "thinking_complete", thinking: reasoningBuf } as StreamEvent;
              reasoningBuf = "";
            }
          }

          try { for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
            watchdog.reset();

            switch (event.type) {
              case "response.created":
                responseId = event.response.id;
                break;

              case "response.reasoning_summary_text.delta":
                reasoningBuf += event.delta;
                break;

              case "response.output_text.delta":
                yield* flushReasoning();
                yield { kind: "text_delta", text: event.delta } as const;
                break;

              case "response.refusal.delta":
                yield* flushReasoning();
                yield { kind: "text_delta", text: event.delta } as const;
                break;

              case "response.function_call_arguments.delta":
                toolArgsBuf += event.delta;
                break;

              case "response.output_item.done": {
                yield* flushReasoning();
                const item = event.item;
                if (item.type === "function_call") {
                  let toolInput: Record<string, unknown>;
                  try {
                    toolInput = JSON.parse(item.arguments) as Record<string, unknown>;
                  } catch {
                    toolInput = { _raw: item.arguments };
                  }
                  yield {
                    kind: "tool_use",
                    toolCall: { id: item.call_id, name: item.name, input: toolInput },
                  } as const;
                  toolArgsBuf = "";
                }
                break;
              }

              case "response.completed": {
                receivedCompleted = true;
                yield* flushReasoning();
                const response = event.response;
                responseId = response?.id ?? responseId;
                if (response?.usage) {
                  const cachedTokens = response.usage.input_tokens_details?.cached_tokens ?? 0;
                  const reasoningTokens = response.usage.output_tokens_details?.reasoning_tokens ?? 0;
                  yield {
                    kind: "usage",
                    inputTokens: (response.usage.input_tokens ?? 0) - cachedTokens,
                    outputTokens: response.usage.output_tokens ?? 0,
                    cacheReadTokens: cachedTokens,
                    cacheCreateTokens: 0,
                    reasoningTokens,
                  } as const;
                }

                for (const item of response?.output ?? []) {
                  if (item.type === "reasoning") {
                    const r = item as ResponseReasoningItem;
                    if (r.id && r.encrypted_content) {
                      yield {
                        kind: "reasoning",
                        id: r.id,
                        encryptedContent: r.encrypted_content,
                        ...(r.summary ? { summary: r.summary } : {}),
                      } as StreamEvent;
                    }
                  }
                }

                const status = response?.status;
                if (status === "incomplete") {
                  throw new OutputLengthExceededError("Response truncated");
                }
                yield {
                  kind: "done",
                  stopReason: status === "completed" ? "end_turn" : status ?? "unknown",
                  responseId,
                } as const;
                break;
              }

              case "response.failed": {
                const error = event.response?.error;
                const reason = event.response?.incomplete_details?.reason;
                throw classifyResponseFailed(
                  error ? { code: error.code, message: error.message } : undefined,
                  reason,
                );
              }

              case "error": {
                const errorEvent = event as ResponseErrorEvent;
                throw new RetryableStreamError(
                  `Error Code ${errorEvent.code}: ${errorEvent.message}`,
                  "transient",
                );
              }
            }
          } } finally { watchdog.cleanup(); }

          if (!receivedCompleted) {
            throw new RetryableStreamError("stream closed before response.completed", "transient");
          }
        } catch (err) {
          if (watchdog.timedOut) {
            throw new RetryableStreamError("OpenAI stream idle timeout", "transient");
          }
          if (options.signal?.aborted) throw err;

          if (err instanceof OpenAI.BadRequestError) {
            const msg = err.message;
            if (
              msg.includes("maximum context length") ||
              msg.includes("context_length_exceeded")
            ) {
              throw new ContextLengthExceededError(msg);
            }
          }
          if (err instanceof OpenAI.APIConnectionError) {
            throw new RetryableStreamError(err.message, "transient");
          }
          if (err instanceof OpenAI.APIError && err.status !== undefined && err.status >= 500) {
            throw new RetryableStreamError(err.message, "overload");
          }
          if (err instanceof Error && err.cause) {
            const cause = err.cause;
            if (cause instanceof OpenAI.APIConnectionError) {
              throw new RetryableStreamError(cause.message, "transient");
            }
            if (cause instanceof OpenAI.APIError && cause.status !== undefined && cause.status >= 500) {
              throw new RetryableStreamError(cause.message, "overload");
            }
          }
          throw err;
        }
      }, "OpenAI");
    },

    async complete(messages: Message[]): Promise<string> {
      const input = toResponseInput(messages);
      const instructions = extractSystemPrompt(messages);

      if (isChatGPT) {
        // Codex endpoint requires streaming for all requests
        return withRetry(async () => {
          const stream = await client.responses.create({
            model: modelCache.getCached()?.model ?? defaultModel,
            input,
            instructions,
            stream: true,
            store: false,
          } as ResponseCreateParamsStreaming);
          const parts: string[] = [];
          for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
            if (event.type === "response.output_text.delta") parts.push(event.delta);
          }
          return parts.join("");
        }, "OpenAI");
      }

      return withRetry(async () => {
        const response = await client.responses.create({
          model: modelCache.getCached()?.model ?? defaultModel,
          input,
          instructions,
          max_output_tokens: Math.min(outputLimit(modelCache.getCached()?.info ?? null), 8_192),
        });
        const output = response.output ?? [];
        return output
          .filter((item): item is OpenAI.Responses.ResponseOutputMessage => item.type === "message")
          .flatMap((item) => item.content)
          .filter((c): c is OpenAI.Responses.ResponseOutputText => c.type === "output_text")
          .map((c) => c.text)
          .join("");
      }, "OpenAI");
    },
  };

  return adapter;
}
