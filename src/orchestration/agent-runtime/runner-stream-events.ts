// Translates loop stream events into runtime events for the session's event
// channel: one exhaustive switch, one emit per event kind.
import { createRuntimeEvent } from "../../infra/runtime-event-factory.js";
import { redactSecrets } from "../../infra/redact-secrets.js";
import { isAnthropicNarration } from "../../infra/llm/anthropic-narration.js";
import { reasoningSummaryText } from "../../infra/output/assistant-content-runs.js";
import type { AgentOptions } from "./types.js";
import { assertNever } from "../../infra/assert-never.js";
import {
  emitAssistant,
  emitCompactionCompleted,
  emitCompactionStarted,
  emitContentBlockDelta,
  emitContextUpdate,
  emitProviderResponseStarted,
  emitResult,
  emitTextComplete,
  emitToolInputComplete,
  emitToolInputDelta,
  emitToolPreviewCheck,
  emitToolExecutionOutput,
  emitToolExecutionOutputRecorded,
  emitToolResult,
  emitToolResultAvailable,
  emitToolResultAck,

  type ThinkingAccumulator,
  type ToolInputExecution,
} from "./emit.js";
import { decorateWorkflowToolCall } from "./tools/workflow-tool.js";
import type { TurnUsageTracker } from "./turn-usage-tracker.js";
import type { StreamEvent, ToolCall } from "./llm/types.js";
import { runtimeToolExecution, type RuntimeTool } from "./tools/types.js";

interface StreamEventEmitContext {
  options: Pick<AgentOptions, "onEvent">;
  /** Context window of the model this runner serves, reported on the turn's
   *  terminal event. */
  contextWindow: number;
  costTracker: TurnUsageTracker;
  providerSessionKey: string;
  parentToolUseId: string | undefined;
  thinking: ThinkingAccumulator;
  tools: ReadonlyMap<string, RuntimeTool>;
}

// The runtime-assembly stream handler intercepts retry telemetry and provider
// notices before emission (they mutate session notices, not runtime events),
// so this module never sees them.
type EmittableStreamEvent = Exclude<StreamEvent, { kind: "stream_retry" | "stream_resample" | "stream_attempt_start" | "provider_status" }>;

