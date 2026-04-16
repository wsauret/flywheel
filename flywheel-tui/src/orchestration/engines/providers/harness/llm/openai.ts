/**
 * OpenAI streaming adapter.
 *
 * Uses the Chat Completions API with streaming. Reasoning effort maps
 * directly to the OpenAI reasoning_effort parameter for o-series and
 * gpt-5 families.
 */

import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
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

const log = Log.create({ service: "llm-openai" });

const REASONING_EFFORT: Record<ReasoningEffort, "low" | "medium" | "high" | null> = {
  off: null,
  low: "low",
  medium: "medium",
  high: "high",
};

function toOpenAIMessages(m: Message): OpenAI.ChatCompletionMessageParam[] {
  if (m.role === "system") {
    const text =
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("");
    return [{ role: "system", content: text }];
  }
  if (m.role === "assistant") {
    if (typeof m.content === "string") return [{ role: "assistant", content: m.content }];
    const textParts = m.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text);
    const toolUses = m.content
      .filter((b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => b.type === "tool_use");
    const text = textParts.join("") || null;
    if (toolUses.length === 0) return [{ role: "assistant", content: text }];
    return [{
      role: "assistant",
      content: text,
      tool_calls: toolUses.map((t) => ({
        id: t.id,
        type: "function" as const,
        function: { name: t.name, arguments: JSON.stringify(t.input) },
      })),
    }];
  }
  if (typeof m.content === "string") return [{ role: "user", content: m.content }];
  const toolResults = m.content.filter(
    (b): b is { type: "tool_result"; tool_use_id: string; content: string } => b.type === "tool_result",
  );
  if (toolResults.length > 0) {
    return toolResults.map((r) => ({
      role: "tool" as const,
      tool_call_id: r.tool_use_id,
      content: r.content,
    }));
  }
  const parts: OpenAI.ChatCompletionContentPart[] = [];
  for (const block of m.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.mediaType};base64,${block.data}` },
      });
    }
  }
  return [{ role: "user", content: parts }];
}

export function createOpenAIAdapter(
  apiKey: string,
  defaultModel: string,
  modelsClient: ModelsClient,
): LLMClient {
  const client = new OpenAI({ apiKey });

  let cache: { model: string; info: ModelInfo } | null = null;

  async function resolveModelInfo(model: string): Promise<ModelInfo | null> {
    if (cache?.model === model) return cache.info;
    const info = await modelsClient.getModelInfo(model, "openai");
    if (info) cache = { model, info };
    return info;
  }

  function supportsReasoning(model: string, info: ModelInfo | null): boolean {
    return info?.reasoning ?? /^(o\d|gpt-5)/.test(model);
  }

  function contextLimit(info: ModelInfo | null): number {
    return info?.contextLimit ?? 128_000;
  }

  function outputLimit(info: ModelInfo | null): number {
    return info?.outputLimit ?? 16_384;
  }

  const adapter: LLMClient = {
    provider: "openai",
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
      const cacheReadRate = info.cost.cacheRead ?? inputRate * 0.5;
      const cacheWriteRate = info.cost.cacheWrite ?? inputRate;
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

      const chatMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: options.systemPrompt },
        ...options.messages.flatMap(toOpenAIMessages),
      ];

      const chatTools: OpenAI.ChatCompletionTool[] = options.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema as OpenAI.FunctionParameters,
        },
      }));

      const effort = REASONING_EFFORT[reasoning];
      const hasReasoning = effort !== null && supportsReasoning(model, info);
      if (reasoning !== "off" && !supportsReasoning(model, info)) {
        log.warn(`Model ${model} does not support reasoning -- proceeding without reasoning_effort`);
      }

      yield* withRetryStream(async function* () {
        try {
          const params: OpenAI.ChatCompletionCreateParamsStreaming = {
            model,
            messages: chatMessages,
            tools: chatTools,
            max_completion_tokens: outputLimit(info),
            stream: true,
            stream_options: { include_usage: true },
          };
          if (hasReasoning) params.reasoning_effort = effort;

          const stream = await client.chat.completions.create(params);

          const toolCalls = new Map<
            number,
            { id: string; name: string; args: string }
          >();
          let finishReason: string | null = null;

          for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
            const choice = chunk.choices[0];
            if (choice) {
              const delta = choice.delta;
              if (delta.content) {
                yield { kind: "text_delta", text: delta.content } as const;
              }
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const existing = toolCalls.get(tc.index);
                  if (!existing) {
                    toolCalls.set(tc.index, {
                      id: tc.id ?? "",
                      name: tc.function?.name ?? "",
                      args: tc.function?.arguments ?? "",
                    });
                  } else {
                    if (tc.function?.arguments) existing.args += tc.function.arguments;
                  }
                }
              }
              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
              }
            }

            if (chunk.usage) {
              const reasoningTokens =
                chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0;
              const cacheReadTokens =
                chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
              yield {
                kind: "usage",
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
                cacheReadTokens,
                cacheCreateTokens: 0,
                reasoningTokens,
              } as const;
            }
          }

          if (finishReason === "length") {
            throw new OutputLengthExceededError("Response truncated");
          }

          for (const [, tc] of toolCalls) {
            let input: Record<string, unknown>;
            try {
              input = JSON.parse(tc.args) as Record<string, unknown>;
            } catch {
              input = { _raw: tc.args };
            }
            yield {
              kind: "tool_use",
              toolCall: { id: tc.id, name: tc.name, input },
            } as const;
          }

          yield {
            kind: "done",
            stopReason: finishReason ?? "unknown",
          } as const;
        } catch (err) {
          if (err instanceof OpenAI.BadRequestError) {
            const msg = err.message;
            if (
              msg.includes("maximum context length") ||
              msg.includes("context_length_exceeded")
            ) {
              throw new ContextLengthExceededError(msg);
            }
          }
          throw err;
        }
      }, "OpenAI");
    },

    async complete(messages: Message[]): Promise<string> {
      const chatMessages = messages.flatMap(toOpenAIMessages);

      return withRetry(async () => {
        const response = await client.chat.completions.create({
          model: cache?.model ?? defaultModel,
          messages: chatMessages,
          max_completion_tokens: Math.min(outputLimit(cache?.info ?? null), 8_192),
        });
        return response.choices[0]?.message.content ?? "";
      }, "OpenAI");
    },
  };

  return adapter;
}

