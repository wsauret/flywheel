import type { MetricValues } from "./lib/metrics.js"

/** Paired first-open evidence. Only the candidate has ownership-conversion work. */
export interface WorkflowAgentMigrationMetrics {
  readonly firstFrameMs: number
  readonly firstOpenReadyMs: number
  readonly conversionMs?: number
  readonly summaryRebuildMs: number
  readonly peakHeapMiB: number
  readonly peakRssMiB: number
  readonly secondOpenReadyMs: number
  readonly convertedWorkflows: number
  readonly convertedGenerations: number
  readonly residualGapCount: number
  readonly secondOpenConvertedWorkflows: number
}

/** Candidate-only account-service evidence. Baselines predate the account service and never produce these metrics. */
export const ACCOUNT_SERVICE_REQUIRED_METRICS = [
  "accountService.zeroProjectRssMb",
  "accountService.oneProjectRssMb",
  "accountService.twoProjectRssMb",
  "accountService.secondProjectIncrementalRssMb",
  "accountService.processResourceGenerations",
  "accountService.open1Ms",
  "accountService.open2Ms",
  "accountService.open3Ms",
  "accountService.warmOpenMedianMs",
] as const

/** Returns required candidate evidence that is absent, non-finite, or invalid for its metric. */
export function missingCandidateAccountServiceEvidence(metrics: MetricValues): string[] {
  return ACCOUNT_SERVICE_REQUIRED_METRICS.filter((metric) => {
    const value = metrics[metric]
    return value === undefined
      || !Number.isFinite(value)
      || (metric !== "accountService.secondProjectIncrementalRssMb" && value < 0)
  })
}

export const SESSION_SUMMARY_REQUIRED_METRICS = [
  "sessionSummary.pageTransactionP95Ms",
  "sessionSummary.maxTaskCpuMs",
  "sessionSummary.detailColdRebuildP95Ms",
  "sessionSummary.detailColdRebuildMaxMs",
  "sessionSummary.detailWarmP95Ms",
  "sessionSummary.searchColdRebuildP95Ms",
  "sessionSummary.searchColdRebuildMaxMs",
  "sessionSummary.searchWarmP95Ms",
  "sessionSummary.warmOpen633RowsMs",
  "sessionSummary.productionFreshnessP95Ms",
  "sessionSummary.unindexedTypePlans",
] as const

/** Candidate summary evidence requires the index for every declared fact family. */
export function missingCandidateSessionSummaryEvidence(metrics: MetricValues): string[] {
  return SESSION_SUMMARY_REQUIRED_METRICS.filter((metric) => {
    const value = metrics[metric]
    if (value === undefined || !Number.isFinite(value) || value < 0) return true
    return metric === "sessionSummary.unindexedTypePlans" && value !== 0
  })
}
