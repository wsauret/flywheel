import { Schema } from "effect"
import { DefinitionProvenanceSchema } from "../../../../workflows/definition-provenance.js"
import { migrateFactVersions, type FactMigrationResult } from "../../../migrations/engine.js"

const DEFINITION_LOADED_HANDOFF_FILENAME_MIGRATION_ID = "definition-loaded-handoff-filename-v1"

/** The one field version 2 could carry that no definition record has. A workflow
 *  handoff is a typed event, so no path ever read this name. */
const LEGACY_HANDOFF_FILENAME_KEY = "handoffFilename"

/** Version-2 `definition.loaded` payload. The recorded definition is typed loose
 *  on purpose: it is the byte shape of a workflow or step definition as the build
 *  that wrote it defined them, and no reader may hold today's schemas over
 *  yesterday's rows. */
const DefinitionLoadedV2PayloadSchema = Schema.Struct({
  kind: Schema.Union([Schema.Literal("workflow"), Schema.Literal("step")]),
  id: Schema.String,
  definition: Schema.Record(Schema.String, Schema.Unknown),
  provenance: Schema.optionalKey(DefinitionProvenanceSchema),
})

const ActorSchema = Schema.Literal("flywheel")

/** Drop the retired handoff filename from historical step snapshots so the
 *  strict reader parses them again. Representation only: the field named a file
 *  no handoff path wrote, so removing it states nothing new about the run. The
 *  identity chain, not this pass, is what makes a session adopt the changed
 *  definition. */
export function migrateDefinitionLoadedHandoffFilename(dbFile: string): FactMigrationResult {
  return migrateFactVersions(dbFile, DEFINITION_LOADED_HANDOFF_FILENAME_MIGRATION_ID, [
    {
      type: "definition.loaded",
      fromVersion: 2,
      rebuild: (payload, storedActor) => {
        const actor = Schema.decodeUnknownSync(ActorSchema)(storedActor)
        const legacy = Schema.decodeUnknownSync(DefinitionLoadedV2PayloadSchema, { onExcessProperty: "error" })(payload)
        const { [LEGACY_HANDOFF_FILENAME_KEY]: _retired, ...definition } = legacy.definition
        return { version: 3, actor, payload: { ...legacy, definition } }
      },
    },
  ])
}
