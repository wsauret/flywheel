import type { RuntimeAuthStatusScope } from "../auth-status-protocol-types.js"
import { Schema } from "effect"
import { type SubscriptionUsageMetric, type SubscriptionUsageSpendSource, SubscriptionUsageMetricSchema, SubscriptionUsageSpendSourceSchema } from "../../infra/llm/subscription-usage.js"
import { RuntimeAuthStatusScopeSchema } from "../auth-status-protocol-schemas.js"
import { defineProtocolModule, defineProtocolMutation, defineProtocolQuery, type ModuleRow } from "../protocol-module.js"
import { formatGenerationSpeed, GenerationStatisticsSchema, type GenerationStatistics } from "../generation-statistics.js"


export const USAGE_HISTORY_RANGES = ["24h", "7d", "Month", "All"] as const
export type UsageHistoryRange = (typeof USAGE_HISTORY_RANGES)[number]

export interface UsageProtocolMetadata {
  readonly profileId: string
  readonly authorityIncarnation: string
  readonly revision: number
  readonly generation: number
  readonly asOf: number
}

/** Current usage revision without aggregating recorded activity or checking providers. */
export interface UsageMetadataResult extends UsageProtocolMetadata { readonly kind: "usage.metadata" }

export interface UsageTokens {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly reasoning: number
  readonly total: number
}

/** How complete the usage evidence of a set of requests is. `attempts` counts measured requests, whose tokens the
 *  totals hold. `unmeasuredAttempts` were served without a usage report and add no tokens or money.
 *  `partialAttempts` are measured requests whose report ended early, so their tokens are lower bounds.
 *  `cacheComplete` is false when some measured request did not report its cache reads, so the cache totals and any
 *  hit rate are unknown. */
export interface UsageCoverageCounts {
  readonly attempts: number
  readonly unmeasuredAttempts: number
  readonly partialAttempts: number
  readonly cacheComplete: boolean
}

export interface UsageModelSummary extends UsageCoverageCounts {
  readonly model: string
  readonly tokens: UsageTokens
  readonly estimatedBilledUsd: number
  readonly includedValueUsd: number
  readonly priceUnavailable: boolean
}

interface UsageAccountWindowSummary extends UsageCoverageCounts {
  readonly tokens: UsageTokens
  readonly includedValueUsd: number
  readonly priceUnavailable: boolean
}
interface UsageAccountActivitySummary extends UsageAccountWindowSummary, UsagePeriodMetadata {
  readonly estimatedBilledUsd: number
}
type UsageAccountActivity =
  | ({ readonly state: "available" } & UsageAccountActivitySummary)
  | { readonly state: "ledger-unavailable" }
type UsageQuotaWindowAccounting =
  | ({ readonly state: "available"; readonly metricKey: string; readonly startMs: number; readonly endMs: number; readonly trackingStartMs: number; readonly partial: boolean } & UsageAccountWindowSummary)
  | { readonly state: "window-unavailable"; readonly metricKey: string }
export type UsageQuotaAccounting =
  | { readonly state: "available"; readonly windows: readonly UsageQuotaWindowAccounting[] }
  | { readonly state: "ledger-unavailable" }
  | { readonly state: "window-unavailable" }

interface UsageBankedResetCredit { readonly expiresAtMs?: number | null; readonly title?: string; readonly description?: string }
interface UsageBankedResets { readonly availableCount: number; readonly credits: readonly UsageBankedResetCredit[] }
/** Flywheel's own monthly cap on one pooled allowance metric. The provider reports no limit for a pooled allowance, so
 *  this cap is the only total a user can spend against, and request admission refuses the account once it is reached. */
interface UsageAllowanceCap { readonly metricKey: string; readonly value: number }
interface UsageSubscriptionObservationBase {
  readonly plan?: string
  readonly tier?: string
  readonly providerStatus: "ok" | "warning" | "exhausted" | "unknown"
  readonly observedAtMs: number
  readonly metrics: readonly SubscriptionUsageMetric[]
  readonly spendSources: readonly SubscriptionUsageSpendSource[]
}

export type UsageSubscriptionObservation =
  | (UsageSubscriptionObservationBase & { readonly state: "supported" })
  | (UsageSubscriptionObservationBase & { readonly state: "stale"; readonly message?: string })
  | (UsageSubscriptionObservationBase & { readonly state: "failure"; readonly message: string })
  | { readonly state: "failure"; readonly message: string }
  | { readonly state: "pending" }
  | { readonly state: "unsupported"; readonly message?: string }
  | { readonly state: "identity-unavailable"; readonly message?: string }
  | { readonly state: "expired-auth"; readonly message?: string }

