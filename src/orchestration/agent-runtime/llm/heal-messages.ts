/**
 * Unified pre-send invariant pass over canonical ConversationMessage[] history.
 *
 * Every provider converter calls this before building its wire payload. The
 * rules are the intersection of all four vendor protocols (Anthropic Messages,
 * OpenAI Responses, OpenAI Chat Completions, Google Generative AI), emitted in
 * the strictest common shape so the same healed history is valid everywhere.
 * Vendor-specific shaping (Anthropic tool_result grouping and cache_control,
 * OpenAI image follow-ups, Google functionResponse naming) stays in the
 * converters; Anthropic's post-conversion assert verifies this pass did its
 * job.
 *
 * 1. Skip assistant turns with `stopReason === "error"`; they're partial
 *    (reasoning without message, tool calls without arguments) and replaying
 *    them causes API errors on all providers. Aborted turns ARE replayed:
 *    the loop tombstones their tool calls at abort time. Aborted turns that
 *    reach us without tombstones fall back to rule 3's generic synthesis
 *    (or the interrupted register when `stopReason` survived in memory;
 *    persistence drops it).
 *
 * 2. Drop toolResults no vendor accepts: orphans (no matching `tool_use` in
 *    the immediately preceding assistant turn) and duplicates (a second
 *    result for an already-answered id). Replace matching error results whose
 *    text is blank and which have no image with a non-empty tombstone.
 *
 * 3. Synthesize an error `toolResult` for every `tool_use` that lacks a
 *    matching result, placed before the next non-toolResult message. Without
 *    this, Anthropic rejects with "tool_use ids were found without
 *    tool_result blocks"; Google rejects with "function call without
 *    response"; OpenAI errors on unmatched function/tool calls.
 */

import { Log } from "../../../infra/log.js";
import type { ConversationMessage } from "./types.js";

const log = Log.create({ service: "heal-messages" });

type ToolResultMessage = Extract<ConversationMessage, { kind: "toolResult" }>;

/** A tool_use awaiting its result. Matching, synthesis, and the durable
 *  session-tree repair all key on the canonical `block.id`; wire-specific
 *  call ids (`providerCallId`) are mapped inside the one converter that
 *  needs them (OpenAI Responses). */
interface PendingToolUse {
  id: string;
  name: string;
  satisfied: boolean;
}
interface PendingToolUses { uses: PendingToolUse[]; aborted: boolean }

/** The one sentence a tombstone carries, wherever it is built: the turn
 *  dispatcher synthesizes a `ToolResult` with it, this module and the session
 *  tree's adjacency repair build canonical messages with it. */
export function interruptedToolText(name: string): string {
  return `Tool '${name}' was interrupted before a result was recorded.`;
}

/** Tombstone for a tool call that was interrupted before a result was
 *  recorded. Single source of truth for the tombstone shape: synthesized by
 *  `healConversation` for aborted turns replayed without tombstones, and
 *  injected by the session tree's durable-layer adjacency repair. */
export function interruptedToolResult(use: { id: string; name: string }): ToolResultMessage {
  return {
    kind: "toolResult",
    toolUseId: use.id,
    isError: true,
    interrupted: true,
    content: [{ type: "text", text: interruptedToolText(use.name) }],
  };
}

export function healConversation(history: ConversationMessage[]): ConversationMessage[] {
  const result: ConversationMessage[] = [];
  let pending: PendingToolUses = { uses: [], aborted: false };

  const flushPending = (): void => {
    const synthesized = unsatisfiedToolResults(pending);
    // Structural evidence only: the branch is live in production and must stay
    // observable without exposing tool identity, arguments, or message content.
    if (synthesized.length > 0) {
      log.warn("synthesized dangling tool results", { synthesized: synthesized.length, aborted: pending.aborted });
    }
    result.push(...synthesized);
    pending = { uses: [], aborted: false };
  };

  for (const message of history) {
    if (message.kind === "assistant") {
      // Pending orphans from a prior assistant turn close out before this one.
      flushPending();

      if (message.stopReason === "error" && !message.incomplete) continue;

      pending = pendingToolUses(message);
      result.push(message);
      continue;
    }

    if (message.kind === "toolResult") {
      const use = markPendingSatisfied(pending, message.toolUseId);
      if (use) result.push(repairEmptyErrorToolResult(use, message));
      continue;
    }

    if (message.kind === "user") {
      flushPending();
      result.push(message);
      continue;
    }

    result.push(message);
  }

  // Conversation ends with unresolved tool calls; synthesize now.
  flushPending();

  return result;
}

function pendingToolUses(message: Extract<ConversationMessage, { kind: "assistant" }>): PendingToolUses {
  const toolUses: PendingToolUse[] = [];
  if (typeof message.content !== "string") {
    for (const block of message.content) {
      if (block.type === "tool_use") toolUses.push({ id: block.id, name: block.name, satisfied: false });
    }
  }
  return { uses: toolUses, aborted: message.stopReason === "aborted" };
}

function markPendingSatisfied(pending: Pick<PendingToolUses, "uses">, toolUseId: string): PendingToolUse | null {
  const match = pending.uses.find((use) => use.id === toolUseId);
  if (!match || match.satisfied) return null;
  match.satisfied = true;
  return match;
}

function repairEmptyErrorToolResult(use: PendingToolUse, message: ToolResultMessage): ToolResultMessage {
  const hasContent = message.content.some((part) => part.type === "image" || part.text.trim().length > 0);
  if (!message.isError || hasContent) return message;
  if (message.interrupted) return interruptedToolResult(use);
  return {
    ...message,
    isError: true,
    content: [{ type: "text", text: `Tool '${use.name}' returned no result content.` }],
  };
}

function unsatisfiedToolResults(pending: PendingToolUses): ToolResultMessage[] {
  const results: ToolResultMessage[] = [];
  for (const use of pending.uses) {
    if (use.satisfied) continue;
    results.push(
      pending.aborted
        ? interruptedToolResult(use)
        : { kind: "toolResult", toolUseId: use.id, isError: true, content: [{ type: "text", text: "No result provided" }] },
    );
  }
  return results;
}
