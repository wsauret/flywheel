import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseInputContent,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import type { ReasoningEffort as OpenAIReasoningEffort } from "openai/resources/shared.js";
import { Log } from "../../../../../infra/log.js";
import { contextWindowForModel } from "../../../engine-context.js";
import type { OpenAIAuth } from "../../../../../infra/auth/openai-auth-types.js";
import { createChatGPTClient } from "./openai-chatgpt.js";
import type { ModelsClient, ModelInfo } from "./models.js";
import { withRetry, withRetryStream } from "./retry.js";
import type { ContentBlock, LLMClient, Message, ReasoningEffort, StreamEvent, StreamOptions } from "./types.js";
import { ContextLengthExceededError, OutputLengthExceededError } from "./types.js";

const log = Log.create({ service: "llm-openai" });
const REASONING_EFFORT: Record<ReasoningEffort, string | null> = {
  off: null,
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
};

function toResponseInput(messages: Message[]): ResponseInput {
  const input: ResponseInput = [];
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  // First pass: collect all tool_use and tool_result IDs for orphan detection.
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_use") toolUseIds.add(block.id);
      else if (block.type === "tool_result") toolResultIds.add(block.tool_use_id);
    }
  }

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      if (typeof m.content === "string") {
        input.push({ role: "user", content: [{ type: "input_text", text: m.content }] });
        continue;
      }
      const parts: ResponseInputContent[] = [];
      for (const block of m.content) {
        if (block.type === "text") {
          parts.push({ type: "input_text", text: block.text });
        } else if (block.type === "image") {
          parts.push({
            type: "input_image",
            image_url: `data:${block.mediaType};base64,${block.data}`,
            detail: "auto",
          });
        } else if (block.type === "tool_result") {
          input.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: block.content,
          });
        }
      }
      if (parts.length > 0) {
        input.push({ role: "user", content: parts });
      }
      continue;
    }

    if (m.role === "assistant") {
      if (typeof m.content === "string") {
        input.push({
          type: "message",
          role: "assistant",
          id: `msg_${input.length}`,
          content: [{ type: "output_text", text: m.content, annotations: [] }],
          status: "completed",
        });
        continue;
      }
      for (const block of m.content) {
        if (block.type === "text") {
          input.push({
            type: "message",
            role: "assistant",
            id: `msg_${input.length}`,
            content: [{ type: "output_text", text: block.text, annotations: [] }],
            status: "completed",
          });
        } else if (block.type === "tool_use") {
          if (!toolResultIds.has(block.id)) continue;
          input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        } else if (block.type === "reasoning") {
          input.push({
            type: "reasoning",
            id: block.id,
            encrypted_content: block.encrypted_content,
          } as ResponseInput[number]);
        }
      }
    }
  }

  return input;
}

function extractSystemPrompt(messages: Message[]): string {
  for (const m of messages) {
    if (m.role === "system") {
      return typeof m.content === "string"
        ? m.content
        : m.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("");
    }
  }
  return "";
}

export function createOpenAIAdapter(
  auth: OpenAIAuth,
  defaultModel: string,
  modelsClient: ModelsClient,
): LLMClient {
  const isChatGPT = auth.kind === "chatgpt";
  const client = isChatGPT
    ? createChatGPTClient(auth)
    : new OpenAI({ apiKey: auth.apiKey });

  let cache: { model: string; info: ModelInfo } | null = null;
  async function resolveModelInfo(model: string): Promise<ModelInfo | null> {
    if (cache?.model === model) return cache.info;
    const info = await modelsClient.getModelInfo(model, "openai");
    if (info) cache = { model, info };
    return info;
  }

  function supportsReasoning(model: string, info: ModelInfo | null): boolean { return info?.reasoning ?? /^(o\d|gpt-5)/.test(model); }
  function contextLimit(model: string, info: ModelInfo | null): number { return info?.contextLimit ?? contextWindowForModel(model); }
  function outputLimit(info: ModelInfo | null): number { return info?.outputLimit ?? 16_384; }

  const adapter: LLMClient = {
    provider: "openai",
    model: defaultModel,
    get contextLimit() {
      return contextLimit(cache?.model ?? defaultModel, cache?.info ?? null);
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
          tokens.cacheWrite * cacheWriteRate) /
        1_000_000
      );
    },

    async *streamWithTools(options: StreamOptions): AsyncGenerator<StreamEvent> {
      const model = options.model ?? defaultModel;
      const info = await resolveModelInfo(model);
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

          const stream = await client.responses.create(params, { signal: options.signal });

          let responseId: string | undefined;
          let toolArgsBuf = "";
          let reasoningBuf = "";

          function* flushReasoning(): Generator<StreamEvent> {
            if (reasoningBuf) {
              yield { kind: "thinking_complete", thinking: reasoningBuf } as StreamEvent;
              reasoningBuf = "";
            }
          }

          for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
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

                // Capture encrypted reasoning items for round-tripping.
                for (const item of response?.output ?? []) {
                  if (item.type === "reasoning") {
                    const r = item as { id?: string; encrypted_content?: string };
                    if (r.id && r.encrypted_content) {
                      yield {
                        kind: "reasoning",
                        id: r.id,
                        encryptedContent: r.encrypted_content,
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
                const details = event.response?.incomplete_details;
                const msg = error
                  ? `${error.code ?? "unknown"}: ${error.message ?? "no message"}`
                  : details?.reason
                    ? `incomplete: ${details.reason}`
                    : "Unknown error";
                throw new Error(msg);
              }

              case "error":
                throw new Error(`Error Code ${(event as { code?: string }).code}: ${(event as { message?: string }).message}` || "Unknown error");
            }
          }
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
      const input = toResponseInput(messages);
      const instructions = extractSystemPrompt(messages);

      if (isChatGPT) {
        // Codex endpoint requires streaming for all requests
        return withRetry(async () => {
          const stream = await client.responses.create({
            model: cache?.model ?? defaultModel,
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
          model: cache?.model ?? defaultModel,
          input,
          instructions,
          max_output_tokens: Math.min(outputLimit(cache?.info ?? null), 8_192),
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
