import { createHash } from "node:crypto"
import type { AccessProviderCandidate, AccessProviderCatalogProvenance } from "../../infra/llm/access-provider.js"
import { Schema } from "effect"
import { ProviderErrorDiagnosticSchema, type ProviderErrorDiagnostic } from "../../infra/llm/provider-error-diagnostic.js"
import type { ProviderRequestOptions } from "../../infra/llm/provider-options.js"
import type { ModuleTransformerApplication } from "../module-hooks.js"
import type { ModelInteractionProfileId } from "../agent-runtime/model-interaction-profile.js"

/** Profile ids that only recorded requests hold: builds before 2026-10-30 served gpt-6-luna through them. */
export const RETIRED_INTERACTION_PROFILE_IDS = Object.freeze(["luna-native-v1", "luna-shell-v1"] as const)
/** The interaction profile a recorded request names: a current id, or a retired one an older build wrote. */
export type RecordedInteractionProfileId = ModelInteractionProfileId | (typeof RETIRED_INTERACTION_PROFILE_IDS)[number]

// Shared sub-schemas for the provider-request audit fact payloads
// (provider-request-audit-events.ts). The projection state
// (provider-request-audit-projection.ts) is a plain type over the same
// inferred shapes; these schemas are the single source of truth.

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
export const ProviderRequestIdentitySchema = Schema.Struct({
  providerSessionKey: NonEmptyString,
  conversationId: Schema.optionalKey(NonEmptyString),
})
export type ProviderRequestIdentity = typeof ProviderRequestIdentitySchema.Type

/** Stable owner for prompt and tool bodies. Durable conversations own their
 * bodies; non-durable runs fall back to their provider session. */
export function providerRequestIdentityKey(identity: ProviderRequestIdentity): string {
  return identity.conversationId
    ? `conversation:${identity.conversationId}`
    : providerRequestStreamKey(identity)
}

/** Provider cache-continuity stream. A provider reset starts a new stream even
 * when the durable conversation remains the same. */
export function providerRequestStreamKey(identity: ProviderRequestIdentity): string {
  return `provider-session:${identity.providerSessionKey}`
}

export function providerRequestIdentityFromPayload(
  payload: {
    readonly identity?: ProviderRequestIdentity
    readonly conversationId?: string
    readonly cacheKey?: string
    readonly treePointer?: { readonly conversationId: string }
  },
): ProviderRequestIdentity {
  if (payload.identity) return payload.identity
  if (payload.conversationId) {
    return {
      providerSessionKey: payload.cacheKey ?? payload.conversationId,
      ...(payload.treePointer ? { conversationId: payload.treePointer.conversationId } : {}),
    }
  }
  throw new Error("provider request audit fact has no request identity")
}

const AuditOpenAIOptionsSchema = Schema.Struct({
  parallel_tool_calls: Schema.optionalKey(Schema.Boolean), text_verbosity: Schema.optionalKey(Schema.String),
  reasoning_summary: Schema.optionalKey(Schema.String), speed: Schema.optionalKey(Schema.String), service_tier: Schema.optionalKey(Schema.String),
})
const AuditAnthropicOptionsSchema = Schema.Struct({ thinking_display: Schema.optionalKey(Schema.String), speed: Schema.optionalKey(Schema.String) })
const AuditGoogleOptionsSchema = Schema.Struct({
  temperature: Schema.optionalKey(Schema.Number),
  thinking_budgets: Schema.optionalKey(Schema.Struct({ low: Schema.optionalKey(Schema.Number), medium: Schema.optionalKey(Schema.Number), high: Schema.optionalKey(Schema.Number) })),
})
const AuditOpenRouterOptionsSchema = Schema.Struct({
  allow_fallbacks: Schema.optionalKey(Schema.Boolean), require_parameters: Schema.optionalKey(Schema.Boolean), zdr: Schema.optionalKey(Schema.Boolean),
  enforce_distillable_text: Schema.optionalKey(Schema.Boolean), data_collection: Schema.optionalKey(Schema.String),
  order: Schema.optionalKey(Schema.Array(Schema.String)), only: Schema.optionalKey(Schema.Array(Schema.String)),
  ignore: Schema.optionalKey(Schema.Array(Schema.String)), quantizations: Schema.optionalKey(Schema.Array(Schema.String)),
  sort: Schema.optionalKey(Schema.Unknown), max_price: Schema.optionalKey(Schema.Unknown),
  preferred_min_throughput: Schema.optionalKey(Schema.Unknown), preferred_max_latency: Schema.optionalKey(Schema.Unknown),
})
export const ProviderRequestAuditOptionsSchema = Schema.Struct({
  openai: Schema.optionalKey(AuditOpenAIOptionsSchema), anthropic: Schema.optionalKey(AuditAnthropicOptionsSchema),
  google: Schema.optionalKey(AuditGoogleOptionsSchema), openrouter: Schema.optionalKey(AuditOpenRouterOptionsSchema),
})
export type ProviderRequestAuditOptions = typeof ProviderRequestAuditOptionsSchema.Type

