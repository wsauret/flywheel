import { createEventProjection, parseProjectionFact, type EventProjection } from "../../infra/event-projection.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { workflowProjectionBoundary } from "../session-fact-source.js"
import type { CommittedWorkflowControl } from "./committed-control.js"
import { committedWorkflowEvent, parseWorkflowSessionFact, workflowAggregateId } from "./session-facts.js"

interface StartedConversationsState {
  /** Each attempt's conversations in the order of the commits that started
   *  them, without repeats. */
  readonly byAttempt: ReadonlyMap<string, readonly string[]>
}

function initialState(): StartedConversationsState {
  return { byAttempt: new Map() }
}

function reduceStarted(state: StartedConversationsState, stored: StoredFact): StartedConversationsState {
  const fact = parseProjectionFact(stored, parseWorkflowSessionFact)
  if (fact.type !== "workflow.control.committed") return state
  const event = committedWorkflowEvent(fact)
  if (event.type !== "ATTEMPT_STARTED") return state
  const known = state.byAttempt.get(event.attemptId) ?? []
  if (known.includes(event.conversationId)) return state
  return { byAttempt: new Map(state.byAttempt).set(event.attemptId, [...known, event.conversationId]) }
}

/** The conversation of every start of every attempt in the session's current
 *  workflow family. Committed control keeps only an attempt's latest
 *  conversation: a context overflow clears it, and the resumed run starts a
 *  new one. Each start commits its conversation, so this fold keeps them all. */
function startedConversations(reader: AsyncEventStateReadSurface, sessionId: string): EventProjection<StartedConversationsState> {
  const aggregateId = workflowAggregateId(sessionId)
  return heldProjection(reader, `workflow-attempt-conversations:${sessionId}`, () => createEventProjection(reader, {
    aggregateId,
    factTypes: ["workflow.control.committed"],
    resetBoundary: workflowProjectionBoundary(reader, aggregateId),
    initialState,
    reduce: reduceStarted,
  }))
}

/** Every conversation in which the tool calls of one attempt ran, oldest
 *  first: each conversation that a start of the attempt committed, and before
 *  them those of each earlier attempt that a retry of it replaced, whose edits
 *  stay on disk. An attempt that control does not hold has none. Store read
 *  failures and unreadable commits propagate. */
export async function attemptConversations(
  reader: AsyncEventStateReadSurface,
  sessionId: string,
  control: Pick<CommittedWorkflowControl, "attempts">,
  attemptId: string,
): Promise<readonly string[]> {
  const { byAttempt } = await startedConversations(reader, sessionId).replay()
  const byId = new Map(control.attempts.map((attempt) => [attempt.id, attempt]))
  const chain: string[] = []
  const visited = new Set<string>()
  for (let attempt = byId.get(attemptId); attempt !== undefined && !visited.has(attempt.id);) {
    visited.add(attempt.id)
    // A recovery root can hold an attempt whose start precedes the family.
    const own = [...byAttempt.get(attempt.id) ?? []]
    if (attempt.conversationId !== null && !own.includes(attempt.conversationId)) own.push(attempt.conversationId)
    chain.unshift(...own)
    attempt = (attempt.provenance._tag === "retry" || attempt.provenance._tag === "continuation") && attempt.parentAttemptId !== null ? byId.get(attempt.parentAttemptId) : undefined
  }
  return chain
}