interface UsageAccountSourceBase {
  readonly sourceId: string
  readonly providerId: string
  readonly label: string
  readonly active: true
  readonly activity: UsageAccountActivity
  /** The provider-side identity the credential signs in as: an email for ChatGPT, a login for GitHub Copilot. Shown so a
   *  user can tell which account a profile is actually reading, since two profiles can hold the same account. */
  readonly identity?: string
}

export type UsageAccountSource =
  | (UsageAccountSourceBase & { readonly kind: "subscription"; readonly quotaAccounting: UsageQuotaAccounting; readonly observation: UsageSubscriptionObservation; readonly bankedResets?: UsageBankedResets; readonly allowanceCap?: UsageAllowanceCap })
  /** `observation` is present only when the key's provider reports a balance, such as DeepSeek's prepaid credit. */
  | (UsageAccountSourceBase & { readonly kind: "metered"; readonly spendMode: "direct_api" | "aggregator"; readonly observation?: UsageSubscriptionObservation })

interface UsagePeriodMetadata {
  readonly startMs: number
  readonly endMs: number
  readonly trackingStartMs: number
  readonly partial: boolean
  readonly incomplete: boolean
}

export interface UsageAccountsResult extends UsageProtocolMetadata {
  readonly kind: "usage.accounts"
  readonly sources: readonly UsageAccountSource[]
}

interface UsageSpendSourceBase extends UsageCoverageCounts {
  readonly sourceId: string
  readonly label: string
  readonly active: boolean
  readonly spendModes: readonly ("included" | "prepaid" | "automatic" | "direct_api" | "aggregator")[]
  readonly tokens: UsageTokens
  readonly estimatedBilledUsd: number
  readonly includedValueUsd: number
  readonly priceUnavailable: boolean
  readonly models: readonly UsageModelSummary[]
}

export type UsageSpendSource =
  | (UsageSpendSourceBase & { readonly kind: "subscription"; readonly providerId: string })
  | (UsageSpendSourceBase & { readonly kind: "metered"; readonly providerId: string })
  | (UsageSpendSourceBase & { readonly kind: "unattributed" })

export interface UsageSpendResult extends UsageProtocolMetadata, UsagePeriodMetadata {
  readonly range: UsageHistoryRange
  readonly kind: "usage.spend"
  readonly estimatedBilledUsd: number
  readonly includedValueUsd: number
  readonly sources: readonly UsageSpendSource[]
}

export type UsageStatsSummary = Omit<UsageModelSummary, "model">

export interface UsageToolStats {
  readonly name: string
  readonly calls: number
  readonly errors: number
  readonly blocked: number
  readonly cancelled: number
  readonly interrupted: number
  readonly stopped: number
}

export interface UsageSessionStats {
  readonly sessionId: string
  readonly asOf: number
  readonly partial: boolean
  readonly descendantCount: number
  readonly direct: UsageStatsSummary
  readonly descendants: UsageStatsSummary
  readonly totals: UsageStatsSummary
  readonly models: readonly UsageModelSummary[]
  readonly tools: readonly UsageToolStats[]
  readonly generation: GenerationStatistics
}

/** Provider-reported prompt volume. Writes are uncached input, not cache hits;
 * output is kept separate because reasoning can overlap it. No input has no rate. */
export function usageTokenBreakdown(tokens: Pick<UsageTokens, "input" | "output" | "cacheRead" | "cacheWrite">) {
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite
  return {
    input,
    cached: tokens.cacheRead,
    uncached: tokens.input + tokens.cacheWrite,
    cacheWrite: tokens.cacheWrite,
    output: tokens.output,
    cacheHitRate: input > 0 ? tokens.cacheRead / input : null,
  }
}

/** Why cache detail reads as unavailable: history from before per-request accounting, or a provider that did not
 *  report cache reads for some request. */
export const USAGE_CACHE_UNAVAILABLE_REASON = "not reported for every request"

/** Request coverage beside a token reading, such as `12 measured requests (1 partial) · 2 unmeasured`. A partial
 *  request is a measured one, so it appears inside the measured count. Each qualifier appears only when it is not 0. */
export function usageCoverageText(counts: UsageCoverageCounts): string {
  const partial = counts.partialAttempts > 0 ? ` (${counts.partialAttempts.toLocaleString("en-US")} partial)` : ""
  return [
    `${counts.attempts.toLocaleString("en-US")} measured requests${partial}`,
    ...(counts.unmeasuredAttempts > 0 ? [`${counts.unmeasuredAttempts.toLocaleString("en-US")} unmeasured`] : []),
  ].join(" · ")
}