function omitUndefined(values: { [key: string]: unknown }): { [key: string]: unknown } {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
}
/** Selects behavior-relevant provider controls for durable audit evidence.
 * Arbitrary extension bodies and provider user identifiers never cross this boundary. */
export function providerRequestAuditOptions(options: ProviderRequestOptions | undefined): ProviderRequestAuditOptions | undefined {
  if (!options) return undefined
  return Schema.decodeUnknownSync(ProviderRequestAuditOptionsSchema, { onExcessProperty: "error" })({
    ...(options.openai ? { openai: omitUndefined({ parallel_tool_calls: options.openai.parallel_tool_calls, text_verbosity: options.openai.text_verbosity, reasoning_summary: options.openai.reasoning_summary, speed: options.openai.speed, service_tier: options.openai.service_tier }) } : {}),
    ...(options.anthropic ? { anthropic: omitUndefined({ thinking_display: options.anthropic.thinking_display, speed: options.anthropic.speed }) } : {}),
    ...(options.google ? { google: omitUndefined({ temperature: options.google.temperature, thinking_budgets: options.google.thinking_budgets }) } : {}),
    ...(options.openrouter ? { openrouter: omitUndefined({ ...options.openrouter }) } : {}),
  })
}

export const HistoricalProviderRequestToolSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  input_schema: UnknownRecordSchema,
})
export const ProviderRequestToolSchema = Schema.Struct({
  name: NonEmptyString,
  registrationId: NonEmptyString,
  executableId: NonEmptyString,
  description: Schema.String,
  input_schema: UnknownRecordSchema,
  kind: Schema.optionalKey(Schema.Union([Schema.Literal("function"), Schema.Literal("custom")])),
  inputFormatSha256: Schema.optionalKey(NonEmptyString),
})

export const ProviderRequestOmittedToolSchema = Schema.Struct({
  name: Schema.String,
  reason: Schema.String,
})

export const ProviderRequestOutcomeSchema = Schema.Union([
  Schema.Literal("ok"),
  Schema.Literal("aborted"),
  Schema.Literal("context_overflow"),
  Schema.Literal("output_overflow"),
  Schema.Literal("stream_error"),
  Schema.Literal("fatal_error"),
])

export const ProviderStreamTelemetrySourceSchema = Schema.Union([
  Schema.Literal("provider"),
  Schema.Literal("normalized"),
  Schema.Literal("watchdog"),
  Schema.Literal("request"),
])

const ProviderStreamInterDeltaSummarySchema = Schema.Struct({
  count: NonNegativeInt,
  meanMs: NonNegativeNumber,
  p50Ms: NonNegativeNumber,
  p90Ms: NonNegativeNumber,
  p99Ms: NonNegativeNumber,
  maxMs: NonNegativeNumber,
  ge1s: NonNegativeInt,
  ge2s: NonNegativeInt,
  ge5s: NonNegativeInt,
  ge10s: NonNegativeInt,
})