export function emitAgentStreamEvent(
  streamEvent: EmittableStreamEvent,
  context: StreamEventEmitContext,
): void {
  const { options, parentToolUseId } = context;
  const blockKey = streamEvent.outputIdentity?.blockKey ?? ("blockKey" in streamEvent ? streamEvent.blockKey : undefined);
  switch (streamEvent.kind) {
    case "stream_abandoned":
      options.onEvent(createRuntimeEvent("model.stream.abandoned", {
        reason: streamEvent.reason,
        ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      }));
      return;
    case "provider_response_started":
      context.thinking.take();
      emitProviderResponseStarted(options.onEvent, parentToolUseId);
      return;
    case "text_delta":
      emitContentBlockDelta(options.onEvent, { type: "text_delta", text: streamEvent.text }, parentToolUseId, blockKey);
      return;
    case "text_terminal":
      options.onEvent(createRuntimeEvent("model.text.reconciled", {
        content: streamEvent.content,
        block_key: blockKey ?? streamEvent.blockKey,
        ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      }));
      return;
    case "text_complete":
      emitTextComplete(options.onEvent, parentToolUseId, blockKey);
      return;
    case "thinking_delta":
      if (streamEvent.presentation === "progress") return;
      emitContentBlockDelta(
        options.onEvent,
        { type: "thinking_delta", thinking: streamEvent.text, ...(streamEvent.estimatedTokens !== undefined ? { estimated_tokens: streamEvent.estimatedTokens } : {}) },
        parentToolUseId,
        blockKey,
      );
      context.thinking.append(streamEvent.text);
      return;
    case "thinking_complete":
      if (isAnthropicNarration(streamEvent) && streamEvent.blockKey !== undefined) {
        options.onEvent(createRuntimeEvent("model.text.reconciled", {
          content: redactSecrets(streamEvent.thinking),
          block_key: blockKey ?? streamEvent.blockKey,
          provisional_block_key: streamEvent.blockKey,
          ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
        }));
        emitTextComplete(options.onEvent, parentToolUseId, blockKey);
        return;
      }
      if (streamEvent.presentation === "progress") {
        emitContentBlockDelta(
          options.onEvent,
          { type: "thinking_delta", thinking: redactSecrets(streamEvent.thinking), presentation: "progress" },
          parentToolUseId,
          blockKey,
        );
        emitTextComplete(options.onEvent, parentToolUseId, blockKey);
        return;
      }
      if (streamEvent.outputIdentity) {
        options.onEvent(createRuntimeEvent("model.content.delta", {
          delta: { type: "thinking_complete", thinking: streamEvent.thinking, provisional_block_key: streamEvent.blockKey },
          block_key: blockKey,
          ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
        }));
      } else if (context.thinking.isEmpty()) emitContentBlockDelta(options.onEvent, { type: "thinking_delta", thinking: streamEvent.thinking }, parentToolUseId, blockKey);
      context.thinking.replace(streamEvent.thinking);
      return;
    case "reasoning":
      if (!streamEvent.outputIdentity) {
        emitContentBlockDelta(options.onEvent, { type: "thinking_delta", thinking: "" }, parentToolUseId);
        return;
      }
      // The streamed summary or raw reasoning text settles to the persisted
      // part, with the text a reopened transcript shows for it.
      options.onEvent(createRuntimeEvent("model.content.delta", {
        delta: { type: "thinking_complete", thinking: reasoningSummaryText(streamEvent), provisional_block_key: streamEvent.blockKey },
        block_key: blockKey,
        ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      }));
      return;
    case "tool_result":
      emitToolResultEvent(streamEvent, options, parentToolUseId);
      return;
    case "tool_result_available":
      emitToolResultAvailable(options.onEvent, streamEvent.toolUseId, streamEvent.content, streamEvent.outcome, {
        ...(streamEvent.details != null ? { details: streamEvent.details } : {}),
        ...(streamEvent.contentTruncated !== undefined ? { contentTruncated: streamEvent.contentTruncated } : {}),
        ...(streamEvent.originalContentBytes !== undefined ? { originalContentBytes: streamEvent.originalContentBytes } : {}),
        ...(streamEvent.originalContentSha256 ? { originalContentSha256: streamEvent.originalContentSha256 } : {}),
        ...(streamEvent.fullContentPath ? { fullContentPath: streamEvent.fullContentPath } : {}),
        ...(streamEvent.semanticOutputTruncated !== undefined ? { semanticOutputTruncated: streamEvent.semanticOutputTruncated } : {}),
        ...(streamEvent.byteOutputTruncated !== undefined ? { byteOutputTruncated: streamEvent.byteOutputTruncated } : {}),
        ...(streamEvent.executionOutputTail !== undefined ? { executionOutputTail: streamEvent.executionOutputTail } : {}),
      });
      return;
    case "tool_result_ack":
      emitToolResultAck(options.onEvent, streamEvent.toolUseId, {
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(streamEvent.modelRequestId ? { modelRequestId: streamEvent.modelRequestId } : {}),
      });
      return;
    case "tool_preview_check":
      emitToolPreviewCheck(options.onEvent, streamEvent.toolUseId, streamEvent.operation);
      return;
    case "tool_input_start":
      emitAssistant(options.onEvent, [{ type: "tool_use", id: streamEvent.toolUseId, name: streamEvent.name, input: {} }], undefined, parentToolUseId);
      return;
    case "tool_input_delta":
      emitToolInputDelta(options.onEvent, streamEvent.toolUseId, streamEvent.partialJson, {
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(streamEvent.modelRequestId ? { modelRequestId: streamEvent.modelRequestId } : {}),
      });
      return;
    case "tool_execution_output":
      emitToolExecutionOutput(options.onEvent, streamEvent.toolUseId, streamEvent.output, {
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(streamEvent.modelRequestId ? { modelRequestId: streamEvent.modelRequestId } : {}),
      });
      return;
    case "tool_use":
      emitToolUseEvent(streamEvent, context, parentToolUseId);
      return;
    case "usage":
      // Adapters leave unreported cache reads inside inputTokens, so this in-process prompt total stays exact.
      // The durable record keeps the unreported detail as null.
      context.costTracker.handleUsage({ ...streamEvent, cacheReadTokens: streamEvent.cacheReadTokens ?? 0 });
      return;
    case "context_update":
      emitContextUpdate(options.onEvent, streamEvent.promptTokens, streamEvent.contextWindow, parentToolUseId);
      return;
    case "compaction_start":
      emitCompactionStarted(options.onEvent, parentToolUseId);
      return;
    case "compaction_done":
      emitCompactionCompleted(options.onEvent, streamEvent.success ? "completed" : "failed", {
        durationMs: streamEvent.durationMs,
        tokensBefore: streamEvent.tokensBefore,
        tokensAfter: streamEvent.tokensAfter,
        parentToolUseId,
      });
      return;
    case "done": {
      const totals = context.costTracker.getTotals();
      emitResult(options.onEvent, {
        totalCostUsd: totals.cost,
        billedCostUsd: totals.billedCost,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        cacheCreateTokens: totals.cacheCreateTokens,
        reasoningTokens: totals.reasoningTokens,
        sessionId: context.providerSessionKey,
        contextWindow: context.contextWindow,
      }, parentToolUseId);
      return;
    }
    // The attempt keeps a transport's context for the request's audit and never forwards it.
    case "transport_context":
      return;
    default:
      assertNever(streamEvent);
  }
}

