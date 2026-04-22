/**
 * Anthropic streaming adapter.
 *
 * Reasoning: maps ReasoningEffort to extended thinking budget_tokens.
 * Caching: 3 ephemeral cache_control breakpoints on tools (last), system,
 * and the final message -- captures the stable prefix (tools + system) plus
 * a rolling anchor (last message) that grows with the conversation.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { TextBlock, ToolUseBlock, ThinkingDelta, TextDelta, InputJSONDelta, SignatureDelta } from "@anthropic-ai/sdk/resources/messages.js";
import { Log } from "../../../../../infra/log.js";
import type { ModelsClient, ModelInfo } from "./models.js";
import { createModelInfoCache, computeCost } from "./llm-helpers.js";
import { CLIENT_TIMEOUT_MS, createIdleWatchdog, withRetry, withRetryStream } from "./retry.js";
import type {
  ContentBlock,
  LLMClient,
  Message,
  ReasoningEffort,
  StreamEvent,
  StreamOptions,
  ToolCall,
} from "./types.js";
import { ContextLengthExceededError, OutputLengthExceededError, RetryableStreamError } from "./types.js";

const log = Log.create({ service: "llm-anthropic" });

const EFFORT_TO_ANTHROPIC: Record<ReasoningEffort, string | null> = {
  off: null,
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
};

const MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];
const MEDIA_TYPE_SET = new Set<string>(MEDIA_TYPES);

const CACHE_CONTROL: Anthropic.CacheControlEphemeral = { type: "ephemeral" };
const STREAM_IDLE_TIMEOUT_MS = 90_000;

function classifyAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.APIConnectionError) {
    return new RetryableStreamError(err.message, "transient");
  }

  if (err instanceof Anthropic.APIError) {
    if (err.status === 529 || err.message?.includes('"type":"overloaded_error"')) {
      return new RetryableStreamError(err.message, "overload");
    }
    if (err.status === 429) {
      const retryAfter = err.headers?.get?.("retry-after");
      const delayMs = retryAfter ? parseFloat(retryAfter) * 1000 : undefined;
      return new RetryableStreamError(err.message, "rate_limit", Number.isFinite(delayMs) ? delayMs : undefined);
    }
    if (err.status === 408 || err.status === 409) {
      return new RetryableStreamError(err.message, "transient");
    }
    if (err.status !== undefined && err.status >= 500) {
      return new RetryableStreamError(err.message, "overload");
    }
  }

  if (err instanceof Error && err.cause) {
    const classified = classifyAnthropicError(err.cause);
    if (classified instanceof RetryableStreamError) return classified;
  }

  return err instanceof Error ? err : new Error(String(err));
}

const BETA_HEADERS = [
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
].join(",");

function toAnthropicContent(
  content: string | ContentBlock[],
  toolResultIds?: Set<string>,
): string | Anthropic.ContentBlockParam[] {
  if (typeof content === "string") return content;
  const result: Anthropic.ContentBlockParam[] = [];
  for (const block of content) {
    if (block.type === "text") {
      result.push({ type: "text" as const, text: block.text });
    } else if (block.type === "image") {
      if (!MEDIA_TYPE_SET.has(block.mediaType)) {
        throw new Error(`Unsupported image media type: ${block.mediaType}`);
      }
      result.push({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: block.mediaType as MediaType,
          data: block.data,
        },
      });
    } else if (block.type === "tool_use") {
      if (toolResultIds && !toolResultIds.has(block.id)) continue;
      result.push({
        type: "tool_use" as const,
        id: block.id,
        name: block.name,
        input: block.input,
      });
    } else if (block.type === "tool_result") {
      result.push({
        type: "tool_result" as const,
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      });
    } else if (block.type === "thinking") {
      if (block.signature && block.thinking) {
        result.push({
          type: "thinking" as const,
          thinking: block.thinking,
          signature: block.signature,
        });
      } else if (block.thinking) {
        result.push({ type: "text" as const, text: `<thinking>\n${block.thinking}\n</thinking>` });
      }
    }
  }
  return result;
}

/** Tag the last content block in a message with cache_control. Mutates in place. */
function tagLastBlock(messages: Anthropic.MessageParam[], idx: number): void {
  const msg = messages[idx]!;
  if (typeof msg.content === "string") {
    messages[idx] = {
      role: msg.role,
      content: [{ type: "text", text: msg.content, cache_control: CACHE_CONTROL }],
    };
    return;
  }
  const blocks = msg.content;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (block.type === "text") {
      blocks[i] = { ...block, cache_control: CACHE_CONTROL };
      return;
    }
    if (block.type === "tool_result") {
      blocks[i] = { ...block, cache_control: CACHE_CONTROL };
      return;
    }
  }
}

