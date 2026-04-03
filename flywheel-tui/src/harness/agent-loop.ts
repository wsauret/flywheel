/**
 * Top-level agent orchestration loop.
 *
 * Wires together the turn executor, completion state machine, doom loop
 * detector, and message history to run a multi-turn agent conversation.
 * Composable: takes a provider, tools, and options — returns a result.
 * No side effects (no config/env reads).
 */

import type {
  LLMProvider,
  Message,
  StreamOptions,
  ToolDefinition,
  UsageInfo,
  AssistantMessage,
  TextContent,
  ToolCallContent,
  ToolResultContent,
  ToolResultMessage,
  UserMessage,
} from "./llm.js";
import type { HarnessTool, ToolContext } from "./tools/types.js";
import { createToolRegistry } from "./tools/registry.js";
import { normalizeTools } from "./intent-trace.js";
import { CompletionStateMachine } from "./completion.js";
import { DoomLoopDetector, extractToolSignature } from "./doom-loop.js";
import { estimateTokens } from "./context.js";
import {
  executeTurn,
  type CollectedToolCall,
  type ToolCallResult,
  type TurnResult,
} from "./turn-executor.js";
import { createTraceEmitter, type TraceCallback, type TraceEmitter } from "./tracer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentLoopOptions {
  provider: LLMProvider;
  tools: HarnessTool[];
  systemPrompt: string;
  initialMessage: string;
  model: string;
  maxTokens?: number;
  maxTurns?: number;
  maxToolFailures?: number;
  thinking?: { type: "enabled"; budgetTokens: number };
  abortSignal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
  onTrace?: TraceCallback;
  onTextDelta?: (text: string) => void;
  onThinking?: (thinking: string) => void;
  onToolUse?: (call: CollectedToolCall) => void;
  onToolResult?: (result: ToolCallResult) => void;
  onTurnComplete?: (turn: number, result: TurnResult) => void;
  onUsage?: (usage: UsageInfo) => void;
}

export type AgentLoopStatus =
  | "completed"
  | "max_turns"
  | "doom_loop"
  | "aborted"
  | "error";

export interface AgentLoopResult {
  status: AgentLoopStatus;
  handoff?: unknown;
  totalTurns: number;
  totalUsage: UsageInfo;
  error?: Error;
}

// ---------------------------------------------------------------------------
// Error sentinel classes for overflow recovery
// ---------------------------------------------------------------------------

export class ContextLengthExceededError extends Error {
  constructor(message = "Context length exceeded") {
    super(message);
    this.name = "ContextLengthExceededError";
  }
}

export class OutputLengthExceededError extends Error {
  constructor(message = "Output length exceeded") {
    super(message);
    this.name = "OutputLengthExceededError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 100;
const DEFAULT_MAX_TOOL_FAILURES = 3;
const DEFAULT_MAX_TOKENS = 16384;
const CONTEXT_WARNING_RATIO = 0.5;
const MIN_MESSAGES_AFTER_TRUNCATION = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addUsage(total: UsageInfo, turn: UsageInfo | null): UsageInfo {
  if (!turn) return total;
  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    cacheReadInputTokens:
      (total.cacheReadInputTokens ?? 0) + (turn.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      (total.cacheCreationInputTokens ?? 0) + (turn.cacheCreationInputTokens ?? 0),
  };
}

function emptyUsage(): UsageInfo {
  return { inputTokens: 0, outputTokens: 0 };
}

/** Estimate total tokens in message history for context budget tracking. */
function estimateHistoryTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else {
      for (const part of msg.content) {
        if ("text" in part) total += estimateTokens(part.text);
        if ("content" in part) total += estimateTokens(part.content);
      }
    }
  }
  return total;
}

/** Build assistant message from turn results for conversation history. */
function buildAssistantMessage(turn: TurnResult): AssistantMessage {
  const content: (TextContent | ToolCallContent)[] = [];

  if (turn.textContent) {
    content.push({ type: "text", text: turn.textContent });
  }

  for (const call of turn.toolCalls) {
    content.push({
      type: "tool_call",
      id: call.id,
      name: call.name,
      arguments: call.input,
    });
  }

  // Ensure at least one content block (LLM APIs require non-empty content)
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  return { role: "assistant", content };
}

/** Build tool result message from turn results for conversation history. */
function buildToolResultMessage(results: ToolCallResult[]): ToolResultMessage {
  const content: ToolResultContent[] = results.map((r) => ({
    type: "tool_result" as const,
    tool_use_id: r.toolCallId,
    content: r.content,
    is_error: r.isError || undefined,
  }));
  return { role: "tool_result", content };
}