// One settled call arrives as one stream event, so its output tail and its
// terminal result are emitted back to back with nothing in between. Turn
// settlement (agent-turn-settlement.ts) is the only publisher of these events
// and it publishes call by call, so the pair needs no cross-call locking.
function emitToolResultEvent(
  streamEvent: Extract<EmittableStreamEvent, { kind: "tool_result" }>,
  options: Pick<AgentOptions, "onEvent">,
  parentToolUseId: string | undefined,
): void {
  if ("executionOutputTail" in streamEvent && typeof streamEvent.executionOutputTail === "string") {
    emitToolExecutionOutputRecorded(options.onEvent, streamEvent.toolUseId, streamEvent.executionOutputTail, {
      ...(parentToolUseId ? { parentToolUseId } : {}),
      ...(streamEvent.modelRequestId ? { modelRequestId: streamEvent.modelRequestId } : {}),
    });
  }
  emitToolResult(options.onEvent, streamEvent.toolUseId, streamEvent.content, streamEvent.outcome, {
    ...(parentToolUseId ? { parentToolUseId } : {}),
    ...(streamEvent.modelRequestId ? { modelRequestId: streamEvent.modelRequestId } : {}),
    ...(streamEvent.details != null ? { details: streamEvent.details } : {}),
    ...(streamEvent.contentTruncated !== undefined ? { contentTruncated: streamEvent.contentTruncated } : {}),
    ...(streamEvent.originalContentBytes !== undefined ? { originalContentBytes: streamEvent.originalContentBytes } : {}),
    ...(streamEvent.originalContentSha256 ? { originalContentSha256: streamEvent.originalContentSha256 } : {}),
    ...(streamEvent.fullContentPath ? { fullContentPath: streamEvent.fullContentPath } : {}),
    ...(streamEvent.semanticOutputTruncated !== undefined ? { semanticOutputTruncated: streamEvent.semanticOutputTruncated } : {}),
    ...(streamEvent.byteOutputTruncated !== undefined ? { byteOutputTruncated: streamEvent.byteOutputTruncated } : {}),
  });
}

function emitToolUseEvent(
  streamEvent: Extract<EmittableStreamEvent, { kind: "tool_use" }>,
  context: StreamEventEmitContext,
  parentToolUseId: string | undefined,
): void {
  emitToolInputComplete(
    context.options.onEvent,
    decorateToolInputComplete(
      decorateWorkflowToolCall(streamEvent.toolCall),
      context.tools.get(streamEvent.toolCall.name),
    ),
    {
      ...(parentToolUseId ? { parentToolUseId } : {}),
      ...(streamEvent.toolCall.modelRequestId ? { modelRequestId: streamEvent.toolCall.modelRequestId } : {}),
      blockKey: streamEvent.outputIdentity?.blockKey,
    },
  );
}

function decorateToolInputComplete<T extends ToolCall>(
  toolCall: T,
  tool: RuntimeTool | undefined,
): T & { execution: ToolInputExecution } {
  const execution = runtimeToolExecution(tool);
  return {
    ...toolCall,
    execution: {
      mode: execution.mode,
      trace_kind: execution.traceKind,
      ...(execution.childHasOwnViewport ? { child_has_own_viewport: true } : {}),
    },
  };
}
