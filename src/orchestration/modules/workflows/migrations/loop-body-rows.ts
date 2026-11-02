import { isRecord } from "../../../../infra/record.js"
import type { EventPayload } from "../../../../infra/event-store-types.js"
import { parseDefinitionProvenanceFact } from "../../../../workflows/definition-provenance-facts.js"
import { parseWorkflowQueueFact } from "../../../../workflows/view/view-facts.js"
import { migrateFactVersions, unreadableWhenRefused, type FactMigrationResult, type FactUpgrade } from "../../../migrations/engine.js"

interface UnknownRecord {
  readonly [key: string]: unknown
}

const LOOP_BODY_ROWS_MIGRATION_ID = "loop-body-rows-v1"

/** Queue-fact versions this pass upgrades. Event-store maintenance reads them so
 *  that it never deletes queue history the workspace upgrade path can still bring
 *  forward. */
export const LOOP_BODY_ROWS_QUEUE_UPGRADES: readonly FactUpgrade[] = [
  { type: "queue.created", fromVersion: 8, rebuild: rebuildQueueFactWithBodyList("queue.created") },
  { type: "queue.mutated", fromVersion: 8, rebuild: rebuildQueueFactWithBodyList("queue.mutated") },
]

/** Record the body of every while step row as one ordered list of its steps:
 *  the queue steps and the compiled steps.
 *
 *  Representation only. A row recorded before loop chains existed named a
 *  body of at most two steps as `do` and an optional `then`, so the list is
 *  `do` followed by `then` and states nothing the row did not already say.
 *
 *  A row that is unreadable for another reason keeps its bytes and its
 *  version, as the retired-self-review pass keeps one, so readers report it as
 *  they did before.
 *
 *  This pass runs after the step-row-content-id pass and before every pass
 *  that reads queue rows through the current strict parsers: the
 *  definition-identity chain rewrites the same rows.
 *  Remove after 2027-04-30. */
export function migrateLoopBodyRows(dbFile: string): FactMigrationResult {
  return migrateFactVersions(dbFile, LOOP_BODY_ROWS_MIGRATION_ID, [
    ...LOOP_BODY_ROWS_QUEUE_UPGRADES,
    { type: "workflow.compiled", fromVersion: 7, rebuild: rebuildWorkflowCompiledWithBodyList },
  ].map(unreadableWhenRefused))
}

/** Rebuild one queue fact at the current version through the current strict
 *  parser, which is what proves the migrated row is readable. The earlier
 *  queue passes rebuild their older rows through this too, so a row of any
 *  earlier version lands on the current one. */
export function rebuildQueueFactWithBodyList(type: "queue.created" | "queue.mutated") {
  return (payload: EventPayload, storedActor: string) => {
    const migrated = parseWorkflowQueueFact({
      type,
      version: 9,
      actor: storedActor,
      payload: queuePayloadWithBodyList(type, payload),
    })
    return { version: migrated.version, actor: migrated.actor, payload: migrated.payload }
  }
}

/** Rebuild one compiled-step fact at version 8, the last version that
 *  recorded no worst case and no verifier result. Neither can be derived
 *  again from the row, so the rebuilt row stays a v8 row. The
 *  step-row-content-id pass hands its rows here too. */
export function rebuildWorkflowCompiledWithBodyList(payload: EventPayload, storedActor: string) {
  if (!isRecord(payload)) throw new Error("workflow.compiled payload is not a record")
  const migrated = parseDefinitionProvenanceFact({
    type: "workflow.compiled",
    version: 8,
    actor: storedActor,
    payload: { ...payload, steps: rowsWithBodyList("workflow.compiled", payload.steps) },
  })
  return { version: migrated.version, actor: migrated.actor, payload: migrated.payload }
}

function queuePayloadWithBodyList(type: string, payload: unknown): UnknownRecord {
  if (!isRecord(payload)) throw new Error(`${type} payload is not a record`)
  if (type === "queue.created") {
    const { queue } = payload
    if (!isRecord(queue)) throw new Error("queue.created payload records no queue")
    return { ...payload, queue: { ...queue, steps: rowsWithBodyList(type, queue.steps) } }
  }
  if (!("insertedSteps" in payload)) return payload
  return { ...payload, insertedSteps: rowsWithBodyList(type, payload.insertedSteps) }
}

function rowsWithBodyList(type: string, rows: unknown): readonly UnknownRecord[] {
  if (!Array.isArray(rows)) throw new Error(`${type} payload records no steps`)
  return rows.map((row: unknown) => {
    if (!isRecord(row)) throw new Error(`${type} payload records a malformed step`)
    if (row.loop === undefined) return row
    const { loop } = row
    if (!isRecord(loop) || !isRecord(loop.body)) throw new Error(`${type} payload records a malformed step loop`)
    const { do: first, then } = loop.body
    return { ...row, loop: { ...loop, body: then === undefined ? [first] : [first, then] } }
  })
}
