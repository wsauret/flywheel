import { HashMap, Option } from "effect"
import type { AsyncEventReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { createEventProjection } from "../../infra/event-projection.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { SESSION_FORK_FACT_TYPES, reduceSessionForkEvent, type SessionForkRecord } from "./session-fork-projection.js"

interface SessionForks {
  readonly forks: StringMap<SessionForkRecord>
  readonly errors: readonly string[]
}

// `type` (not `interface`) so the shape carries the implicit index signature
// a projection state requires.
type WorkspaceForksState = { bySession: HashMap.HashMap<string, SessionForks> }

function sessionOf(event: StoredFact): string | undefined {
  return event.aggregateId === `session:${event.sessionId}` ? event.sessionId : undefined
}

function withSession(state: WorkspaceForksState, event: StoredFact, change: (current: SessionForks) => SessionForks): WorkspaceForksState {
  const sessionId = sessionOf(event)
  if (sessionId === undefined) return state
  const current = Option.getOrUndefined(HashMap.get(state.bySession, sessionId)) ?? { forks: {}, errors: [] }
  return { bySession: HashMap.set(state.bySession, sessionId, change(current)) }
}

/** Every session's fork records, folded once and then advanced. The catalog
 *  reads forks on each usage change of a listed session, so a read per
 *  session from its first fact would grow with both the session count and
 *  the history. */
function workspaceForks(store: AsyncEventReadSurface) {
  return heldProjection(store, "session-forks", () => createEventProjection<WorkspaceForksState>(store, {
    name: "session-forks",
    factTypes: SESSION_FORK_FACT_TYPES,
    initialState: () => ({ bySession: HashMap.empty<string, SessionForks>() }),
    reduce: (state, event) => withSession(state, event, (current) => ({
      ...current,
      forks: reduceSessionForkEvent({ forksByTarget: current.forks }, event).forksByTarget,
    })),
    // An unreadable fork fact stays scoped to the session that holds it.
    reduceUnreadableFact: (state, event, violation) => withSession(state, event, (current) => ({
      ...current,
      errors: [...current.errors, violation.message],
    })),
  }))
}

/** Fork records of `sessionIds`. Invalid facts remain scoped to their session;
 * store failures propagate instead of returning an incomplete summary. */
export async function readForks(sessionIds: readonly string[], store: AsyncEventReadSurface) {
  const { bySession } = await workspaceForks(store).replay()
  const forks: StringMap<SessionForkRecord> = {}
  const errors: { sessionId: string; scope: "fork"; reason: string }[] = []
  for (const sessionId of sessionIds) {
    const recorded = Option.getOrUndefined(HashMap.get(bySession, sessionId))
    if (recorded === undefined) continue
    Object.assign(forks, recorded.forks)
    for (const reason of recorded.errors) errors.push({ sessionId, scope: "fork", reason })
  }
  return { forks, errors }
}
interface StringMap<T> { [key: string]: T }