export const HistoricalProviderStreamSummarySchema = Schema.Struct({
  requestId: Schema.String,
  conversationId: Schema.String,
  turn: PositiveInt,
  rawEventCount: NonNegativeInt,
  startedAt: Schema.optionalKey(Schema.Number),
  completedAt: Schema.optionalKey(Schema.Number),
  durationMs: Schema.optionalKey(NonNegativeNumber),
  outcome: Schema.optionalKey(ProviderRequestOutcomeSchema),
  lastEventKind: Schema.optionalKey(Schema.String),
  countsBySource: Schema.Record(Schema.String, NonNegativeInt),
  countsByKind: Schema.Record(Schema.String, NonNegativeInt),
  firstVisibleDeltaMs: Schema.optionalKey(NonNegativeNumber),
  /** Peak main-thread event-loop lag observed during the stream (live
   *  recording only; maintenance-derived summaries omit it). Attributes a
   *  silent stream to loop starvation vs the wire in events:search. */
  loopLagMs: Schema.optionalKey(NonNegativeNumber),
  interDelta: ProviderStreamInterDeltaSummarySchema,
  watchdog: Schema.Struct({
    thinkingStallCount: NonNegativeInt,
    maxStallMs: Schema.optionalKey(NonNegativeNumber),
  }),
  recovery: Schema.Struct({
    streamRetryCount: NonNegativeInt,
    reasoningDisabledRetryCount: NonNegativeInt,
  }),
  bigGapTransitions: Schema.Array(Schema.Struct({
    transition: Schema.String,
    count: NonNegativeInt,
  })),
  prunedRawEvents: Schema.optionalKey(Schema.Struct({
    cutoffTimestamp: Schema.Number,
    firstPosition: NonNegativeInt,
    lastPosition: NonNegativeInt,
  })),
})
export const ProviderStreamSummaryV2Schema = Schema.Struct({
  requestId: Schema.String,
  identity: ProviderRequestIdentitySchema,
  turn: PositiveInt,
  rawEventCount: NonNegativeInt,
  startedAt: Schema.optionalKey(Schema.Number),
  completedAt: Schema.optionalKey(Schema.Number),
  durationMs: Schema.optionalKey(NonNegativeNumber),
  outcome: Schema.optionalKey(ProviderRequestOutcomeSchema),
  lastEventKind: Schema.optionalKey(Schema.String),
  countsBySource: Schema.Record(Schema.String, NonNegativeInt),
  countsByKind: Schema.Record(Schema.String, NonNegativeInt),
  firstVisibleDeltaMs: Schema.optionalKey(NonNegativeNumber),
  loopLagMs: Schema.optionalKey(NonNegativeNumber),
  interDelta: ProviderStreamInterDeltaSummarySchema,
  watchdog: Schema.Struct({
    thinkingStallCount: NonNegativeInt,
    maxStallMs: Schema.optionalKey(NonNegativeNumber),
  }),
  recovery: Schema.Struct({
    streamRetryCount: NonNegativeInt,
    reasoningDisabledRetryCount: NonNegativeInt,
  }),
  bigGapTransitions: Schema.Array(Schema.Struct({
    transition: Schema.String,
    count: NonNegativeInt,
  })),
  prunedRawEvents: Schema.optionalKey(Schema.Struct({
    cutoffTimestamp: Schema.Number,
    firstPosition: NonNegativeInt,
    lastPosition: NonNegativeInt,
  })),
})

const GenerationMeasurementSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("recorded"),
    basis: Schema.Literal("O200kBase"),
    outputTokens: NonNegativeInt,
    durationMs: NonNegativeNumber,
    measuredBlocks: NonNegativeInt,
    excludedBlocks: NonNegativeInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literals(["historical", "tokenizer-preparation-failed"]),
  }),
])
export type GenerationMeasurement = typeof GenerationMeasurementSchema.Type

export const ProviderStreamSummarySchema = Schema.Struct({
  ...ProviderStreamSummaryV2Schema.fields,
  generation: GenerationMeasurementSchema,
})

export const ProviderRequestErrorSchema = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  diagnostic: Schema.optionalKey(ProviderErrorDiagnosticSchema),
})

// Tier-1 tree pointer: where in the durable conversation tree this request's
// messages live. The reconstruction helper folds the tree up to `leafEntryId`
// to recover the exact model-visible history (historical-fold), so message
// bytes are never copied into the audit fact. Subagent requests omit this;
// their run facts carry inspectability.
export const ProviderRequestTreePointerSchema = Schema.Struct({
  conversationId: NonEmptyString,
  leafEntryId: Schema.NullOr(NonEmptyString),
})

