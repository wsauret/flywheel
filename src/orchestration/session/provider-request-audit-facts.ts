import { Schema, SchemaTransformation } from "effect"
import { parseProjectionFact } from "../../infra/event-projection.js"
import { defineFact } from "../../infra/event-registry.js"
import type { StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { isRecord } from "../../infra/record.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import {
  ProviderRequestErrorSchema,
  ProviderRequestIdentitySchema,
  ProviderRequestOmittedToolSchema,
  ProviderRequestOutcomeSchema,
  ProviderRequestToolSchema,
  HistoricalProviderRequestToolSchema,
  ProviderRequestTreePointerSchema,
  HistoricalProviderStreamSummarySchema,
  ProviderStreamSummarySchema,
  ProviderStreamSummaryV2Schema,
  providerRequestIdentityFromPayload,
  type ProviderRequestIdentity,
  type ProviderStreamSummary,
  ProviderStreamTelemetrySourceSchema,
  PromptStaleMaskingSchema,
  PromptToolHistoryProjectionSchema,
  PromptHistoryLoweringSchema,
  ProviderRequestAuditOptionsSchema,
  ProviderTransportContextSchema,
  RETIRED_INTERACTION_PROFILE_IDS,
} from "./provider-request-audit-types.js"
import { MODEL_INTERACTION_PROFILE_IDS } from "../agent-runtime/model-interaction-profile.js"
import { AccessProviderCandidateSchema, AccessProviderCatalogProvenanceSchema } from "../../infra/llm/access-provider.js"


const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const LowercaseSha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

const ModuleTransformerOutcomeSchema = Schema.Union([Schema.Literal("applied"), Schema.Literal("error")])
// Remove the retired ids after 2027-10-30: v6 facts that builds before 2026-10-30 wrote for gpt-6-luna name them.
const RecordedInteractionProfileIdSchema = Schema.Union([...MODEL_INTERACTION_PROFILE_IDS, ...RETIRED_INTERACTION_PROFILE_IDS].map((id) => Schema.Literal(id)))
// Remove after 2027-10-16: recorded Luna contracts used a numeric model-generation prefix.
const HistoricalInteractionProfileIdSchema = Schema.Union([
  RecordedInteractionProfileIdSchema,
  Schema.String.check(Schema.isPattern(/^gpt-\d+(?:\.\d+)?-luna(?:-shell)?-v1$/)),
]).pipe(Schema.decodeTo(RecordedInteractionProfileIdSchema, SchemaTransformation.transform({
  decode: (id) => id === "default" ? id : id.endsWith("-shell-v1") ? "luna-shell-v1" : "luna-native-v1",
  encode: (id) => id,
})))
const ContextApplicationRecordedSchema = defineFact({
  type: "context.application.recorded",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: Schema.String,
    conversationId: Schema.String,
    turn: PositiveInt,
    contextApplicationId: Schema.String,
    applicationCount: NonNegativeInt,
    sequenceDigest: Schema.String,
  }),
})
const ModuleTransformerApplicationPayloadSchema = Schema.Struct({
  requestId: Schema.String,
  conversationId: Schema.String,
  turn: PositiveInt,
  contextApplicationId: Schema.String,
  applicationId: Schema.String,
  transformerId: Schema.String,
  seam: Schema.String,
  order: Schema.Number,
  outcome: ModuleTransformerOutcomeSchema,
  inputHash: Schema.String,
  outputHash: Schema.String,
})

