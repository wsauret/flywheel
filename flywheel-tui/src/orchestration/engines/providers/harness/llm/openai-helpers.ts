import type {
  ResponseInput,
  ResponseInputContent,
  ResponseReasoningItem,
} from "openai/resources/responses/responses.js";
import type { Message, ReasoningEffort } from "./types.js";
import { ContextLengthExceededError, RetryableStreamError } from "./types.js";

const RETRY_AFTER_RE = /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i;

export function parseRetryAfterMs(message: string): number | undefined {
  const match = RETRY_AFTER_RE.exec(message);
  if (!match) return undefined;
  const value = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  if (unit === "ms") return Math.round(value);
  return Math.round(value * 1000);
}

export function classifyResponseFailed(
  error: { code?: string | null; message?: string | null } | undefined,
  incompleteReason: string | undefined,
): Error {
  if (!error) {
    const msg = incompleteReason ? `incomplete: ${incompleteReason}` : "Unknown error";
    return new RetryableStreamError(msg, "transient");
  }

  const code = error.code ?? undefined;
  const message = error.message ?? "Unknown error";

  if (code === "context_length_exceeded") return new ContextLengthExceededError(message);
  if (code === "insufficient_quota" || code === "usage_not_included") return new Error(message);
  if (code === "invalid_prompt") return new Error(message);

  if (code === "rate_limit_exceeded") {
    return new RetryableStreamError(message, "rate_limit", parseRetryAfterMs(message));
  }
  if (code === "server_is_overloaded" || code === "slow_down") {
    return new RetryableStreamError(message, "overload");
  }

  return new RetryableStreamError(`${code ?? "unknown"}: ${message}`);
}

export const REASONING_EFFORT: Record<ReasoningEffort, string | null> = {
  off: null,
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
};

export function toResponseInput(messages: Message[]): ResponseInput {
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
            summary: block.summary ?? [],
            encrypted_content: block.encrypted_content,
          } satisfies ResponseReasoningItem);
        }
      }
    }
  }

  return input;
}

export function extractSystemPrompt(messages: Message[]): string {
  for (const m of messages) {
    if (m.role === "system") {
      return typeof m.content === "string"
        ? m.content
        : m.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("");
    }
  }
  return "";
}
