import { Schema } from "effect"
import { skillWriteActor, type SkillReviewCompletedFact, type SkillWrittenFact } from "../../../../workflows/skill-facts.js"
import { LEGACY_MEMORY_TARGET_REACH } from "./memory-written.js"
import { migrateFactVersions, type FactMigrationResult } from "../../../migrations/engine.js"

export const SKILL_REACH_MIGRATION_ID = "skill-facts-reach-v1"

/** The historical store vocabulary of `skill.written`: `user` named the global
 *  store's directory, `project` the project store's. Reach is now the recorded
 *  fact (ARCH-LEARNING-005), and `user` is only a directory name. */
const LEGACY_ROOT_REACH = { user: "global", project: "project" } as const

const OriginV1Schema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("review"), reviewRunId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("agent"), sessionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({ kind: Schema.Literal("pruner") }),
])

/** Version 1 knew no promotion, no prepared mutation identity, and no
 *  whole-package identity: it recorded the physical root and the written
 *  file's hash. */
const SkillWrittenV1PayloadSchema = Schema.Struct({
  name: Schema.String,
  action: Schema.Literals(["created", "updated", "patched", "support_file", "file_removed", "archived", "restored"]),
  root: Schema.Literals(["user", "project"]),
  origin: OriginV1Schema,
  contentHash: Schema.String,
  description: Schema.String,
})

/** Version 1 recorded no reach per action and could not recommend a global
 *  change. A memory action carried the legacy memory target as its name, which
 *  is exactly the reach the action wrote. */
const SkillReviewCompletedV1PayloadSchema = Schema.Struct({
  reviewRunId: Schema.String,
  sessionId: Schema.String,
  trigger: Schema.Literals(["iterations", "turns", "manual"]),
  halves: Schema.Array(Schema.Literals(["memory", "skill"])),
  model: Schema.String,
  actions: Schema.Array(Schema.Struct({
    surface: Schema.Literals(["skill", "memory"]),
    name: Schema.String,
    action: Schema.String,
  })),
  durationMs: Schema.Int,
  outcome: Schema.Literals(["acted", "nothing_to_save", "failed"]),
  costUsd: Schema.optionalKey(Schema.Number),
  inputTokens: Schema.optionalKey(Schema.Int),
  outputTokens: Schema.optionalKey(Schema.Int),
  cacheReadTokens: Schema.optionalKey(Schema.Int),
})

/** Adopt the reach vocabulary in historical skill facts before any strict
 *  reader opens the store. The upgrade adds no identity a version-1 writer
 *  never prepared: it states the adopted-version-1 case explicitly, and
 *  `skills:why` reports it as unrecorded rather than as an empty hash. */
export function migrateSkillFactReach(dbFile: string): FactMigrationResult {
  return migrateFactVersions(dbFile, SKILL_REACH_MIGRATION_ID, [
    {
      type: "skill.written",
      fromVersion: 1,
      rebuild: (payload) => {
        const legacy = Schema.decodeUnknownSync(SkillWrittenV1PayloadSchema, { onExcessProperty: "error" })(payload)
        const migrated: SkillWrittenFact["payload"] = {
          name: legacy.name,
          action: legacy.action,
          reach: LEGACY_ROOT_REACH[legacy.root],
          origin: legacy.origin,
          identity: { kind: "adopted_v1" },
          contentHash: legacy.contentHash,
          description: legacy.description,
        }
        return { version: 2, actor: skillWriteActor(legacy.origin), payload: migrated }
      },
    },
    {
      type: "skill.review.completed",
      fromVersion: 1,
      rebuild: (payload) => {
        const legacy = Schema.decodeUnknownSync(SkillReviewCompletedV1PayloadSchema, { onExcessProperty: "error" })(payload)
        const migrated: SkillReviewCompletedFact["payload"] = {
          ...legacy,
          actions: legacy.actions.map(migrateReviewAction),
          // A version-1 review had no recommendation action, so it truly
          // proposed none.
          recommendations: [],
        }
        return { version: 2, actor: "agent", payload: migrated }
      },
    },
  ])
}

type LegacyReviewAction = typeof SkillReviewCompletedV1PayloadSchema.Type["actions"][number]
type ReviewAction = SkillReviewCompletedFact["payload"]["actions"][number]

/** A version-1 memory action named the legacy store, which is exactly the reach
 *  it wrote. A skill action recorded no reach at all, so it adopts the explicit
 *  version-1 case rather than a guess. */
function migrateReviewAction(action: LegacyReviewAction): ReviewAction {
  if (action.surface !== "memory") return { ...action, reach: "adopted_v1" }
  const reach = action.name === "memory" ? LEGACY_MEMORY_TARGET_REACH.memory : action.name === "user" ? LEGACY_MEMORY_TARGET_REACH.user : undefined
  if (reach !== "project" && reach !== "global") {
    throw new Error(`review memory action names store "${action.name}"; version 1 recorded only "memory" or "user"`)
  }
  return { ...action, name: reach, reach }
}