// Tier-1 Ref fact. Always stores the hashes, sha, token counts, and tree
// pointer. The `systemPrompt` body is present ONLY the first time a given
// `systemPromptHash` is seen within a conversation; later identical prompts
// carry the hash alone (within-conversation dedup). Subagent requests omit
// `treePointer`; their run facts cover inspectability.
const PromptAssembledV2Schema = defineFact({
  type: "prompt.assembled",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: Schema.String, conversationId: Schema.String, turn: PositiveInt,
    promptKind: Schema.String, systemPromptHash: Schema.String,
    systemPrompt: Schema.optionalKey(Schema.String), toolSurfaceHash: Schema.String,
    promptSha256: Schema.String, messageCount: NonNegativeInt,
    estimatedContextTokens: NonNegativeNumber, contextWindow: PositiveInt,
    treePointer: Schema.optionalKey(ProviderRequestTreePointerSchema),
    parentToolUseId: Schema.optionalKey(Schema.String), staleMasking: Schema.optionalKey(PromptStaleMaskingSchema),
    contextApplicationId: Schema.optionalKey(Schema.String),
  }),
})
const PromptAssembledV3Schema = defineFact({
  type: "prompt.assembled", version: 3, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: NonEmptyString, conversationId: NonEmptyString, turn: PositiveInt,
    promptKind: NonEmptyString, systemPromptHash: LowercaseSha256,
    systemPrompt: Schema.optionalKey(Schema.String), toolSurfaceHash: LowercaseSha256,
    promptSha256: LowercaseSha256, messageCount: NonNegativeInt,
    estimatedContextTokens: NonNegativeNumber, attemptStaticTokens: NonNegativeNumber,
    contextWindow: PositiveInt, treePointer: Schema.optionalKey(ProviderRequestTreePointerSchema),
    parentToolUseId: Schema.optionalKey(NonEmptyString), staleMasking: Schema.optionalKey(PromptStaleMaskingSchema),
    requestContext: Schema.optionalKey(NonEmptyString), contextApplicationId: Schema.optionalKey(NonEmptyString),
  }),
})

// Tool surface fact. Emitted ONLY the first time a `toolSurfaceHash` is seen
// within a conversation, carrying the full body. Later identical surfaces emit
// nothing; the request's `prompt.assembled.toolSurfaceHash` references this
// stored body (within-conversation dedup).
const ToolSurfaceSelectedV2Schema = defineFact({
  type: "tool_surface.selected", version: 2, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: Schema.String, conversationId: Schema.String, turn: PositiveInt,
    toolSurfaceHash: Schema.String, tools: Schema.Array(HistoricalProviderRequestToolSchema),
    omittedTools: Schema.Array(ProviderRequestOmittedToolSchema),
  }),
})
const ToolSurfaceSelectedV3Schema = defineFact({
  type: "tool_surface.selected", version: 3, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: NonEmptyString, conversationId: NonEmptyString, turn: PositiveInt,
    toolSurfaceHash: LowercaseSha256, tools: Schema.Array(ProviderRequestToolSchema),
    omittedTools: Schema.Array(ProviderRequestOmittedToolSchema),
  }),
})
const PresentedProviderRequestToolSchema = Schema.Struct({
  name: NonEmptyString,
  registrationId: NonEmptyString,
  executableId: NonEmptyString,
  description: Schema.String,
  input_schema: UnknownRecordSchema,
  kind: Schema.Union([Schema.Literal("function"), Schema.Literal("custom")]),
  inputFormatSha256: LowercaseSha256,
})

const ContextTransformerAppliedSchema = defineFact({
  type: "context.transformer.applied",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: ModuleTransformerApplicationPayloadSchema,
})

const ModelRequestedV1Schema = defineFact({
  type: "model.requested",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: Schema.String,
    conversationId: Schema.String,
    turn: PositiveInt,
    model: Schema.String,
    accessProvider: Schema.String,
    modelFamily: Schema.String,
    reasoningEffort: Schema.optionalKey(Schema.String),
    cacheRetention: Schema.optionalKey(Schema.String),
    cacheKey: Schema.optionalKey(Schema.String),
    providerOptions: Schema.optionalKey(Schema.Unknown),
  }),
})

