import { isRecord } from "../../../../infra/record.js"
import type { EventPayload } from "../../../../infra/event-store-types.js"
import { parseWorkflowQueueFact } from "../../../../workflows/view/view-facts.js"
import { migrateFactVersions, unreadableWhenRefused, type FactMigrationResult, type FactUpgrade } from "../../../migrations/engine.js"
import { rebuildQueueFactWithBodyList, rebuildWorkflowCompiledWithBodyList } from "./loop-body-rows.js"

interface UnknownRecord {
  readonly [key: string]: unknown
}

const STEP_ROW_CONTENT_ID_MIGRATION_ID = "step-row-content-id-v1"

/** The member a step row named its model seat by before steps carried their
 *  own content. */
const RETIRED_KEY = "skillId"

/** Queue-fact versions this pass upgrades. Event-store maintenance reads them so
 *  that it never deletes queue history the workspace upgrade path can still bring
 *  forward. */
export const STEP_ROW_CONTENT_ID_QUEUE_UPGRADES: readonly FactUpgrade[] = [
  { type: "queue.created", fromVersion: 7, rebuild: rebuildQueueFactWithContentId("queue.created") },
  { type: "queue.mutated", fromVersion: 7, rebuild: rebuildQueueFactWithContentId("queue.mutated") },
  { type: "queue.plan.changed", fromVersion: 1, rebuild: rebuildQueuePlanWithContentId },
]

/** Name the seat of every recorded step row by `contentId` in place of
 *  `skillId`: the queue steps, the planned steps, and the compiled steps.
 *
 *  Representation only. Since steps carry their own content, the member holds
 *  the content id of the step, and the content id of a step whose binding
 *  named a skill is that skill id. So the value moves to the new member byte
 *  for byte and states nothing the row did not already say.
 *
 *  A row that is unreadable for another reason keeps its bytes and its
 *  version, as the retired-self-review pass keeps one, so readers report it as
 *  they did before.
 *
 *  This pass runs after the retired-child-ask-user pass and before every pass
 *  that reads queue rows through the current strict parsers: the
 *  definition-identity chain rewrites the same rows.
 *  Remove after 2027-04-30. */
export function migrateStepRowContentId(dbFile: string): FactMigrationResult {
  return migrateFactVersions(dbFile, STEP_ROW_CONTENT_ID_MIGRATION_ID, [
    ...STEP_ROW_CONTENT_ID_QUEUE_UPGRADES,
    { type: "workflow.compiled", fromVersion: 6, rebuild: rebuildWorkflowCompiled },
  ].map(unreadableWhenRefused))
}

/** Rebuild one queue fact at the current version. The loop-body-rows rebuild
 *  that follows records each loop body as one list and parses the row
 *  strictly, which is what proves the migrated row is readable. The earlier
 *  queue passes rebuild their older rows through this too, so a row of any
 *  earlier version lands on the current one. */
export function rebuildQueueFactWithContentId(type: "queue.created" | "queue.mutated") {
  const rebuildCurrent = rebuildQueueFactWithBodyList(type)
  return (payload: EventPayload, storedActor: string) => rebuildCurrent(queuePayloadWithContentId(type, payload), storedActor)
}

function queuePayloadWithContentId(type: string, payload: unknown): UnknownRecord {
  if (!isRecord(payload)) throw new Error(`${type} payload is not a record`)
  if (type === "queue.created") {
    const { queue } = payload
    if (!isRecord(queue)) throw new Error("queue.created payload records no queue")
    return { ...payload, queue: { ...queue, steps: rowsWithContentId(type, queue.steps) } }
  }
  if (!("insertedSteps" in payload)) return payload
  return { ...payload, insertedSteps: rowsWithContentId(type, payload.insertedSteps) }
}

function rebuildQueuePlanWithContentId(payload: EventPayload, storedActor: string) {
  if (!isRecord(payload) || !isRecord(payload.plan)) throw new Error("queue.plan.changed payload records no plan")
  const migrated = parseWorkflowQueueFact({
    type: "queue.plan.changed",
    version: 2,
    actor: storedActor,
    payload: { ...payload, plan: { ...payload.plan, steps: rowsWithContentId("queue.plan.changed", payload.plan.steps) } },
  })
  return { version: migrated.version, actor: migrated.actor, payload: migrated.payload }
}

function rebuildWorkflowCompiled(payload: EventPayload, storedActor: string) {
  if (!isRecord(payload)) throw new Error("workflow.compiled payload is not a record")
  return rebuildWorkflowCompiledWithBodyList({ ...payload, steps: rowsWithContentId("workflow.compiled", payload.steps) }, storedActor)
}

function rowsWithContentId(type: string, rows: unknown): readonly UnknownRecord[] {
  if (!Array.isArray(rows)) throw new Error(`${type} payload records no steps`)
  return rows.map((row: unknown) => {
    if (!isRecord(row)) throw new Error(`${type} payload records a malformed step`)
    const { [RETIRED_KEY]: seat, ...kept } = row
    if (typeof seat !== "string") throw new Error(`${type} payload records a step with no ${RETIRED_KEY}`)
    return { ...kept, contentId: seat }
  })
}