// Stale tool-result masking applied to this request's outbound messages
// (agent-runtime/context/stale-tool-result-masker.ts). `promptSha256` covers
// the MASKED prompt (the bytes actually sent); reconstruction replays the mask
// over the tree-rebuilt messages via `maskedToolUseIds` before verifying.
export const PromptStaleMaskingSchema = Schema.Struct({
  cutoffIndex: NonNegativeInt,
  // Remove the optional historical shape after 2027-04-19. Startup converts
  // records without a zone from the first request's pressure.
  zone: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1), Schema.isLessThanOrEqualTo(2))),
  masksApplied: PositiveInt,
  bytesSaved: NonNegativeInt,
  maskedToolUseIds: Schema.Array(Schema.String),
  // Optional-key for reads only: facts recorded before tool-use input masking
  // existed carry no list. The writer always sets it.
  maskedToolUseInputIds: Schema.optionalKey(Schema.Array(Schema.String)),
})
export const PromptToolHistoryProjectionSchema = Schema.Struct({
  loweredToolUseIds: Schema.Array(Schema.String),
})
// What the shared lowering of provider history (agent-runtime/llm/provider-history.ts) withheld from this request's
// messages: request framing that the serving route does not read, and deliberation that another access provider,
// API, or model produced. `at` is the index of the message in the request's messages before the lowering, `block`
// the index of the content block that the edit changes, absent when the edit leaves out the whole message.
// `promptSha256` covers the lowered messages; reconstruction replays the edits after the tool-history projection.
export const PromptHistoryLoweringSchema = Schema.Struct({
  edits: Schema.Array(Schema.Struct({
    at: NonNegativeInt,
    block: Schema.optionalKey(NonNegativeInt),
    reason: Schema.Literals(["claude-framing", "model-framing", "agent-host-framing", "foreign-deliberation", "progress-as-text", "foreign-thought-signature", "image-limit"]),
  })),
})

export type ProviderRequestAuditTool = typeof ProviderRequestToolSchema.Type
export type HistoricalProviderRequestAuditTool = typeof HistoricalProviderRequestToolSchema.Type
export type ProviderRequestAuditOmittedTool = typeof ProviderRequestOmittedToolSchema.Type
export type ProviderRequestOutcome = typeof ProviderRequestOutcomeSchema.Type
type ProviderRequestTreePointer = typeof ProviderRequestTreePointerSchema.Type
export type PromptStaleMasking = typeof PromptStaleMaskingSchema.Type
export type PromptToolHistoryProjection = typeof PromptToolHistoryProjectionSchema.Type
export type PromptHistoryLowering = typeof PromptHistoryLoweringSchema.Type

type ProviderStreamTelemetrySource = typeof ProviderStreamTelemetrySourceSchema.Type
export type ProviderStreamSummary = typeof ProviderStreamSummarySchema.Type

/** One part that a transport between Flywheel's adapter and the service, such as an agent engine, added to a request
 *  beyond the request that the audit records. It names the part and never holds its content. */
const ProviderTransportAdditionSchema = Schema.Struct({
  /** Where the part stands: a system block, a message, a body field, or a header. */
  part: Schema.Literals(["system", "message", "body", "header"]),
  /** What the part is, in the transport's terms, such as `billing` or `reminder:environment`. */
  kind: NonEmptyString,
  /** The index of the system block, or of the recorded request's message that the part goes with. */
  at: Schema.optionalKey(NonNegativeInt),
  /** A short value that is no content, such as an effort level or a header's exact value. */
  value: Schema.optionalKey(Schema.String),
})

/** A model request that the transport sent by itself, which Flywheel did not admit. A field that the transport did
 *  not state is absent and reads as not recorded. */
const ProviderTransportHiddenRequestSchema = Schema.Struct({
  /** How the transport showed the request, and its own name for the code path that sent it. */
  source: NonEmptyString,
  /** The HTTP status of the request's answer. */
  status: Schema.optionalKey(Schema.Int),
  /** The input tokens that the request's answer stated. */
  inputTokens: Schema.optionalKey(NonNegativeInt),
})

