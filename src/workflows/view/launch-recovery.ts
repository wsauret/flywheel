import { CorruptEventRowError, type EventStoreReadSurface } from "../../infra/event-store-types.js"
import { parseWorkflowSessionFact } from "../vm/session-facts.js"
import { workflowRowsFromV9 } from "./schemas.js"
import type { WorkflowView } from "./types.js"

/** Historical launch companions can omit the plan or tree. */
const LAUNCH_FACT_TYPES: ReadonlySet<string> = new Set(["context.input.seeded", "queue.created", "queue.plan.changed", "queue.tree.changed"])

/** A launch-only history proves that no worker has committed execution. Any
 * corrupt, duplicate launch, or execution fact refuses reconstruction. The rows
 * returned are the launch rows only, for comparison with recompiled control. */
export function readPristineWorkflowLaunch(facts: Readonly<ReturnType<EventStoreReadSurface["readTolerant"]>>): { queue: Omit<WorkflowView, "tree"> | null } | null {
  const seen = new Set<string>()
  let queue: Omit<WorkflowView, "tree"> | null = null
  for (const stored of facts) {
    if (stored instanceof CorruptEventRowError) return null
    try {
      const { type, version, actor, payload } = stored
      const fact = parseWorkflowSessionFact({ type, version, actor, payload })
      if (fact.type === "workflow.run.registered" || fact.type === "workflow.run.settings.updated" || fact.type === "workflow.run.adopted") continue
      if (!LAUNCH_FACT_TYPES.has(fact.type) || seen.has(fact.type)) return null
      seen.add(fact.type)
      if (fact.type === "queue.created") queue = fact.version === 9 ? workflowRowsFromV9(fact.payload.queue) : fact.payload.rows
    } catch {
      return null
    }
  }
  return { queue }
}
