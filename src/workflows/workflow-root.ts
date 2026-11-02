import { parseProjectionFact } from "../infra/event-projection.js"
import { CorruptEventRowError, type StoredFact } from "../infra/event-store-types.js"
import { parseWorkflowSessionFact } from "./vm/session-facts.js"

export const WORKFLOW_ROOT_FACT_TYPES = ["workflow.control.initialized", "workflow.control.recovered"] as const

/** Select the newest root envelope in ordered history without decoding payloads.
 * Unsupported versions and malformed payloads remain fences, not permission to
 * reuse an older root. Unstored proposal facts have no durable coordinates. */
export function selectNewestWorkflowRoot(facts: readonly unknown[]): {
  readonly index: number
  readonly type: typeof WORKFLOW_ROOT_FACT_TYPES[number]
  readonly version: unknown
  readonly seq: number | null
  readonly position: number | null
} | null {
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const candidate = facts[index]
    const value = candidate instanceof CorruptEventRowError ? candidate.row : candidate
    if (!value || typeof value !== "object" || !("type" in value)) continue
    const type = value.type
    if (type !== "workflow.control.initialized" && type !== "workflow.control.recovered") continue
    return {
      index,
      type,
      version: "version" in value ? value.version : undefined,
      seq: "seq" in value && typeof value.seq === "number" ? value.seq : null,
      position: "position" in value && typeof value.position === "number" ? value.position : null,
    }
  }
  return null
}

/** Validate the selected root before reading a workflow family. Only recovery
 * replaces family state: a normal launch can seed input before initialization.
 * A malformed or unsupported newest root throws a positioned InvariantViolation;
 * unreadable JSON preserves its CorruptEventRowError. */
export function workflowFamilyBoundary(events: readonly (StoredFact | CorruptEventRowError)[]): StoredFact | null {
  const root = selectNewestWorkflowRoot(events)
  if (!root) return null
  // SAFETY: selectNewestWorkflowRoot returns an index within this unchanged event array.
  const event = events[root.index]!
  if (event instanceof CorruptEventRowError) throw event
  parseProjectionFact(event, parseWorkflowSessionFact)
  return root.type === "workflow.control.recovered" ? event : null
}

/** Select family history before decoding any potentially superseded payload. */
export function workflowFamilyEvents(events: readonly StoredFact[]): readonly StoredFact[] {
  const boundary = workflowFamilyBoundary(events)
  return boundary ? events.filter((event) => event.position > boundary.position) : events
}
