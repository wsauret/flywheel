/**
 * Agent loop state helpers. The conversation's `messages` array is the
 * authoritative state; this module just provides the shape transforms the
 * loop needs (rendering tool results and durable tool-use blocks).
 * History replacement at compaction is handled by compaction/compact.ts and
 * compaction/apply.ts returning a new array; the loop reassigns its `let
 * messages` binding.
 * No more in-place splicing of the conversation history.
 */

import type { ContentBlock, ConversationMessage, ToolCall } from "./llm/types.js";
import type { LlmToolOutputPart } from "./llm/messages.js";
import { toolOutcomeToProviderIsError, type ToolOutcome } from "../../infra/tool-outcome.js";

export interface ToolResultEntry {
  toolUseId: string;
  content: LlmToolOutputPart[];
  outcome: ToolOutcome;
}

export function toolResultMessages(results: ReadonlyArray<ToolResultEntry>): Extract<ConversationMessage, { kind: "toolResult" }>[] {
  return results.map((r) => ({
    kind: "toolResult" as const,
    toolUseId: r.toolUseId,
    content: r.content,
    ...(toolOutcomeToProviderIsError(r.outcome) ? { isError: true } : {}),
    ...(r.outcome === "interrupted" ? { interrupted: true } : {}),
    // Wait-state marker (gate results): survives into the session tree so the
    // derived-history fold can render blocked, not error (is_error stays true
    // on the provider wire).
    ...(r.outcome === "blocked" ? { blocked: true } : {}),
  }));
}


/** The tool_use content block that references one call. The durable assistant
 *  message the model reads back carries these blocks, so this is the one place
 *  that states which call fields survive into the conversation. */
export function toolUseBlock(call: ToolCall): Extract<ContentBlock, { type: "tool_use" }> {
  return {
    type: "tool_use",
    id: call.id,
    name: call.name,
    input: call.input,
    ...(call.registrationId ? { registrationId: call.registrationId } : {}),
    ...(call.providerItemId ? { providerItemId: call.providerItemId } : {}),
    ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
    ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
  };
}
