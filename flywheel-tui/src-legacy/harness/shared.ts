/**
 * Shared harness infrastructure for HarnessSpawner and InteractiveWorker.
 *
 * Extracts common tool setup, NDJSON emission helpers, and provider creation
 * to eliminate duplication between spawner and interactive chat modules.
 */

import type { HarnessTool } from "./tools/types.js";
import type { CollectedToolCall, ToolCallResult } from "./turn-executor.js";
import { AnthropicProvider, sanitizeApiKey } from "./anthropic.js";
import { gatherWorkspaceContext, buildSystemPrompt, type WorkspaceContext } from "./prompts.js";
import { createBashTool } from "./tools/bash.js";
import { createReadTool } from "./tools/read.js";
import { editTool } from "./tools/edit.js";
import { textSearchTool } from "./tools/text-search.js";
import { astSearchTool } from "./tools/ast-search.js";
import { taskCompleteTool } from "./tools/task-complete.js";
import { writeTool } from "./tools/write.js";

// ---------------------------------------------------------------------------
// Tool set builders
// ---------------------------------------------------------------------------

/** Standard tool set including task_complete (for workflow/spawner use). */
export function createStandardTools(): HarnessTool[] {
  return [
    createBashTool(),
    createReadTool(),
    writeTool,
    editTool,
    textSearchTool,
    astSearchTool,
    taskCompleteTool,
  ];
}

/** Chat tool set without task_complete (for interactive conversation). */
export function createChatTools(): HarnessTool[] {
  return [
    createBashTool(),
    createReadTool(),
    writeTool,
    editTool,
    textSearchTool,
    astSearchTool,
  ];
}

// ---------------------------------------------------------------------------
// Provider creation
// ---------------------------------------------------------------------------

/** Create an AnthropicProvider with the given API key. */
export function createProvider(apiKey: string): AnthropicProvider {
  return new AnthropicProvider({ apiKey });
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/** Build the system prompt from the current workspace. */
export async function buildWorkspaceSystemPrompt(customInstructions?: string): Promise<string> {
  const context = await gatherWorkspaceContext();
  if (customInstructions) {
    context.customInstructions = customInstructions;
  }
  return buildSystemPrompt(context);
}

// ---------------------------------------------------------------------------
// NDJSON emission helpers
// ---------------------------------------------------------------------------

type StdoutCallback = (chunk: string) => void;

/** Sanitize text to prevent API key leakage. */
export function sanitize(text: string): string {
  return sanitizeApiKey(text);
}

/** Emit a single NDJSON line via an onStdout callback. */
export function emitNdjson(onStdout: StdoutCallback | undefined, event: Record<string, unknown>): void {
  if (!onStdout) return;
  const line = sanitize(JSON.stringify(event));
  onStdout(line + "\n");
}

/** Emit an assistant text event. */
export function emitText(onStdout: StdoutCallback | undefined, text: string): void {
  emitNdjson(onStdout, {
    type: "assistant",
    message: {
      content: [{ type: "text", text: sanitize(text) }],
    },
  });
}

/** Emit an assistant tool use event. */
export function emitToolUse(onStdout: StdoutCallback | undefined, call: CollectedToolCall): void {
  emitNdjson(onStdout, {
    type: "assistant",
    message: {
      content: [{
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      }],
    },
  });
}

/** Emit an assistant thinking event. */
export function emitThinking(onStdout: StdoutCallback | undefined, thinking: string): void {
  emitNdjson(onStdout, {
    type: "assistant",
    message: {
      content: [{ type: "thinking", thinking: sanitize(thinking) }],
    },
  });
}

/** Emit a tool result event. */
export function emitToolResult(onStdout: StdoutCallback | undefined, result: ToolCallResult): void {
  emitNdjson(onStdout, {
    type: "tool_result",
    tool_use_id: result.toolCallId,
    content: result.name,
    is_error: result.isError,
  });
}

/** Emit a usage event. */
export function emitUsage(
  onStdout: StdoutCallback | undefined,
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number },
): void {
  emitNdjson(onStdout, {
    type: "usage",
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
    },
  });
}

/** Emit a completion/result event. */
export function emitCompletion(onStdout: StdoutCallback | undefined): void {
  emitNdjson(onStdout, { type: "result", subtype: "success" });
}