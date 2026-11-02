import { parseProjectionFact } from "../../../../infra/event-projection.js"
import type { StoredFact } from "../../../../infra/event-store-types.js"
import { attemptIdOf, parseWorkflowQueueFact } from "../../../../workflows/view/view-facts.js"
import { loadQueueFromEvents } from "../../../../workflows/view/view-projection.js"
import type { AttemptExecutionHistory } from "../../../module-diagnostics.js"

/** Read the retained attempt timing and conversation links without starting work.
 *  The queue projection carries each attempt's timing; every conversation an
 *  attempt ever ran in links back to it, not only its latest one. */
export function readAttemptExecutionHistory(events: readonly StoredFact[]): AttemptExecutionHistory | undefined {
  const queue = loadQueueFromEvents(events)
  if (!queue) return undefined
  const conversationToAttempt = new Map<string, string>()
  for (const attempt of queue.attempts) if (attempt.lastConversationId) conversationToAttempt.set(attempt.lastConversationId, attempt.id)
  for (const event of events) {
    if (event.type !== "step.resume_state.recorded") continue
    const fact = parseProjectionFact(event, parseWorkflowQueueFact)
    if (fact.type !== "step.resume_state.recorded" || fact.payload.conversationId === null) continue
    conversationToAttempt.set(fact.payload.conversationId, attemptIdOf(fact))
  }
  return { attempts: queue.attempts, conversationToAttempt }
}