/** Adds the coverage of several readings. */
export function sumUsageCoverage(values: readonly UsageCoverageCounts[]): UsageCoverageCounts {
  return values.reduce((sum, value) => ({
    attempts: sum.attempts + value.attempts,
    unmeasuredAttempts: sum.unmeasuredAttempts + value.unmeasuredAttempts,
    partialAttempts: sum.partialAttempts + value.partialAttempts,
    cacheComplete: sum.cacheComplete && value.cacheComplete,
  }), { attempts: 0, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true })
}

/** Shared comparison readings and coverage copy for descendant-scoped Stats. */
export function generationSpeedLines(generation: GenerationStatistics) {
  const { totals } = generation
  const rows = generation.models.map((model) => ({
    label: `${model.model} · ${model.reasoningEffort ?? "not recorded"}`,
    value: formatGenerationSpeed(model.averageTokensPerSecond) || "Not measured",
  }))
  if (!rows.length) rows.push({ label: "Generation speed", value: formatGenerationSpeed(totals.averageTokensPerSecond) || "Not measured" })
  const coverageLines = [
    `${totals.measuredRequests.toLocaleString("en-US")} measured requests · ${totals.unmeasuredRequests.toLocaleString("en-US")} known unmeasured requests · ${totals.excludedBlocks.toLocaleString("en-US")} excluded output blocks`,
  ]
  if (!generation.coverageComplete) {
    coverageLines.push("Some output has no measurement. Historical request coverage can be unknown.", "Single-chunk output has no measurable streaming duration. Historical requests are not backfilled.")
  }
  return {
    rows, coverageLines,
    basisLine: "O200kBase local comparison tokens. Assistant text and streamed tool arguments only. Not billed provider tokens.",
  }
}

/** Sum reported buckets before deriving ratios, so large requests carry their
 * actual weight. The total field keeps its existing accounting meaning. */
