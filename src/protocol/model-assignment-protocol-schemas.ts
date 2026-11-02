import { Schema } from "effect"
import { EffortSchema } from "../infra/workflow-types.js"
import { AccessProviderCandidateSchema } from "./auth-status-protocol-schemas.js"
import type { RuntimeRoleAssignmentEntry } from "./role-protocol-types.js"
import type {
  EffortOptionRow,
  ModelAssignmentRow,
  ModelOptionRow,
  RuntimeResetModelAssignmentsResult,
  RuntimeSaveModelEffortResult,
  RuntimeSessionModelPlanResult,
} from "./model-assignment-protocol-types.js"

// Every exported schema is pinned to its in-process type with a Codec
// annotation (the lockstep pattern runtime-protocol-schemas.ts documents), so
// a shape that drifts between the pair is a type error here at the source.

const ModelSelectionSlotSchema = Schema.Struct({ kind: Schema.Literal("role"), roleId: Schema.String })
const ModelTierSchema = Schema.Union([Schema.Literal("default"), Schema.Literal("powerful"), Schema.Literal("mid"), Schema.Literal("cheap")])
const RuntimeModelAssignmentScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("defaults") }),
  Schema.Struct({ kind: Schema.Literal("session"), sessionId: Schema.String }),
])
const RuntimeModelAssignmentWriteScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("defaults") }),
  Schema.Struct({ kind: Schema.Literal("session"), sessionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("defaults-and-session"), sessionId: Schema.String }),
])

export const RuntimeModelAssignmentsQuerySchema = Schema.Struct({ scope: RuntimeModelAssignmentScopeSchema, slots: Schema.Array(ModelSelectionSlotSchema) })
export const RuntimeSessionModelPlanQuerySchema = Schema.Struct({ sessionId: Schema.String, slots: Schema.Array(ModelSelectionSlotSchema) })
export const RuntimeModelOptionsQuerySchema = Schema.Struct({ scope: RuntimeModelAssignmentScopeSchema, slot: ModelSelectionSlotSchema })
export const RuntimeEffortOptionsQuerySchema = Schema.Struct({ scope: RuntimeModelAssignmentScopeSchema, slot: ModelSelectionSlotSchema, model: Schema.NullOr(Schema.String) })
export const RuntimeSaveModelEffortMutationSchema = Schema.Struct({
  scope: RuntimeModelAssignmentWriteScopeSchema,
  slot: ModelSelectionSlotSchema,
  model: Schema.NullOr(Schema.String),
  effort: Schema.UndefinedOr(Schema.NullOr(EffortSchema)),
})
export const RuntimeResetModelAssignmentsMutationSchema = Schema.Struct({ scope: RuntimeModelAssignmentWriteScopeSchema, slots: Schema.Array(ModelSelectionSlotSchema) })

export const RuntimeModelAssignmentRowSchema: Schema.Codec<ModelAssignmentRow> = Schema.Struct({
  slot: ModelSelectionSlotSchema,
  label: Schema.String,
  model: Schema.String,
  effort: EffortSchema,
  modelSource: Schema.Union([Schema.Literal("explicit"), Schema.Literal("default"), Schema.Literal("inherited")]),
  matchesInheritedPair: Schema.Boolean,
  savedModel: Schema.optionalKey(Schema.String),
})

export const RuntimeSessionModelPlanResultSchema: Schema.Codec<RuntimeSessionModelPlanResult> = Schema.Struct({
  sessionId: Schema.String,
  profile: Schema.Struct({ persistedId: Schema.String, effectiveId: Schema.String }),
  assignments: Schema.Array(RuntimeModelAssignmentRowSchema),
  plans: Schema.Array(Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("available"),
      model: Schema.String,
      candidates: Schema.Array(Schema.Union([
        AccessProviderCandidateSchema.members[0].pipe(Schema.fieldsAssign({ wireModelId: Schema.String })),
        AccessProviderCandidateSchema.members[1].pipe(Schema.fieldsAssign({ wireModelId: Schema.String })),
      ])),
    }),
    Schema.Struct({ kind: Schema.Literal("unavailable"), model: Schema.String, reason: Schema.String, missing: Schema.Literals(["provider", "offering", "access"]) }),
  ])),
})

export const RuntimeModelOptionRowSchema: Schema.Codec<ModelOptionRow> = Schema.Struct({
  slot: ModelSelectionSlotSchema,
  model: Schema.NullOr(Schema.String),
  label: Schema.String,
  tier: Schema.optionalKey(ModelTierSchema),
  selectable: Schema.Boolean,
  current: Schema.optionalKey(Schema.Boolean),
  inherit: Schema.optionalKey(Schema.Boolean),
  efforts: Schema.Array(EffortSchema),
  effort: EffortSchema,
  inheritModel: Schema.optionalKey(Schema.String),
  roleDefault: Schema.optionalKey(Schema.Boolean),
  reason: Schema.optionalKey(Schema.String),
  providers: Schema.Array(Schema.Struct({ name: Schema.String, shortName: Schema.String, serving: Schema.Boolean })),
  cost: Schema.optionalKey(Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.optionalKey(Schema.Number),
  })),
  catalogProvenance: Schema.optionalKey(Schema.Literals(["first-party", "first-party-cached", "models-dev-live", "models-dev-archive", "models-dev-bundled", "static"])),
})

export const RuntimeEffortOptionRowSchema: Schema.Codec<EffortOptionRow> = Schema.Struct({
  slot: ModelSelectionSlotSchema,
  effort: Schema.NullOr(EffortSchema),
  label: Schema.String,
  selectable: Schema.Boolean,
  current: Schema.optionalKey(Schema.Boolean),
  inherit: Schema.optionalKey(Schema.Boolean),
})

export const RuntimeSaveModelEffortResultSchema: Schema.Codec<RuntimeSaveModelEffortResult> = Schema.Struct({ label: Schema.String, warning: Schema.optionalKey(Schema.String), mirrored: Schema.optionalKey(Schema.Boolean) })
export const RuntimeResetModelAssignmentsResultSchema: Schema.Codec<RuntimeResetModelAssignmentsResult> = Schema.Struct({
  rows: Schema.Array(RuntimeModelAssignmentRowSchema),
  warning: Schema.optionalKey(Schema.String),
  mirrored: Schema.optionalKey(Schema.Boolean),
})
export const RuntimeRoleAssignmentEntrySchema: Schema.Codec<RuntimeRoleAssignmentEntry> = Schema.Struct({ model: Schema.String, effort: Schema.String })
