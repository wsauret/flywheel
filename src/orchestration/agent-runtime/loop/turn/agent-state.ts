/**
 * Shape transforms between settled tool calls and conversation messages:
 * the tool-result messages of a settled batch and the durable tool-use block
 * of one call. The loop's conversation history owns the messages.
 */

import type { ContentBlock, ConversationMessage, ToolCall } from "../../llm/types.js";
import type { LlmToolOutputPart } from "../../llm/messages.js";
import { toolOutcomeToProviderIsError, type ToolOutcome } from "../../../../infra/tool-outcome.js";

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
