/**
 * LLM Provider interface and stream event types.
 *
 * This is the contract that all LLM provider adapters must implement.
 */

// ---------------------------------------------------------------------------
// Thinking effort levels — provider-agnostic, mapped per adapter
// ---------------------------------------------------------------------------

export type ThinkingEffort = "low" | "medium" | "high" | "max";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolCallContent {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface UserMessage {
  role: "user";
  content: string | TextContent[];
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ToolCallContent)[];
}

export interface ToolResultMessage {
  role: "tool_result";
  content: ToolResultContent[];
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ---------------------------------------------------------------------------
// Usage info
// ---------------------------------------------------------------------------

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

// ---------------------------------------------------------------------------
// Stream events — discriminated union
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "usage"; usage: UsageInfo }
  | { type: "error"; error: Error }
  | { type: "message_stop" };

// ---------------------------------------------------------------------------
// Stream options
// ---------------------------------------------------------------------------

export interface StreamOptions {
  model: string;
  system: string;
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens: number;
  thinking?: { effort: ThinkingEffort };
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// LLM Provider interface
// ---------------------------------------------------------------------------

export interface LLMProvider {
  stream(options: StreamOptions): AsyncIterable<StreamEvent>;
}
