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
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "reasoning"; id: string; encrypted_content: string };

export interface Message {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type Provider = "anthropic" | "openai";

// --- Streaming types ---

export type StreamEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "thinking_complete"; thinking: string; signature?: string }
  | { kind: "tool_use"; toolCall: ToolCall }
  | { kind: "tool_result"; toolCallId: string; content: string }
  | { kind: "reasoning"; id: string; encryptedContent: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number; reasoningTokens: number }
  | { kind: "done"; stopReason: string; responseId?: string };

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
  readonly provider: Provider;
  readonly model: string;
  readonly contextLimit: number;
  readonly outputLimit: number;
  readonly supportsReasoning: boolean;

  streamWithTools(options: StreamOptions): AsyncGenerator<StreamEvent>;
  complete(messages: Message[]): Promise<string>;

  /** Compute cost in USD from token counts using models.dev pricing.
   *  Returns 0 if pricing info is not yet available. */
  costFor(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }): number;
}

// --- Error classes ---

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
