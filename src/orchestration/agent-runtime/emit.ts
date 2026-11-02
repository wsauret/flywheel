import { createRuntimeEvent } from "../../infra/runtime-event-factory.js";
import { redactDurableToolInput } from "../../infra/durable-tool-input.js";
import { redactSecrets } from "../../infra/redact-secrets.js";
import type { ContentBlock } from "../../infra/runtime-content-blocks.js";
import type { MutationEvidence } from "../../infra/mutation-evidence.js";
import type { BackgroundCommandRecord } from "../../infra/runtime-fact-types.js";
import type { RuntimeEvent, UsageData } from "../../infra/runtime-event-types.js";
import type { LlmToolOutputPart } from "./llm/messages.js";
import { toolOutcomeToProviderIsError, type ToolOutcome } from "../../infra/tool-outcome.js";
import type { RuntimeToolExecution } from "./tools/types.js";
import { probeToolRenderPhase } from "../../infra/render-probe.js";
import { sanitizeExternalText } from "../../infra/control-characters.js";
import type { ChatInput } from "../../infra/chat-input.js";
import type { ContentBlock as CanonicalContentBlock } from "./llm/types.js";
import { redactBlock } from "./agent-loop-history.js";
import { isAnthropicNarration } from "../../infra/llm/anthropic-narration.js";

interface ToolInput {
  [key: string]: unknown;
}

interface UserContentBlock {
  [key: string]: unknown;
}

interface ModelUsage {
  [model: string]: { contextWindow?: number };
}
export type EventEmitter = (event: RuntimeEvent) => void;

export interface ThinkingAccumulator {
  append(text: string): void;
  replace(text: string): void;
  isEmpty(): boolean;
  /** Read the accumulated thinking and reset for the next turn. */
  take(): string;
}

/** Per-turn thinking content, shared by the stream-event path (which
 *  accumulates deltas) and the turn-assistant path (which takes the result
 *  into the assistant message). */
export function createThinkingAccumulator(): ThinkingAccumulator {
  let accumulated = "";
  return {
    append(text) { accumulated += text; },
    replace(text) { accumulated = text; },
    isEmpty() { return accumulated === ""; },
    take() {
      const value = accumulated;
      accumulated = "";
      return value;
    },
  };
}

interface ToolCall {
  id: string;
  name: string;
  input: ToolInput;
  modelRequestId?: string;
  providerCallId?: string;
  repairedFrom?: string;
  execution?: ToolInputExecution;
}

export interface ToolInputExecution {
  mode: RuntimeToolExecution["mode"];
  trace_kind: RuntimeToolExecution["traceKind"];
  child_has_own_viewport?: boolean;
}

interface ResultOpts {
  totalCostUsd: number;
  billedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  reasoningTokens?: number;
  sessionId: string;
  contextWindow?: number;
}

interface ToolEventMeta {
  blockKey?: string;
  parentToolUseId?: string;
  modelRequestId?: string;
  details?: unknown;
  contentTruncated?: boolean;
  originalContentBytes?: number;
  originalContentSha256?: string;
  fullContentPath?: string;
  semanticOutputTruncated?: boolean;
  byteOutputTruncated?: boolean;
  executionOutputTail?: string;
}

export function emitUser(
  emit: EventEmitter,
  content: string | ReadonlyArray<UserContentBlock>,
  origin: "user" | "system",
  parentToolUseId?: string,
  identity?: Pick<ChatInput, "submissionIds" | "dispatchIds">,
): void {
  const userContent = typeof content === "string"
    ? [{ type: "text", text: content }]
    : [...content];

  emit(
    createRuntimeEvent("model.user_message.recorded", {
      message: { content: userContent, origin, ...(identity?.submissionIds?.length ? { submissionIds: identity.submissionIds } : {}), ...(identity?.dispatchIds?.length ? { dispatchIds: identity.dispatchIds } : {}) },
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    }),
  );
}

