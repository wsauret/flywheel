import { createEventProjection, parseProjectionFact, type EventProjection } from "../../infra/event-projection.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { durableOwnerAggregate, type DurableOwner } from "../../infra/durable-owner.js"
import type { AsyncEventReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { computeContextPercent, type BudgetMetrics, type ContextUtilization } from "./budget-store-types.js"
import { parseSessionRuntimeFact, type SessionRuntimeFact } from "./session-runtime-event-types.js"
import { currentUsageMeasurement } from "../../infra/runtime-fact-types.js"

// `type` (not `interface`) so the shape carries the implicit index signature
// `createEventProjection` requires of a projection state.
export type BudgetProjectionState = {
  totalCost: number
  // Metered (API-key) portion of totalCost; the remainder is
  // subscription-covered API-equivalent value.
  totalBilledCost: number
  priceUnavailable: boolean
  // Sums of the tokens providers reported. A partial entry adds its lower bounds.
  totalInputTokens: number
  totalOutputTokens: number
  // Served requests whose provider reported no usage; they add no tokens or money.
  unmeasuredRequests: number
  invocationsUsed: number
  contextPromptTokens: number
  contextWindow: number
  // Last-seen cumulative counter per runner stream. The session runner,
  // subagents, and background reviews have distinct keys, so interleaved
  // readings never corrupt each other's baselines.
  streamBaselines: StringMap<StreamBaseline>
  // Committed usage entries are deltas and deduplicate independently of the
  // historical cumulative runner streams.
  settledUsageEntryIds: StringMap<true>
  // A committed entry is the accounting authority for the matching terminal
  // stream. Terminal facts do not carry budgetStreamId, so parentage is the join.
  committedUsageStreams: StringMap<true>
}

type StreamBaseline = {
  cost: number
  billedCost: number
  inputTokens: number
  outputTokens: number
}

const SESSION_STREAM = ""
const ZERO_BASELINE: StreamBaseline = { cost: 0, billedCost: 0, inputTokens: 0, outputTokens: 0 }

export function createBudgetProjection(
  reader: AsyncEventReadSurface,
  owner: string | DurableOwner | { readonly kind: "historical-residual"; readonly aggregateId: string },
): EventProjection<BudgetProjectionState> {
  const aggregateId = typeof owner !== "string" && owner.kind === "historical-residual" ? owner.aggregateId
    : durableOwnerAggregate(typeof owner === "string" ? { kind: "session", sessionId: owner } : owner)
  return heldProjection(reader, `budget:${aggregateId}`, () => createEventProjection(reader, {
    aggregateId,
    factTypes: BUDGET_FACT_TYPES,
    initialState: initialBudgetProjectionState,
    ...draftedBudgetFold(),
    foldsPushedFacts: true,
  }))
}

/** The held projection's fold. A draft copies each id set once, at its first
 *  committed usage entry, so a pushed fact of another type copies nothing. */
function draftedBudgetFold() {
  let drafted = new WeakSet<object>()
  return {
    draft(state: BudgetProjectionState): BudgetProjectionState {
      drafted = new WeakSet()
      return { ...state }
    },
    reduce: (state: BudgetProjectionState, event: StoredFact) => foldBudgetFact(state, parseProjectionFact(event, parseSessionRuntimeFact), drafted),
  }
}

export const BUDGET_FACT_TYPES = [
  "budget.process.started",
  "budget.invocation.recorded",
  "budget.stream.completed",
  "model.context.measured",
  "model.usage.measured",
  "model.turn.completed",
] as const

export function budgetMetricsFromProjection(state: BudgetProjectionState): BudgetMetrics {
  return {
    tokens: state.totalInputTokens + state.totalOutputTokens,
    cost: state.totalCost,
    billedCost: state.totalBilledCost,
    priceUnavailable: state.priceUnavailable,
    contextPercent: computeContextPercent(state.contextPromptTokens, state.contextWindow),
    contextPromptTokens: state.contextPromptTokens,
  }
}

export function contextUtilizationFromProjection(state: BudgetProjectionState): ContextUtilization {
  return {
    promptTokens: state.contextPromptTokens,
    contextWindow: state.contextWindow,
    percent: computeContextPercent(state.contextPromptTokens, state.contextWindow),
  }
}

export function initialBudgetProjectionState(): BudgetProjectionState {
  return {
    totalCost: 0,
    totalBilledCost: 0,
    priceUnavailable: false,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    unmeasuredRequests: 0,
    invocationsUsed: 0,
    contextPromptTokens: 0,
    contextWindow: 0,
    streamBaselines: {},
    settledUsageEntryIds: {},
    committedUsageStreams: {},
  }
}

export function reduceBudgetEvent(state: BudgetProjectionState, event: StoredFact): BudgetProjectionState {
  return reduceBudgetFact(state, parseProjectionFact(event, parseSessionRuntimeFact))
}

/** Folds one fact that the caller already parsed, so a caller that folds the
 *  same fact into two states parses it once. Returns a new state and never
 *  changes `state`. */
export function reduceBudgetFact(state: BudgetProjectionState, fact: SessionRuntimeFact): BudgetProjectionState {
  return foldBudgetFact(state, fact, undefined)
}

/** `drafted` holds the id sets that the caller's projection draft owns: a
 *  committed usage entry joins those in place and copies any other set once.
 *  Copying them for each entry instead is quadratic over the entries of a
 *  session. Without `drafted`, the fold never changes `state`. */
function foldBudgetFact(state: BudgetProjectionState, fact: SessionRuntimeFact, drafted: WeakSet<object> | undefined): BudgetProjectionState {
  switch (fact.type) {
    case "budget.process.started":
      // A restarted worker-runtime process restarts the session runner's cumulative
      // counters. Subagent streams key by unique dispatch ids and never span
      // a restart, so only the session stream's baseline resets; wiping a
      // still-running subagent's baseline would re-count its whole run.
      return { ...state, streamBaselines: { ...state.streamBaselines, [SESSION_STREAM]: ZERO_BASELINE } }
    case "budget.invocation.recorded":
      return { ...state, invocationsUsed: state.invocationsUsed + fact.payload.count }
    case "budget.stream.completed": {
      const streamKey = fact.version === 1
        ? fact.payload.parentToolUseId
        : budgetStreamKey(fact.payload.budgetStreamId)
      if (!(streamKey in state.streamBaselines)) return state
      const streamBaselines = Object.fromEntries(
        Object.entries(state.streamBaselines).filter(([key]) => key !== streamKey),
      )
      return { ...state, streamBaselines }
    }
    case "model.context.measured":
      // Subagent measurements (parentToolUseId set) describe the child's own
      // context window, not this session's. Cost aggregates into the parent,
      // context never does - subagents exist to keep it out.
      if (fact.payload.parentToolUseId) return state
      return reduceContextMeasured(state, fact.payload.promptTokens, fact.payload.contextWindow)
    case "model.usage.measured":
      if (fact.version === 4 || fact.version === 5 || fact.version === 6) return foldCommittedUsageEntry(state, committedUsageEntry(fact), drafted)
      return foldCumulativeReading(state, usageStreamKey(fact), {
        cost: fact.payload.totalCostUsd,
        billedCost: fact.version === 1 ? fact.payload.billedCostUsd ?? 0 : fact.payload.billedCostUsd,
        inputTokens: fact.payload.inputTokens,
        outputTokens: fact.payload.outputTokens,
      })
    case "model.turn.completed": {
      // Terminal reading of the session runner's own cumulative counter; the
      // per-usage readings above normally leave this a no-op reconciliation.
      const streamKey = fact.payload.parentToolUseId ?? SESSION_STREAM
      if (Object.hasOwn(state.committedUsageStreams, streamKey)) return state
      const inputTokens = readUsageField(fact.payload.usage, "input_tokens")
      const outputTokens = readUsageField(fact.payload.usage, "output_tokens")
      return foldCumulativeReading(state, streamKey, {
        ...(typeof fact.payload.totalCostUsd === "number" ? { cost: fact.payload.totalCostUsd } : {}),
        ...(typeof fact.payload.billedCostUsd === "number" ? { billedCost: fact.payload.billedCostUsd } : {}),
        ...(inputTokens !== null ? { inputTokens } : {}),
        ...(outputTokens !== null ? { outputTokens } : {}),
      })
    }
    default:
      return state
  }
}

interface CommittedUsageEntry {
  id: string
  streamKey: string
  cost: number | null
  billedCost: number | null
  inputTokens: number
  outputTokens: number
  priceUnavailable: boolean
  unmeasured: boolean
}

function committedUsageEntry(fact: Extract<SessionRuntimeFact, { type: "model.usage.measured"; version: 4 | 5 | 6 }>): CommittedUsageEntry {
  const streamKey = fact.payload.parentToolUseId ?? SESSION_STREAM
  if (fact.version === 4) {
    const { payload } = fact
    return {
      id: payload.usageEntryId, streamKey, cost: payload.costUsdDelta, billedCost: payload.billedCostUsdDelta,
      inputTokens: payload.inputTokensDelta, outputTokens: payload.outputTokensDelta, priceUnavailable: false, unmeasured: false,
    }
  }
  const entry = currentUsageMeasurement(fact)
  if (entry.coverage === "unmeasured") {
    return { id: entry.attemptId, streamKey, cost: null, billedCost: null, inputTokens: 0, outputTokens: 0, priceUnavailable: false, unmeasured: true }
  }
  const cost = entry.price.kind === "unavailable" ? null : entry.price.estimatedUsd
  return {
    id: entry.attemptId, streamKey, cost, billedCost: cost === null ? null : entry.classification === "real_spend" ? cost : 0,
    inputTokens: entry.tokens.input, outputTokens: entry.tokens.output, priceUnavailable: cost === null, unmeasured: false,
  }
}

function foldCommittedUsageEntry(state: BudgetProjectionState, entry: CommittedUsageEntry, drafted: WeakSet<object> | undefined): BudgetProjectionState {
  if (Object.hasOwn(state.settledUsageEntryIds, entry.id)) return state
  const settledUsageEntryIds = draftedSet(state.settledUsageEntryIds, drafted)
  const committedUsageStreams = draftedSet(state.committedUsageStreams, drafted)
  settledUsageEntryIds[entry.id] = true
  committedUsageStreams[entry.streamKey] = true
  return {
    ...state,
    totalCost: state.totalCost + (entry.cost ?? 0),
    totalBilledCost: state.totalBilledCost + (entry.billedCost ?? 0),
    priceUnavailable: state.priceUnavailable || entry.priceUnavailable,
    totalInputTokens: state.totalInputTokens + entry.inputTokens,
    totalOutputTokens: state.totalOutputTokens + entry.outputTokens,
    unmeasuredRequests: state.unmeasuredRequests + (entry.unmeasured ? 1 : 0),
    settledUsageEntryIds,
    committedUsageStreams,
  }
}

function draftedSet(set: StringMap<true>, drafted: WeakSet<object> | undefined): StringMap<true> {
  if (drafted?.has(set)) return set
  const copy = { ...set }
  drafted?.add(copy)
  return copy
}

function reduceContextMeasured(state: BudgetProjectionState, promptTokens: number, contextWindow: number): BudgetProjectionState {
  const nextPromptTokens = promptTokens > 0 ? promptTokens : state.contextPromptTokens
  const nextContextWindow = contextWindow > 0 ? contextWindow : state.contextWindow
  if (nextPromptTokens === state.contextPromptTokens && nextContextWindow === state.contextWindow) return state
  return { ...state, contextPromptTokens: nextPromptTokens, contextWindow: nextContextWindow }
}

interface CumulativeReading {
  cost?: number
  billedCost?: number
  inputTokens?: number
  outputTokens?: number
}

function usageStreamKey(fact: Extract<ReturnType<typeof parseSessionRuntimeFact>, { type: "model.usage.measured" }>): string {
  if (fact.version === 3 && fact.payload.budgetStreamId) return budgetStreamKey(fact.payload.budgetStreamId)
  return fact.payload.parentToolUseId ?? SESSION_STREAM
}

function budgetStreamKey(streamId: string): string {
  return `budget:${streamId}`
}

// One runner stream reports monotonically growing run totals; session totals
// advance by the delta against that stream's own baseline.
function foldCumulativeReading(state: BudgetProjectionState, streamKey: string, reading: CumulativeReading): BudgetProjectionState {
  const baseline = state.streamBaselines[streamKey] ?? ZERO_BASELINE
  let next = state
  let nextBaseline = baseline

  if (typeof reading.cost === "number" && reading.cost >= 0) {
    const costDelta = cumulativeDelta(reading.cost, baseline.cost)
    next = { ...next, totalCost: next.totalCost + costDelta }
    nextBaseline = { ...nextBaseline, cost: reading.cost }
  }
  if (typeof reading.billedCost === "number" && reading.billedCost >= 0) {
    next = { ...next, totalBilledCost: next.totalBilledCost + cumulativeDelta(reading.billedCost, baseline.billedCost) }
    nextBaseline = { ...nextBaseline, billedCost: reading.billedCost }
  }
  if (reading.inputTokens !== undefined || reading.outputTokens !== undefined) {
    const rawInput = reading.inputTokens ?? baseline.inputTokens
    const rawOutput = reading.outputTokens ?? baseline.outputTokens
    next = {
      ...next,
      totalInputTokens: next.totalInputTokens + cumulativeDelta(rawInput, baseline.inputTokens),
      totalOutputTokens: next.totalOutputTokens + cumulativeDelta(rawOutput, baseline.outputTokens),
    }
    nextBaseline = { ...nextBaseline, inputTokens: rawInput, outputTokens: rawOutput }
  }
  if (nextBaseline === baseline) return next
  return { ...next, streamBaselines: { ...state.streamBaselines, [streamKey]: nextBaseline } }
}

// Cumulative counters reset to 0 when the provider process restarts; a drop
// means new baseline, not corruption.
function cumulativeDelta(current: number, previous: number): number {
  if (current < 0) return 0
  return current >= previous ? current - previous : current
}

// `usage` is preserved raw provider evidence (UnknownRecord by design); numeric
// extraction here is the normalization boundary.
function readUsageField(usage: StringMap<unknown> | undefined, key: string): number | null {
  if (!usage) return null
  const value = usage[key]
  return typeof value === "number" && value >= 0 ? value : null
}
interface StringMap<T> { [key: string]: T }
