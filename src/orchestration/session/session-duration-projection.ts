import { parseProjectionFact, reduceEvents } from "../../infra/event-projection.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { parseSessionRuntimeFact } from "./session-runtime-event-types.js"

export type SessionDurationProjectionState = {
  accumulatedActiveMs: number
}

export const SESSION_DURATION_FACT_TYPES = ["session.duration.recorded"] as const

/** Read the superseding duration fact through the owning asynchronous state port.
 * Store and strict fact-decoding failures propagate to the caller. */
export async function readSessionDurationFromReader(reader: AsyncEventStateReadSurface, sessionId: string): Promise<SessionDurationProjectionState> {
  const events = await reader.readLatestByAggregateAndTypes(`session:${sessionId}`, SESSION_DURATION_FACT_TYPES)
  return reduceEvents(events, {
    factTypes: SESSION_DURATION_FACT_TYPES,
    initialState,
    reduce: reduceSessionDurationEvent,
  })
}

function initialState(): SessionDurationProjectionState {
  return { accumulatedActiveMs: 0 }
}

export function reduceSessionDurationEvent(state: SessionDurationProjectionState, event: StoredFact): SessionDurationProjectionState {
  const fact = parseProjectionFact(event, parseSessionRuntimeFact)
  switch (fact.type) {
    case "session.duration.recorded":
      return { accumulatedActiveMs: fact.payload.accumulatedActiveMs }
    default:
      return state
  }
}