const ModelRequestedV2Schema = defineFact({
  type: "model.requested",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: Schema.String,
    conversationId: Schema.String,
    turn: PositiveInt,
    model: Schema.String,
    accessProvider: Schema.String,
    modelFamily: Schema.String,
    interactionProfileId: HistoricalInteractionProfileIdSchema,
    reasoningEffort: Schema.optionalKey(Schema.String),
    cacheRetention: Schema.optionalKey(Schema.String),
    cacheKey: Schema.optionalKey(Schema.String),
    providerOptions: Schema.optionalKey(Schema.Unknown),
  }),
})

const ModelRequestedV3Schema = defineFact({
  type: "model.requested", version: 3, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: NonEmptyString, conversationId: NonEmptyString, turn: PositiveInt,
    model: NonEmptyString, accessProvider: NonEmptyString, modelFamily: NonEmptyString,
    interactionProfileId: HistoricalInteractionProfileIdSchema,
    reasoningEffort: Schema.optionalKey(Schema.String), cacheRetention: Schema.optionalKey(Schema.String),
    cacheKey: Schema.optionalKey(Schema.String), providerOptions: Schema.optionalKey(ProviderRequestAuditOptionsSchema),
  }),
})

const ModelRequestedV4Schema = defineFact({
  type: "model.requested", version: 4, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: NonEmptyString, conversationId: NonEmptyString, turn: PositiveInt,
    model: NonEmptyString, accessProvider: NonEmptyString, accessProviderCandidate: AccessProviderCandidateSchema,
    catalogProvenance: Schema.optionalKey(AccessProviderCatalogProvenanceSchema), modelFamily: NonEmptyString,
    interactionProfileId: HistoricalInteractionProfileIdSchema,
    reasoningEffort: Schema.optionalKey(Schema.String), cacheRetention: Schema.optionalKey(Schema.String),
    cacheKey: Schema.optionalKey(Schema.String), providerOptions: Schema.optionalKey(ProviderRequestAuditOptionsSchema),
  }),
})

const ModelRequestDispatchedSchema = defineFact({
  type: "model.request.dispatched",
  version: 1,
  actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: Schema.String,
    conversationId: Schema.String,
    turn: PositiveInt,
  }),
})

const ModelResponseReceivedSchema = defineFact({
  type: "model.response_received",
  version: 1,
  actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: Schema.String,
    conversationId: Schema.String,
    turn: PositiveInt,
    outcome: ProviderRequestOutcomeSchema,
    durationMs: NonNegativeNumber,
    stopReason: Schema.optionalKey(Schema.String),
    responseId: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(ProviderRequestErrorSchema),
  }),
})

const ModelUsageRecordedSchema = defineFact({
  type: "model.usage.recorded",
  version: 1,
  actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: Schema.String,
    conversationId: Schema.String,
    turn: PositiveInt,
    stepId: Schema.optionalKey(Schema.String),
    parentToolUseId: Schema.optionalKey(Schema.String),
    inputTokens: NonNegativeInt,
    outputTokens: NonNegativeInt,
    cacheReadInputTokens: NonNegativeInt,
    cacheCreationInputTokens: NonNegativeInt,
    reasoningTokens: NonNegativeInt,
    promptTokens: NonNegativeInt,
    deltaCostUsd: NonNegativeNumber,
  }),
})

const ModelStreamStartedSchema = defineFact({
  type: "model.stream.started",
  version: 1,
  actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: Schema.String,
    conversationId: Schema.String,
    turn: PositiveInt,
  }),
})

const ModelStreamEventObservedSchema = defineFact({
  type: "model.stream.event_observed",
  version: 1,
  actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: Schema.String,
    conversationId: Schema.String,
    turn: PositiveInt,
    sequence: PositiveInt,
    source: ProviderStreamTelemetrySourceSchema,
    kind: Schema.NonEmptyString,
    elapsedMs: NonNegativeNumber,
    sincePreviousMs: NonNegativeNumber,
    metadata: UnknownRecordSchema,
  }),
})

