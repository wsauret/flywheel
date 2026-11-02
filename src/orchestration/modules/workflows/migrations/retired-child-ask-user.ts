import { isRecord } from "../../../../infra/record.js"
import type { EventPayload } from "../../../../infra/event-store-types.js"
import { parseDefinitionProvenanceFact } from "../../../../workflows/definition-provenance-facts.js"
import { migrateFactVersions, unreadableWhenRefused, type FactMigrationResult, type FactUpgrade } from "../../../migrations/engine.js"
import { rebuildQueueFactWithContentId } from "./step-row-content-id.js"

interface UnknownRecord {
  readonly [key: string]: unknown
}

const RETIRED_CHILD_ASK_USER_MIGRATION_ID = "retired-child-ask-user-v1"

/** The tool scope key this pass removes. It granted a workflow step the
 *  question tool, which only a root chat has now (PI-AGENT-024). */
const RETIRED_KEY = "ask_user"

/** Queue-fact versions this pass upgrades. Event-store maintenance reads them so
 *  that it never deletes queue history the workspace upgrade path can still bring
 *  forward. */
export const RETIRED_CHILD_ASK_USER_QUEUE_UPGRADES: readonly FactUpgrade[] = [
  { type: "queue.created", fromVersion: 6, rebuild: rebuildQueueFactWithoutAskUser("queue.created") },
  { type: "queue.mutated", fromVersion: 6, rebuild: rebuildQueueFactWithoutAskUser("queue.mutated") },
]

/** Remove the retired `ask_user` tool scope from every recorded queue step,
 *  compiled step, and workflow binding snapshot.
 *
 *  Representation only. The key granted a step a tool that no step has now,
 *  so no reader can act on it and dropping it states nothing new about the
 *  run. A session's definition identity still pins the hashes it recorded;
 *  the retired-child-ask-user identity migration, not this pass, is what lets
 *  a paused workflow adopt bindings without the key.
 *
 *  A row that is unreadable for another reason keeps its bytes and its
 *  version, as the retired-self-review pass keeps one, so readers report it as
 *  they did before.
 *
 *  This pass runs after the retired-self-review pass and before every pass
 *  that reads these families through the current strict parsers.
 *  Remove this conversion after 2027-04-03. */
export function migrateRetiredChildAskUser(dbFile: string): FactMigrationResult {
  return migrateFactVersions(dbFile, RETIRED_CHILD_ASK_USER_MIGRATION_ID, [
    ...RETIRED_CHILD_ASK_USER_QUEUE_UPGRADES,
    { type: "workflow.compiled", fromVersion: 4, rebuild: rebuildWorkflowCompiledWithoutAskUser },
    { type: "definition.loaded", fromVersion: 5, rebuild: rebuildDefinitionLoadedWithoutAskUser },
  ].map(unreadableWhenRefused))
}

/** Rebuild one queue fact at the current version. The step-row-content-id
 *  rebuild that follows renames the seat member and parses the row strictly,
 *  which is what proves the migrated row is readable. The earlier queue passes
 *  rebuild their older rows through this too, so a row of any earlier version
 *  lands on the current one. */
export function rebuildQueueFactWithoutAskUser(type: "queue.created" | "queue.mutated") {
  const rebuildCurrent = rebuildQueueFactWithContentId(type)
  return (payload: EventPayload, storedActor: string) => rebuildCurrent(queuePayloadWithoutAskUser(type, payload), storedActor)
}

function queuePayloadWithoutAskUser(type: string, payload: unknown): UnknownRecord {
  if (!isRecord(payload)) throw new Error(`${type} payload is not a record`)
  if (type === "queue.created") {
    const { queue } = payload
    if (!isRecord(queue)) throw new Error("queue.created payload records no queue")
    return { ...payload, queue: { ...queue, steps: recordsWithoutAskUser(type, queue.steps) } }
  }
  if (!("insertedSteps" in payload)) return payload
  return { ...payload, insertedSteps: recordsWithoutAskUser(type, payload.insertedSteps) }
}

/** Rebuild one compiled-step fact at the current version. The retired
 *  self-review pass hands its rows here too. */
export function rebuildWorkflowCompiledWithoutAskUser(payload: EventPayload, storedActor: string) {
  if (!isRecord(payload)) throw new Error("workflow.compiled payload is not a record")
  const migrated = parseDefinitionProvenanceFact({
    type: "workflow.compiled",
    version: 5,
    actor: storedActor,
    payload: { ...payload, steps: recordsWithoutAskUser("workflow.compiled", payload.steps) },
  })
  return { version: migrated.version, actor: migrated.actor, payload: migrated.payload }
}

/** Rebuild one definition snapshot at the current version. The retired
 *  self-review pass hands its rows here too. */
export function rebuildDefinitionLoadedWithoutAskUser(payload: EventPayload, storedActor: string) {
  if (!isRecord(payload) || !isRecord(payload.definition)) throw new Error("definition.loaded payload records no definition")
  const migrated = parseDefinitionProvenanceFact({
    type: "definition.loaded",
    version: 6,
    actor: storedActor,
    payload: { ...payload, definition: definitionWithoutAskUser(payload.kind, payload.definition) },
  })
  return { version: migrated.version, actor: migrated.actor, payload: migrated.payload }
}

/** A workflow snapshot carries the key in each binding's tool scope; a
 *  binding snapshot carries it in its own; a skill snapshot never carried it. */
function definitionWithoutAskUser(kind: unknown, definition: UnknownRecord): UnknownRecord {
  if (kind === "binding") return withoutAskUser(definition)
  if (kind !== "workflow") return definition
  const { bindings } = definition
  if (!isRecord(bindings)) throw new Error("definition.loaded workflow snapshot records no bindings")
  return {
    ...definition,
    bindings: Object.fromEntries(Object.entries(bindings).map(([id, binding]) => {
      if (!isRecord(binding)) throw new Error(`definition.loaded workflow snapshot records a malformed binding ${id}`)
      return [id, withoutAskUser(binding)]
    })),
  }
}

function recordsWithoutAskUser(type: string, records: unknown): readonly UnknownRecord[] {
  if (!Array.isArray(records)) throw new Error(`${type} payload records no steps`)
  return records.map((record: unknown) => {
    if (!isRecord(record)) throw new Error(`${type} payload records a malformed step`)
    return withoutAskUser(record)
  })
}

function withoutAskUser(record: UnknownRecord): UnknownRecord {
  const { toolScoping } = record
  if (!isRecord(toolScoping)) return record
  const { [RETIRED_KEY]: _retired, ...kept } = toolScoping
  return { ...record, toolScoping: kept }
}
