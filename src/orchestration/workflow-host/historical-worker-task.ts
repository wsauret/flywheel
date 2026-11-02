import { CorruptEventRowError, type AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { contextlessRecoveryRoot } from "../../workflows/context-bundle/context-recovery.js"
import { workflowAggregateId } from "../../workflows/vm/session-facts.js"
import { parseConversationTreeFact } from "../session/conversation/conversation-facts.js"

/** Return the immutable root id only for the old operator-only worker-tree
 * producer. Publication positions prove the four-fact batch even when a newer
 * complete root owns current context. This read never publishes or salvages
 * task text; the worker's already assembled prompt remains its only source. */
export async function historicalWorkerTaskRootId(
  reader: AsyncEventStateReadSurface,
  sessionId: string,
  attemptId: string,
  conversationId: string,
): Promise<string | null> {
  const { facts: [created, appended] } = await reader.readSlice({ aggregateId: `conversation:${conversationId}`, order: "asc", limit: 2 }, true)
  if (!created || !appended || created instanceof CorruptEventRowError || appended instanceof CorruptEventRowError
    || created.seq !== 0 || appended.seq !== 1 || appended.position !== created.position + 1) return null
  try {
    const tree = parseConversationTreeFact({ type: created.type, version: created.version, actor: created.actor, payload: created.payload })
    const initial = parseConversationTreeFact({ type: appended.type, version: appended.version, actor: appended.actor, payload: appended.payload })
    if (tree.type !== "chat.tree.created" || tree.version !== 1 || tree.payload.conversationId !== conversationId
      || initial.type !== "chat.entries.appended" || initial.version !== 1 || initial.payload.conversationId !== conversationId
      || initial.payload.entries.length !== 1) return null
    const [entry] = initial.payload.entries
    if (!entry || entry.kind !== "message" || entry.parentId !== null || entry.timestamp !== tree.payload.createdAt
      || "displayOnly" in entry || "followUpRequestSequence" in entry
      || entry.message.kind !== "user" || typeof entry.message.content !== "string"
      || "origin" in entry.message || "invocation" in entry.message) return null
  } catch {
    return null
  }

  const { facts: [event, evidence] } = await reader.readSlice({
    aggregateId: workflowAggregateId(sessionId), sessionId,
    positions: [created.position - 2, created.position - 1],
  }, true)
  if (!event || !evidence || event instanceof CorruptEventRowError || evidence instanceof CorruptEventRowError
    || event.position !== created.position - 2 || evidence.position !== created.position - 1) return null
  const root = contextlessRecoveryRoot(event, evidence)
  if (!root) return null
  const { identities, control } = root.payload
  if (identities.attempt?.source !== "synthesized" || identities.attempt.value !== attemptId
    || identities.conversation?.source !== "synthesized" || identities.conversation.value !== conversationId
    || identities.workflow.value !== control.definitionIdentity.workflowDefinitionId) return null
  const attempt = control.attempts.find(({ id }) => id === attemptId)
  if (!attempt || attempt.conversationId !== conversationId || identities.step?.value !== attempt.logicalNodeId
    || attempt.workflowDefinitionId !== identities.workflow.value || attempt.state._tag !== "pending"
    || attempt.provenance._tag !== "retry" || attempt.parentAttemptId === null
    || attempt.handoff !== null || attempt.priorRetryFeedback !== null) return null
  return event.id
}
