import { isRecord } from "../../../../infra/record.js"
import type { EventPayload } from "../../../../infra/event-store-types.js"
import { parseWorkflowQueueFact } from "../../../../workflows/view/view-facts.js"
import { migrateFactVersions, unreadableWhenRefused, type FactMigrationResult } from "../../../migrations/engine.js"

const RESUME_REVERT_ATTEMPT_ID_MIGRATION_ID = "resume-revert-attempt-id-v1"

/** Name the attempt of every recorded resume revert by `attemptId` in place
 *  of `stepId`.
 *
 *  Representation only: the member always held the attempt id, so the value
 *  moves to the new member byte for byte. Retention keeps the newest row of
 *  each attempt by `$.attemptId`. A version 1 row has no such member, so
 *  without this pass every version 1 row would group under one empty key, and
 *  retention would delete the counters of other attempts.
 *
 *  A row that is unreadable for another reason keeps its bytes and its
 *  version, so readers report it as they did before. The pass runs in the
 *  stored-facts phase, before any session opens and so before retention runs
 *  at a session's close. Remove after 2027-04-30. */
export function migrateResumeRevertAttemptId(dbFile: string): FactMigrationResult {
  return migrateFactVersions(dbFile, RESUME_REVERT_ATTEMPT_ID_MIGRATION_ID, [
    unreadableWhenRefused({ type: "step.resume_revert.recorded", fromVersion: 1, rebuild: rebuildResumeRevert }),
  ])
}

function rebuildResumeRevert(payload: EventPayload, storedActor: string) {
  if (!isRecord(payload)) throw new Error("step.resume_revert.recorded payload is not a record")
  const { stepId, ...kept } = payload
  const migrated = parseWorkflowQueueFact({ type: "step.resume_revert.recorded", version: 2, actor: storedActor, payload: { ...kept, attemptId: stepId } })
  return { version: migrated.version, actor: migrated.actor, payload: migrated.payload }
}
