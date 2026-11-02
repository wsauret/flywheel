import { createEventProjection } from "../../infra/event-projection.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { CorruptEventRowError, type AsyncEventReadSurface, type EventStoreReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import type { MessageProducer } from "../../infra/chat-input.js"
import { reduceSessionMetadataEvent } from "./session-metadata-projection.js"

export interface SessionMessageSources {
  readonly workflows: Set<string>
  readonly agents: Map<string, string | null>
}

function initialSources(): SessionMessageSources {
  return { workflows: new Set(), agents: new Map() }
}

function sourceKey(workflowId: string, conversationId: string): string {
  return JSON.stringify([workflowId, conversationId])
}

function reduceSources(state: SessionMessageSources, event: StoredFact): SessionMessageSources {
  // Remove legacy workflow sender recovery after 2027-10-17, with the session.created v5 decoder.
  const session = reduceSessionMetadataEvent({ sessions: {}, deleted: {}, errors: {} }, event).sessions[event.sessionId]
  if (!session) return state
  if (session.kind === "workflow") {
    state.workflows.add(event.sessionId)
    return state
  }
  if (session.kind !== "workflow-agent") return state
  const key = sourceKey(session.workflowMembership.workflowId, session.importedResources?.conversationId ?? session.conversationId)
  const previous = state.agents.get(key)
  state.agents.set(key, previous === undefined || previous === event.sessionId ? event.sessionId : null)
  return state
}

/** Historical sender identity is derived from immutable member creation, never a workflow's current seat. */
export function sessionMessageSources(reader: AsyncEventReadSurface) {
  return heldProjection(reader, "session-message-sources", () => createEventProjection(reader, {
    factTypes: ["session.created"], initialState: initialSources, reduce: reduceSources,
    reduceCorruptRow: (state) => state,
    draft: (state) => ({ workflows: new Set(state.workflows), agents: new Map(state.agents) }),
  }))
}

/** Startup and historical snapshots use the same sender recovery as live conversation reads.
 * The returned read folds only the creations committed since its previous call, so a
 * migration that converts many workflows and creates their agent sessions as it goes
 * decodes each session creation once, not once per workflow. */
export function sessionMessageSourcesSync(reader: EventStoreReadSurface): () => SessionMessageSources {
  let state = initialSources()
  let through = 0
  return () => {
    for (const event of reader.readTolerant({ types: ["session.created"], afterPosition: through })) {
      if (!(event instanceof CorruptEventRowError)) state = reduceSources(state, event)
      through = event.position
    }
    return state
  }
}

/** Resolve only the exact historical conversation. A gap deliberately carries no agent reply address. */
export function recoverSessionMessageProducer(producer: MessageProducer | undefined, sources: SessionMessageSources): MessageProducer | undefined {
  if (producer?.kind !== "session" || !sources.workflows.has(producer.sessionId)) return producer
  const sessionId = sources.agents.get(sourceKey(producer.sessionId, producer.conversationId))
  if (sessionId) return { ...producer, sessionId }
  return { ...producer, recovery: { workflowId: producer.sessionId, reason: sessionId === null ? "ambiguous" : "unresolved" } }
}
