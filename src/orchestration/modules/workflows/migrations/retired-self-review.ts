import { isRecord } from "../../../../infra/record.js"
import type { EventPayload } from "../../../../infra/event-store-types.js"
import { migrateFactVersions, unreadableWhenRefused, type FactMigrationResult, type FactUpgrade } from "../../../migrations/engine.js"
import { rebuildDefinitionLoadedWithoutAskUser, rebuildQueueFactWithoutAskUser, rebuildWorkflowCompiledWithoutAskUser } from "./retired-child-ask-user.js"

interface UnknownRecord {
  readonly [key: string]: unknown
}

/** The second id of this pass. An earlier build refused definition snapshots
 *  that the current rebuild chain reads, and the `-v1` watermark stands above
 *  those rows. A new id has no watermark, so the pass examines each upgraded
 *  family once more. */
const RETIRED_SELF_REVIEW_MIGRATION_ID = "retired-self-review-v2"

/** The binding policy key this pass removes. It switched a review pass that a
 *  step's first valid handoff had to survive, and that pass no longer exists. */
const RETIRED_KEY = "selfReview"

/** Queue-fact versions this pass upgrades. Event-store maintenance reads them so
 *  that it never deletes queue history the workspace upgrade path can still bring
 *  forward. */
export const RETIRED_SELF_REVIEW_QUEUE_UPGRADES: readonly FactUpgrade[] = [
  { type: "queue.created", fromVersion: 5, rebuild: rebuildQueueFactWithoutSelfReview("queue.created") },
  { type: "queue.mutated", fromVersion: 5, rebuild: rebuildQueueFactWithoutSelfReview("queue.mutated") },
]

/** Remove the retired `selfReview` policy from every recorded queue step,
 *  compiled step, and workflow binding snapshot.
 *
 *  Representation only. The key named whether a step ran the self-review pass,
 *  which Flywheel removed, so no reader can act on it and dropping it states
 *  nothing new about the run. A session's definition identity still pins the
 *  hashes it recorded; the retired-self-review identity migration, not this
 *  pass, is what lets a paused workflow adopt bindings without the key.
 *
 *  A row that is unreadable for another reason stays as it is. Older builds
 *  wrote rows that today's strict parser already refused before this pass
 *  existed, such as a queue step with a tool scope key that no build defined.
 *  Removing `selfReview` cannot make such a row readable, and refusing it
 *  here would block the project from opening, so it keeps its bytes and its
 *  version and readers report it as they did before.
 *
 *  This pass runs before every pass that reads these families through the
 *  current strict parsers.
 *  Remove this conversion after 2026-12-03. */
export function migrateRetiredSelfReview(dbFile: string): FactMigrationResult {
  return migrateFactVersions(dbFile, RETIRED_SELF_REVIEW_MIGRATION_ID, [
    ...RETIRED_SELF_REVIEW_QUEUE_UPGRADES,
    { type: "workflow.compiled", fromVersion: 3, rebuild: rebuildWorkflowCompiled },
    { type: "definition.loaded", fromVersion: 4, rebuild: rebuildDefinitionLoaded },
  ].map(unreadableWhenRefused))
}

/** Rebuild one queue fact at the current version. The retired-child-ask-user
 *  rebuild that follows removes the later retired key and parses the row
 *  strictly, which is what proves the migrated row is readable. The
 *  queue-step-skill-id pass rebuilds its older rows through this too, so a
 *  row of any earlier version lands on the current one. */
export function rebuildQueueFactWithoutSelfReview(type: "queue.created" | "queue.mutated") {
  const rebuildCurrent = rebuildQueueFactWithoutAskUser(type)
  return (payload: EventPayload, storedActor: string) => rebuildCurrent(queuePayloadWithoutSelfReview(type, payload), storedActor)
}

function queuePayloadWithoutSelfReview(type: string, payload: unknown): UnknownRecord {
  if (!isRecord(payload)) throw new Error(`${type} payload is not a record`)
  if (type === "queue.created") {
    const { queue } = payload
    if (!isRecord(queue)) throw new Error("queue.created payload records no queue")
    return { ...payload, queue: { ...queue, steps: recordsWithoutSelfReview(type, queue.steps) } }
  }
  if (!("insertedSteps" in payload)) return payload
  return { ...payload, insertedSteps: recordsWithoutSelfReview(type, payload.insertedSteps) }
}

function rebuildWorkflowCompiled(payload: EventPayload, storedActor: string) {
  if (!isRecord(payload)) throw new Error("workflow.compiled payload is not a record")
  return rebuildWorkflowCompiledWithoutAskUser({ ...payload, steps: recordsWithoutSelfReview("workflow.compiled", payload.steps) }, storedActor)
}

function rebuildDefinitionLoaded(payload: EventPayload, storedActor: string) {
  if (!isRecord(payload) || !isRecord(payload.definition)) throw new Error("definition.loaded payload records no definition")
  return rebuildDefinitionLoadedWithoutAskUser({ ...payload, definition: definitionWithoutSelfReview(payload.kind, payload.definition) }, storedActor)
}

/** A workflow snapshot carries the key on each binding; a binding snapshot
 *  carries it on itself; a skill snapshot never carried it. */
function definitionWithoutSelfReview(kind: unknown, definition: UnknownRecord): UnknownRecord {
  if (kind === "binding") return withoutSelfReview(definition)
  if (kind !== "workflow") return definition
  const { bindings } = definition
  if (!isRecord(bindings)) throw new Error("definition.loaded workflow snapshot records no bindings")
  return {
    ...definition,
    bindings: Object.fromEntries(Object.entries(bindings).map(([id, binding]) => {
      if (!isRecord(binding)) throw new Error(`definition.loaded workflow snapshot records a malformed binding ${id}`)
      return [id, withoutSelfReview(binding)]
    })),
  }
}

function recordsWithoutSelfReview(type: string, records: unknown): readonly UnknownRecord[] {
  if (!Array.isArray(records)) throw new Error(`${type} payload records no steps`)
  return records.map((record: unknown) => {
    if (!isRecord(record)) throw new Error(`${type} payload records a malformed step`)
    return withoutSelfReview(record)
  })
}

function withoutSelfReview(record: UnknownRecord): UnknownRecord {
  const { [RETIRED_KEY]: _retired, ...kept } = record
  return kept
}
