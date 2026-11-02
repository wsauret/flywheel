/**
 * Metric math and budget assertion for the release performance tier.
 *
 * Budgets are a hybrid gate: `ceiling` is an absolute hard limit that holds
 * even when no baseline exists, and `tolerancePct` bounds the relative
 * regression against a baseline binary measured on the same machine in the
 * same run. A metric without a tolerance is absolute-only.
 *
 * `toleranceFloor` is the noise floor of the relative gate: identical
 * binaries measured back to back differ by scheduling noise, and on a small
 * metric (a 90 ms open, a 7 ms p95 frame) that noise exceeds any reasonable
 * percentage. A regression therefore only counts when it exceeds the
 * percentage AND the absolute floor over the baseline.
 */

export interface MetricBudget {
  ceiling: number
  paired?: "ratio" | "difference"
  tolerancePct?: number
  toleranceFloor?: number
}

export interface Budgets {
  [metric: string]: MetricBudget
}

export interface MetricValues {
  [metric: string]: number
}

export interface MetricPair {
  readonly candidate: MetricValues
  readonly baseline: MetricValues
}

/** Reduces three matched runs as median_i(candidate_i / baseline_i), or
 * median_i(candidate_i - baseline_i). Never subtract variant medians or take the worst pair.
 * Each active heap sample is its run's single post-GC observation; upgrade heap remains a peak. */
export function assertPairedBudgets(pairs: readonly MetricPair[], budgets: Budgets): BudgetViolation[] {
  if (!Object.values(budgets).some(budget => budget.paired)) return []
  if (pairs.length !== 3) throw new Error("paired evidence requires exactly three pairs")
  const violations: BudgetViolation[] = []
  for (const [metric, budget] of Object.entries(budgets)) {
    if (!budget.paired) continue
    const samples = pairs.map(({ candidate, baseline }) => {
      const value = candidate[metric]
      const previous = baseline[metric]
      if (value === undefined || previous === undefined || !Number.isFinite(value) || !Number.isFinite(previous)
        || (budget.paired === "ratio" && (previous <= 0 || value < 0))) throw new Error(`invalid paired evidence for ${metric}`)
      return budget.paired === "ratio" ? value / previous : value - previous
    })
    const measured = median(samples)
    if (measured > budget.ceiling) violations.push({ metric, measured, limit: budget.ceiling, kind: "ceiling" })
  }
  return violations
}

export interface BudgetViolation {
  metric: string
  measured: number
  limit: number
  kind: "ceiling" | "regression"
  baseline?: number
}

function sortedValueAt(sorted: readonly number[], index: number): number {
  const value = sorted[index]
  if (value === undefined) throw new Error(`no value at index ${index}`)
  return value
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of no values")
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sortedValueAt(sorted, mid) : (sortedValueAt(sorted, mid - 1) + sortedValueAt(sorted, mid)) / 2
}

/** Nearest-rank percentile; p in (0, 100]. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error("percentile of no values")
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sortedValueAt(sorted, rank - 1)
}

/** Judges `measured` against each ceiling, and each tolerance against the
 *  matched candidate/baseline `pairs` of the same machine load. The relative
 *  verdict reads the median pair by candidate over its own limit, never the
 *  two roles' medians taken apart: load that moves between reps would then
 *  invent a regression or hide one. With an even count the upper median
 *  decides, and a violation names that pair's values. */
