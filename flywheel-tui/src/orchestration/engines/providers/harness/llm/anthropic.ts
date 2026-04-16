/**
 * Anthropic streaming adapter.
 *
 * Reasoning: maps ReasoningEffort to extended thinking budget_tokens.
 * Caching: 3 ephemeral cache_control breakpoints on tools (last), system,
 * and the final message -- captures the stable prefix (tools + system) plus
 * a rolling anchor (last message) that grows with the conversation.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { TextBlock, ToolUseBlock, ThinkingDelta, TextDelta, InputJSONDelta } from "@anthropic-ai/sdk/resources/messages.js";
import { Log } from "../../../../../infra/log.js";
import type { ModelsClient, ModelInfo } from "./models.js";
import { withRetry, withRetryStream } from "./retry.js";
import type {
  ContentBlock,
  LLMClient,
  Message,
  ReasoningEffort,
  StreamEvent,
  StreamOptions,
  ToolCall,
} from "./types.js";
import { ContextLengthExceededError, OutputLengthExceededError } from "./types.js";

const log = Log.create({ service: "llm-anthropic" });

const THINKING_BUDGETS: Record<ReasoningEffort, number> = {
  off: 0,
  low: 2_048,
  medium: 4_096,
  high: 8_192,
};

const MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];
const MEDIA_TYPE_SET = new Set<string>(MEDIA_TYPES);

const CACHE_CONTROL: Anthropic.CacheControlEphemeral = { type: "ephemeral" };

function toAnthropicContent(
  content: string | ContentBlock[],
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
      });
    }
  }
  return result;
}

/** Mutates the last element in place -- safe because convertMessages returns a fresh array. */
function withLastMessageCached(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx]!;
  if (typeof last.content === "string") {
    const textBlock: Anthropic.TextBlockParam = {
      type: "text",
      text: last.content,
      cache_control: CACHE_CONTROL,
    };
    messages[lastIdx] = { role: last.role, content: [textBlock] };
    return messages;
  }
  const content: Anthropic.ContentBlockParam[] = last.content.map((block, i) => {
    if (i !== last.content.length - 1) return block;
    if (block.type === "text") {
      return { type: "text" as const, text: block.text, cache_control: CACHE_CONTROL };
    }
    return block;
  });
  messages[lastIdx] = { role: last.role, content };
  return messages;
}

function convertMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: toAnthropicContent(m.content),
    }));
}