const ModelStreamCompletedSchema = defineFact({
  type: "model.stream.completed",
  version: 1,
  actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: Schema.String,
    conversationId: Schema.String,
    turn: PositiveInt,
    durationMs: NonNegativeNumber,
    eventCount: NonNegativeInt,
    outcome: ProviderRequestOutcomeSchema,
    lastEventKind: Schema.optionalKey(Schema.String),
  }),
})

const ModelStreamSummaryRecordedSchema = defineFact({
  type: "model.stream.summary.recorded",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: HistoricalProviderStreamSummarySchema,
})

const PromptAssembledV4Schema = defineFact({
  type: "prompt.assembled", version: 4, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    promptKind: NonEmptyString, systemPromptHash: LowercaseSha256,
    systemPrompt: Schema.optionalKey(Schema.String), toolSurfaceHash: LowercaseSha256,
    promptSha256: LowercaseSha256, messageCount: NonNegativeInt,
    estimatedContextTokens: NonNegativeNumber, attemptStaticTokens: NonNegativeNumber,
    contextWindow: PositiveInt, treeLeafEntryId: Schema.optionalKey(Schema.NullOr(NonEmptyString)),
    parentToolUseId: Schema.optionalKey(NonEmptyString), staleMasking: Schema.optionalKey(PromptStaleMaskingSchema),
    requestContext: Schema.optionalKey(NonEmptyString), contextApplicationId: Schema.optionalKey(NonEmptyString),
  }),
})
const PromptAssembledV5Schema = defineFact({
  type: "prompt.assembled", version: 5, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    promptKind: NonEmptyString, requestPurpose: Schema.optionalKey(Schema.Literal("compaction")),
    systemPromptHash: LowercaseSha256, systemPrompt: Schema.optionalKey(Schema.String),
    toolSurfaceHash: LowercaseSha256, promptSha256: LowercaseSha256, messageCount: NonNegativeInt,
    estimatedContextTokens: NonNegativeNumber, attemptStaticTokens: NonNegativeNumber,
    contextWindow: PositiveInt, treeLeafEntryId: Schema.optionalKey(Schema.NullOr(NonEmptyString)),
    parentToolUseId: Schema.optionalKey(NonEmptyString), staleMasking: Schema.optionalKey(PromptStaleMaskingSchema),
    toolHistoryProjection: Schema.optionalKey(PromptToolHistoryProjectionSchema),
    // Absent on requests recorded before 2026-10-27 and on requests whose lowering withheld nothing.
    historyLowering: Schema.optionalKey(PromptHistoryLoweringSchema),
    requestContext: Schema.optionalKey(NonEmptyString), contextApplicationId: Schema.optionalKey(NonEmptyString),
  }),
})
const ToolSurfaceSelectedV4Schema = defineFact({
  type: "tool_surface.selected", version: 4, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    toolSurfaceHash: LowercaseSha256, tools: Schema.Array(ProviderRequestToolSchema),
    omittedTools: Schema.Array(ProviderRequestOmittedToolSchema),
  }),
})
const ToolSurfaceSelectedV5Schema = defineFact({
  type: "tool_surface.selected", version: 5, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    toolSurfaceHash: LowercaseSha256, tools: Schema.Array(PresentedProviderRequestToolSchema),
    omittedTools: Schema.Array(ProviderRequestOmittedToolSchema),
  }),
})
const ContextApplicationRecordedV2Schema = defineFact({
  type: "context.application.recorded", version: 2, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    contextApplicationId: NonEmptyString, applicationCount: NonNegativeInt, sequenceDigest: NonEmptyString,
  }),
})
const ContextTransformerAppliedV2Schema = defineFact({
  type: "context.transformer.applied", version: 2, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    contextApplicationId: NonEmptyString, applicationId: NonEmptyString, transformerId: NonEmptyString,
    seam: NonEmptyString, order: Schema.Number, outcome: ModuleTransformerOutcomeSchema,
    inputHash: NonEmptyString, outputHash: NonEmptyString,
  }),
})
const ModelRequestedV5Schema = defineFact({
  type: "model.requested", version: 5, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    model: NonEmptyString, accessProvider: NonEmptyString, accessProviderCandidate: Schema.optionalKey(AccessProviderCandidateSchema),
    catalogProvenance: Schema.optionalKey(AccessProviderCatalogProvenanceSchema), modelFamily: NonEmptyString,
    interactionProfileId: HistoricalInteractionProfileIdSchema,
    reasoningEffort: Schema.optionalKey(Schema.String), cacheRetention: Schema.optionalKey(Schema.String),
    cacheKey: Schema.optionalKey(Schema.String), providerOptions: Schema.optionalKey(ProviderRequestAuditOptionsSchema),
  }),
})
const ModelRequestedV6Schema = defineFact({
  type: "model.requested", version: 6, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    ...ModelRequestedV5Schema.fields.payload.fields,
    interactionProfileId: RecordedInteractionProfileIdSchema,
  }),
})
const ModelRequestDispatchedV2Schema = defineFact({
  type: "model.request.dispatched", version: 2, actor: Schema.Literal("provider"),
  payload: Schema.Struct({ requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt }),
})
const ModelResponseReceivedV2Schema = defineFact({
  type: "model.response_received", version: 2, actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    outcome: ProviderRequestOutcomeSchema, durationMs: NonNegativeNumber,
    stopReason: Schema.optionalKey(Schema.String), responseId: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(ProviderRequestErrorSchema),
  }),
})
// Version 2 predates the transport context, so its responses read as not recorded. Remove the version 2 reader
// after 2027-10-09, once retained stores no longer hold a version 2 response.
const ModelResponseReceivedV3Schema = defineFact({
  type: "model.response_received", version: 3, actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    outcome: ProviderRequestOutcomeSchema, durationMs: NonNegativeNumber,
    stopReason: Schema.optionalKey(Schema.String), responseId: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(ProviderRequestErrorSchema), transportContext: Schema.optionalKey(ProviderTransportContextSchema),
  }),
})
const ModelUsageRecordedV2Schema = defineFact({
  type: "model.usage.recorded", version: 2, actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    stepId: Schema.optionalKey(NonEmptyString), parentToolUseId: Schema.optionalKey(NonEmptyString),
    inputTokens: NonNegativeInt, outputTokens: NonNegativeInt, cacheReadInputTokens: NonNegativeInt,
    cacheCreationInputTokens: NonNegativeInt, reasoningTokens: NonNegativeInt,
    promptTokens: NonNegativeInt, deltaCostUsd: NonNegativeNumber,
  }),
})
const ModelUsageRecordedV3Schema = defineFact({
  type: "model.usage.recorded", version: 3, actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: NonEmptyString, attemptId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    stepId: Schema.optionalKey(NonEmptyString), parentToolUseId: Schema.optionalKey(NonEmptyString),
    inputTokens: NonNegativeInt, outputTokens: NonNegativeInt, cacheReadInputTokens: NonNegativeInt,
    cacheCreationInputTokens: NonNegativeInt, reasoningTokens: NonNegativeInt, promptTokens: NonNegativeInt,
  }),
})
// v4: the attempt of an agent of a workflow is `workflowAttemptId`.
// Versions 1 to 3 named it `stepId`; the projection reads both. Remove the
// `stepId` readers after 2027-04-30.
const ModelUsageRecordedV4Schema = defineFact({
  type: "model.usage.recorded", version: 4, actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: NonEmptyString, attemptId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    workflowAttemptId: Schema.optionalKey(NonEmptyString), parentToolUseId: Schema.optionalKey(NonEmptyString),
    inputTokens: NonNegativeInt, outputTokens: NonNegativeInt, cacheReadInputTokens: NonNegativeInt,
    cacheCreationInputTokens: NonNegativeInt, reasoningTokens: NonNegativeInt, promptTokens: NonNegativeInt,
  }),
})
// v5: `coverage` states how complete the provider's report was. An unmeasured
// attempt has null tokens, an unreported detail is null, and `promptTokens` is
// null when any of its parts is. Every v4 fact was complete.
const NullableTokens = Schema.NullOr(NonNegativeInt)
const ModelUsageRecordedV5Schema = defineFact({
  type: "model.usage.recorded", version: 5, actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: NonEmptyString, attemptId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    workflowAttemptId: Schema.optionalKey(NonEmptyString), parentToolUseId: Schema.optionalKey(NonEmptyString),
    coverage: Schema.Literals(["complete", "partial", "unmeasured"]),
    inputTokens: NullableTokens, outputTokens: NullableTokens, cacheReadInputTokens: NullableTokens,
    cacheCreationInputTokens: NullableTokens, reasoningTokens: NullableTokens, promptTokens: NullableTokens,
  }),
})
const ModelStreamStartedV2Schema = defineFact({
  type: "model.stream.started", version: 2, actor: Schema.Literal("provider"),
  payload: Schema.Struct({ requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt }),
})
const ModelStreamEventObservedV2Schema = defineFact({
  type: "model.stream.event_observed", version: 2, actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    sequence: PositiveInt, source: ProviderStreamTelemetrySourceSchema, kind: NonEmptyString,
    elapsedMs: NonNegativeNumber, sincePreviousMs: NonNegativeNumber, metadata: UnknownRecordSchema,
  }),
})
const ModelStreamCompletedV2Schema = defineFact({
  type: "model.stream.completed", version: 2, actor: Schema.Literal("provider"),
  payload: Schema.Struct({
    requestId: NonEmptyString, identity: ProviderRequestIdentitySchema, turn: PositiveInt,
    durationMs: NonNegativeNumber, eventCount: NonNegativeInt, outcome: ProviderRequestOutcomeSchema,
    lastEventKind: Schema.optionalKey(Schema.String),
  }),
})
const ModelStreamSummaryRecordedV2Schema = defineFact({
  type: "model.stream.summary.recorded", version: 2, actor: Schema.Literal("flywheel"), payload: ProviderStreamSummaryV2Schema,
})
const ModelStreamSummaryRecordedV3Schema = defineFact({
  type: "model.stream.summary.recorded", version: 3, actor: Schema.Literal("flywheel"), payload: ProviderStreamSummarySchema,
})

