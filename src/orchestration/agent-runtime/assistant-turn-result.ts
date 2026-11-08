/**
 * The result of one streaming assistant turn and the reducer that folds
 * provider stream events into it. Kept separate from the request-scoped
 * `streamAssistantTurn` boundary so the turn's accumulation logic has one
 * home and the stream module stays focused on request/response identity.
 */

import { Log } from "../../infra/log.js";
import { toolUseBlock } from "./agent-state.js";
import type { AgentRuntimeError, ContextOverflow, OutputOverflow } from "./errors.js";
import { assertNever } from "../../infra/assert-never.js";
import type { ProviderTransportContext } from "../session/provider-request-audit-types.js";
import type {
  AssistantMetadata,
  CompletedStopReason,
  ContentBlock,
  ProviderStreamEvent,
  ToolCall,
  AssistantOutputIdentity,
} from "./llm/types.js";

const log = Log.create({ service: "assistant-turn-result" });
const textBlocksByResult = new WeakMap<AssistantTurnResult, Map<string, Extract<ContentBlock, { type: "text" }>>>();
const runsByResult = new WeakMap<AssistantTurnResult, Map<ContentBlock, { index: number; parts: Extract<ContentBlock, { type: "text" }>[] }>>();

function associateRun(result: AssistantTurnResult, block: ContentBlock): void {
  let runs = runsByResult.get(result);
  if (!runs) { runs = new Map(); runsByResult.set(result, runs); }
  const index = result.assistantContent.length;
  const previous = result.assistantContent.at(-1);
  const adjacent = block.type === "text" && previous?.type === "text" ? runs.get(previous) : undefined;
  const run = adjacent ?? { index, parts: [] };
  if (block.type === "text") run.parts.push(block);
  runs.set(block, run);
}

function keyedTextBlock(result: AssistantTurnResult, blockKey: string): Extract<ContentBlock, { type: "text" }> {
  let blocks = textBlocksByResult.get(result);
  if (!blocks) {
    blocks = new Map();
    textBlocksByResult.set(result, blocks);
  }
  const existing = blocks.get(blockKey);
  if (existing) return existing;
  const block = { type: "text", text: "" } as const;
  associateRun(result, block);
  result.assistantContent.push(block);
  blocks.set(blockKey, block);
  return block;
}

/** Discriminated outcome of one streaming assistant turn. `ok` is the happy
 *  path; every other variant carries the typed error that ended the turn so
 *  the caller dispatches recovery without unwrapping a thrown error. */
export type TurnOutcome =
  | { kind: "ok"; stopReason: CompletedStopReason }
  | { kind: "incomplete" }
  | { kind: "aborted" }
  | { kind: "context_overflow"; error: ContextOverflow }
  | { kind: "output_overflow"; error: OutputOverflow }
  | { kind: "stream_error"; error: AgentRuntimeError };

export interface AssistantTurnResult {
  /** Reserved before the attempt can publish any public output. */
  entryId?: string;
  outcome: TurnOutcome;
  assistantContent: ContentBlock[];
  toolCalls: ToolCall[];
  assistantMetadata: AssistantMetadata | undefined;
  lastAssistantMetadata: AssistantMetadata | undefined;
  usageAnchor: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; cacheRetentionMs?: number | null } | undefined;
  /** The provider's own terminal event, retained instead of forwarded: the
   *  turn's terminal runtime projection belongs after the assistant and its
   *  tool results are durable, so the settlement coordinator publishes it
   *  (agent-turn-settlement.ts). Undefined until the provider completes the
   *  response, and again after a retry discards the attempt. */
  terminalEvent: Extract<ProviderStreamEvent, { kind: "done" }> | undefined;
  /** What a transport added to the request, for its audit response. A retry keeps it: it describes the request
   *  that the audit records, not the discarded content. */
  transportContext: ProviderTransportContext | undefined;
}
function resetAssistantTurnResult(result: AssistantTurnResult): void {
  result.assistantContent = [];
  result.toolCalls = [];
  result.outcome = { kind: "ok", stopReason: "unknown" };
  result.assistantMetadata = undefined;
  result.terminalEvent = undefined;
  textBlocksByResult.delete(result);
  runsByResult.delete(result);
}