export function sumUsageTokens(values: readonly UsageTokens[]): UsageTokens {
  return values.reduce((sum, value) => ({
    input: sum.input + value.input,
    output: sum.output + value.output,
    cacheRead: sum.cacheRead + value.cacheRead,
    cacheWrite: sum.cacheWrite + value.cacheWrite,
    reasoning: sum.reasoning + value.reasoning,
    total: sum.total + value.total,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 })
}

/** One cache reading and recovery destination shared by client Status views. */
export function usageStatsStatusRow(stats: UsageSessionStats | undefined): ModuleRow {
  let value = "Unavailable"
  if (stats) {
    const rate = usageTokenBreakdown(stats.totals.tokens).cacheHitRate
    value = stats.totals.cacheComplete
      ? `${rate === null ? "No usage yet" : `${(rate * 100).toFixed(1)}% of reported input`}${stats.partial ? " · partial" : ""}`
      : `Unavailable · ${USAGE_CACHE_UNAVAILABLE_REASON}`
  }
  return { id: USAGE_STATS_SURFACE, label: "Cache", value, action: { kind: "surface", id: USAGE_STATS_SURFACE } }
}



interface UsageHistoryResetMarker {
  readonly metricName: string
  readonly resetId: string
  readonly resetAtMs?: number
  readonly observedAtMs: number
}

interface UsageHistorySample {
  readonly hourStartMs: number
  readonly observedAtMs: number
  readonly plan?: string
  readonly tier?: string
  readonly providerStatus: "ok" | "warning" | "exhausted" | "unknown"
  readonly metrics: readonly SubscriptionUsageMetric[]
  readonly spendSources: readonly SubscriptionUsageSpendSource[]
}

/** What one hour of the ledger cost on a source: what was billed and what a
 *  subscription covered. Summed forward, it is spend over time. */
export interface UsageSpendPoint {
  readonly hourStartMs: number
  readonly billedUsd: number
  readonly includedUsd: number
}

export interface UsageHistorySource {
  readonly sourceId: string
  readonly kind: "subscription" | "metered"
  readonly providerId: string
  readonly label: string
  readonly plan?: string
  readonly tier?: string
  readonly providerStatus?: "ok" | "warning" | "exhausted" | "unknown"
  readonly spendSources: readonly SubscriptionUsageSpendSource[]
  readonly count: number
  readonly samples: readonly UsageHistorySample[]
  readonly latest: readonly SubscriptionUsageMetric[]
  readonly peak: readonly SubscriptionUsageMetric[]
  readonly resetMarkers: readonly UsageHistoryResetMarker[]
  /** Spend in the range by hour, oldest first. A metered account has only this. */
  readonly spend: readonly UsageSpendPoint[]
}

export interface UsageHistoryResult extends UsageProtocolMetadata {
  readonly kind: "usage.history"
  readonly range: UsageHistoryRange
  readonly startMs: number
  readonly endMs: number
  readonly sources: readonly UsageHistorySource[]
}

export interface UsageAccountsQuery { readonly scope: RuntimeAuthStatusScope; readonly asOf?: number; readonly freshnessMs?: number }
export interface UsageSpendQuery { readonly scope: RuntimeAuthStatusScope; readonly range?: UsageHistoryRange; readonly asOf?: number }
export interface UsageHistoryQuery { readonly scope: RuntimeAuthStatusScope; readonly range: UsageHistoryRange; readonly asOf?: number }
export interface UsageOpenMutation { readonly scope: RuntimeAuthStatusScope; readonly freshnessMs?: number }
export type UsageMutationResult = { readonly ok: true; readonly usage: UsageProtocolMetadata } | { readonly ok: false; readonly error: string }
export interface UsageApplyResetMutation { readonly scope: RuntimeAuthStatusScope; readonly sourceId: string; readonly authorityIncarnation: string; readonly revision: number; readonly redeemRequestId: string }
export type UsageApplyResetResult = { readonly kind: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" | "uncertain" | "stale" }


const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const NonNegativeFinite = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
const ProviderStatusSchema = Schema.Literals(["ok", "warning", "exhausted", "unknown"])
const SpendModeSchema = Schema.Literals(["included", "prepaid", "automatic", "direct_api", "aggregator"])

const UsageProtocolMetadataSchema = Schema.Struct({
  profileId: Schema.NonEmptyString,
  authorityIncarnation: Schema.NonEmptyString,
  revision: NonNegativeInt,
  generation: NonNegativeInt,
  asOf: NonNegativeInt,
})

const UsageTokensSchema = Schema.Struct({ input: NonNegativeInt, output: NonNegativeInt, cacheRead: NonNegativeInt, cacheWrite: NonNegativeInt, reasoning: NonNegativeInt, total: NonNegativeInt })
const UsageCoverageCountsFields = { attempts: NonNegativeInt, unmeasuredAttempts: NonNegativeInt, partialAttempts: NonNegativeInt, cacheComplete: Schema.Boolean }
const UsageModelSummarySchema = Schema.Struct({ model: Schema.NonEmptyString, ...UsageCoverageCountsFields, tokens: UsageTokensSchema, estimatedBilledUsd: NonNegativeFinite, includedValueUsd: NonNegativeFinite, priceUnavailable: Schema.Boolean })
const UsageStatsSummarySchema = Schema.Struct({ ...UsageCoverageCountsFields, tokens: UsageTokensSchema, estimatedBilledUsd: NonNegativeFinite, includedValueUsd: NonNegativeFinite, priceUnavailable: Schema.Boolean })
const UsageToolStatsSchema = Schema.Struct({ name: Schema.NonEmptyString, calls: NonNegativeInt, errors: NonNegativeInt, blocked: NonNegativeInt, cancelled: NonNegativeInt, interrupted: NonNegativeInt, stopped: NonNegativeInt })
const UsageSessionStatsSchema: Schema.Codec<UsageSessionStats> = Schema.Struct({
  sessionId: Schema.NonEmptyString, asOf: NonNegativeInt, partial: Schema.Boolean, descendantCount: NonNegativeInt,
  direct: UsageStatsSummarySchema, descendants: UsageStatsSummarySchema, totals: UsageStatsSummarySchema,
  models: Schema.Array(UsageModelSummarySchema), tools: Schema.Array(UsageToolStatsSchema),
  generation: GenerationStatisticsSchema,
})
const UsageAccountWindowSummarySchema = Schema.Struct({ ...UsageCoverageCountsFields, tokens: UsageTokensSchema, includedValueUsd: NonNegativeFinite, priceUnavailable: Schema.Boolean })
const UsagePeriodMetadataSchema = Schema.Struct({ startMs: NonNegativeInt, endMs: NonNegativeInt, trackingStartMs: NonNegativeInt, partial: Schema.Boolean, incomplete: Schema.Boolean })
const AvailableUsageAccountActivitySchema = UsageAccountWindowSummarySchema
  .pipe(Schema.fieldsAssign(UsagePeriodMetadataSchema.fields), Schema.fieldsAssign({ state: Schema.Literal("available"), estimatedBilledUsd: NonNegativeFinite }))
  .pipe(Schema.refine((value): value is typeof value => value.startMs <= value.endMs, { message: "expected an ordered half-open activity range" }))
const UsageAccountActivitySchema = Schema.Union([
  AvailableUsageAccountActivitySchema,
  Schema.Struct({ state: Schema.Literal("ledger-unavailable") }),
])
const AvailableUsageQuotaAccountingSchema = UsageAccountWindowSummarySchema.pipe(
  Schema.fieldsAssign({ state: Schema.Literal("available"), metricKey: Schema.NonEmptyString, startMs: NonNegativeInt, endMs: NonNegativeInt, trackingStartMs: NonNegativeInt, partial: Schema.Boolean }),
  Schema.refine((value): value is typeof value => value.startMs < value.endMs, { message: "expected a non-empty half-open quota window" }),
)
const UsageQuotaWindowAccountingSchema = Schema.Union([
  AvailableUsageQuotaAccountingSchema,
  Schema.Struct({ state: Schema.Literal("window-unavailable"), metricKey: Schema.NonEmptyString }),
])
const UsageQuotaAccountingSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("available"), windows: Schema.Array(UsageQuotaWindowAccountingSchema) }),
  Schema.Struct({ state: Schema.Literal("ledger-unavailable") }),
  Schema.Struct({ state: Schema.Literal("window-unavailable") }),
])
const UsageSubscriptionObservationBaseSchema = Schema.Struct({ plan: Schema.optionalKey(Schema.String), tier: Schema.optionalKey(Schema.String), providerStatus: ProviderStatusSchema, observedAtMs: NonNegativeInt, metrics: Schema.Array(SubscriptionUsageMetricSchema), spendSources: Schema.Array(SubscriptionUsageSpendSourceSchema) })
const UsageSubscriptionObservationSchema = Schema.Union([
  UsageSubscriptionObservationBaseSchema.pipe(Schema.fieldsAssign({ state: Schema.Literal("supported") })),
  UsageSubscriptionObservationBaseSchema.pipe(Schema.fieldsAssign({ state: Schema.Literal("stale"), message: Schema.optionalKey(Schema.String) })),
  UsageSubscriptionObservationBaseSchema.pipe(Schema.fieldsAssign({ state: Schema.Literal("failure"), message: Schema.String })),
  Schema.Struct({ state: Schema.Literal("failure"), message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("pending") }),
  Schema.Struct({ state: Schema.Literal("unsupported"), message: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ state: Schema.Literal("identity-unavailable"), message: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ state: Schema.Literal("expired-auth"), message: Schema.optionalKey(Schema.String) }),
])
const UsageBankedResetCreditSchema = Schema.Struct({ expiresAtMs: Schema.optionalKey(Schema.NullOr(NonNegativeInt)), title: Schema.optionalKey(Schema.String), description: Schema.optionalKey(Schema.String) })
const UsageBankedResetsSchema = Schema.Struct({ availableCount: NonNegativeInt, credits: Schema.Array(UsageBankedResetCreditSchema) })
const UsageAllowanceCapSchema = Schema.Struct({ metricKey: Schema.NonEmptyString, value: NonNegativeFinite })
const UsageAccountSourceBaseSchema = Schema.Struct({ sourceId: Schema.NonEmptyString, providerId: Schema.NonEmptyString, label: Schema.NonEmptyString, active: Schema.Literal(true), activity: UsageAccountActivitySchema, identity: Schema.optionalKey(Schema.NonEmptyString) })
const UsageAccountSourceSchema = Schema.Union([
  UsageAccountSourceBaseSchema.pipe(Schema.fieldsAssign({ kind: Schema.Literal("subscription"), quotaAccounting: UsageQuotaAccountingSchema, observation: UsageSubscriptionObservationSchema, bankedResets: Schema.optionalKey(UsageBankedResetsSchema), allowanceCap: Schema.optionalKey(UsageAllowanceCapSchema) })),
  UsageAccountSourceBaseSchema.pipe(Schema.fieldsAssign({ kind: Schema.Literal("metered"), spendMode: Schema.Literals(["direct_api", "aggregator"]), observation: Schema.optionalKey(UsageSubscriptionObservationSchema) })),
])
export const UsageAccountsResultSchema: Schema.Codec<UsageAccountsResult> = UsageProtocolMetadataSchema.pipe(Schema.fieldsAssign({ kind: Schema.Literal("usage.accounts"), sources: Schema.Array(UsageAccountSourceSchema) }))

