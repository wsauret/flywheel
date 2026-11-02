import { Schema } from "effect"
import { defineFact } from "../infra/event-registry.js"
import { LearningScopeSchema, type LearningScope } from "../infra/learning-scope.js"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

// skill.written records one mutation of a managed skill package through the
// skill_manage tool. The package files are the durable artifact; the fact is
// the audit trail: who wrote (origin), which mutation at which reach, the
// identity of this one write, the content-bound proposal identity a global
// change was confirmed under, and the content identities of the written file
// and of the whole resulting package, so `skills:why <name>` can trace any
// package state to the sessions that produced it.
const SkillWriteOriginSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("review"), reviewRunId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("agent"), sessionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("user") }),
  // The deterministic lifecycle pruner (curator mechanism 1); it only archives.
  Schema.Struct({ kind: Schema.Literal("pruner") }),
])

/** Complete identity of one whole package: `SKILL.md` and every declared
 *  resource. Recorded, never recomputed, so audit evidence names the exact
 *  bytes a mutation produced. */
const PackageIdentitySchema = Schema.Struct({
  sha256: Schema.String,
  bytes: Schema.Int,
})

const CorpusIdentitySchema = Schema.Struct({
  version: Schema.Literal(1),
  sha256: Schema.String,
  bytes: NonNegativeInt,
})

const CoreManifestSchema = Schema.Array(Schema.Struct({
  id: Schema.String,
  packageIdentity: PackageIdentitySchema,
}))


/** Identity of one recorded mutation. `recorded` is the only case a writer may
 *  produce: the unique identity of this one write, the content-bound proposal
 *  identity it applied, and the whole-package identity the write left behind.
 *  The write identity is what makes the audit outbox exact. A proposal identity
 *  is content-bound, so a later write that produces the same bytes carries the
 *  same one; only the write identity can tell a replay of one write from
 *  evidence of another. `adopted_v1` is the explicit statement that a fact
 *  predates prepared identities, so a reader never has to tell an unrecorded
 *  identity from a missing field. */
const SkillWrittenIdentitySchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("recorded"),
    writeId: Schema.String,
    proposalId: Schema.String,
    packageIdentity: PackageIdentitySchema,
  }),
  Schema.Struct({ kind: Schema.Literal("adopted_v1") }),
])

const SkillWrittenFactSchema = defineFact({
  type: "skill.written",
  version: 2,
  actor: Schema.Union([Schema.Literal("agent"), Schema.Literal("user"), Schema.Literal("flywheel")]),
  payload: Schema.Struct({
    name: Schema.String,
    action: Schema.Union([
      Schema.Literal("created"),
      Schema.Literal("updated"),
      Schema.Literal("patched"),
      Schema.Literal("support_file"),
      Schema.Literal("file_removed"),
      Schema.Literal("archived"),
      Schema.Literal("restored"),
      // The project package moved into the global store under the same id.
      Schema.Literal("promoted"),
    ]),
    /** Reach of the store the mutation landed in (ARCH-LEARNING-005). */
    reach: LearningScopeSchema,
    origin: SkillWriteOriginSchema,
    identity: SkillWrittenIdentitySchema,
    /** sha256 of the written file (SKILL.md for whole-package actions). */
    contentHash: Schema.String,
    /** The trigger description after the write: the catalog's routing surface. */
    description: Schema.String,
  }),
})

const SkillLoadedFactSchema = defineFact({
  type: "skill.loaded",
  version: 1,
  actor: Schema.Literal("agent"),
  payload: Schema.Struct({ name: Schema.String }),
})

// Rebuildable prefix cache for skill-load telemetry. The tool-input facts remain
// authoritative; this snapshot only lets readers fold the unseen suffix.
const SkillLoadsSnapshottedFactSchema = defineFact({
  type: "skill.loads.snapshotted",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    throughPosition: NonNegativeInt,
    stats: Schema.Array(Schema.Struct({
      skillId: Schema.String,
      loads: PositiveInt,
      lastLoadedAt: NonNegativeInt,
    })),
  }),
})