/**
 * What a transport added to one request (ARCH-CONTEXT-008): the request that the audit records is the one that Flywheel
 * prepared, and the transport sent it with these additions. `hiddenRequests` are the requests that the transport sent
 * by itself since its previous record, so a person sees partial accounting as partial. `notRecorded` names each
 * addition that the transport makes but does not state, such as a count that its output does not show.
 */
export const ProviderTransportContextSchema = Schema.Struct({
  /** The transport that added them, such as `claude-engine`. */
  identity: NonEmptyString,
  additions: Schema.Array(ProviderTransportAdditionSchema),
  hiddenRequests: Schema.Array(ProviderTransportHiddenRequestSchema),
  notRecorded: Schema.Array(NonEmptyString),
})
export type ProviderTransportContext = typeof ProviderTransportContextSchema.Type
export type ProviderTransportAddition = typeof ProviderTransportAdditionSchema.Type
export type ProviderTransportHiddenRequest = typeof ProviderTransportHiddenRequestSchema.Type

export interface ProviderRequestAuditContextApplication {
  readonly identity: string
  readonly applications: readonly ModuleTransformerApplication[]
}

export function digestProviderRequestContextApplications(applications: readonly ModuleTransformerApplication[]): string {
  return createHash("sha256").update(JSON.stringify(applications)).digest("hex")
}

export interface ProviderRequestAuditRequestInput {
  requestId: string
  identity: ProviderRequestIdentity
  turn: number
  promptKind: string
  requestPurpose?: "compaction"
  systemPrompt: string
  messages: ReadonlyArray<unknown>
  messageCount: number
  estimatedContextTokens: number
  attemptStaticTokens: number
  contextWindow: number
  tools: ReadonlyArray<ProviderRequestAuditTool>
  omittedTools: ReadonlyArray<ProviderRequestAuditOmittedTool>
  interactionProfileId: ModelInteractionProfileId
  model: string
  accessProvider: string
  accessProviderCandidate?: AccessProviderCandidate
  catalogProvenance?: AccessProviderCatalogProvenance
  modelFamily: string
  reasoningEffort?: string
  cacheRetention?: string
  cacheKey?: string
  providerOptions?: ProviderRequestAuditOptions
  parentToolUseId?: string
  /** Durable conversation-tree leaf the assembled messages came from. Present
   *  for chat and workflow workers; absent for subagents. */
  treeLeafEntryId?: string | null
  staleMasking?: PromptStaleMasking
  toolHistoryProjection?: PromptToolHistoryProjection
  historyLowering?: PromptHistoryLowering
  /** Request-only user context, stored only in the audit fact for exact reconstruction. */
  requestContext?: string
  contextApplication?: ProviderRequestAuditContextApplication
}

export interface ProviderRequestAuditResponseInput {
  requestId: string
  identity: ProviderRequestIdentity
  turn: number
  outcome: ProviderRequestOutcome
  durationMs: number
  stopReason?: string
  responseId?: string
  error?: {
    tag: string
    message: string
    diagnostic?: ProviderErrorDiagnostic
  }
  transportContext?: ProviderTransportContext
}

export interface ProviderRequestUsageInput {
  requestId: string
  identity: ProviderRequestIdentity
  turn: number
  attemptId?: string
  workflowAttemptId?: string
  parentToolUseId?: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  reasoningTokens: number
  promptTokens: number
  deltaCostUsd: number
}

export interface ProviderStreamTelemetryStartedInput {
  requestId: string
  identity: ProviderRequestIdentity
  turn: number
}

export interface ProviderStreamTelemetryEventInput {
  requestId: string
  identity: ProviderRequestIdentity
  turn: number
  sequence: number
  source: ProviderStreamTelemetrySource
  kind: string
  elapsedMs: number
  sincePreviousMs: number
  metadata: StringMap<unknown>
}

/** The one diagnostic record of a provider request. It carries no identity:
 *  `requestId` joins it to the durable request facts. */
export interface ProviderStreamTelemetryCompletedInput {
  requestId: string
  turn: number
  durationMs: number
  eventCount: number
  outcome: ProviderRequestOutcome
  lastEventKind?: string
  /** Watchdog thinking stalls the stream went through. */
  stallCount: number
}

