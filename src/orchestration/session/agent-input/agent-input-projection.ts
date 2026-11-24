import { createEventProjection, type EventProjection } from "../../../infra/projection/event-projection.js"
import { heldProjection } from "../../../infra/projection/projection-registry.js"
import { CorruptEventRowError, type AsyncEventReadSurface, type StoredFact } from "../../../infra/store/event-store-types.js"
import { yieldToNextTask } from "../../../infra/task-scheduling.js"
import { InvariantViolation } from "../../../infra/invariant.js"
import type { DegradedBlock, QuestionEntry } from "../../../infra/output-blocks.js"
import type { AgentInputAnswer } from "../../../protocol/session/question-protocol-types.js"
import type { AgentInputDecision, AgentInputFact } from "./agent-input-facts.js"
import { AGENT_INPUT_FACT_TYPES, parseAgentInputFact } from "./agent-input-facts.js"

interface AgentInputOpen {
  readonly interactionId: string
  readonly conversationId: string
  readonly toolUseId: string
  readonly request: readonly QuestionEntry[]
  readonly decision?: AgentInputDecision
  readonly openedAt: number
}

export type AgentInputEntry =
  | (AgentInputOpen & { readonly kind: "pending" })
  | (AgentInputOpen & { readonly kind: "answered"; readonly answers: StringMap<AgentInputAnswer>; readonly terminalAt: number; readonly consumedBy?: string })
  | (AgentInputOpen & { readonly kind: "cancelled"; readonly reason: string; readonly terminalAt: number })
  | (AgentInputOpen & { readonly kind: "withdrawn"; readonly reason: Extract<AgentInputFact, { type: "agent_input.withdrawn" }>["payload"]["reason"]; readonly terminalAt: number })
  | (AgentInputOpen & { readonly kind: "unreadable"; readonly gaps: readonly [DegradedBlock, ...DegradedBlock[]] })

interface AgentInputHistory {
  readonly entries: ReadonlyMap<string, AgentInputEntry>
  /** Facts with no readable request to anchor them. Only primary session history displays these. */
  readonly gaps: readonly DegradedBlock[]
}

interface AgentInputProjectionState extends AgentInputHistory {
  readonly unreadablePrecursors: ReadonlyMap<string, "request" | "answer">
}

export interface AgentInputSnapshot extends AgentInputHistory {
  readonly position: number
}

export interface AgentInputCursorReader {
  replay(): Promise<AgentInputSnapshot>
}

/** Read-only historical fold. Decode failures carry source provenance, never answer authority.
 * Readable duplicate and orphan facts still violate the family's structural contract. */
function reduceAgentInputEvent(state: AgentInputProjectionState, event: StoredFact): AgentInputProjectionState {
  const entries = new Map(state.entries)
  const gaps = [...state.gaps]
  const unreadablePrecursors = new Map(state.unreadablePrecursors)
  // A stored answer can outlive a damaged request, and its guarded consumption
  // can outlive a damaged answer. These links carry no executable authority.
  function degrade(damaged: StoredFact, failureClass: DegradedBlock["failureClass"]): void {
    const gap: DegradedBlock = {
      kind: "degraded",
      id: `agent-input:${damaged.id}`,
      factFamily: "agent_input",
      failureClass,
      eventType: damaged.type,
      eventVersion: damaged.version,
      eventPosition: damaged.position,
      notice: "Part of this transcript could not be displayed.",
      timestamp: damaged.timestamp,
    }
    // Only an intact id links damage to a validated request. Malformed fields
    // never supply conversation identity or executable evidence.
    const interactionId = damaged.payload.interactionId
    const open = typeof interactionId === "string" ? entries.get(interactionId) : undefined
    if (open) {
      entries.set(open.interactionId, {
        kind: "unreadable",
        interactionId: open.interactionId,
        conversationId: open.conversationId,
        toolUseId: open.toolUseId,
        request: open.request,
        ...(open.decision ? { decision: open.decision } : {}),
        openedAt: open.openedAt,
        gaps: open.kind === "unreadable" ? [...open.gaps, gap] : [gap],
      })
    } else gaps.push(gap)
  }
  let fact: AgentInputFact
  try {
    fact = parseAgentInputFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
  } catch {
    degrade(event, "decode_failure")
    const interactionId = event.payload.interactionId
    if (typeof interactionId === "string") {
      if (event.type === "agent_input.requested") unreadablePrecursors.set(interactionId, "request")
      if (event.type === "agent_input.answered") unreadablePrecursors.set(interactionId, "answer")
    }
    return { entries, gaps, unreadablePrecursors }
  }
  const interactionId = fact.payload.interactionId
  if (fact.type === "agent_input.requested") {
    if (entries.has(interactionId)) throw violation(event, "duplicate-event", `duplicate request ${interactionId}`)
    unreadablePrecursors.delete(interactionId)
    entries.set(interactionId, {
      kind: "pending",
      interactionId,
      conversationId: fact.payload.conversationId,
      toolUseId: fact.payload.toolUseId,
      request: fact.payload.request,
      ...(fact.payload.decision ? { decision: fact.payload.decision } : {}),
      openedAt: event.timestamp,
    })
    return { entries, gaps, unreadablePrecursors }
  }
  const open = entries.get(interactionId)
  const precursor = unreadablePrecursors.get(interactionId)
  if ((!open && precursor === "request" && fact.type !== "agent_input.consumed")
    || (precursor === "answer" && fact.type === "agent_input.consumed")) {
    degrade(event, "structural_violation")
    unreadablePrecursors.delete(interactionId)
    if (fact.type === "agent_input.answered") unreadablePrecursors.set(interactionId, "answer")
    return { entries, gaps, unreadablePrecursors }
  }
  if (!open) throw violation(event, "orphan-event", `terminal fact has no request ${interactionId}`)
  if (fact.type === "agent_input.consumed") {
    if (open.kind !== "answered") throw violation(event, "orphan-event", `interaction ${interactionId} was consumed while ${open.kind}`)
    if (open.consumedBy !== undefined) throw violation(event, "duplicate-event", `interaction ${interactionId} was already consumed`)
    entries.set(interactionId, { ...open, consumedBy: fact.payload.claimId })
    return { entries, gaps, unreadablePrecursors }
  }
  if (open.kind !== "pending") throw violation(event, "duplicate-event", `interaction ${interactionId} is already terminal`)
  entries.set(interactionId, fact.type === "agent_input.answered"
    ? { ...open, kind: "answered", answers: fact.payload.answers, terminalAt: event.timestamp }
    : fact.type === "agent_input.withdrawn"
      ? { ...open, kind: "withdrawn", reason: fact.payload.reason, terminalAt: event.timestamp }
      : { ...open, kind: "cancelled", reason: fact.payload.reason, terminalAt: event.timestamp })
  return { entries, gaps, unreadablePrecursors }
}