export function emitAssistant(
  emit: EventEmitter,
  content: ContentBlock[],
  usage?: UsageData,
  parentToolUseId?: string,
  entryId?: string,
): void {
  emit(
    createRuntimeEvent("model.assistant_message.recorded", {
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      ...(entryId ? { entry_id: entryId } : {}),
      message: { content, ...(usage ? { usage } : {}) },
    }),
  );
}

interface TurnCostSource {
  getTurnTokens(): { inputTokens: number; outputTokens: number };
  getTurnCacheTokens(): { cacheReadTokens: number; cacheCreateTokens: number };
  resetTurn(): void;
}

/** Emit the turn's assistant message with its cost attribution, then reset
 *  the tracker so the next turn starts from zero. Empty turns (no text and
 *  no thinking) emit nothing but still reset. */
export function emitTurnAssistant(
  emit: EventEmitter,
  content: ReadonlyArray<CanonicalContentBlock>,
  costTracker: TurnCostSource,
  parentToolUseId: string | undefined,
  entryId?: string,
): void {
  // Keep each canonical slot, but publish narration without its replay-only envelope.
  const blocks: ContentBlock[] = content.map(block => block.type === "thinking" && isAnthropicNarration(block)
    ? { type: "thinking", thinking: redactSecrets(block.thinking), presentation: "progress" }
    : redactBlock(block));
  if (blocks.length > 0) {
    const tokens = costTracker.getTurnTokens();
    const cache = costTracker.getTurnCacheTokens();
    emitAssistant(emit, blocks, {
      input_tokens: tokens.inputTokens,
      cache_read_input_tokens: cache.cacheReadTokens,
      cache_creation_input_tokens: cache.cacheCreateTokens,
    }, parentToolUseId, entryId);
  }
  costTracker.resetTurn();
}

export function emitProviderResponseStarted(emit: EventEmitter, parentToolUseId?: string): void {
  emit(createRuntimeEvent("agent.provider_response.started", (parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {})));
}

export function emitToolResult(
  emit: EventEmitter,
  toolUseId: string,
  content: LlmToolOutputPart[],
  outcome: ToolOutcome,
  meta: ToolEventMeta = {},
): void {
  emit(
    createRuntimeEvent("tool.result.recorded", {
      tool_use_id: toolUseId,
      content,
      is_error: toolOutcomeToProviderIsError(outcome),
      outcome,
      ...(outcome === "interrupted" ? { interrupted: true } : {}),
      ...(meta.parentToolUseId ? { parent_tool_use_id: meta.parentToolUseId } : {}),
      ...(meta.modelRequestId ? { model_request_id: meta.modelRequestId } : {}),
      ...(meta.details != null ? { details: meta.details } : {}),
      ...(meta.contentTruncated !== undefined ? { content_truncated: meta.contentTruncated } : {}),
      ...(meta.originalContentBytes !== undefined ? { original_content_bytes: meta.originalContentBytes } : {}),
      ...(meta.originalContentSha256 ? { original_content_sha256: meta.originalContentSha256 } : {}),
      ...(meta.fullContentPath ? { full_content_path: meta.fullContentPath } : {}),
      ...(meta.semanticOutputTruncated !== undefined ? { semantic_output_truncated: meta.semanticOutputTruncated } : {}),
      ...(meta.byteOutputTruncated !== undefined ? { byte_output_truncated: meta.byteOutputTruncated } : {}),
    }),
  );
}

