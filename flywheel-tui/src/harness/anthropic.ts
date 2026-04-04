/**
 * Anthropic LLM provider adapter.
 *
 * Streams the Anthropic Messages API, parses SSE events into StreamEvent union,
 * injects cache_control breakpoints, supports extended thinking, and retries
 * transient errors with exponential backoff.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  TextBlockParam,
  CacheControlEphemeral,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { isTransientError } from "../worker/errors.js";
import type {
  LLMProvider,
  StreamEvent,
  StreamOptions,
  Message,
  ToolDefinition,
  UsageInfo,
} from "./llm.js";

// ---------------------------------------------------------------------------
// API key sanitizer
// ---------------------------------------------------------------------------

const API_KEY_PATTERN = /sk-ant-[a-zA-Z0-9_-]{20,}/g;

export function sanitizeApiKey(text: string): string {
  return text.replace(API_KEY_PATTERN, "[REDACTED]");
}

function sanitizeError(error: unknown): Error {
  if (error instanceof Error) {
    const sanitized = new Error(sanitizeApiKey(error.message));
    sanitized.stack = error.stack ? sanitizeApiKey(error.stack) : undefined;
    sanitized.name = error.name;
    return sanitized;
  }
  return new Error(sanitizeApiKey(String(error)));
}

// ---------------------------------------------------------------------------
// Retry utility
// ---------------------------------------------------------------------------

const MAX_RETRY_ATTEMPTS = 5;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4000;

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  signal?: AbortSignal;
}

/**
 * Retry an async function with exponential backoff.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? MAX_RETRY_ATTEMPTS;
  const baseDelay = options.baseDelayMs ?? BASE_DELAY_MS;
  const maxDelay = options.maxDelayMs ?? MAX_DELAY_MS;
  const isRetryable = options.isRetryable ?? isAnthropicRetryable;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (options.signal?.aborted) {
        throw sanitizeError(error);
      }

      const isLast = attempt === maxAttempts - 1;
      if (isLast || !isRetryable(error)) {
        throw sanitizeError(error);
      }

      const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
      await sleep(delay, options.signal);
    }
  }

  throw sanitizeError(lastError);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const timer = setTimeout(resolve, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Retryable error classification
// ---------------------------------------------------------------------------

/**
 * Classify whether an Anthropic API error is retryable.
 * Combines Anthropic SDK error codes with isTransientError() from worker/errors.
 */
export function isAnthropicRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message;

  // Use the existing transient error detector from worker/errors.ts
  if (isTransientError(message)) return true;

  // Anthropic-specific retryable patterns
  if (/rate.?limit|too many requests|overloaded|529/i.test(message)) return true;
  if (/internal.?error|internal_error/i.test(message)) return true;

  // Anthropic SDK error status codes
  if ("status" in error) {
    const status = (error as { status: number }).status;
    if (status === 429 || status === 529 || status === 503 || status === 502) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Cache control injection — 2-breakpoint strategy
// ---------------------------------------------------------------------------

type CacheControlBlock = {
  cache_control?: CacheControlEphemeral | null;
};

/**
 * Apply 2-breakpoint caching strategy:
 * 1. Cache the system prompt (first breakpoint)
 * 2. Cache the last conversation message (second breakpoint)
 */
export function applyCacheBreakpoints(params: MessageCreateParamsStreaming): void {
  const cacheControl: CacheControlEphemeral = { type: "ephemeral" };
  const longTtlCacheControl: CacheControlEphemeral = { type: "ephemeral", ttl: "1h" };

  // Breakpoint 1: Cache system prompt (1h TTL — prompt never changes within a session)
  if (params.system && Array.isArray(params.system) && params.system.length > 0) {
    const firstBlock = params.system[0] as TextBlockParam & CacheControlBlock;
    if (firstBlock) {
      firstBlock.cache_control = longTtlCacheControl;
    }
  }

  // Breakpoint 2: Cache last message in conversation
  if (params.messages.length > 0) {
    const lastMessage = params.messages[params.messages.length - 1];
    if (lastMessage) {
      if (typeof lastMessage.content === "string") {
        (lastMessage as MessageParam).content = [
          {
            type: "text" as const,
            text: lastMessage.content,
            cache_control: cacheControl,
          },
        ];
      } else if (Array.isArray(lastMessage.content) && lastMessage.content.length > 0) {
        const lastBlock = lastMessage.content[lastMessage.content.length - 1] as CacheControlBlock;
        if (lastBlock) {
          lastBlock.cache_control = cacheControl;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Message conversion
// ---------------------------------------------------------------------------

function convertMessages(messages: Message[]): MessageParam[] {
  const params: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        params.push({ role: "user", content: msg.content });
      } else {
        const blocks = msg.content.map((c) => ({
          type: "text" as const,
          text: c.text,
        }));
        params.push({ role: "user", content: blocks });
      }
    } else if (msg.role === "assistant") {
      const blocks = msg.content.map((c) => {
        if (c.type === "text") {
          return { type: "text" as const, text: c.text };
        }
        return {
          type: "tool_use" as const,
          id: c.id,
          name: c.name,
          input: c.arguments,
        };
      });
      params.push({ role: "assistant", content: blocks });
    } else if (msg.role === "tool_result") {
      const blocks = msg.content.map((c) => ({
        type: "tool_result" as const,
        tool_use_id: c.tool_use_id,
        content: c.content,
        is_error: c.is_error ?? false,
      }));
      params.push({ role: "user", content: blocks });
    }
  }

  return params;
}

function convertTools(tools: ToolDefinition[]): Anthropic.Messages.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object" as const,
      properties: tool.input_schema.properties,
      required: tool.input_schema.required ?? [],
    },
  }));
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseUrl?: string;
}

