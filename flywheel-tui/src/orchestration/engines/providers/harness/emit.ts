/**
 * NDJSON event construction helpers for the harness engine.
 *
 * Translates harness-internal data into NDJSONEvent objects that match
 * the Claude Code wire format. All construction goes through
 * createNDJSONEvent() so the lazy-raw optimization applies.
 */

import type { NDJSONEvent, ContentBlock } from "../../../../infra/ndjson-event-types.js";
import type { ContentBlock as LLMContentBlock } from "./llm/types.js";
import { createNDJSONEvent } from "../../../../infra/ndjson-event-factory.js";

type EventEmitter = (event: NDJSONEvent) => void;

interface UsageData {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function emitUser(
  emit: EventEmitter,
  content: string | LLMContentBlock[],
): void {
  const userContent = typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;

  emit(
    createNDJSONEvent("user", {
      type: "user",
      message: { role: "user", content: userContent },
    }),
  );
}

export function emitAssistant(
  emit: EventEmitter,
  content: ContentBlock[],
  usage?: UsageData,
  parentToolUseId?: string,
): void {
  emit(
    createNDJSONEvent("assistant", {
      type: "assistant",
      message: { content, usage, ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}) },
    }),
  );
}

export function emitToolResult(
  emit: EventEmitter,
  toolUseId: string,
  content: string,
  isError: boolean,
  parentToolUseId?: string,
): void {
  emit(
    createNDJSONEvent("tool_result", {
      type: "tool_result",
      tool_use_id: toolUseId,
      content,
      is_error: isError,
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    }),
  );
}

export function emitContentBlockDelta(
  emit: EventEmitter,
  delta: { type: string; text?: string; thinking?: string },
  parentToolUseId?: string,
): void {
  emit(
    createNDJSONEvent("content_block_delta", {
      type: "content_block_delta",
      delta,
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    }),
  );
}

interface ResultOpts {
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessionId: string;
  contextWindow?: number;
}

export function emitCompaction(
  emit: EventEmitter,
  state: "start" | "done" | "error",
  durationMs?: number,
  parentToolUseId?: string,
): void {
  emit(
    createNDJSONEvent("compaction", {
      type: "compaction",
      state,
      ...(durationMs != null ? { duration_ms: durationMs } : {}),
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    }),
  );
}

export function emitResult(emit: EventEmitter, opts: ResultOpts, parentToolUseId?: string): void {
  const modelUsage: Record<string, { contextWindow?: number }> | undefined =
    opts.contextWindow
      ? { default: { contextWindow: opts.contextWindow } }
      : undefined;

  emit(
    createNDJSONEvent("result", {
      type: "result",
      subtype: "success",
      session_id: opts.sessionId,
      total_cost_usd: opts.totalCostUsd,
      usage: {
        input_tokens: opts.inputTokens,
        output_tokens: opts.outputTokens,
      },
      modelUsage,
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    }),
  );
}
