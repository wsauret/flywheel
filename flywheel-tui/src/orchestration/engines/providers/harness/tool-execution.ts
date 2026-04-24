// Parallel tool-call execution — runs every tool_use block from the assistant
// turn concurrently, steers on queued user input, and normalizes outputs to
// ToolResultEntry. Owns the "every tool_use must get exactly one tool_result"
// invariant: even errors/skips produce an entry so the next API call is
// structurally valid.

import { errorMessage } from "../../../../infra/error-message.js";
import { Log } from "../../../../infra/log.js";
import type { StreamEvent, ToolCall } from "./llm/types.js";
import type { ToolContext, ToolDefinition } from "./tools/types.js";
import type { ToolResultEntry } from "./agent-state.js";
import { executeTool } from "./tools/tool-dispatch.js";
import { limitOutput } from "./context/truncation.js";
import { createTokenCounter } from "./context/token-counter.js";

const log = Log.create({ service: "harness-tool-execution" });

export interface ToolExecutionInput {
  toolCalls: ReadonlyArray<ToolCall>;
  toolContext: ToolContext;
  signal: AbortSignal | undefined;
  hasQueuedInput: (() => boolean) | undefined;
  extraTools: ReadonlyMap<string, ToolDefinition> | undefined;
  cwd: string;
  sessionId: string | undefined;
  tokenCounter: ReturnType<typeof createTokenCounter>;
  onEvent: (event: StreamEvent) => void;
}

export interface ToolExecutionOutcome {
  toolResults: ToolResultEntry[];
  todoMutated: boolean;
}

export async function executeToolCallsParallel(input: ToolExecutionInput): Promise<ToolExecutionOutcome> {
  const toolResults: ToolResultEntry[] = [];
  const steeringAbort = new AbortController();
  const toolSignal = input.signal
    ? AbortSignal.any([input.signal, steeringAbort.signal])
    : steeringAbort.signal;
  const steeringContext: ToolContext = { ...input.toolContext, signal: toolSignal };

  const settled = await Promise.allSettled(
    input.toolCalls.map(async (tc) => {
      if (steeringAbort.signal.aborted || input.signal?.aborted) return { tc, skipped: true as const };
      try {
        const result = await executeTool(tc.name, tc.input, steeringContext, tc.id, input.extraTools);
        if (input.hasQueuedInput?.() && !steeringAbort.signal.aborted) {
          steeringAbort.abort();
        }
        return { tc, skipped: false as const, result };
      } catch (err) {
        if (steeringAbort.signal.aborted || input.signal?.aborted) return { tc, skipped: true as const };
        log.warn("tool execution threw", { tool: tc.name, error: errorMessage(err) });
        throw err;
      }
    }),
  );

  let todoMutated = false;
  for (let i = 0; i < settled.length; i++) {
    const entry = settled[i]!;
    const tc = input.toolCalls[i]!;
    if (entry.status === "rejected") {
      const content = "Tool execution failed.";
      input.onEvent({ kind: "tool_result", toolCallId: tc.id, content });
      toolResults.push({ toolCallId: tc.id, content, isError: true });
      continue;
    }
    const value = entry.value;
    if (value.skipped) {
      const content = input.signal?.aborted ? "Interrupted by user." : "Skipped due to queued user message.";
      input.onEvent({ kind: "tool_result", toolCallId: value.tc.id, content });
      toolResults.push({ toolCallId: value.tc.id, content, isError: true });
    } else {
      try {
        const { text: content } = await limitOutput(value.result.content, undefined, input.cwd, input.sessionId);
        input.onEvent({ kind: "tool_result", toolCallId: value.tc.id, content });
        toolResults.push({ toolCallId: value.tc.id, content });
        input.tokenCounter.addToolResult(content);
        if (value.tc.name === "todo_list" && value.tc.input?.operation !== "read") todoMutated = true;
      } catch (err) {
        // Never leave a tool_use without a matching tool_result — the next
        // API call would reject the conversation as malformed.
        log.warn("tool output processing failed", { tool: value.tc.name, error: errorMessage(err) });
        const content = `Tool output processing failed: ${errorMessage(err)}`;
        input.onEvent({ kind: "tool_result", toolCallId: value.tc.id, content });
        toolResults.push({ toolCallId: value.tc.id, content, isError: true });
      }
    }
  }

  return { toolResults, todoMutated };
}