/** Accumulates canonical content before deriving its live publication identity. */
export function handleStreamEvent(event: ProviderStreamEvent, result: AssistantTurnResult): ProviderStreamEvent & { readonly outputIdentity?: AssistantOutputIdentity } {
  if (
    event.kind === "provider_response_started" ||
    event.kind === "tool_input_start" ||
    event.kind === "tool_input_delta" ||
    event.kind === "context_update" ||
    event.kind === "provider_status" ||
    event.kind === "stream_attempt_start" ||
    event.kind === "stream_resample"
  ) {
    return event;
  }
  switch (event.kind) {
    case "text_complete": {
      const block = event.blockKey === undefined ? undefined : textBlocksByResult.get(result)?.get(event.blockKey);
      return block ? publication(event, result, block) : event;
    }
    case "text_delta": {
      const block = keyedTextBlock(result, event.blockKey);
      block.text += event.text;
      if (event.signature) block.signature = event.signature;
      return publication(event, result, block);
    }
    case "text_terminal": {
      const block = keyedTextBlock(result, event.blockKey);
      block.text = event.content;
      if (event.signature) block.signature = event.signature;
      return publication(event, result, block);
    }
    case "thinking_delta":
      // Private previews are not canonical parts until the provider classifies them.
      return event;
    case "thinking_complete": {
      if (!event.signature && event.presentation !== "progress") return event;
      const block: Extract<ContentBlock, { type: "thinking" }> = {
        type: "thinking",
        thinking: event.thinking,
        ...(event.signature ? { signature: event.signature } : {}),
        ...(event.redacted ? { redacted: true } : {}),
        ...(event.presentation ? { presentation: event.presentation } : {}),
      };
      associateRun(result, block);
      result.assistantContent.push(block);
      return publication(event, result, block);
    }
    case "reasoning": {
      const block: Extract<ContentBlock, { type: "reasoning" }> = {
        type: "reasoning",
        id: event.id,
        encrypted_content: event.encryptedContent,
        ...(event.summary ? { summary: event.summary } : {}),
      };
      associateRun(result, block);
      result.assistantContent.push(block);
      return publication(event, result, block);
    }
    case "tool_use": {
      result.toolCalls.push(event.toolCall);
      const block = toolUseBlock(event.toolCall);
      associateRun(result, block);
      result.assistantContent.push(block);
      return publication(event, result, block);
    }
    case "usage":
      result.usageAnchor = {
        inputTokens: event.inputTokens,
        // Adapters leave unreported cache reads inside inputTokens, so the prompt total stays exact.
        cacheReadTokens: event.cacheReadTokens ?? 0,
        cacheWriteTokens: event.cacheCreateTokens,
        reasoningTokens: event.reasoningTokens,
        ...(event.cacheRetentionMs === undefined ? {} : { cacheRetentionMs: event.cacheRetentionMs }),
      };
      return event;
    case "transport_context":
      result.transportContext = event.context;
      return event;
    case "done":
      result.outcome = { kind: "ok", stopReason: event.stopReason };
      result.assistantMetadata = event.metadata;
      result.lastAssistantMetadata = event.metadata ?? result.lastAssistantMetadata;
      result.terminalEvent = event;
      return event;
    case "stream_retry":
      // The evidence gate in withRetryStream stops in-stream retries once the
      // attempt has produced content, so a retry can only discard an empty
      // accumulator (plus provisional metadata).
      log.warn("stream retry, resetting empty turn accumulator", {
        droppedContentBlocks: result.assistantContent.length,
        droppedToolCalls: result.toolCalls.length,
        attempt: event.attempt,
      });
      resetAssistantTurnResult(result);
      return event;
    default:
      assertNever(event);
  }
}

function publication(
  event: Extract<ProviderStreamEvent, { kind: "text_delta" | "text_terminal" | "text_complete" | "thinking_delta" | "thinking_complete" | "tool_use" | "reasoning" }>,
  result: AssistantTurnResult,
  block: ContentBlock,
): ProviderStreamEvent & { readonly outputIdentity?: AssistantOutputIdentity } {
  if (result.entryId === undefined) return event;
  const run = runsByResult.get(result)?.get(block);
  if (!run) throw new Error("Canonical assistant part has no output run");
  const outputIdentity = {
    entryId: result.entryId,
    blockKey: `${result.entryId}:${run.index}`,
  };
  return event.kind === "text_terminal"
    ? { ...event, content: run.parts.map((part) => part.text).join(""), outputIdentity }
    : { ...event, outputIdentity };
}