export function emitToolResultAvailable(
  emit: EventEmitter,
  toolUseId: string,
  content: LlmToolOutputPart[],
  outcome: ToolOutcome,
  meta: ToolEventMeta = {},
): void {
  probeToolRenderPhase(toolUseId, "availability");
  emit(createRuntimeEvent("tool.result.available", {
    tool_use_id: toolUseId,
    content,
    outcome,
    ...(meta.details != null ? { details: meta.details } : {}),
    ...(meta.contentTruncated !== undefined ? { content_truncated: meta.contentTruncated } : {}),
    ...(meta.originalContentBytes !== undefined ? { original_content_bytes: meta.originalContentBytes } : {}),
    ...(meta.originalContentSha256 ? { original_content_sha256: meta.originalContentSha256 } : {}),
    ...(meta.fullContentPath ? { full_content_path: meta.fullContentPath } : {}),
    ...(meta.semanticOutputTruncated !== undefined ? { semantic_output_truncated: meta.semanticOutputTruncated } : {}),
    ...(meta.byteOutputTruncated !== undefined ? { byte_output_truncated: meta.byteOutputTruncated } : {}),
    ...(meta.executionOutputTail !== undefined ? { execution_output_tail: meta.executionOutputTail } : {}),
  }));
}

export function emitToolResultAck(
  emit: EventEmitter,
  toolUseId: string,
  meta: ToolEventMeta = {},
): void {
  emit(
    createRuntimeEvent("tool.result.acknowledged", {
      tool_use_id: toolUseId,
      ...(meta.parentToolUseId ? { parent_tool_use_id: meta.parentToolUseId } : {}),
      ...(meta.modelRequestId ? { model_request_id: meta.modelRequestId } : {}),
    }),
  );
}

export function emitToolPreviewCheck(
  emit: EventEmitter,
  toolUseId: string,
  operation: { type: "set"; advice: string } | { type: "clear" },
): void {
  emit(createRuntimeEvent("tool.preview.check", {
    tool_use_id: toolUseId,
    operation: operation.type === "set"
      ? { type: "set", advice: sanitizeExternalText(operation.advice) }
      : operation,
  }));
}

export function emitContentBlockDelta(
  emit: EventEmitter,
  delta: { type: string; text?: string; thinking?: string; presentation?: "progress"; estimated_tokens?: number },
  parentToolUseId?: string,
  blockKey?: string,
): void {
  emit(
    createRuntimeEvent("model.content.delta", {
      delta,
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      ...(blockKey ? { block_key: blockKey } : {}),
    }),
  );
}

export function emitTextComplete(
  emit: EventEmitter,
  parentToolUseId?: string,
  blockKey?: string,
): void {
  emit(
    createRuntimeEvent("model.text.completed", {
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      ...(blockKey ? { block_key: blockKey } : {}),
    }),
  );
}

export function emitToolInputDelta(
  emit: EventEmitter,
  toolUseId: string,
  partialJson: string,
  meta: ToolEventMeta = {},
): void {
  emit(
    createRuntimeEvent("tool.input.delta", {
      tool_use_id: toolUseId,
      partial_json: partialJson,
      ...(meta.parentToolUseId ? { parent_tool_use_id: meta.parentToolUseId } : {}),
      ...(meta.modelRequestId ? { model_request_id: meta.modelRequestId } : {}),
    }),
  );
}

export function emitToolExecutionOutput(
  emit: EventEmitter,
  toolUseId: string,
  output: string,
  meta: ToolEventMeta = {},
): void {
  emit(
    createRuntimeEvent("tool.execution_output.delta", {
      tool_use_id: toolUseId,
      // Live output reaches every client, so it is redacted exactly as its
      // durable record is.
      output: redactSecrets(output),
      ...(meta.parentToolUseId ? { parent_tool_use_id: meta.parentToolUseId } : {}),
      ...(meta.modelRequestId ? { model_request_id: meta.modelRequestId } : {}),
    }),
  );
}

/** Records a settled command's tail and, for a mutating command that settled
 *  in the background, the project edits it published at exit.
 *  Returns the recorder's acknowledgement, including a durability promise. */
export function emitToolExecutionOutputRecorded<A>(
  emit: (event: Extract<RuntimeEvent, { type: "tool.execution_output.recorded" }>) => A,
  toolUseId: string,
  output: string,
  meta: ToolEventMeta = {},
  mutation: { readonly mutationEvidence?: MutationEvidence } = {},
): A {
  return emit(createRuntimeEvent("tool.execution_output.recorded", {
    tool_use_id: toolUseId,
    output: redactSecrets(output),
    ...(meta.parentToolUseId ? { parent_tool_use_id: meta.parentToolUseId } : {}),
    ...(meta.modelRequestId ? { model_request_id: meta.modelRequestId } : {}),
    ...(mutation.mutationEvidence ? { mutationEvidence: mutation.mutationEvidence } : {}),
  }));
}