function initialAgentInputState(): AgentInputProjectionState {
  return { entries: new Map(), gaps: [], unreadablePrecursors: new Map() }
}

function createHeldAgentInputProjection(reader: AsyncEventReadSurface, sessionId: string): EventProjection<AgentInputProjectionState> {
  return heldProjection(reader, `agent-input:${sessionId}`, () => createEventProjection(reader, {
    name: `agent-input:${sessionId}`,
    aggregateId: `session:${sessionId}`,
    factTypes: AGENT_INPUT_FACT_TYPES,
    initialState: initialAgentInputState,
    reduce: reduceAgentInputEvent,
  }))
}

export async function loadAgentInputProjection(reader: AsyncEventReadSurface, sessionId: string): Promise<ReadonlyMap<string, AgentInputEntry>> {
  return (await createHeldAgentInputProjection(reader, sessionId).replay()).entries
}

const SESSION_AGGREGATE_PREFIX = "session:"

/** The project's sessions with a pending question, closed ones included,
 *  each with the time its question opened, and the sessions whose question
 *  history could not be folded. */
export interface PendingInputBaseline {
  readonly waiting: ReadonlyMap<string, number>
  readonly unreadable: ReadonlySet<string>
}

/** One read of every session's question facts through one captured ceiling.
 *  It folds each session with the reducer that decides the dock, so the two
 *  never disagree. Damage stays inside its session (ARCH-SUBSTRATE-013): a
 *  corrupt row or a broken fact order leaves that session out of `waiting`
 *  and names it in `unreadable`, and every other session keeps its answer.
 *  A one-shot read: its caller advances the set from later facts. */
export async function loadSessionsWithPendingInput(reader: AsyncEventReadSurface): Promise<PendingInputBaseline> {
  const states = new Map<string, AgentInputProjectionState>()
  const unreadable = new Set<string>()
  const query = { aggregatePrefix: SESSION_AGGREGATE_PREFIX, types: AGENT_INPUT_FACT_TYPES }
  const upper = await reader.capturePosition()
  for (let position = 0; position < upper;) {
    const page = await reader.readPage(query, upper, position, true, "deferred")
    for (const fact of page.facts) {
      if (fact instanceof CorruptEventRowError) {
        unreadable.add(fact.sessionId)
        continue
      }
      const sessionId = fact.aggregateId.slice(SESSION_AGGREGATE_PREFIX.length)
      if (unreadable.has(sessionId)) continue
      try {
        states.set(sessionId, reduceAgentInputEvent(states.get(sessionId) ?? initialAgentInputState(), fact))
      } catch (error) {
        if (!(error instanceof InvariantViolation)) throw error
        unreadable.add(sessionId)
      }
    }
    if (page.continuationPosition === null) break
    position = page.continuationPosition
    await yieldToNextTask()
  }
  const waiting = new Map<string, number>()
  for (const [sessionId, state] of states) {
    const openedAt = unreadable.has(sessionId) ? undefined : pendingInputOpenedAt(state.entries)
    if (openedAt !== undefined) waiting.set(sessionId, openedAt)
  }
  return { waiting, unreadable }
}

/** When the question that a session's dock shows opened, or undefined when
 *  no question waits. The dock serves pending questions in the order the
 *  agent asked them, and the entries keep that order. */
function pendingInputOpenedAt(entries: ReadonlyMap<string, AgentInputEntry>): number | undefined {
  for (const entry of entries.values()) if (entry.kind === "pending") return entry.openedAt
  return undefined
}

/** One session's answer to `loadSessionsWithPendingInput`, from its held fold:
 *  when its docked question opened, or undefined when no question waits. */
export async function loadPendingInputOpenedAt(reader: AsyncEventReadSurface, sessionId: string): Promise<number | undefined> {
  return pendingInputOpenedAt(await loadAgentInputProjection(reader, sessionId))
}

/** Incrementally folds one session's question facts for transcript projection. */
export function createAgentInputCursorReader(reader: AsyncEventReadSurface, sessionId: string): AgentInputCursorReader {
  const projection = createHeldAgentInputProjection(reader, sessionId)
  return {
    async replay() {
      const state = await projection.replay()
      return { position: projection.getPosition(), entries: state.entries, gaps: state.gaps }
    },
  }
}

function violation(event: StoredFact, kind: "orphan-event" | "duplicate-event", detail: string): InvariantViolation {
  return new InvariantViolation({ kind, eventType: event.type, eventPosition: event.position, aggregateId: event.aggregateId, detail })
}
interface StringMap<T> { [key: string]: T }