// skill.recommendation.recorded records one background-review recommendation
// to move a project package into the global store. The review cannot write
// globally and cannot ask the user, so it records the store-prepared proposal
// identity instead: the same identity a later interactive turn prepares, asks
// with, and commits. Nothing global is written or staged by this fact, and the
// identity is also the parent conversation's delivery key.
const SkillRecommendationRecordedFactSchema = defineFact({
  type: "skill.recommendation.recorded",
  version: 1,
  actor: Schema.Literal("agent"),
  payload: Schema.Struct({
    /** Writer-prepared, content-bound identity of the recommended mutation. */
    recommendationId: Schema.String,
    name: Schema.String,
    action: Schema.Literal("promote"),
    /** Reach the recommendation would move the package to. */
    reach: LearningScopeSchema,
    origin: SkillWriteOriginSchema,
    packageIdentity: PackageIdentitySchema,
    /** The writer's own user-readable statement of the proposal. */
    summary: Schema.String,
  }),
})

// skill.operation.transitioned records one state change of a confirmed global
// skill operation: claimed, staged, hidden, published, completed, or refused.
// The durable manifest under the global store remains the sole progress
// authority - recovery reads it and never these facts - so this is audit
// evidence of what one operation did and when, and it is written only where a
// session writer exists.
const SkillOperationTransitionedFactSchema = defineFact({
  type: "skill.operation.transitioned",
  version: 1,
  actor: Schema.Literal("agent"),
  payload: Schema.Struct({
    /** Identity of the one operation this transition belongs to: the
     *  confirmation that authorized it, not the bytes it applies. Two
     *  confirmations of identical bytes are two operations with two audit
     *  trails. */
    operationId: Schema.String,
    /** Content-bound proposal identity the operation applies, shared with the
     *  confirmation and the resulting skill.written fact. */
    proposalId: Schema.String,
    name: Schema.String,
    reach: LearningScopeSchema,
    state: Schema.Literals(["claiming", "claimed", "staged", "hidden", "published", "completed", "refused"]),
    /** Why a terminal transition ended as it did, and where preserved bytes
     *  were left when a conflict prevented a rollback. */
    detail: Schema.optionalKey(Schema.String),
  }),
})

// skill.review.completed records one firing of the learning review:
// its trigger, the model that ran it, what it wrote (or that it had nothing to
// save), and its duration. The review never runs silently; this fact makes
// review frequency, act-rate, and cost attribution measurable via
// events:search even when the outcome was "nothing to save".
const SkillReviewCompletedFactSchema = defineFact({
  type: "skill.review.completed",
  version: 2,
  actor: Schema.Literal("agent"),
  payload: Schema.Struct({
    reviewRunId: Schema.String,
    sessionId: Schema.String,
    trigger: Schema.Union([Schema.Literal("iterations"), Schema.Literal("turns"), Schema.Literal("manual")]),
    /** Which halves were due and reviewed: the prompt selection. */
    halves: Schema.Array(Schema.Union([Schema.Literal("memory"), Schema.Literal("skill")])),
    model: Schema.String,
    actions: Schema.Array(Schema.Struct({
      surface: Schema.Union([Schema.Literal("skill"), Schema.Literal("memory")]),
      name: Schema.String,
      action: Schema.String,
      /** Reach the action wrote. `adopted_v1` states that the fact predates
       *  per-action reach; no writer may produce it. */
      reach: Schema.Union([LearningScopeSchema, Schema.Literal("adopted_v1")]),
    })),
    /** Global changes the review proposed instead of writing them. */
    recommendations: Schema.Array(Schema.Struct({
      recommendationId: Schema.String,
      name: Schema.String,
      action: Schema.Literal("promote"),
      reach: LearningScopeSchema,
    })),
    durationMs: Schema.Int,
    outcome: Schema.Union([Schema.Literal("acted"), Schema.Literal("nothing_to_save"), Schema.Literal("failed")]),
    /** The fork's cumulative usage totals, absent when the run died before
     *  any provider usage report landed. High cacheReadTokens against low
     *  inputTokens is the warm-replay signature; a routed (aux-model) review
     *  shows the inverse because its cache is cold. */
    costUsd: Schema.optionalKey(Schema.Number),
    inputTokens: Schema.optionalKey(Schema.Int),
    outputTokens: Schema.optionalKey(Schema.Int),
    cacheReadTokens: Schema.optionalKey(Schema.Int),
  }),
})