/** Records a background command as it starts and again as it settles, for
 *  the background index of its session. */
export function emitBackgroundCommandRecorded(
  emit: (event: Extract<RuntimeEvent, { type: "tool.background_command.recorded" }>) => void,
  record: BackgroundCommandRecord,
): void {
  emit(createRuntimeEvent("tool.background_command.recorded", record));
}

export function emitToolInputComplete(
  emit: EventEmitter,
  toolCall: ToolCall,
  meta: ToolEventMeta = {},
  transformToolCall?: (tc: ToolCall) => ToolCall,
): void {
  const rendered = transformToolCall ? transformToolCall(toolCall) : toolCall;
  emit(
    createRuntimeEvent("tool.input.completed", {
      tool_use: {
        ...rendered,
        input: redactDurableToolInput(rendered.name, rendered.input),
        provider_call_id: toolCall.providerCallId ?? toolCall.id,
        provider_tool_name: toolCall.repairedFrom ?? toolCall.name,
        executable_tool_name: rendered.name,
      },
      ...(meta.blockKey ? { block_key: meta.blockKey } : {}),
      ...(meta.parentToolUseId ? { parent_tool_use_id: meta.parentToolUseId } : {}),
      ...(meta.modelRequestId ?? rendered.modelRequestId ? { model_request_id: meta.modelRequestId ?? rendered.modelRequestId } : {}),
    }),
  );
}

export function emitCompactionStarted(emit: EventEmitter, parentToolUseId?: string): void {
  emit(createRuntimeEvent("agent.compaction.started", (parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {})));
}

export function emitCompactionCompleted(
  emit: EventEmitter,
  status: "completed" | "failed",
  opts: { durationMs?: number; tokensBefore?: number; tokensAfter?: number; parentToolUseId?: string } = {},
): void {
  emit(createRuntimeEvent("agent.compaction.completed", {
    status,
    ...(opts.durationMs != null ? { duration_ms: opts.durationMs } : {}),
    ...(opts.tokensBefore != null ? { tokens_before: opts.tokensBefore } : {}),
    ...(opts.tokensAfter != null ? { tokens_after: opts.tokensAfter } : {}),
    ...(opts.parentToolUseId ? { parent_tool_use_id: opts.parentToolUseId } : {}),
  }));
}

export function emitContextUpdate(
  emit: EventEmitter,
  promptTokens: number,
  contextWindow: number,
  parentToolUseId?: string,
): void {
  emit(
    createRuntimeEvent("model.context.measured", {
      context_prompt_tokens: promptTokens,
      context_window: contextWindow,
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    }),
  );
}


export function emitResult(emit: EventEmitter, opts: ResultOpts, parentToolUseId?: string): void {
  const modelUsage: ModelUsage | undefined =
    opts.contextWindow
      ? { default: { contextWindow: opts.contextWindow } }
      : undefined;

  emit(
    createRuntimeEvent("model.turn.completed", {
      subtype: "success",
      session_id: opts.sessionId,
      total_cost_usd: opts.totalCostUsd,
      billed_cost_usd: opts.billedCostUsd,
      usage: {
        input_tokens: opts.inputTokens,
        output_tokens: opts.outputTokens,
        ...(opts.cacheReadTokens !== undefined ? { cache_read_input_tokens: opts.cacheReadTokens } : {}),
        ...(opts.cacheCreateTokens !== undefined ? { cache_creation_input_tokens: opts.cacheCreateTokens } : {}),
        ...(opts.reasoningTokens !== undefined ? { reasoning_tokens: opts.reasoningTokens } : {}),
      },
      modelUsage,
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    }),
  );
}
