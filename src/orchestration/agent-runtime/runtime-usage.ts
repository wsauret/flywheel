import type { UsageEntry } from "../../infra/llm/usage-entry.js";
import type { RuntimeConversation } from "./runtime-conversation.js";
import { createTurnUsageTracker, type TurnUsageTracker } from "./turn-usage-tracker.js";
import type { AgentOptions } from "./types.js";
import { createProcessUsageSettlement, createSessionUsageSettlement, recoverSessionUsageSettlements, type UsageSettlement } from "./usage-settlement.js";
import type { DurableOwner } from "../../infra/durable-owner.js";

type RuntimeUsageOptions = Pick<AgentOptions, "onEvent" | "usageObserver" | "usageProfile" | "sessionEventReader" | "sessionEventStore" | "sessionEventWriter">;
type RuntimeUsageConversation = Pick<RuntimeConversation, "requestAccounting" | "sessionId" | "aggregateId" | "artifactScopeId">;

/** The usage stream that a conversation's requests charge: its request accounting's, else its session's, else its
 *  own artifact scope's. */
export function budgetStreamIdOf(conversation: Pick<RuntimeConversation, "requestAccounting" | "sessionId" | "artifactScopeId">): string {
  return conversation.requestAccounting?.streamId ?? conversation.sessionId ?? conversation.artifactScopeId;
}

/** Prepares turn accounting from its owning stream and recovers checkpoints only for a durable conversation owner.
 * Recovery failures propagate before the turn can send a provider request. */
export async function prepareRuntimeUsage(
  options: RuntimeUsageOptions,
  conversation: RuntimeUsageConversation,
  parentToolUseId?: string,
): Promise<{ usageTracker: TurnUsageTracker; usageSettlement: UsageSettlement | undefined; budgetStreamId: string }> {
  const { requestAccounting, sessionId, aggregateId } = conversation;
  const budgetStreamId = budgetStreamIdOf(conversation);
  const usageTracker = createTurnUsageTracker({ emit: options.onEvent, budgetStreamId, ...(parentToolUseId ? { parentToolUseId } : {}) });
  const commitUsage = (entry: UsageEntry, published: boolean): boolean => {
    const committed = published ? usageTracker.commitPublishedEntry(entry) : usageTracker.commitEntry(entry);
    if (committed) options.usageObserver?.(entry);
    return committed;
  };
  const commitPublishedUsage = (entry: UsageEntry): boolean => commitUsage(entry, true);
  const commitProcessUsage = (entry: UsageEntry): boolean => commitUsage(entry, false);
  const usageProfile = options.usageProfile;
  const usageReader = requestAccounting?.reader ?? options.sessionEventReader ?? options.sessionEventStore;
  const usageWriter = requestAccounting?.writer ?? options.sessionEventWriter;
  const owner: DurableOwner | undefined = requestAccounting?.owner ?? (sessionId && aggregateId ? { kind: "session", sessionId } : undefined);
  const usageSettlement = usageProfile
    ? owner && usageWriter && usageReader
      ? createSessionUsageSettlement({ owner, reader: usageReader, writer: usageWriter, acquireAuthority: usageProfile.acquireAuthority, onCommitted: commitPublishedUsage })
      : createProcessUsageSettlement({ acquireAuthority: usageProfile.acquireAuthority, onCommitted: commitProcessUsage })
    : undefined;
  if (usageSettlement && usageProfile && aggregateId && owner && usageWriter && usageReader) {
    await recoverSessionUsageSettlements({ owner, reader: usageReader, writer: usageWriter, acquireAuthority: usageProfile.acquireAuthority, onCommitted: commitPublishedUsage }, usageSettlement);
  }
  return { usageTracker, usageSettlement, budgetStreamId };
}