const HistoricalSkillCleanupClaimedFactSchema = defineFact({
  type: "skill.cleanup.claimed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ corpusIdentity: CorpusIdentitySchema, ownerId: Schema.String, token: Schema.String, claimedAt: NonNegativeInt, expiresAt: NonNegativeInt }),
})
const HistoricalSkillCleanupRenewedFactSchema = defineFact({
  type: "skill.cleanup.renewed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ corpusIdentity: CorpusIdentitySchema, ownerId: Schema.String, token: Schema.String, renewedAt: NonNegativeInt, expiresAt: NonNegativeInt }),
})
const HistoricalSkillCleanupDeferredFactSchema = defineFact({
  type: "skill.cleanup.deferred",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ corpusIdentity: CorpusIdentitySchema, ownerId: Schema.String, token: Schema.String, deferredAt: NonNegativeInt, cooldownUntil: NonNegativeInt, reason: Schema.String }),
})
const HistoricalSkillCleanupCompletedFactSchema = defineFact({
  type: "skill.cleanup.completed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ corpusIdentity: CorpusIdentitySchema, ownerId: Schema.String, token: Schema.String, completedAt: NonNegativeInt }),
})

const PreviousSkillCleanupClaimedFactSchema = defineFact({
  type: "skill.cleanup.claimed",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ coreIdentity: CorpusIdentitySchema, coreManifest: CoreManifestSchema, ownerId: Schema.String, token: Schema.String, claimedAt: NonNegativeInt, expiresAt: NonNegativeInt }),
})
const PreviousSkillCleanupRenewedFactSchema = defineFact({
  type: "skill.cleanup.renewed",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ coreIdentity: CorpusIdentitySchema, ownerId: Schema.String, token: Schema.String, renewedAt: NonNegativeInt, expiresAt: NonNegativeInt }),
})
const PreviousSkillCleanupDeferredFactSchema = defineFact({
  type: "skill.cleanup.deferred",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ coreIdentity: CorpusIdentitySchema, ownerId: Schema.String, token: Schema.String, deferredAt: NonNegativeInt, cooldownUntil: NonNegativeInt, reason: Schema.String }),
})
const PreviousSkillCleanupCompletedFactSchema = defineFact({
  type: "skill.cleanup.completed",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ coreIdentity: CorpusIdentitySchema, coreManifest: CoreManifestSchema, ownerId: Schema.String, token: Schema.String, completedAt: NonNegativeInt }),
})

const SkillCleanupClaimedFactSchema = defineFact({
  type: "skill.cleanup.claimed",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ coreIdentity: CorpusIdentitySchema, coreManifest: CoreManifestSchema, ownerId: Schema.String, token: Schema.String, forced: Schema.Boolean, claimedAt: NonNegativeInt, expiresAt: NonNegativeInt }),
})
const SkillCleanupRenewedFactSchema = defineFact({
  type: "skill.cleanup.renewed",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ coreIdentity: CorpusIdentitySchema, ownerId: Schema.String, token: Schema.String, renewedAt: NonNegativeInt, expiresAt: NonNegativeInt }),
})
const SkillCleanupDeferredFactSchema = defineFact({
  type: "skill.cleanup.deferred",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ coreIdentity: CorpusIdentitySchema, ownerId: Schema.String, token: Schema.String, deferredAt: NonNegativeInt, cooldownUntil: NonNegativeInt, reason: Schema.String }),
})
const SkillCleanupCompletedFactSchema = defineFact({
  type: "skill.cleanup.completed",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ coreIdentity: CorpusIdentitySchema, coreManifest: CoreManifestSchema, ownerId: Schema.String, token: Schema.String, completedAt: NonNegativeInt }),
})

export const SkillFactSchemas = [
  SkillLoadedFactSchema,
  SkillWrittenFactSchema,
  SkillLoadsSnapshottedFactSchema,
  SkillRecommendationRecordedFactSchema,
  SkillOperationTransitionedFactSchema,
  SkillReviewCompletedFactSchema,
  HistoricalSkillCleanupClaimedFactSchema,
  HistoricalSkillCleanupRenewedFactSchema,
  HistoricalSkillCleanupDeferredFactSchema,
  HistoricalSkillCleanupCompletedFactSchema,
  PreviousSkillCleanupClaimedFactSchema,
  PreviousSkillCleanupRenewedFactSchema,
  PreviousSkillCleanupDeferredFactSchema,
  PreviousSkillCleanupCompletedFactSchema,
  SkillCleanupClaimedFactSchema,
  SkillCleanupRenewedFactSchema,
  SkillCleanupDeferredFactSchema,
  SkillCleanupCompletedFactSchema,
] as const