/** Truncate oldest messages to recover from context overflow. */
function truncateHistory(messages: Message[]): Message[] {
  if (messages.length <= MIN_MESSAGES_AFTER_TRUNCATION) {
    return messages;
  }

  // Keep the first message (initial user prompt) and the most recent messages
  const first = messages[0]!;
  const recentCount = Math.max(
    MIN_MESSAGES_AFTER_TRUNCATION - 1,
    Math.floor(messages.length / 2),
  );
  const recent = messages.slice(-recentCount);

  const truncationNotice: UserMessage = {
    role: "user",
    content:
      "[System: Earlier conversation messages were removed to fit context limits. Continue with the task based on the remaining context.]",
  };

  return [first, truncationNotice, ...recent];
}

/** Detect context/output overflow errors from an unknown error. */
function isContextLengthError(err: unknown): boolean {
  if (err instanceof ContextLengthExceededError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /context.*(length|limit|window).*exceed/i.test(msg)
    || /too many tokens/i.test(msg)
    || /maximum context length/i.test(msg);
}

function isOutputLengthError(err: unknown): boolean {
  if (err instanceof OutputLengthExceededError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /output.*(length|limit).*exceed/i.test(msg)
    || /max_tokens/i.test(msg);
}

// ---------------------------------------------------------------------------
// Agent Loop
// ---------------------------------------------------------------------------

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    provider,
    tools,
    systemPrompt,
    initialMessage,
    model,
    maxTokens = DEFAULT_MAX_TOKENS,
    maxTurns = DEFAULT_MAX_TURNS,
    maxToolFailures = DEFAULT_MAX_TOOL_FAILURES,
    thinking,
    abortSignal,
    cwd = process.cwd(),
    env = {},
    onTrace,
    onTextDelta,
    onThinking,
    onToolUse,
    onToolResult,
    onTurnComplete,
    onUsage,
  } = options;

  const emitter = createTraceEmitter(onTrace);

  // Setup
  const registry = createToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }

  const toolDefs = normalizeTools(
    registry.toLLMDefinitions() as ToolDefinition[],
  );
  const completionSM = new CompletionStateMachine();
  const doomDetector = new DoomLoopDetector();

  const toolContext: ToolContext = { cwd, env, abortSignal };

  // Message history
  const messages: Message[] = [
    { role: "user", content: initialMessage } satisfies UserMessage,
  ];

  let totalUsage = emptyUsage();
  let consecutiveToolFailures = 0;

  // Estimated context budget for warning (model-dependent, rough heuristic)
  const estimatedContextBudget = 200_000;

  for (let turn = 0; turn < maxTurns; turn++) {
    // Check abort signal
    if (abortSignal?.aborted) {
      const result: AgentLoopResult = { status: "aborted", totalTurns: turn, totalUsage };
      emitter.emit({ type: "complete", status: result.status, totalTurns: result.totalTurns, totalUsage, durationMs: emitter.elapsedMs });
      return result;
    }

    emitter.emit({ type: "turn_start", turn });
    const turnStartTime = Date.now();

    // Build stream options for this turn
    const streamOptions: StreamOptions = {
      model,
      system: systemPrompt,
      messages: [...messages],
      tools: toolDefs,
      maxTokens,
      ...(thinking ? { thinking } : {}),
      ...(abortSignal ? { abortSignal } : {}),
    };

    let turnResult: TurnResult;

    try {
      turnResult = await executeTurn({
        provider,
        registry,
        streamOptions,
        toolContext,
        onTextDelta,
        onThinking,
        onToolUse,
        onToolResult,
        onTrace: onTrace,
      });
    } catch (err) {
      // Context overflow recovery
      if (isContextLengthError(err)) {
        const before = messages.length;
        messages.splice(0, messages.length, ...truncateHistory(messages));
        emitter.emit({ type: "context_overflow", action: "truncate", turn, messagesBefore: before, messagesAfter: messages.length });
        try {
          const retryOptions: StreamOptions = {
            model,
            system: systemPrompt,
            messages: [...messages],
            tools: toolDefs,
            maxTokens,
            ...(thinking ? { thinking } : {}),
            ...(abortSignal ? { abortSignal } : {}),
          };
          turnResult = await executeTurn({
            provider,
            registry,
            streamOptions: retryOptions,
            toolContext,
            onTextDelta,
            onThinking,
            onToolUse,
            onToolResult,
            onTrace: onTrace,
          });
        } catch (retryErr) {
          const error = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
          emitter.emit({ type: "error", turn, error, recoverable: false });
          return { status: "error", totalTurns: turn, totalUsage, error };
        }
      } else if (isOutputLengthError(err)) {
        emitter.emit({ type: "output_overflow", turn, action: "continue" });
        messages.push({
          role: "user",
          content: "Your previous response was truncated due to output length limits. Continue where you left off.",
        } satisfies UserMessage);
        continue;
      } else {
        const error = err instanceof Error ? err : new Error(String(err));
        emitter.emit({ type: "error", turn, error, recoverable: false });
        return { status: "error", totalTurns: turn, totalUsage, error };
      }
    }

    // Track cumulative usage
    totalUsage = addUsage(totalUsage, turnResult.usage);
    if (turnResult.usage) {
      onUsage?.(turnResult.usage);
      emitter.emit({ type: "usage", turn, usage: turnResult.usage, cumulative: { ...totalUsage } });
    }

    const turnDuration = Date.now() - turnStartTime;
    emitter.emit({ type: "turn_end", turn, toolCallCount: turnResult.toolCalls.length, hasCompletion: turnResult.completionAttempt !== null, durationMs: turnDuration });

    // Notify turn complete
    onTurnComplete?.(turn, turnResult);

    // Handle completion attempt (task_complete was called)
    if (turnResult.completionAttempt !== null) {
      const result = completionSM.handleTaskComplete(turnResult.completionAttempt);
      emitter.emit({ type: "completion_attempt", turn, handoff: turnResult.completionAttempt, result: result.status, message: result.status === "error" ? result.message : undefined });

      if (result.status === "confirmed") {
        messages.push(buildAssistantMessage(turnResult));
        if (turnResult.toolResults.length > 0) {
          messages.push(buildToolResultMessage(turnResult.toolResults));
        }
        const loopResult: AgentLoopResult = { status: "completed", handoff: result.handoff, totalTurns: turn + 1, totalUsage };
        emitter.emit({ type: "complete", status: "completed", totalTurns: loopResult.totalTurns, totalUsage, durationMs: emitter.elapsedMs });
        return loopResult;
      }

      if (result.status === "pending") {
        messages.push(buildAssistantMessage(turnResult));
        if (turnResult.toolResults.length > 0) {
          messages.push(buildToolResultMessage(turnResult.toolResults));
        }
        messages.push({
          role: "user",
          content: result.checklist,
        } satisfies UserMessage);
        continue;
      }

      if (result.status === "error") {
        messages.push(buildAssistantMessage(turnResult));
        if (turnResult.toolResults.length > 0) {
          messages.push(buildToolResultMessage(turnResult.toolResults));
        }
        messages.push({
          role: "user",
          content: result.message,
        } satisfies UserMessage);
        continue;
      }
    }

    // Record tool calls in doom loop detector
    for (const call of turnResult.toolCalls) {
      const signature = extractToolSignature(call.name, call.input);
      doomDetector.recordToolCall(call.name, signature);
    }

    // Check doom loop
    const doomWarning = doomDetector.getWarning();
    if (doomWarning) {
      emitter.emit({ type: "doom_loop", turn, warning: doomWarning });
      const loopResult: AgentLoopResult = { status: "doom_loop", totalTurns: turn + 1, totalUsage, error: new Error(doomWarning) };
      emitter.emit({ type: "complete", status: "doom_loop", totalTurns: loopResult.totalTurns, totalUsage, durationMs: emitter.elapsedMs });
      return loopResult;
    }

    // Track consecutive tool failures
    const failedResults = turnResult.toolResults.filter((r) => r.isError);
    if (failedResults.length > 0 && failedResults.length === turnResult.toolResults.length) {
      consecutiveToolFailures++;
    } else if (turnResult.toolResults.length > 0) {
      consecutiveToolFailures = 0;
    }

    if (consecutiveToolFailures >= maxToolFailures) {
      emitter.emit({ type: "tool_failure_warning", turn, consecutiveFailures: consecutiveToolFailures });
      messages.push(buildAssistantMessage(turnResult));
      if (turnResult.toolResults.length > 0) {
        messages.push(buildToolResultMessage(turnResult.toolResults));
      }
      messages.push({
        role: "user",
        content: `Warning: ${consecutiveToolFailures} consecutive tool calls have failed. Try a different approach or call task_complete if the task cannot be completed.`,
      } satisfies UserMessage);
      consecutiveToolFailures = 0;
      continue;
    }

    // Add assistant message + tool results to history
    messages.push(buildAssistantMessage(turnResult));
    if (turnResult.toolResults.length > 0) {
      messages.push(buildToolResultMessage(turnResult.toolResults));
    }

    // No tool calls and no completion: model stopped without calling task_complete.
    // Nudge it — the agent must always complete via task_complete for structured output.
    if (turnResult.toolCalls.length === 0 && turnResult.completionAttempt === null) {
      messages.push({
        role: "user",
        content: "You must call task_complete to finish the task. Provide a summary of what you accomplished. Do not respond with text only — use the task_complete tool.",
      } satisfies UserMessage);
      continue;
    }

    // Context budget warning
    const historyTokens = estimateHistoryTokens(messages);
    if (historyTokens > estimatedContextBudget * CONTEXT_WARNING_RATIO) {
      // No-op for now — tracer consumers can track usage events
    }
  }

  // Exceeded max turns
  const result: AgentLoopResult = { status: "max_turns", totalTurns: maxTurns, totalUsage };
  emitter.emit({ type: "complete", status: "max_turns", totalTurns: maxTurns, totalUsage, durationMs: emitter.elapsedMs });
  return result;
}
