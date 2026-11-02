import { Schema } from "effect"
import type {
  ProviderModelRow,
  ProviderModelTarget,
  ProviderModelView,
  RuntimeProviderModelHiddenResult,
  RuntimeSetProviderAutoEnableNewModelsResult,
  RuntimeSetProviderModelResult,
} from "./provider-model-preference-protocol-types.js"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ProviderIdSchema = Schema.NonEmptyString
const ModelIdSchema = Schema.NonEmptyString
export const ProviderModelTargetSchema: Schema.Codec<ProviderModelTarget> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("singleton"), providerId: ProviderIdSchema }),
  Schema.Struct({ kind: Schema.Literal("subscription"), providerId: ProviderIdSchema, accountCorrelationId: Schema.NonEmptyString }),
])
const CatalogLiveOutcomeSchema = Schema.Literals(["valid", "authentication-invalid", "discovery-failed", "empty", "unusable"])
const ProviderCatalogDiscoverySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("available"), provenance: Schema.Literals(["first-party", "first-party-cached", "models-dev-live", "models-dev-archive", "models-dev-bundled", "static"]), liveOutcome: CatalogLiveOutcomeSchema }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.Literals(["authentication-absent", "authentication-invalid", "discovery-pending", "discovery-failed", "empty", "unusable"]), discoveryReason: Schema.optionalKey(Schema.Literals(["timeout", "oversized", "malformed", "transport", "http"])) }),
])

const ProviderModelRowSchema: Schema.Codec<ProviderModelRow> = Schema.Struct({
  modelId: ModelIdSchema,
  checked: Schema.Boolean,
  optInAvailable: Schema.Boolean,
  configured: Schema.Boolean,
  unavailableReason: Schema.optionalKey(Schema.NonEmptyString),
  accessState: Schema.optionalKey(Schema.Literals(["pending", "verified"])),
})

export const ProviderModelViewSchema: Schema.Codec<ProviderModelView> = Schema.Struct({
  profileId: Schema.NonEmptyString,
  eligibilityRevision: NonNegativeInt,
  target: ProviderModelTargetSchema,
  providerDisplayName: Schema.NonEmptyString,
  catalog: ProviderCatalogDiscoverySchema,
  rows: Schema.Array(ProviderModelRowSchema),
  preferenceAvailable: Schema.optionalKey(Schema.Boolean),
  freeRoutes: Schema.optionalKey(Schema.Struct({ enabled: Schema.Boolean })),
  recheckAvailable: Schema.optionalKey(Schema.Boolean),
  audit: Schema.optionalKey(Schema.Struct({ remaining: NonNegativeInt, refused: NonNegativeInt })),
})

export const RuntimeProviderModelsQuerySchema = Schema.Struct({
  profileId: Schema.NonEmptyString,
  target: ProviderModelTargetSchema,
})

export const RuntimeSetProviderModelMutationSchema = Schema.Struct({
  queriedProfileId: Schema.NonEmptyString,
  queriedEligibilityRevision: NonNegativeInt,
  target: ProviderModelTargetSchema,
  modelId: ModelIdSchema,
  checked: Schema.Boolean,
})

export const RuntimeDeselectAllProviderModelsMutationSchema = Schema.Struct({
  queriedProfileId: Schema.NonEmptyString,
  queriedEligibilityRevision: NonNegativeInt,
  target: ProviderModelTargetSchema,
})

export const RuntimeRecheckProviderModelsMutationSchema = Schema.Struct({
  queriedProfileId: Schema.NonEmptyString,
  queriedEligibilityRevision: NonNegativeInt,
  target: ProviderModelTargetSchema,
})

export const RuntimeSetProviderFreeRoutesMutationSchema = Schema.Struct({
  queriedProfileId: Schema.NonEmptyString,
  queriedEligibilityRevision: NonNegativeInt,
  target: ProviderModelTargetSchema,
  enabled: Schema.Boolean,
})

export const RuntimeSetProviderAutoEnableNewModelsMutationSchema = Schema.Struct({
  queriedProfileId: Schema.NonEmptyString,
  queriedEligibilityRevision: NonNegativeInt,
  enabled: Schema.Boolean,
})

export const RuntimeSetProviderAutoEnableNewModelsResultSchema: Schema.Codec<RuntimeSetProviderAutoEnableNewModelsResult> = Schema.Struct({
  profileId: Schema.NonEmptyString,
  eligibilityRevision: NonNegativeInt,
  autoEnableNewModels: Schema.Boolean,
})

export const RuntimeProviderModelHiddenResultSchema: Schema.Codec<RuntimeProviderModelHiddenResult> = Schema.Struct({
  profileId: Schema.NonEmptyString,
  eligibilityRevision: NonNegativeInt,
  target: ProviderModelTargetSchema,
  hidden: Schema.Literal(true),
})

export const RuntimeSetProviderModelResultSchema: Schema.Codec<RuntimeSetProviderModelResult> = Schema.Union([Schema.Struct({
  profileId: Schema.NonEmptyString,
  eligibilityRevision: NonNegativeInt,
  target: ProviderModelTargetSchema,
  row: ProviderModelRowSchema,
}), RuntimeProviderModelHiddenResultSchema])