const SkillFactSchema = Schema.Union(SkillFactSchemas)

/** Strictly decode one stored skill fact. Flywheel-owned state, so a row that
 *  does not decode is a producer bug and throws rather than being guessed at. */
export function parseSkillFact(value: unknown): SkillFact {
  return Schema.decodeUnknownSync(SkillFactSchema, { onExcessProperty: "error" })(value)
}

export type SkillFact = typeof SkillFactSchema.Type
export type SkillWrittenFact = typeof SkillWrittenFactSchema.Type
export type SkillLoadedFact = typeof SkillLoadedFactSchema.Type
export type SkillLoadsSnapshottedFact = typeof SkillLoadsSnapshottedFactSchema.Type
export type SkillRecommendationRecordedFact = typeof SkillRecommendationRecordedFactSchema.Type
export type SkillOperationTransitionedFact = typeof SkillOperationTransitionedFactSchema.Type
export type SkillReviewCompletedFact = typeof SkillReviewCompletedFactSchema.Type
export type SkillCleanupCompletedFact = typeof SkillCleanupCompletedFactSchema.Type

/** Record one review firing. Every action of a fact this writer produces names
 *  the reach it wrote; the adopted version-1 case is not reachable from here. */
export function skillReviewCompletedFact(
  payload: Omit<SkillReviewCompletedFact["payload"], "actions"> & {
    readonly actions: readonly (Omit<SkillReviewCompletedFact["payload"]["actions"][number], "reach"> & { readonly reach: LearningScope })[]
  },
): SkillReviewCompletedFact {
  return { type: "skill.review.completed", version: 2, actor: "agent", payload } satisfies SkillReviewCompletedFact
}

export function skillLoadedFact(payload: SkillLoadedFact["payload"]): SkillLoadedFact {
  return { type: "skill.loaded", version: 1, actor: "agent", payload } satisfies SkillLoadedFact
}

export function skillLoadsSnapshottedFact(payload: SkillLoadsSnapshottedFact["payload"]): SkillLoadsSnapshottedFact {
  return { type: "skill.loads.snapshotted", version: 1, actor: "flywheel", payload } satisfies SkillLoadsSnapshottedFact
}

/** Actor of one managed write. The origin decides it, so the current writer and
 *  the version-1 upgrade derive it the same way. */
export function skillWriteActor(origin: SkillWrittenFact["payload"]["origin"]): SkillWrittenFact["actor"] {
  return origin.kind === "user" ? "user" : origin.kind === "pruner" ? "flywheel" : "agent"
}

/** Record one landed mutation. A writer always knows the complete identity of
 *  what it wrote, so this constructor takes it directly and the payload's
 *  adopted-version-1 case stays unreachable from any write path. */
export function skillWrittenFact(
  payload: Omit<SkillWrittenFact["payload"], "identity"> & {
    readonly writeId: string
    readonly proposalId: string
    readonly packageIdentity: typeof PackageIdentitySchema.Type
  },
): SkillWrittenFact {
  const { writeId, proposalId, packageIdentity, ...rest } = payload
  return {
    type: "skill.written",
    version: 2,
    actor: skillWriteActor(payload.origin),
    payload: { ...rest, identity: { kind: "recorded", writeId, proposalId, packageIdentity } },
  } satisfies SkillWrittenFact
}

export function skillRecommendationRecordedFact(payload: SkillRecommendationRecordedFact["payload"]): SkillRecommendationRecordedFact {
  return { type: "skill.recommendation.recorded", version: 1, actor: "agent", payload } satisfies SkillRecommendationRecordedFact
}

export function skillOperationTransitionedFact(payload: SkillOperationTransitionedFact["payload"]): SkillOperationTransitionedFact {
  return { type: "skill.operation.transitioned", version: 1, actor: "agent", payload } satisfies SkillOperationTransitionedFact
}

export function skillCleanupCompletedFact(payload: SkillCleanupCompletedFact["payload"]): SkillCleanupCompletedFact {
  return { type: "skill.cleanup.completed", version: 4, actor: "flywheel", payload }
}
