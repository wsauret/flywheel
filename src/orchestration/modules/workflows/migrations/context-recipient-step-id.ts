import { isRecord } from "../../../../infra/record.js"
import { parseWorkflowContextFact } from "../../../../workflows/context-bundle/context-facts.js"
import { migrateFactVersions, type FactMigrationResult } from "../../../migrations/engine.js"

const CONTEXT_RECIPIENT_STEP_ID_MIGRATION_ID = "context-recipient-step-id-v1"
const CURRENT_CONTEXT_ACCUMULATED_VERSION = 4

/** Address historical ordinary handoffs to no specific attempt.
 *
 * Version 3 predates targeted blocker reports. Its entries were visible to the
 * next runnable attempt, which version 4 states as `recipientStepId: null`.
 * The fact upgrade is transactional and validates every rebuilt row through the
 * current strict parser before it writes anything. */
export function migrateContextRecipientStepId(dbFile: string): FactMigrationResult {
  return migrateFactVersions(dbFile, CONTEXT_RECIPIENT_STEP_ID_MIGRATION_ID, [{
    type: "context.accumulated",
    fromVersion: 3,
    rebuild: (payload, storedActor) => {
      if (!isRecord(payload) || !isRecord(payload.entry)) {
        throw new Error("context.accumulated payload records no entry")
      }
      if ("recipientStepId" in payload.entry) {
        throw new Error("context.accumulated@3 cannot record a recipient step id")
      }
      const entry = { ...payload.entry, recipientStepId: null }
      const migrated = parseWorkflowContextFact({
        type: "context.accumulated",
        version: CURRENT_CONTEXT_ACCUMULATED_VERSION,
        actor: storedActor,
        payload: { ...payload, entry },
      })
      return { version: migrated.version, actor: migrated.actor, payload: migrated.payload }
    },
  }])
}
