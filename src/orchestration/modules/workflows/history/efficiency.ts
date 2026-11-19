import { parseProjectionFact } from "../../../../infra/event-projection.js"
import type { StoredFact } from "../../../../infra/event-store-types.js"
import { attemptIdOf, parseWorkflowQueueFact } from "../../../../workflows/view/view-facts.js"
import { loadQueueFromEvents } from "../../../../workflows/view/view-projection.js"
import type { AttemptExecutionHistory, ConversationAttemptStart } from "../../../module-diagnostics.js"

/** Read the retained attempt timing and conversation links without starting work.
 *  The queue projection carries each attempt's timing; every conversation an
 *  attempt ever ran in links back to it, not only its latest one, and each
 *  start in a conversation records its time. */
export function readAttemptExecutionHistory(events: readonly StoredFact[]): AttemptExecutionHistory | undefined {
  const queue = loadQueueFromEvents(events)
  if (!queue) return undefined
  const conversationAttempts = new Map<string, readonly ConversationAttemptStart[]>()
  for (const event of events) {
    if (event.type !== "step.resume_state.recorded") continue
    const fact = parseProjectionFact(event, parseWorkflowQueueFact)
    if (fact.type !== "step.resume_state.recorded" || fact.payload.conversationId === null) continue
    const starts = conversationAttempts.get(fact.payload.conversationId) ?? []
    const attemptId = attemptIdOf(fact)
    if (starts.at(-1)?.attemptId !== attemptId) conversationAttempts.set(fact.payload.conversationId, [...starts, { attemptId, startedAt: event.timestamp }])
  }
  // A row can name a conversation whose start precedes the retained facts.
  for (const attempt of queue.attempts) {
    if (attempt.lastConversationId && !conversationAttempts.has(attempt.lastConversationId)) {
      conversationAttempts.set(attempt.lastConversationId, [{ attemptId: attempt.id, startedAt: attempt.startedAt ?? 0 }])
    }
  }
  return { attempts: queue.attempts, conversationAttempts }
}