export class AnthropicProvider implements LLMProvider {
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions = {}) {
    this.client = new Anthropic({
      apiKey: options.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? "",
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      dangerouslyAllowBrowser: true,
    });
  }

  async *stream(options: StreamOptions): AsyncIterable<StreamEvent> {
    const params = this.buildParams(options);
    applyCacheBreakpoints(params);

    const events = await retry(
      () => this.createStream(params, options.abortSignal),
      {
        isRetryable: isAnthropicRetryable,
        signal: options.abortSignal,
      },
    );

    yield* this.parseEvents(events);
  }

  private async createStream(
    params: MessageCreateParamsStreaming,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<RawMessageStreamEvent>> {
    const stream = this.client.messages.stream(
      { ...params, stream: true },
      { signal },
    );

    // Force the connection to open (throws on auth/network errors immediately)
    await stream.withResponse();

    return stream;
  }

  private buildParams(options: StreamOptions): MessageCreateParamsStreaming {
    const params: MessageCreateParamsStreaming = {
      model: options.model,
      max_tokens: options.maxTokens,
      stream: true,
      messages: convertMessages(options.messages),
    };

    // System prompt
    if (options.system) {
      params.system = [
        { type: "text", text: options.system },
      ];
    }

    // Tools
    if (options.tools && options.tools.length > 0) {
      params.tools = convertTools(options.tools);
    }

    // Adaptive thinking with effort level
    if (options.thinking) {
      params.thinking = { type: "adaptive" };
      params.output_config = { effort: options.thinking.effort };
      // API requirement: temperature must be 1 when thinking is enabled
      params.temperature = 1;
    }

    return params;
  }

  private async *parseEvents(
    events: AsyncIterable<RawMessageStreamEvent>,
  ): AsyncIterable<StreamEvent> {
    const usage: UsageInfo = {
      inputTokens: 0,
      outputTokens: 0,
    };

    let currentToolId = "";
    let currentToolName = "";
    let toolJsonBuffer = "";

    try {
      for await (const event of events) {
        if (event.type === "message_start") {
          usage.inputTokens = event.message.usage.input_tokens;
          usage.outputTokens = event.message.usage.output_tokens;
          if (event.message.usage.cache_read_input_tokens) {
            usage.cacheReadInputTokens = event.message.usage.cache_read_input_tokens;
          }
          if (event.message.usage.cache_creation_input_tokens) {
            usage.cacheCreationInputTokens = event.message.usage.cache_creation_input_tokens;
          }
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            currentToolId = event.content_block.id;
            currentToolName = event.content_block.name;
            toolJsonBuffer = "";
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          } else if (event.delta.type === "thinking_delta") {
            yield { type: "thinking", thinking: event.delta.thinking };
          } else if (event.delta.type === "input_json_delta") {
            toolJsonBuffer += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          if (currentToolId) {
            let input: Record<string, unknown> = {};
            try {
              if (toolJsonBuffer) {
                input = JSON.parse(toolJsonBuffer) as Record<string, unknown>;
              }
            } catch {
              input = {};
            }
            yield {
              type: "tool_use",
              id: currentToolId,
              name: currentToolName,
              input,
            };
            currentToolId = "";
            currentToolName = "";
            toolJsonBuffer = "";
          }
        } else if (event.type === "message_delta") {
          if (event.usage.output_tokens != null) {
            usage.outputTokens = event.usage.output_tokens;
          }
        }
      }

      yield { type: "usage", usage };
      yield { type: "message_stop" };
    } catch (error) {
      yield { type: "error", error: sanitizeError(error) };
    }
  }
}
