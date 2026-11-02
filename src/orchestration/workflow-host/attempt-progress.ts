import { parseProjectionFact } from "../../infra/event-projection.js"
import { CorruptEventRowError, type AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { readConversationCheckpoint, renderConversationCheckpoint } from "../session/conversation-checkpoint.js"
import { parseConversationTreeFact } from "../session/conversation/conversation-facts.js"
import { workflowMembershipReader } from "../session/workflow-membership.js"

/** The conversations of `since` that recorded a complete assistant message,
 *  which is a model response that a provider served, strictly after the
 *  workspace position given for each. The loop records an aborted, an
 *  overflowed, or a failed response as incomplete, and it does not count.
 *  One read serves every conversation. An unreadable row proves no response.
 *  Store read failures propagate. */
export async function conversationsWithServedResponse(reader: AsyncEventStateReadSurface, since: ReadonlyMap<string, number>): Promise<ReadonlySet<string>> {
  if (since.size === 0) return new Set()
  const { facts } = await reader.readSlice({
    aggregateIds: [...since.keys()].map((conversationId) => `conversation:${conversationId}`),
    types: ["chat.entries.appended"],
    afterPosition: Math.min(...since.values()),
  }, true)
  const served = new Set<string>()
  for (const stored of facts) {
    if (stored instanceof CorruptEventRowError) continue
    const fact = parseProjectionFact(stored, parseConversationTreeFact)
    if (fact.type !== "chat.entries.appended" || stored.position <= (since.get(fact.payload.conversationId) ?? Number.POSITIVE_INFINITY)) continue
    if (fact.payload.entries.some((entry) => entry.kind === "message" && entry.message.kind === "assistant" && entry.message.incomplete !== true)) served.add(fact.payload.conversationId)
  }
  return served
}

/** The rendered latest checkpoint of one conversation of a workflow agent,
 *  which the member session that ran the conversation owns, or null when
 *  the conversation recorded none or its member session was deleted. */
export async function memberConversationCheckpoint(reader: AsyncEventStateReadSurface, workflowId: string, conversationId: string): Promise<string | null> {
  const member = (await workflowMembershipReader(reader).list(workflowId)).find((candidate) => candidate.conversationId === conversationId)
  if (!member) return null
  const checkpoint = await readConversationCheckpoint(reader, { kind: "session", sessionId: member.sessionId }, conversationId)
  return checkpoint ? renderConversationCheckpoint(checkpoint) : null
}