export function assertBudgets(measured: MetricValues, budgets: Budgets, pairs: readonly MetricPair[] = []): BudgetViolation[] {
  const violations: BudgetViolation[] = []
  for (const [metric, budget] of Object.entries(budgets)) {
    if (budget.paired) continue
    const value = measured[metric]
    // A budgeted metric the run did not produce is a scenario failure, which
    // the runner reports separately; the budget pass only judges what ran.
    if (value === undefined) continue
    if (value > budget.ceiling) {
      violations.push({ metric, measured: value, limit: budget.ceiling, kind: "ceiling" })
    }
    const { tolerancePct } = budget
    if (tolerancePct === undefined) continue
    const judged = pairs.flatMap(({ candidate, baseline }) => {
      const current = candidate[metric]
      const previous = baseline[metric]
      if (current === undefined || previous === undefined || previous <= 0) return []
      const limit = Math.max(previous * (1 + tolerancePct / 100), previous + (budget.toleranceFloor ?? 0))
      return [{ current, previous, limit }]
    }).sort((a, b) => a.current / a.limit - b.current / b.limit)
    const decisive = judged[Math.floor(judged.length / 2)]
    if (decisive && decisive.current > decisive.limit) {
      violations.push({ metric, measured: decisive.current, limit: decisive.limit, kind: "regression", baseline: decisive.previous })
    }
  }
  return violations
}

export function formatViolation(violation: BudgetViolation): string {
  const measured = violation.measured.toFixed(1)
  const limit = violation.limit.toFixed(1)
  return violation.kind === "ceiling"
    ? `${violation.metric}: ${measured} exceeds the absolute ceiling ${limit}`
    : `${violation.metric}: ${measured} regresses more than allowed over baseline ${violation.baseline?.toFixed(1)} (limit ${limit})`
}

/** budgets.json is this suite's own checked-in file, but it still enters
 *  through a parse that proves the shape instead of an assertion. A budget
 *  may state `platform` overrides keyed by `process.platform`; the host's
 *  override is merged over the base here, so every assertion downstream sees
 *  one budget and never asks which platform it is on. */
export function parseBudgets(raw: unknown, platform: string = process.platform): Budgets {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("budgets.json must be an object")
  const budgets: Budgets = {}
  for (const [metric, budget] of Object.entries(raw)) {
    const base = parseBudget(metric, budget)
    const overrides = fieldsOf(metric, budget).platform
    if (overrides === undefined) {
      budgets[metric] = base
      continue
    }
    if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) throw new Error(`platform overrides for ${metric} must be an object`)
    const override = fieldsOf(metric, overrides)[platform]
    budgets[metric] = override === undefined ? base : { ...base, ...parseBudget(`${metric} on ${platform}`, override, base.ceiling) }
  }
  return budgets
}

/** The fields of one budget object as they were written, before any of them
 *  is proved: the JSON boundary, and the one place its shape is still open. */
interface BudgetFields {
  readonly [key: string]: unknown
}

function fieldsOf(metric: string, budget: unknown): BudgetFields {
  if (typeof budget !== "object" || budget === null || Array.isArray(budget)) throw new Error(`budget for ${metric} must be an object`)
  return Object.fromEntries(Object.entries(budget))
}

/** One budget's fields. An override may omit the ceiling only when the base
 *  supplies it. */
function parseBudget(metric: string, budget: unknown, inheritedCeiling?: number): MetricBudget {
  const fields = fieldsOf(metric, budget)
  const ceiling = fields.ceiling ?? inheritedCeiling
  const tolerancePct = fields.tolerancePct
  const toleranceFloor = fields.toleranceFloor
  const paired = fields.paired
  if (typeof ceiling !== "number") throw new Error(`budget for ${metric} needs a numeric ceiling`)
  if (tolerancePct !== undefined && typeof tolerancePct !== "number") throw new Error(`tolerancePct for ${metric} must be a number`)
  if (toleranceFloor !== undefined && typeof toleranceFloor !== "number") throw new Error(`toleranceFloor for ${metric} must be a number`)
  if (paired !== undefined && paired !== "ratio" && paired !== "difference") throw new Error(`invalid paired comparison for ${metric}`)
  return {
    ceiling,
    ...(paired === undefined ? {} : { paired }),
    ...(tolerancePct === undefined ? {} : { tolerancePct }),
    ...(toleranceFloor === undefined ? {} : { toleranceFloor }),
  }
}