export const PROVIDER_REQUEST_DIAGNOSTIC_TYPES = [
  "model.stream.started",
  "model.stream.event_observed",
  "model.stream.completed",
] as const

export const ProviderRequestAuditFactSchemas = [
  ContextApplicationRecordedSchema, ContextApplicationRecordedV2Schema,
  PromptAssembledV2Schema, PromptAssembledV3Schema, PromptAssembledV4Schema, PromptAssembledV5Schema,
  ToolSurfaceSelectedV2Schema, ToolSurfaceSelectedV3Schema, ToolSurfaceSelectedV4Schema, ToolSurfaceSelectedV5Schema,
  ContextTransformerAppliedSchema, ContextTransformerAppliedV2Schema,
  ModelRequestedV1Schema, ModelRequestedV2Schema, ModelRequestedV3Schema, ModelRequestedV4Schema, ModelRequestedV5Schema, ModelRequestedV6Schema,
  ModelRequestDispatchedSchema, ModelRequestDispatchedV2Schema,
  ModelResponseReceivedSchema, ModelResponseReceivedV2Schema, ModelResponseReceivedV3Schema,
  ModelUsageRecordedSchema, ModelUsageRecordedV2Schema, ModelUsageRecordedV3Schema, ModelUsageRecordedV4Schema, ModelUsageRecordedV5Schema,
  ModelStreamStartedSchema, ModelStreamStartedV2Schema,
  ModelStreamEventObservedSchema, ModelStreamEventObservedV2Schema,
  ModelStreamCompletedSchema, ModelStreamCompletedV2Schema,
  ModelStreamSummaryRecordedSchema, ModelStreamSummaryRecordedV2Schema, ModelStreamSummaryRecordedV3Schema,
] as const