const UsageSpendSourceBaseSchema = Schema.Struct({ sourceId: Schema.NonEmptyString, label: Schema.NonEmptyString, active: Schema.Boolean, spendModes: Schema.Array(SpendModeSchema), ...UsageCoverageCountsFields, tokens: UsageTokensSchema, estimatedBilledUsd: NonNegativeFinite, includedValueUsd: NonNegativeFinite, priceUnavailable: Schema.Boolean, models: Schema.Array(UsageModelSummarySchema) })
const UsageSpendSourceSchema = Schema.Union([
  UsageSpendSourceBaseSchema.pipe(Schema.fieldsAssign({ kind: Schema.Literal("subscription"), providerId: Schema.NonEmptyString })),
  UsageSpendSourceBaseSchema.pipe(Schema.fieldsAssign({ kind: Schema.Literal("metered"), providerId: Schema.NonEmptyString })),
  UsageSpendSourceBaseSchema.pipe(Schema.fieldsAssign({ kind: Schema.Literal("unattributed") })),
])
const UsageSpendResultSchema: Schema.Codec<UsageSpendResult> = UsageProtocolMetadataSchema.pipe(Schema.fieldsAssign(UsagePeriodMetadataSchema.fields), Schema.fieldsAssign({ kind: Schema.Literal("usage.spend"), range: Schema.Literals(USAGE_HISTORY_RANGES), estimatedBilledUsd: NonNegativeFinite, includedValueUsd: NonNegativeFinite, sources: Schema.Array(UsageSpendSourceSchema) }))