export interface ProviderStreamTelemetryEvent {
  sequence: number
  timestamp: number
  source: ProviderStreamTelemetrySource
  kind: string
  elapsedMs: number
  sincePreviousMs: number
  metadata: StringMap<unknown>
}

// Tier-1 Ref: the small, always-stored handle to a provider request. The
// projection ALWAYS returns this shape; it never reconstructs message bytes.
// Heavy bulk (messages, system prompt, tool surface) is referenced by the tree
// pointer plus content hashes and recovered on demand by the reconstruction
// helper, which verifies the result against `promptSha256`.
export interface ProviderRequestAuditEntry {
  requestId: string
  identity: ProviderRequestIdentity
  turn: number
  /** Version of the durable request identity contract. */
  auditVersion?: 1 | 2 | 3 | 4 | 5 | 6
  /** Time the durable request intent was committed, before provider I/O. */
  preparedAt?: number
  /** Time provider I/O was observed to begin. Absent means dispatch is ambiguous or did not occur. */
  dispatchedAt?: number
  /** Historical `model.requested` facts are prepared until dispatch evidence follows. */
  dispatchState?: "prepared" | "dispatched"
  /** Terminal evidence is absent after a crash or failed terminal write. */
  completionState?: "unknown" | "terminal"
  /** Dispatch time retained for chronology consumers. */
  requestedAt?: number
  respondedAt?: number
  prompt?: {
    promptKind: string
    requestPurpose?: "compaction"
    messageCount: number
    estimatedContextTokens: number
    /** Exact static cost of the final attempt prompt and provider definitions. */
    attemptStaticTokens?: number
    contextWindow: number
    promptSha256: string
    systemPromptHash: string
    toolSurfaceHash: string
    /** Absent for subagents; they record Tier-1 metadata only. */
    treePointer?: ProviderRequestTreePointer
    parentToolUseId?: string
    staleMasking?: PromptStaleMasking
    toolHistoryProjection?: PromptToolHistoryProjection
    historyLowering?: PromptHistoryLowering
    requestContext?: string
    contextApplicationId?: string
  }
  toolSurface?: {
    readonly tools: readonly (ProviderRequestAuditTool | HistoricalProviderRequestAuditTool)[]
    readonly omittedTools: readonly ProviderRequestAuditOmittedTool[]
  }
  contextApplications?: ModuleTransformerApplication[]
  request?: {
    model: string
    accessProvider: string
    modelFamily: string
    accessProviderCandidate?: AccessProviderCandidate
    catalogProvenance?: AccessProviderCatalogProvenance
    interactionProfileId?: RecordedInteractionProfileId
    reasoningEffort?: string
    cacheRetention?: string
    cacheKey?: string
    providerOptions?: unknown
  }
  response?: {
    outcome: ProviderRequestOutcome
    durationMs: number
    stopReason?: string
    responseId?: string
    error?: {
      tag: string
      message: string
      diagnostic?: ProviderErrorDiagnostic
    }
    /** What a transport added to the request. Absent for a direct request and for a response recorded before
     *  version 3 of `model.response_received`, which reads as not recorded. */
    transportContext?: ProviderTransportContext
  }
  usage?: {
    recordedAt?: number
    workflowAttemptId?: string
    parentToolUseId?: string
    /** How complete the provider's report was. Facts before version 5 of `model.usage.recorded` were complete.
     *  An unmeasured request has null tokens; a detail the provider did not report is null. */
    coverage: "complete" | "partial" | "unmeasured"
    inputTokens: number | null
    outputTokens: number | null
    cacheReadInputTokens: number | null
    cacheCreationInputTokens: number | null
    reasoningTokens: number | null
    promptTokens: number | null
    deltaCostUsd?: number
    attemptId?: string
  }
  stream?: {
    startedAt?: number
    completedAt?: number
    durationMs?: number
    eventCount?: number
    outcome?: ProviderRequestOutcome
    lastEventKind?: string
    events: ProviderStreamTelemetryEvent[]
    summary?: ProviderStreamSummary
  }
}
interface StringMap<T> { [key: string]: T }
