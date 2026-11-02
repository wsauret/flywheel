import type { StoredFact } from "../../infra/event-store-types.js"
import type { GenerationStatistics } from "../../protocol/generation-statistics.js"
import { canonicalProviderStreamSummary, readProviderRequestAuditFact } from "./provider-request-audit-facts.js"
import type { GenerationMeasurement } from "./provider-request-audit-types.js"
import { settledUsageMeasurement } from "./durable-usage.js"

type Totals = GenerationStatistics["totals"]
type Model = GenerationStatistics["models"][number]
interface Request {
  attribution?: { model: string; reasoningEffort: string | null }
  generation?: GenerationMeasurement
  usageMeasured?: true
}
/** One session's compact request evidence, as `reduceGenerationEvidence` folds it. */
export interface GenerationEvidence {
  requests: { [requestId: string]: Request }
  /** A usage fact named no attempt: an older version without an entry, or a version this build does not know. */
  usageWithoutAttempt: boolean
}

/** The facts that `reduceGenerationEvidence` folds. */
export const GENERATION_EVIDENCE_FACT_TYPES = ["model.requested", "model.stream.summary.recorded", "model.usage.measured"] as const

export const initialGenerationEvidence = (): GenerationEvidence => ({ requests: {}, usageWithoutAttempt: false })

const emptyTotals = (): Totals => ({
  outputTokens: 0, durationMs: 0, measuredRequests: 0, unmeasuredRequests: 0,
  measuredBlocks: 0, excludedBlocks: 0, averageTokensPerSecond: null,
})

function addTotals(left: Totals, right: Totals): Totals {
  const outputTokens = left.outputTokens + right.outputTokens
  const durationMs = left.durationMs + right.durationMs
  return {
    outputTokens, durationMs,
    measuredRequests: left.measuredRequests + right.measuredRequests,
    unmeasuredRequests: left.unmeasuredRequests + right.unmeasuredRequests,
    measuredBlocks: left.measuredBlocks + right.measuredBlocks,
    excludedBlocks: left.excludedBlocks + right.excludedBlocks,
    averageTokensPerSecond: tokensPerSecond(outputTokens, durationMs),
  }
}

/** The pooled speed of `outputTokens` generated in `durationMs`, or null
 *  when no duration was measured. */
export function tokensPerSecond(outputTokens: number, durationMs: number): number | null {
  return durationMs > 0 ? outputTokens * 1000 / durationMs : null
}

/** The request and the generation measurement that one stored
 *  `model.stream.summary.recorded` fact states. Throws when the fact cannot
 *  be read. */
export function readStreamSummaryGeneration(event: StoredFact) {
  const fact = readProviderRequestAuditFact(event)
  if (fact.type !== "model.stream.summary.recorded") throw new Error(`${event.type} fact ${event.id} is not a stream summary`)
  const { requestId, generation } = canonicalProviderStreamSummary(fact)
  return { requestId, generation }
}

/** Pools request-local durations and token totals, never rates or cross-agent intervals. Inputs can include independently scoped descendant readings. */
export function mergeGenerationStatistics(values: readonly GenerationStatistics[]): GenerationStatistics {
  let totals = emptyTotals()
  const models = new Map<string, Model>()
  for (const value of values) {
    totals = addTotals(totals, value.totals)
    for (const row of value.models) {
      const key = JSON.stringify([row.model, row.reasoningEffort])
      models.set(key, { ...row, ...addTotals(models.get(key) ?? emptyTotals(), row) })
    }
  }
  return {
    basis: "O200kBase", totals,
    models: [...models.values()].sort((a, b) => a.model.localeCompare(b.model) || (a.reasoningEffort ?? "").localeCompare(b.reasoningEffort ?? "")),
    coverageComplete: values.every((value) => value.coverageComplete),
  }
}

/** Changes `state` in place and returns it. Each fact is read before the
 *  state changes, so a fact that cannot be read leaves the state as it was.
 *  Its owner serializes access to this private index; published statistics
 *  are detached values. */
export function reduceGenerationEvidence(state: GenerationEvidence, event: StoredFact): GenerationEvidence {
  if (event.type === "model.usage.measured") {
    const measurement = settledUsageMeasurement(event)
    if (measurement === undefined) {
      state.usageWithoutAttempt = true
      return state
    }
    const requestId = measurement.attemptId
    state.requests[requestId] = { ...state.requests[requestId], usageMeasured: true }
    return state
  }
  if (event.type === "model.stream.summary.recorded") {
    const { requestId, generation } = readStreamSummaryGeneration(event)
    state.requests[requestId] = { ...state.requests[requestId], generation }
    return state
  }
  const fact = readProviderRequestAuditFact(event)
  if (fact.type === "model.requested") {
    const { requestId, model, reasoningEffort } = fact.payload
    state.requests[requestId] = { ...state.requests[requestId], attribution: { model, reasoningEffort: reasoningEffort ?? null } }
  }
  return state
}

export function generationStatistics(state: GenerationEvidence): GenerationStatistics {
  const values: GenerationStatistics[] = []
  for (const request of Object.values(state.requests)) {
    // Attribution alone can describe an in-flight request; only settled evidence contributes coverage.
    if (!request.generation && !request.usageMeasured) continue
    const measured = request.generation?.kind === "recorded" && request.generation.durationMs > 0
    const generation = request.generation
    const totals: Totals = generation?.kind === "recorded"
      ? { outputTokens: generation.outputTokens, durationMs: generation.durationMs,
          measuredBlocks: generation.measuredBlocks, excludedBlocks: generation.excludedBlocks,
          measuredRequests: measured ? 1 : 0, unmeasuredRequests: measured ? 0 : 1,
          averageTokensPerSecond: tokensPerSecond(generation.outputTokens, generation.durationMs) }
      : { ...emptyTotals(), unmeasuredRequests: 1 }
    values.push({
      basis: "O200kBase", totals,
      models: request.attribution ? [{ ...request.attribution, ...totals }] : [],
      coverageComplete: measured && totals.excludedBlocks === 0 && request.attribution !== undefined,
    })
  }
  const result = mergeGenerationStatistics(values)
  return { ...result, coverageComplete: result.coverageComplete && !state.usageWithoutAttempt }
}
