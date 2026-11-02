import { Schema } from "effect"
import { memoryWriteActor } from "../../../../workflows/memory/memory-fact-writers.js"
import type { MemoryWrittenFact } from "../../../../workflows/memory/memory-facts.js"
import { LearningScopeSchema } from "../../../../infra/learning-scope.js"
import { migrateFactVersions, type FactMigrationResult } from "../../../migrations/engine.js"

export const MEMORY_WRITTEN_MIGRATION_ID = "memory-written-v3"

/** The historical target vocabulary: `memory` was the project store and `user`
 *  was the global store. One reach vocabulary (ARCH-LEARNING-005) replaced both. The
 *  version-1 review fact recorded the same words, so its upgrade reads this map
 *  rather than restating it. */
export const LEGACY_MEMORY_TARGET_REACH = { memory: "project", user: "global" } as const

const MemoryActionSchema = Schema.Literals(["add", "replace", "remove", "batch"])

const MemoryOriginSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("review"), reviewRunId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("agent"), sessionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("user") }),
])

const MemoryWrittenV1PayloadSchema = Schema.Struct({
  target: Schema.Literals(["memory", "user"]),
  action: MemoryActionSchema,
  origin: MemoryOriginSchema,
  contentHash: Schema.String,
})

/** Version 2 adopted the reach vocabulary. Within its lifetime the audit
 *  journal started preparing write identities without a version bump, so
 *  `mutationId` is present on late version-2 facts and absent on early ones. */
const MemoryWrittenV2PayloadSchema = Schema.Struct({
  target: LearningScopeSchema,
  action: MemoryActionSchema,
  origin: MemoryOriginSchema,
  mutationId: Schema.optionalKey(Schema.String),
  contentHash: Schema.String,
})

/** Identity a legacy fact carries into version 3. A prepared identity is kept
 *  as the recorded case; a fact that never carried one states the adopted case
 *  explicitly, so no strict reader has to bridge an absent field. */
function adoptedIdentity(mutationId: string | undefined): MemoryWrittenFact["payload"]["identity"] {
  return mutationId === undefined ? { kind: "adopted_v1" } : { kind: "recorded", mutationId }
}

/** Adopt the reach vocabulary and the explicit write-identity union in
 *  historical `memory.written` facts before any strict reader opens the
 *  store. */
export function migrateMemoryWrittenFacts(dbFile: string): FactMigrationResult {
  return migrateFactVersions(dbFile, MEMORY_WRITTEN_MIGRATION_ID, [
    {
      type: "memory.written",
      fromVersion: 1,
      rebuild: (payload) => {
        const legacy = Schema.decodeUnknownSync(MemoryWrittenV1PayloadSchema, { onExcessProperty: "error" })(payload)
        const migrated: MemoryWrittenFact["payload"] = {
          target: LEGACY_MEMORY_TARGET_REACH[legacy.target],
          action: legacy.action,
          origin: legacy.origin,
          identity: adoptedIdentity(undefined),
          contentHash: legacy.contentHash,
        }
        return { version: 3, actor: memoryWriteActor(legacy.origin), payload: migrated }
      },
    },
    {
      type: "memory.written",
      fromVersion: 2,
      rebuild: (payload) => {
        const legacy = Schema.decodeUnknownSync(MemoryWrittenV2PayloadSchema, { onExcessProperty: "error" })(payload)
        const { mutationId, ...kept } = legacy
        const migrated: MemoryWrittenFact["payload"] = { ...kept, identity: adoptedIdentity(mutationId) }
        return { version: 3, actor: memoryWriteActor(legacy.origin), payload: migrated }
      },
    },
  ])
}