/** Place cache breakpoints on the penultimate and last user messages. Mutates in place. */
function addCacheBreakpoints(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;

  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user") userIndices.push(i);
  }

  if (userIndices.length >= 2) {
    tagLastBlock(messages, userIndices[userIndices.length - 2]!);
  }
  if (userIndices.length >= 1) {
    tagLastBlock(messages, userIndices[userIndices.length - 1]!);
  }

  return messages;
}

function convertMessages(messages: Message[]): Anthropic.MessageParam[] {
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_result") toolResultIds.add(b.tool_use_id);
    }
  }

  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: toAnthropicContent(m.content, toolResultIds),
    }));
}

export function createAnthropicAdapter(
  apiKey: string,
  defaultModel: string,
  modelsClient: ModelsClient,
): LLMClient {
  const client = new Anthropic({ apiKey, timeout: CLIENT_TIMEOUT_MS });

  const modelCache = createModelInfoCache(modelsClient, "anthropic");
  const ANTHROPIC_CACHE_RATES = { cacheReadRatio: 0.1, cacheWriteRatio: 1.25 } as const;

  function supportsReasoning(model: string, info: ModelInfo | null): boolean {
    return info?.reasoning ?? /^claude-(opus|sonnet|haiku)-4/.test(model);
  }

  function supportsAdaptiveThinking(model: string): boolean {
    return /claude-(opus|sonnet)-4[.-]([6-9]|\d{2,})/.test(model);
  }

  function contextLimit(info: ModelInfo | null): number {
    return info?.contextLimit ?? 200_000;
  }

  function outputLimit(info: ModelInfo | null): number {
    return info?.outputLimit ?? 16_384;
  }

  const adapter: LLMClient = {
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: defaultModel,
    get contextLimit() {
      return contextLimit(modelCache.getCached()?.info ?? null);
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
      return computeCost(tokens, info.cost, ANTHROPIC_CACHE_RATES);
    },

    async *streamWithTools(options: StreamOptions): AsyncGenerator<StreamEvent> {
      const model = options.model ?? defaultModel;
      const info = await modelCache.resolveModelInfo(model);
      const reasoning = options.reasoningEffort ?? "max";

      const anthropicMessages = convertMessages(options.messages);
      const anthropicTools: Anthropic.Tool[] = options.tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool["input_schema"],
        ...(i === options.tools.length - 1 ? { cache_control: CACHE_CONTROL } : {}),
      }));

      const useThinking = reasoning !== "off" && supportsReasoning(model, info);
      if (reasoning !== "off" && !supportsReasoning(model, info)) {
        log.warn(`Model ${model} does not support reasoning -- proceeding without extended thinking`);
      }

      const maxOutput = outputLimit(info);
      const maxTokens = maxOutput;

      yield* withRetryStream(async function* () {
        let stream: ReturnType<typeof client.messages.stream> | undefined;
        const watchdog = createIdleWatchdog(STREAM_IDLE_TIMEOUT_MS, () => {
          log.warn(`Anthropic stream idle for ${STREAM_IDLE_TIMEOUT_MS}ms, aborting`);
          stream?.abort();
        });

        try {
          const params: Anthropic.MessageCreateParamsStreaming = {
            model,
            max_tokens: maxTokens,
            stream: true,
            system: [{ type: "text", text: options.systemPrompt, cache_control: CACHE_CONTROL }],
            messages: addCacheBreakpoints(anthropicMessages),
            tools: anthropicTools,
          };
          if (useThinking) {
            if (supportsAdaptiveThinking(model)) {
              (params as unknown as Record<string, unknown>).thinking = { type: "adaptive" };
              const effort = EFFORT_TO_ANTHROPIC[reasoning];
              if (effort) {
                (params as unknown as Record<string, unknown>).output_config = { effort };
              }
            } else {
              params.thinking = { type: "enabled", budget_tokens: maxTokens - 1 };
            }
          }

          if (!useThinking) {
            params.temperature = 1;
          }

          stream = client.messages.stream(params, {
            signal: options.signal,
            headers: { "anthropic-beta": BETA_HEADERS },
          });
          const toolInputBuffers = new Map<number, { id: string; name: string; json: string }>();
          const thinkingBuffers = new Map<number, { thinking: string; signature: string }>();
          let receivedMessageStop = false;

          watchdog.reset();

          try { for await (const event of stream) {
            watchdog.reset();
            if (event.type === "content_block_start") {
              const block = event.content_block;
              if (block.type === "tool_use") {
                toolInputBuffers.set(event.index, { id: block.id, name: block.name, json: "" });
              } else if (block.type === "thinking") {
                thinkingBuffers.set(event.index, { thinking: "", signature: "" });
              }
            } else if (event.type === "content_block_delta") {
              const delta = event.delta;
              if (delta.type === "text_delta") {
                yield { kind: "text_delta", text: (delta as TextDelta).text } as const;
              } else if (delta.type === "thinking_delta") {
                const buf = thinkingBuffers.get(event.index);
                if (buf) buf.thinking += (delta as ThinkingDelta).thinking;
                yield { kind: "thinking_delta", text: (delta as ThinkingDelta).thinking } as const;
              } else if (delta.type === "signature_delta") {
                const buf = thinkingBuffers.get(event.index);
                if (buf) buf.signature += (delta as SignatureDelta).signature;
              } else if (delta.type === "input_json_delta") {
                const buf = toolInputBuffers.get(event.index);
                if (buf) buf.json += (delta as InputJSONDelta).partial_json;
              }
            } else if (event.type === "content_block_stop") {
              const toolBuf = toolInputBuffers.get(event.index);
              if (toolBuf) {
                let input: Record<string, unknown>;
                try {
                  input = JSON.parse(toolBuf.json) as Record<string, unknown>;
                } catch {
                  input = { _raw: toolBuf.json };
                }
                yield {
                  kind: "tool_use",
                  toolCall: { id: toolBuf.id, name: toolBuf.name, input },
                } as const;
                toolInputBuffers.delete(event.index);
              }
              const thinkBuf = thinkingBuffers.get(event.index);
              if (thinkBuf) {
                yield {
                  kind: "thinking_complete",
                  thinking: thinkBuf.thinking,
                  signature: thinkBuf.signature || undefined,
                } as StreamEvent;
                thinkingBuffers.delete(event.index);
              }
            } else if (event.type === "message_delta") {
              const stopReason = event.delta.stop_reason;
              if (stopReason === "max_tokens") {
                throw new OutputLengthExceededError("Response truncated");
              }
            } else if (event.type === "message_stop") {
              receivedMessageStop = true;
            }
          } } finally { watchdog.cleanup(); }

          if (!receivedMessageStop) {
            throw new RetryableStreamError("Anthropic stream closed before message_stop", "transient");
          }

          const finalMessage = await stream.finalMessage();
          yield {
            kind: "usage",
            inputTokens: finalMessage.usage.input_tokens,
            outputTokens: finalMessage.usage.output_tokens,
            cacheReadTokens: finalMessage.usage.cache_read_input_tokens ?? 0,
            cacheCreateTokens: finalMessage.usage.cache_creation_input_tokens ?? 0,
            reasoningTokens: 0,
          } as const;

          yield { kind: "done", stopReason: finalMessage.stop_reason ?? "unknown" } as const;
        } catch (err) {
          if (watchdog.timedOut) {
            throw new RetryableStreamError("Anthropic stream idle timeout", "transient");
          }
          if (options.signal?.aborted) throw err;

          if (err instanceof Anthropic.BadRequestError) {
            const msg = err.message;
            if (msg.includes("prompt is too long") || msg.includes("context")) {
              throw new ContextLengthExceededError(msg);
            }
          }
          if (err instanceof RetryableStreamError || err instanceof ContextLengthExceededError || err instanceof OutputLengthExceededError) {
            throw err;
          }
          throw classifyAnthropicError(err);
        }
      }, "Anthropic");
    },

    async complete(messages: Message[]): Promise<string> {
      const anthropicMessages = convertMessages(messages);

      return withRetry(async () => {
        const response = await client.messages.create({
          model: modelCache.getCached()?.model ?? defaultModel,
          max_tokens: Math.min(outputLimit(modelCache.getCached()?.info ?? null), 16_384),
          messages: addCacheBreakpoints(anthropicMessages),
        });
        return response.content
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
      }, "Anthropic");
    },
  };

  return adapter;
}

