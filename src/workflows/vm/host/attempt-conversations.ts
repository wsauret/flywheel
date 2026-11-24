import { createEventProjection, parseProjectionFact, type EventProjection } from "../../../infra/projection/event-projection.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../../infra/store/event-store-types.js"
import { heldProjection } from "../../../infra/projection/projection-registry.js"
import { workflowProjectionBoundary } from "../../run/session-fact-source.js"
import type { CommittedWorkflowControl } from "../facts/committed-control.js"
import { committedWorkflowEvent, parseWorkflowSessionFact, workflowAggregateId } from "../facts/session-facts.js"

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

/** The conversations that each attempt of a workflow started in, by attempt
 *  id, oldest first. A context overflow clears an attempt's conversation
 *  from control, and this record keeps it. */
export type AttemptStarts = ReadonlyMap<string, readonly string[]>

export async function readAttemptStarts(reader: AsyncEventStateReadSurface, workflowId: string): Promise<AttemptStarts> {
  return (await startedConversations(reader, workflowId).replay()).byAttempt
}

/** One attempt as control or the view holds it: `lastConversationId` is its
 *  current conversation, which names a start that precedes a recovery root. */
interface HeldAttempt { readonly id: string; readonly lastConversationId?: string }

/** The conversation that an attempt started in last, whose session runs it. */
export function startedConversation(starts: AttemptStarts, attempt: HeldAttempt): string | undefined {
  return starts.get(attempt.id)?.at(-1) ?? attempt.lastConversationId
}

/** The attempt that each agent session serves, by the session's
 *  conversation: the latest attempt, in run order, that started in it. A
 *  reopened agent continues in its failed attempt's conversation, so one
 *  session serves each of its attempts in turn, also after an overflow moved
 *  the reopened attempt to a new conversation. */
export function servedAttempts(starts: AttemptStarts, attempts: readonly HeldAttempt[]): Map<string, string> {
  const served = new Map<string, string>()
  for (const attempt of attempts) {
    const conversationId = startedConversation(starts, attempt)
    if (conversationId !== undefined) served.set(conversationId, attempt.id)
  }
  return served
}

/** Every conversation in which the tool calls of one attempt ran, oldest
 *  first and each once: each conversation that a start of the attempt
 *  committed, and before them those of each earlier attempt that a retry or
 *  a continuation of it replaced, whose edits stay on disk. A reopened
 *  attempt runs in the conversation of the attempt that it reopened. An
 *  attempt that control does not hold has none. Store read failures and
 *  unreadable commits propagate. */
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
  return [...new Set(chain)]
}
