import type { AccessProviderId } from "./access-provider.js";
import type { ModelFamily } from "./model-family.js";

/**
 * Provider-agnostic LLM types.
 *
 * Single internal message shape flows through the harness engine.
 * Provider adapters convert to/from wire formats.
 */

export type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "reasoning"; id: string; encrypted_content: string; summary?: Array<{ type: "summary_text"; text: string }> };

export interface Message {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}


export type StreamEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "thinking_complete"; thinking: string; signature?: string }
  | { kind: "tool_use"; toolCall: ToolCall }
  | { kind: "tool_result"; toolCallId: string; content: string }
  | { kind: "reasoning"; id: string; encryptedContent: string; summary?: Array<{ type: "summary_text"; text: string }> }
  | { kind: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; reasoningTokens: number }
  | { kind: "done"; stopReason: string; responseId?: string }
  | { kind: "todo_state"; todos: ReadonlyArray<{ id: string; content: string; status: string; notes?: string }> }
  | { kind: "compaction_start" }
  | { kind: "compaction_done"; success: boolean; durationMs: number };

export interface StreamOptions {
  messages: Message[];
  tools: ReadonlyArray<ToolDef>;
  systemPrompt: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  previousResponseId?: string;
}

export interface LLMClient {
  readonly accessProvider: AccessProviderId;
  readonly modelFamily: ModelFamily;
  readonly model: string;
  readonly contextLimit: number;
  readonly outputLimit: number;
  readonly supportsReasoning: boolean;

  streamWithTools(options: StreamOptions): AsyncGenerator<StreamEvent>;
  complete(messages: Message[]): Promise<string>;

  /** Compute cost in USD from token counts using models.dev pricing.
   *  `promptTokens` is the total prompt size for the API call (for tier determination).
   *  Returns 0 if pricing info is not yet available. */
  costFor(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; promptTokens?: number }): number;
}


export class ContextLengthExceededError extends Error {
  constructor(msg = "Context length exceeded") {
    super(msg);
    this.name = "ContextLengthExceededError";
  }
}

export class OutputLengthExceededError extends Error {
  truncatedContent: string;
  constructor(msg = "Output length exceeded", truncated = "") {
    super(msg);
    this.name = "OutputLengthExceededError";
    this.truncatedContent = truncated;
  }
}

type RetryableErrorKind = "rate_limit" | "overload" | "transient" | "unknown";

export class RetryableStreamError extends Error {
  readonly retryDelayMs: number | undefined;
  readonly kind: RetryableErrorKind;
  constructor(message: string, kind: RetryableErrorKind = "unknown", retryDelayMs?: number) {
    super(message);
    this.name = "RetryableStreamError";
    this.kind = kind;
    this.retryDelayMs = retryDelayMs;
  }
}