const ProviderRequestAuditFactSchema = Schema.Union(ProviderRequestAuditFactSchemas)

export type ProviderRequestAuditFact = typeof ProviderRequestAuditFactSchema.Type

/** The strict decode. Writers gate every fact bound for the store on it. */
export function parseProviderRequestAuditFact(value: unknown): ProviderRequestAuditFact {
  return Schema.decodeUnknownSync(ProviderRequestAuditFactSchema, { onExcessProperty: "error" })(value)
}

const log = Log.create({ service: "provider-request-audit" })

/** One warning for each salvage a process applies, then one count. */
const salvageWarnings = coalesceRepeats<{ readonly aggregateId: string; readonly position: number }>({
  windowMs: 60_000,
  first: (salvage, { aggregateId, position }) => {
    log.warn("a provider request fact has a historical form; it reads through the family's salvage rule", { salvage, aggregateId, position })
  },
  repeated: (salvage, { count }) => {
    log.warn("more provider request facts have a historical form; they read through the family's salvage rule", { salvage, count })
  },
})

/** Decodes one stored fact of this family at the historical recovery
 *  boundary. The strict decode comes first. A fact it refuses then crosses
 *  only the family's reviewed salvage rules, with a warning, and a fact that
 *  no rule reads stays an invariant violation. The stored row never changes. */