const UsageHistoryResetMarkerSchema = Schema.Struct({ metricName: Schema.NonEmptyString, resetId: Schema.NonEmptyString, resetAtMs: Schema.optionalKey(NonNegativeInt), observedAtMs: NonNegativeInt })
const UsageHistorySampleSchema = Schema.Struct({ hourStartMs: NonNegativeInt, observedAtMs: NonNegativeInt, plan: Schema.optionalKey(Schema.String), tier: Schema.optionalKey(Schema.String), providerStatus: ProviderStatusSchema, metrics: Schema.Array(SubscriptionUsageMetricSchema), spendSources: Schema.Array(SubscriptionUsageSpendSourceSchema) })
const UsageSpendPointSchema = Schema.Struct({ hourStartMs: NonNegativeInt, billedUsd: Schema.Number, includedUsd: Schema.Number })
const UsageHistorySourceSchema = Schema.Struct({ sourceId: Schema.NonEmptyString, kind: Schema.Literals(["subscription", "metered"]), providerId: Schema.NonEmptyString, label: Schema.NonEmptyString, plan: Schema.optionalKey(Schema.String), tier: Schema.optionalKey(Schema.String), providerStatus: Schema.optionalKey(ProviderStatusSchema), spendSources: Schema.Array(SubscriptionUsageSpendSourceSchema), count: NonNegativeInt, samples: Schema.Array(UsageHistorySampleSchema), latest: Schema.Array(SubscriptionUsageMetricSchema), peak: Schema.Array(SubscriptionUsageMetricSchema), resetMarkers: Schema.Array(UsageHistoryResetMarkerSchema), spend: Schema.Array(UsageSpendPointSchema) })
const UsageHistoryResultSchema: Schema.Codec<UsageHistoryResult> = UsageProtocolMetadataSchema.pipe(Schema.fieldsAssign({ kind: Schema.Literal("usage.history"), range: Schema.Literals(USAGE_HISTORY_RANGES), startMs: NonNegativeInt, endMs: NonNegativeInt, sources: Schema.Array(UsageHistorySourceSchema) }))

const UsageAccountsQueryFields = { scope: RuntimeAuthStatusScopeSchema, asOf: Schema.optionalKey(NonNegativeInt), freshnessMs: Schema.optionalKey(NonNegativeInt) }
const UsageSpendQueryFields = { scope: RuntimeAuthStatusScopeSchema, range: Schema.optionalKey(Schema.Literals(USAGE_HISTORY_RANGES)), asOf: Schema.optionalKey(NonNegativeInt) }
const UsageHistoryQueryFields = { scope: RuntimeAuthStatusScopeSchema, range: Schema.Literals(USAGE_HISTORY_RANGES), asOf: Schema.optionalKey(NonNegativeInt) }
const UsageOpenMutationFields = { scope: RuntimeAuthStatusScopeSchema, freshnessMs: Schema.optionalKey(NonNegativeInt) }
const UsageRefreshMutationFields = { scope: RuntimeAuthStatusScopeSchema }
const UsageApplyResetMutationFields = { scope: RuntimeAuthStatusScopeSchema, sourceId: Schema.NonEmptyString, authorityIncarnation: Schema.NonEmptyString, revision: NonNegativeInt, redeemRequestId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)) }
const UsageApplyResetResultSchema: Schema.Codec<UsageApplyResetResult> = Schema.Struct({ kind: Schema.Literals(["reset", "nothingToReset", "noCredit", "alreadyRedeemed", "uncertain", "stale"]) })
const UsageMutationResultSchema: Schema.Codec<UsageMutationResult> = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), usage: UsageProtocolMetadataSchema }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])


/** The surface both clients open for profile-scoped accounting and provider observations. */
export const USAGE_SURFACE = "usage"
export const USAGE_COMMAND = "usage"
/** The command's one name, which its surface also heads with. */
export const USAGE_COMMAND_NAME = "Usage"
export const USAGE_STATS_SURFACE = "usage-stats"
export const USAGE_STATS_COMMAND = "stats"
export const USAGE_STATS_COMMAND_NAME = "Stats"
export const USAGE_SPEND_SURFACE = "usage-spend"

/** Usage reads are parameterized and have no live cursor. The module owns
 *  their codecs and policies alongside the mutations that refresh observations. */
