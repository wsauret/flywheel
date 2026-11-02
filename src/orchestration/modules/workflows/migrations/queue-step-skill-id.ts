import { isRecord } from "../../../../infra/record.js"
import { migrateFactVersions, type FactMigrationResult, type FactUpgrade } from "../../../migrations/engine.js"
import { rebuildQueueFactWithoutSelfReview } from "./retired-self-review.js"

interface UnknownRecord {
  readonly [key: string]: unknown
}

const QUEUE_STEP_SKILL_ID_MIGRATION_ID = "queue-step-skill-id-v1"

/** Queue-fact versions this pass upgrades. Event-store maintenance reads them so
 *  that it never deletes queue history the workspace upgrade path can still bring
 *  forward. */
export const QUEUE_STEP_SKILL_ID_UPGRADES: readonly FactUpgrade[] = [
  { type: "queue.created", fromVersion: 4, rebuild: rebuildQueueFact("queue.created") },
  { type: "queue.mutated", fromVersion: 4, rebuild: rebuildQueueFact("queue.mutated") },
]

/** Give every embedded queue step the skill id that names its seat.
 *
 *  Representation only. Before the unified catalog, a queue step recorded one id:
 *  `definitionId`, which was the step definition id. Phase 1 keeps ids
 *  byte-identical, so that recorded id is also the qualified skill id of the same
 *  procedure, and copying it into `skillId` states nothing the row did not
 *  already say. A row written after the member was added already carries it and
 *  keeps the recorded value. The rebuild chain then moves the value to
 *  `contentId`, the member the current step shape names the seat by.
 *
 *  This pass runs before the definition-identity chain, because the chain's
 *  catalog adoption rewrites the same queue rows and every workflow reader parses
 *  them strictly. */
export function migrateQueueStepSkillId(dbFile: string): FactMigrationResult {
  return migrateFactVersions(dbFile, QUEUE_STEP_SKILL_ID_MIGRATION_ID, QUEUE_STEP_SKILL_ID_UPGRADES)
}

/** Rebuild one legacy queue fact at the current version. A v4 row also carries
 *  the retired `selfReview` key, so the skill ids are added first and the
 *  retired-self-review rebuild then removes the key and parses the row strictly,
 *  which is what proves the migrated row is readable. A payload the parser
 *  refuses fails the whole pass instead of landing a row the reader would
 *  reject later. */
function rebuildQueueFact(type: "queue.created" | "queue.mutated") {
  const rebuildCurrent = rebuildQueueFactWithoutSelfReview(type)
  return (payload: unknown, storedActor: string) => rebuildCurrent(payloadWithSkillIds(type, payload), storedActor)
}

function payloadWithSkillIds(type: string, payload: unknown): UnknownRecord {
  if (!isRecord(payload)) throw new Error(`${type} payload is not a record`)
  if (type === "queue.created") {
    const { queue } = payload
    if (!isRecord(queue)) throw new Error("queue.created payload records no queue")
    return { ...payload, queue: { ...queue, steps: stepsWithSkillIds(type, queue.steps) } }
  }
  if (!("insertedSteps" in payload)) return payload
  return { ...payload, insertedSteps: stepsWithSkillIds(type, payload.insertedSteps) }
}

function stepsWithSkillIds(type: string, steps: unknown): readonly UnknownRecord[] {
  if (!Array.isArray(steps)) throw new Error(`${type} payload records no queue steps`)
  return steps.map((step: unknown) => {
    if (!isRecord(step)) throw new Error(`${type} payload records a malformed queue step`)
    if ("skillId" in step) return step
    if (typeof step.definitionId !== "string" || step.definitionId.length === 0) {
      throw new Error(`${type} payload records a queue step with no definition id`)
    }
    return { ...step, skillId: step.definitionId }
  })
}
