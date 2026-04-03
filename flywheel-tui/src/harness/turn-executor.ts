/**
 * Single-turn execution: stream LLM response, collect events, dispatch tool calls.
 *
 * Handles streaming, intent extraction, task_complete detection, and
 * tool dispatch via the registry's concurrency-aware batch executor.
 */

import type { LLMProvider, StreamOptions, UsageInfo } from "./llm.js";
import type { ToolContext, ToolResult } from "./tools/types.js";
import type { ToolRegistry } from "./tools/registry.js";
import { extractIntent } from "./intent-trace.js";
import { limitOutput } from "./context.js";
import type { TraceCallback } from "./tracer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CollectedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  intent?: string;
}

export interface ToolCallResult {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

export interface TurnResult {
  textContent: string;
  thinkingContent: string;
  toolCalls: CollectedToolCall[];
  toolResults: ToolCallResult[];
  usage: UsageInfo | null;
  completionAttempt: unknown | null;
}

export interface TurnExecutorOptions {
  provider: LLMProvider;
  registry: ToolRegistry;
  streamOptions: StreamOptions;
  toolContext: ToolContext;
  onTextDelta?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolUse?: (call: CollectedToolCall) => void;
  onToolResult?: (result: ToolCallResult) => void;
  onTrace?: TraceCallback;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TASK_COMPLETE_TOOL = "task_complete";

// ---------------------------------------------------------------------------
// Execute a single turn
// ---------------------------------------------------------------------------

export async function executeTurn(options: TurnExecutorOptions): Promise<TurnResult> {
  const {
    provider,
    registry,
    streamOptions,
    toolContext,
    onTextDelta,
    onThinking,
    onToolUse,
    onToolResult,
    onTrace,
  } = options;

  const trace: TraceCallback = onTrace ?? (() => {});

  // Accumulators
  let textContent = "";
  let thinkingContent = "";
  const toolCalls: CollectedToolCall[] = [];
  let usage: UsageInfo | null = null;
  let completionAttempt: unknown | null = null;

  // 1. Stream LLM response and collect events
  for await (const event of provider.stream(streamOptions)) {
    switch (event.type) {
      case "text_delta": {
        textContent += event.text;
        onTextDelta?.(event.text);
        break;
      }
      case "thinking": {
        thinkingContent += event.thinking;
        onThinking?.(event.thinking);
        break;
      }
      case "tool_use": {
        const input = { ...event.input };

        // Extract intent (_i field) before execution
        const intent = extractIntent(input);

        const collected: CollectedToolCall = {
          id: event.id,
          name: event.name,
          input,
          ...(intent ? { intent } : {}),
        };

        toolCalls.push(collected);
        onToolUse?.(collected);
        break;
      }
      case "usage": {
        usage = event.usage;
        break;
      }
      case "error": {
        throw event.error;
      }
      case "message_stop":
      case "tool_result": {
        // tool_result events from stream are not expected here;
        // we produce our own after dispatching
        break;
      }
    }
  }

  // 2. Separate task_complete calls from regular tool calls
  const completionCalls: CollectedToolCall[] = [];
  const regularCalls: CollectedToolCall[] = [];

  for (const call of toolCalls) {
    if (call.name === TASK_COMPLETE_TOOL) {
      completionCalls.push(call);
    } else {
      regularCalls.push(call);
    }
  }

  // 3. Extract completion attempt from the first task_complete call
  if (completionCalls.length > 0) {
    completionAttempt = completionCalls[0]!.input;
  }

  // 4. Dispatch regular tool calls via registry
  const toolResults: ToolCallResult[] = [];

  if (regularCalls.length > 0) {
    // Emit tool_call_start for each call
    for (const call of regularCalls) {
      trace({ ts: Date.now(), type: "tool_call_start", id: call.id, name: call.name, input: call.input, intent: call.intent });
    }

    const batchStartTimes = regularCalls.map(() => Date.now());
    const batchCalls = regularCalls.map((call) => ({
      id: call.id,
      name: call.name,
      input: call.input,
    }));

    const results: ToolResult[] = await registry.executeBatch(batchCalls, toolContext);

    for (let i = 0; i < regularCalls.length; i++) {
      const call = regularCalls[i]!;
      const result = results[i]!;
      const durationMs = Date.now() - batchStartTimes[i]!;

      // Apply output truncation to large results
      const content = limitOutput(result.content);
      const isError = result.isError ?? false;

      trace({ ts: Date.now(), type: "tool_call_end", id: call.id, name: call.name, content, isError, durationMs });

      const toolCallResult: ToolCallResult = {
        toolCallId: call.id,
        name: call.name,
        content,
        isError,
      };

      toolResults.push(toolCallResult);
      onToolResult?.(toolCallResult);
    }
  }

  // 5. Add placeholder results for task_complete calls
  // (completion.ts handles the state machine; we just signal that it was called)
  for (const call of completionCalls) {
    const toolCallResult: ToolCallResult = {
      toolCallId: call.id,
      name: call.name,
      content: "Completion request received.",
      isError: false,
    };
    toolResults.push(toolCallResult);
    onToolResult?.(toolCallResult);
  }

  return {
    textContent,
    thinkingContent,
    toolCalls,
    toolResults,
    usage,
    completionAttempt,
  };
}
