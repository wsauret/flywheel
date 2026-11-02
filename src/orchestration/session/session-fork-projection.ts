import { parseProjectionFact } from "../../infra/event-projection.js"
import type { StoredFact } from "../../infra/event-store-types.js"
import { parseSessionForkFact, type ForkSelection } from "./session-fork-facts.js"

export interface SessionForkRecord {
  eventId: string
  eventPosition: number
  timestamp: number
  sourceSessionId: string
  targetSessionId: string
  selection: ForkSelection
  sourceEventPrefixPosition: number
  copiedEntryCount: number
  copiedRootEntryId?: string
  copiedLeafEntryId?: string
  publishedAt: string
}

// `type` (not `interface`) so the shape carries the implicit index signature
// a projection state requires.
export type SessionForkProjectionState = {
  forksByTarget: StringMap<SessionForkRecord>
}

export const SESSION_FORK_FACT_TYPES = ["session.forked"] as const

export function reduceSessionForkEvent(
  state: SessionForkProjectionState,
  event: StoredFact,
): SessionForkProjectionState {
  const fact = parseProjectionFact(event, parseSessionForkFact)
  return {
    forksByTarget: {
      ...state.forksByTarget,
      [fact.payload.targetSessionId]: {
        eventId: event.id,
        eventPosition: event.position,
        timestamp: event.timestamp,
        ...fact.payload,
      },
    },
  }
}
interface StringMap<T> { [key: string]: T }
