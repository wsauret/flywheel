import type { AsyncEventReadSurface, StoredFact } from "../../../infra/event-store-types.js"
import { InvariantViolation } from "../../../infra/invariant.js"
import { createEventProjection } from "../../../infra/event-projection.js"
import { heldProjection } from "../../../infra/projection-registry.js"
import { parsePapercutFact, type PapercutCategory } from "./facts.js"

interface LivePapercut {
  readonly recordedFactId: string
  readonly owningSessionId: string
  readonly position: number
  readonly timestamp: number
  readonly observation: string
  readonly category?: PapercutCategory
  readonly conversationId: string
  readonly modelRequestId: string
  readonly toolUseId: string
  readonly parentToolUseId?: string
}

export interface PapercutBacklog {
  readonly live: readonly LivePapercut[]
  readonly count: number
}

export const PAPERCUT_FACT_TYPES = ["papercut.recorded", "papercut.disposed"] as const

interface PapercutProjectionState {
  readonly entries: Map<string, LivePapercut>
  readonly terminal: Set<string>
}

export interface PapercutBacklogProjection {
  snapshot(): PapercutBacklog
  replay(): Promise<PapercutBacklog>
  apply(event: StoredFact): Promise<PapercutBacklog>
}

export function projectPapercutBacklog(events: readonly StoredFact[]): PapercutBacklog {
  const state = initialState()
  for (const event of [...events].sort((left, right) => left.position - right.position)) reduce(state, event)
  return backlog(state)
}

export function createPapercutBacklogProjection(reader: AsyncEventReadSurface): PapercutBacklogProjection {
  const projection = heldProjection(reader, "papercut-backlog", () => createEventProjection(reader, {
    name: "papercut-backlog",
    factTypes: PAPERCUT_FACT_TYPES,
    initialState,
    reduce,
  }))
  return {
    snapshot: () => backlog(projection.getState()),
    replay: async () => backlog(await projection.replay()),
    apply: async (event) => backlog(await projection.apply(event)),
  }
}

function initialState(): PapercutProjectionState {
  return { entries: new Map(), terminal: new Set() }
}

function reduce(state: PapercutProjectionState, event: StoredFact): PapercutProjectionState {
  if (event.type !== "papercut.recorded" && event.type !== "papercut.disposed") return state
  const fact = parsePapercutFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })

  if (fact.type === "papercut.recorded") {
    if (!event.aggregateId.startsWith("session:") || event.aggregateId !== `session:${event.sessionId}`) {
      throw violation(event, "papercut.recorded must belong to its session aggregate")
    }
    if (state.entries.has(event.id) || state.terminal.has(event.id)) throw violation(event, `duplicate papercut ${event.id}`)
    state.entries.set(event.id, {
      recordedFactId: event.id,
      owningSessionId: event.sessionId,
      position: event.position,
      timestamp: event.timestamp,
      observation: fact.payload.observation,
      ...(fact.payload.category ? { category: fact.payload.category } : {}),
      conversationId: fact.payload.conversationId,
      modelRequestId: fact.payload.modelRequestId,
      toolUseId: fact.payload.toolUseId,
      ...(fact.payload.parentToolUseId ? { parentToolUseId: fact.payload.parentToolUseId } : {}),
    })
    return state
  }

  const target = fact.payload.recordedFactId
  if (state.terminal.has(target)) throw violation(event, `papercut ${target} is already terminal`)
  if (!state.entries.delete(target)) throw violation(event, `disposition references unknown papercut ${target}`)
  state.terminal.add(target)
  return state
}

function backlog(state: PapercutProjectionState): PapercutBacklog {
  const live = [...state.entries.values()]
  return { live, count: live.length }
}

function violation(event: StoredFact, detail: string): InvariantViolation {
  return new InvariantViolation({ kind: "orphan-event", eventType: event.type, eventPosition: event.position, aggregateId: event.aggregateId, detail })
}
