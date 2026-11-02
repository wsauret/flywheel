import { Schema } from "effect"
import { parseSubagentRunFact } from "../facts.js"
import { migrateFactVersions, type FactMigrationResult } from "../../../migrations/engine.js"

export const SUBAGENT_PROMPT_MIGRATION_ID = "subagent-prompt-task-v3"

const SubagentPromptV1PayloadSchema = Schema.Struct({
  childRunId: Schema.String,
  prompt: Schema.String,
  systemPrompt: Schema.String,
  toolNames: Schema.Array(Schema.String),
})

// Version 2 rows were written under two names for the same field: the
// terminology change of 2026-08-17 renamed `taskInstructions` to `task`
// without advancing the version. Exactly one of the two must be present.
const SubagentPromptV2PayloadSchema = Schema.Struct({
  childRunId: Schema.String,
  prompt: Schema.String,
  task: Schema.optionalKey(Schema.String),
  taskInstructions: Schema.optionalKey(Schema.String),
  toolNames: Schema.Array(Schema.String),
})

/** Adopt every earlier `subagent.prompted` shape into version 3 before strict
 *  projections read it. The payload carries no actor evidence of its own, so
 *  the upgrade proves the stored actor by parsing the rebuilt fact against the
 *  strict registry schema. Remove after 2027-03-17, when no store written
 *  before that date is expected to open under this release. */
export function migrateSubagentPromptTaskInstructions(dbFile: string): FactMigrationResult {
  const rebuild = (legacy: { childRunId: string; prompt: string; toolNames: readonly string[] }, task: string, storedActor: string) => {
    const migrated = parseSubagentRunFact({
      type: "subagent.prompted",
      version: 3,
      actor: storedActor,
      payload: { childRunId: legacy.childRunId, prompt: legacy.prompt, task, toolNames: legacy.toolNames },
    })
    return { version: migrated.version, actor: migrated.actor, payload: migrated.payload }
  }
  return migrateFactVersions(dbFile, SUBAGENT_PROMPT_MIGRATION_ID, [
    {
      type: "subagent.prompted",
      fromVersion: 1,
      rebuild: (payload, storedActor) => {
        const legacy = Schema.decodeUnknownSync(SubagentPromptV1PayloadSchema, { onExcessProperty: "error" })(payload)
        return rebuild(legacy, legacy.systemPrompt, storedActor)
      },
    },
    {
      type: "subagent.prompted",
      fromVersion: 2,
      rebuild: (payload, storedActor) => {
        const legacy = Schema.decodeUnknownSync(SubagentPromptV2PayloadSchema, { onExcessProperty: "error" })(payload)
        const task = legacy.task ?? legacy.taskInstructions
        if (task === undefined || (legacy.task !== undefined && legacy.taskInstructions !== undefined)) {
          throw new Error("subagent.prompted@2 must carry exactly one of task or taskInstructions")
        }
        return rebuild(legacy, task, storedActor)
      },
    },
  ])
}