export const subscriptionUsageProtocol = defineProtocolModule({
  id: "subscription-usage",
  domains: [],
  queries: [
    defineProtocolQuery({ query: "usage.metadata", input: { scope: RuntimeAuthStatusScopeSchema }, result: UsageProtocolMetadataSchema.pipe(Schema.fieldsAssign({ kind: Schema.Literal("usage.metadata") })), deadline: "control" }),
    defineProtocolQuery({ query: "usage.stats", input: { sessionId: Schema.NonEmptyString }, result: UsageSessionStatsSchema, deadline: "control" }),
    defineProtocolQuery({ query: "usage.accounts", input: UsageAccountsQueryFields, result: UsageAccountsResultSchema, deadline: "control" }),
    defineProtocolQuery({ query: "usage.spend", input: UsageSpendQueryFields, result: UsageSpendResultSchema, deadline: "control" }),
    defineProtocolQuery({ query: "usage.history", input: UsageHistoryQueryFields, result: UsageHistoryResultSchema, deadline: "control" }),
  ],
  mutations: [
    defineProtocolMutation({ type: "usage.open", fields: UsageOpenMutationFields, result: UsageMutationResultSchema, policy: "lossless" }),
    defineProtocolMutation({ type: "usage.refresh", fields: UsageRefreshMutationFields, result: UsageMutationResultSchema, policy: "lossless" }),
    defineProtocolMutation({ type: "usage.apply_reset", fields: UsageApplyResetMutationFields, result: UsageApplyResetResultSchema, policy: "lossless" }),
  ],
})

/** Current-month spend as one declarative status row. A missing authority
 *  contributes no reading, so unavailable accounting never appears as zero. */
export function subscriptionUsageStatusRows(result: UsageSpendResult | undefined): readonly ModuleRow[] {
  if (!result || result.authorityIncarnation === "unavailable") return []
  return [{ id: "subscription-usage", label: "Usage", value: `$${result.estimatedBilledUsd.toFixed(2)} this month`, action: { kind: "surface", id: USAGE_SURFACE } }]
}


/** Usage history as every client draws it: one series per window the
 *  provider still reports that saw use in the range, and spend over the
 *  range as one more series. The web charts a series as a line and the
 *  terminal as a sparkline, from the same points, so a window that is
 *  worth showing on one client is worth showing on the other. */

type UsageMetric = UsageHistorySource["latest"][number]
type Value = NonNullable<UsageMetric["used"]>
type ProviderStatus = NonNullable<UsageHistorySource["providerStatus"]>

type UsageSeriesTone = "warn" | "error"

interface HistoryPoint {
  readonly atMs: number
  readonly fraction: number
}

/** One window's use over a range: a point per hourly sample that carried a
 *  usable reading, the provider's resets inside the range, and the latest and
 *  peak readings as the person reads them. */
export interface HistorySeries {
  readonly metricKey: string
  readonly label: string
  readonly points: readonly HistoryPoint[]
  readonly resets: readonly number[]
  readonly latest: string
  readonly peak?: string
  readonly tone?: UsageSeriesTone
}

/** A window the provider classified as detail most readers never need; both
 *  clients hide it until asked. */
export function isDetailWindow(metric: Pick<UsageMetric, "detail">): boolean {
  return metric.detail === true
}

function sameUnit(left: Value | undefined, right: Value | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return false
  if (left.kind === "count" && right.kind === "count") return left.unit === right.unit
  if (left.kind === "money" && right.kind === "money") return left.currency === right.currency
  return true
}

/** How much of a metric is used, between 0 and 1, from whichever pair the
 *  provider reported, else against a cap of Flywheel's own; nothing when
 *  neither gives a usable pair. */
export function usageFraction(metric: UsageMetric, cap: number | undefined): number | undefined {
  let fraction: number | undefined
  if (metric.usedFraction !== undefined) fraction = metric.usedFraction
  else if (sameUnit(metric.used, metric.limit) && metric.used && metric.limit && metric.limit.value > 0) fraction = metric.used.value / metric.limit.value
  else if (sameUnit(metric.remaining, metric.limit) && metric.remaining && metric.limit && metric.limit.value > 0) fraction = 1 - metric.remaining.value / metric.limit.value
  else if (cap !== undefined && cap > 0 && metric.used?.kind === "count") fraction = metric.used.value / cap
  return fraction === undefined ? undefined : Math.max(0, Math.min(1, fraction))
}

function formatValue(value: Value): string {
  switch (value.kind) {
    case "percentage":
      return `${Math.round(value.value * 100)}%`
    case "money":
      return value.value.toLocaleString("en-US", { style: "currency", currency: value.currency })
    case "count":
      return `${value.value.toLocaleString("en-US")} ${value.unit}`
  }
}