export function createAnthropicAdapter(
  apiKey: string,
  defaultModel: string,
  modelsClient: ModelsClient,
): LLMClient {
  const client = new Anthropic({ apiKey });

  let cache: { model: string; info: ModelInfo } | null = null;

  async function resolveModelInfo(model: string): Promise<ModelInfo | null> {
    if (cache?.model === model) return cache.info;
    const info = await modelsClient.getModelInfo(model, "anthropic");
    if (info) cache = { model, info };
    return info;
  }

  function supportsReasoning(model: string, info: ModelInfo | null): boolean {
    return info?.reasoning ?? /^claude-(opus|sonnet|haiku)-4/.test(model);
  }

  function contextLimit(info: ModelInfo | null): number {
    return info?.contextLimit ?? 200_000;
  }

  function outputLimit(info: ModelInfo | null): number {
    return info?.outputLimit ?? 16_384;
  }

  const adapter: LLMClient = {
    provider: "anthropic",
    model: defaultModel,
    get contextLimit() {
      return contextLimit(cache?.info ?? null);
    },
    get outputLimit() {
      return outputLimit(cache?.info ?? null);
    },
    get supportsReasoning() {
      return supportsReasoning(cache?.model ?? defaultModel, cache?.info ?? null);
    },

    costFor(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }): number {
      const info = cache?.info ?? null;
      if (!info?.cost) return 0;
      const inputRate = info.cost.input;
      const outputRate = info.cost.output;
      const cacheReadRate = info.cost.cacheRead ?? inputRate * 0.1;
      const cacheWriteRate = info.cost.cacheWrite ?? inputRate * 1.25;
      return (
        (tokens.input * inputRate +
          tokens.output * outputRate +
          tokens.cacheRead * cacheReadRate +
          tokens.cacheWrite * cacheWriteRate +
          tokens.reasoning * outputRate) /
        1_000_000
      );
    },

    async *streamWithTools(options: StreamOptions): AsyncGenerator<StreamEvent> {
      const model = options.model ?? defaultModel;
      const info = await resolveModelInfo(model);
      const reasoning = options.reasoningEffort ?? "high";

      const anthropicMessages = convertMessages(options.messages);
      const anthropicTools: Anthropic.Tool[] = options.tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool["input_schema"],
        ...(i === options.tools.length - 1 ? { cache_control: CACHE_CONTROL } : {}),
      }));

      const thinkingBudget = THINKING_BUDGETS[reasoning];
      const useThinking = thinkingBudget > 0 && supportsReasoning(model, info);
      if (reasoning !== "off" && !supportsReasoning(model, info)) {
        log.warn(`Model ${model} does not support reasoning -- proceeding without extended thinking`);
      }

      const maxTokens = useThinking
        ? Math.max(outputLimit(info), thinkingBudget + 1_024)
        : outputLimit(info);

      yield* withRetryStream(async function* () {
        try {
          const params: Anthropic.MessageCreateParamsStreaming = {
            model,
            max_tokens: maxTokens,
            stream: true,
            system: [{ type: "text", text: options.systemPrompt, cache_control: CACHE_CONTROL }],
            messages: withLastMessageCached(anthropicMessages),
            tools: anthropicTools,
          };
          if (useThinking) {
            params.thinking = { type: "enabled", budget_tokens: thinkingBudget };
          }

          const stream = client.messages.stream(params, { signal: options.signal });
          const toolInputBuffers = new Map<number, { id: string; name: string; json: string }>();

          for await (const event of stream) {
            if (event.type === "content_block_start") {
              const block = event.content_block;
              if (block.type === "tool_use") {
                toolInputBuffers.set(event.index, { id: block.id, name: block.name, json: "" });
              }
            } else if (event.type === "content_block_delta") {
              const delta = event.delta;
              if (delta.type === "text_delta") {
                yield { kind: "text_delta", text: (delta as TextDelta).text } as const;
              } else if (delta.type === "thinking_delta") {
                yield { kind: "thinking_delta", text: (delta as ThinkingDelta).thinking } as const;
              } else if (delta.type === "input_json_delta") {
                const buf = toolInputBuffers.get(event.index);
                if (buf) buf.json += (delta as InputJSONDelta).partial_json;
              }
            } else if (event.type === "content_block_stop") {
              const buf = toolInputBuffers.get(event.index);
              if (buf) {
                let input: Record<string, unknown>;
                try {
                  input = JSON.parse(buf.json) as Record<string, unknown>;
                } catch {
                  input = { _raw: buf.json };
                }
                yield {
                  kind: "tool_use",
                  toolCall: { id: buf.id, name: buf.name, input },
                } as const;
                toolInputBuffers.delete(event.index);
              }
            } else if (event.type === "message_delta") {
              const stopReason = event.delta.stop_reason;
              if (stopReason === "max_tokens") {
                throw new OutputLengthExceededError("Response truncated");
              }
            } else if (event.type === "message_start") {
              const usage = event.message.usage;
              yield {
                kind: "usage",
                inputTokens: usage.input_tokens,
                outputTokens: 0,
                cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                cacheCreateTokens: usage.cache_creation_input_tokens ?? 0,
                reasoningTokens: 0,
              } as const;
            }
          }

          const finalMessage = await stream.finalMessage();
          const outputTokens = finalMessage.usage.output_tokens;
          yield {
            kind: "usage",
            inputTokens: finalMessage.usage.input_tokens,
            outputTokens,
            cacheReadTokens: finalMessage.usage.cache_read_input_tokens ?? 0,
            cacheCreateTokens: finalMessage.usage.cache_creation_input_tokens ?? 0,
            reasoningTokens: 0,
          } as const;

          yield { kind: "done", stopReason: finalMessage.stop_reason ?? "unknown" } as const;
        } catch (err) {
          if (err instanceof Anthropic.BadRequestError) {
            const msg = err.message;
            if (msg.includes("prompt is too long") || msg.includes("context")) {
              throw new ContextLengthExceededError(msg);
            }
          }
          throw err;
        }
      }, "Anthropic");
    },

    async complete(messages: Message[]): Promise<string> {
      const anthropicMessages = convertMessages(messages);

      return withRetry(async () => {
        const response = await client.messages.create({
          model: cache?.model ?? defaultModel,
          max_tokens: Math.min(outputLimit(cache?.info ?? null), 16_384),
          messages: withLastMessageCached(anthropicMessages),
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