export function readProviderRequestAuditFact(event: StoredFact): ProviderRequestAuditFact {
  try {
    return parseProjectionFact(event, parseProviderRequestAuditFact)
  } catch (violation) {
    const salvaged = salvageIdentityWithoutProviderSessionKey(event)
    if (salvaged === null) throw violation
    salvageWarnings.observe(`${event.type}@${event.version} identity without providerSessionKey`, { aggregateId: event.aggregateId, position: event.position })
    return salvaged
  }
}

/** Builds of 2026-08-31 recorded request identities that name the durable
 *  conversation but not the provider session. The conversation is the stream
 *  those requests belong to, so it becomes their provider session key. Every
 *  fact of one request carries the same identity, so its facts still agree.
 *  Remove this salvage after 2027-04-04. */
function salvageIdentityWithoutProviderSessionKey(event: StoredFact): ProviderRequestAuditFact | null {
  const { payload } = event
  if (!isRecord(payload) || !isRecord(payload.identity) || "providerSessionKey" in payload.identity) return null
  const { conversationId } = payload.identity
  if (typeof conversationId !== "string" || conversationId.length === 0) return null
  try {
    return parseProviderRequestAuditFact({
      type: event.type,
      version: event.version,
      actor: event.actor,
      payload: { ...payload, identity: { ...payload.identity, providerSessionKey: conversationId } },
    })
  } catch {
    return null
  }
}

/** Converts a decoded summary to the current read shape without rewriting historical facts. */
export function canonicalProviderStreamSummary(
  fact: Extract<ProviderRequestAuditFact, { type: "model.stream.summary.recorded" }>,
  identity: ProviderRequestIdentity = providerRequestIdentityFromPayload(fact.payload),
): ProviderStreamSummary {
  if (fact.version === 3) return { ...fact.payload, identity }
  // Remove this v1/v2 historical conversion after 2027-09-30.
  const { conversationId: _historicalConversationId, ...summary } = fact.version === 1
    ? fact.payload
    : { ...fact.payload, conversationId: undefined }
  return { ...summary, identity, generation: { kind: "unavailable", reason: "historical" } }
}