/** A window's reading in words: its fraction when one is known, else the
 *  value the provider sent. */
function latestReading(metric: UsageMetric): string {
  const fraction = usageFraction(metric, undefined)
  if (fraction !== undefined) return `${Math.round(fraction * 100)}% used`
  if (metric.used !== undefined && metric.limit !== undefined) return `${formatValue(metric.used)} of ${formatValue(metric.limit)}`
  if (metric.remaining !== undefined) return `${formatValue(metric.remaining)} left`
  if (metric.used !== undefined) return `${formatValue(metric.used)} used`
  return "No reading"
}

function tone(metric: UsageMetric, status: ProviderStatus, fraction: number | undefined): UsageSeriesTone | undefined {
  if (metric.providerStatus === "exhausted" || status === "exhausted" || fraction === 1) return "error"
  if (metric.providerStatus === "warning" || status === "warning") return "warn"
  return undefined
}

/** The prepaid balances an observation reports, in the provider's order: what
 *  is left of each funded balance, else one line saying none is left. Empty
 *  when the provider reported no prepaid balance. An account row shows the
 *  first line; the open account shows them all. */
export function prepaidBalances(observation: UsageSubscriptionObservation): readonly string[] {
  if (!("spendSources" in observation)) return []
  const prepaid = observation.spendSources.filter((source) => source.kind === "prepaid")
  const funded = prepaid.flatMap((source) => source.availability === "funded" && source.remaining !== undefined ? [`${formatValue(source.remaining)} left`] : [])
  if (funded.length > 0) return funded
  return prepaid.some((source) => source.availability === "empty") ? ["No balance left"] : []
}

export function formatUsd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

/** The windows a history source reports, over the range the result covers:
 *  the ones the provider named in its newest reading, because a key it has
 *  stopped using is a retired spelling, not a window, and among those the
 *  ones that saw any use in the range, because an untouched reserve window
 *  is an empty chart. The first window stays whatever it saw, so a source is
 *  never blank. */
export function historySeries(source: UsageHistorySource, showDetail: boolean): readonly HistorySeries[] {
  const status = source.providerStatus ?? "unknown"
  const current = new Set(source.samples.at(-1)?.metrics.map((metric) => metric.metricKey) ?? source.latest.map((metric) => metric.metricKey))
  const peakOf = (key: string) => {
    const peak = source.peak.find((candidate) => candidate.metricKey === key)
    return peak === undefined ? undefined : usageFraction(peak, undefined)
  }
  return source.latest
    .filter((metric) => current.has(metric.metricKey) && (showDetail || !isDetailWindow(metric)))
    .toSorted((left, right) => left.rank - right.rank)
    .filter((metric, index) => index === 0 || (peakOf(metric.metricKey) ?? 0) > 0)
    .map((metric): HistorySeries => {
      const points = source.samples.flatMap((sample): HistoryPoint[] => {
        const reading = sample.metrics.find((candidate) => candidate.metricKey === metric.metricKey)
        const fraction = reading === undefined ? undefined : usageFraction(reading, undefined)
        return fraction === undefined ? [] : [{ atMs: sample.hourStartMs, fraction }]
      })
      const fraction = usageFraction(metric, undefined)
      const peakFraction = peakOf(metric.metricKey)
      const seriesTone = tone(metric, status, fraction)
      return {
        metricKey: metric.metricKey,
        label: metric.label,
        points,
        resets: source.resetMarkers.flatMap((marker) => (marker.metricName === metric.metricKey && marker.resetAtMs !== undefined ? [marker.resetAtMs] : [])),
        latest: latestReading(metric),
        ...(peakFraction === undefined ? {} : { peak: `${Math.round(peakFraction * 100)}% peak` }),
        ...(seriesTone === undefined ? {} : { tone: seriesTone }),
      }
    })
}

/** Spend over the range as a series: the billed total climbing hour by hour
 *  for a metered key, and for a subscription only when something was billed
 *  beyond the plan, since its windows already show the plan's use. Nothing
 *  when nothing was billed, so the client can say so instead. */
export function spendSeries(source: UsageHistorySource, startMs: number): readonly HistorySeries[] {
  const billed = source.spend.reduce((total, point) => total + point.billedUsd, 0)
  if (billed <= 0) return []
  let running = 0
  const points = source.spend.map((point): HistoryPoint => ({ atMs: point.hourStartMs, fraction: (running += point.billedUsd) / billed }))
  return [{
    metricKey: "spend",
    label: source.kind === "metered" ? "Spend" : "Billed beyond the plan",
    points: [{ atMs: startMs, fraction: 0 }, ...points],
    resets: [],
    latest: `${formatUsd(billed)} in range`,
  }]
}
