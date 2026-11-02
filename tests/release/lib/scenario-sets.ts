/**
 * The two scenario sets the release performance runner offers. `startup` is
 * the everyday gate: published startup comparisons, for a local launch and
 * for a remote first attach through the relay, and candidate summary-index
 * ceilings. `release` adds the remaining ceiling-bound scenarios. The separate
 * opt-in workflow family adds pinned pre-D upgrade pairs to startup and active
 * workflow pairs to release.
 */
import { runChatRunnerReconciliationScenario } from "../scenarios/chat-runner-reconciliation.js"
import { executorResponsivenessRequiredMetrics, runExecutorResponsivenessScenario } from "../scenarios/executor-responsiveness.js"
import { runParallelSessionsScenario } from "../scenarios/parallel-sessions.js"
import { runParallelWorkflowAgentsScenario } from "../scenarios/parallel-workflow-agents.js"
import { REMOTE_ATTACH_METRICS, runRemoteAttachScenario } from "../scenarios/remote-attach.js"
import type { ScenarioContext, ScenarioResult } from "../scenarios/scenario-context.js"
import { runScrollScenario } from "../scenarios/scroll.js"
import { runSessionModalScenario } from "../scenarios/session-modal.js"
import { runSessionSummaryScenario } from "../scenarios/session-summary.js"
import { runStartupScenario } from "../scenarios/startup.js"
import { runWorkflowAgentUpgradeScenario } from "../scenarios/workflow-agent-upgrade.js"
import type { Budgets, MetricValues } from "./metrics.js"

export type ScenarioSet = "startup" | "release"

export type MeasurementRole = "candidate" | "baseline"

export interface ScenarioRow {
  readonly name: string
  /** Measured runs whose median becomes the metric. */
  readonly reps: number
  readonly withFixture: boolean
  readonly roles?: readonly MeasurementRole[]
  /** The metrics a run of this row must produce on the platform. The budget
   *  pass skips a metric a run did not produce, so a row whose ceilings are
   *  its purpose names them here and fails by itself without them. */
  readonly requiredMetrics?: (platform: NodeJS.Platform, role: MeasurementRole) => readonly string[]
  readonly run: (context: ScenarioContext) => Promise<ScenarioResult>
}

/** Median of this many measured runs. */
export const MEASURED_REPS = 3

const STARTUP_SCENARIOS: readonly ScenarioRow[] = [
  { name: "startup-empty", reps: MEASURED_REPS, withFixture: false, run: (context) => runStartupScenario(context, "startup.empty") },
  { name: "startup-large", reps: MEASURED_REPS, withFixture: true, run: (context) => runStartupScenario(context, "startup.large") },
  // A published baseline that predates the remote terminal reports nothing,
  // so only the candidate must produce the metrics.
  { name: "remote-attach", reps: MEASURED_REPS, withFixture: false,
    requiredMetrics: (_platform, role) => role === "candidate" ? REMOTE_ATTACH_METRICS : [], run: runRemoteAttachScenario },
  { name: "session-summary", reps: 1, withFixture: false, roles: ["candidate"], run: runSessionSummaryScenario },
  { name: "workflow-agent-upgrade", reps: MEASURED_REPS, withFixture: false,
    requiredMetrics: (_platform, role) => [
      ...["firstFrameMs", "firstOpenReadyMs", "summaryRebuildMs", "peakHeapMiB", "peakRssMiB", "secondOpenReadyMs", "convertedWorkflows", "convertedGenerations", "residualGapCount", "secondOpenConvertedWorkflows"].map(name => `workflowAgentMigration.${name}`),
      ...(role === "candidate" ? ["workflowAgentMigration.conversionMs"] : []),
    ], run: runWorkflowAgentUpgradeScenario },
]

const RELEASE_SCENARIOS: readonly ScenarioRow[] = [
  ...STARTUP_SCENARIOS,
  { name: "session-modal", reps: MEASURED_REPS, withFixture: true, run: runSessionModalScenario },
  { name: "runner-reconciliation", reps: MEASURED_REPS, withFixture: true, run: runChatRunnerReconciliationScenario },
  // One run: the scroll metrics already aggregate hundreds of frames from a
  // burst spanning about a minute, so repetition buys little for its cost.
  { name: "scroll", reps: 1, withFixture: true, run: runScrollScenario },
  // Candidate only and one run: the load is synthetic and steady, and every
  // metric is an absolute ceiling on runtime fairness, not an A/B.
  { name: "parallel-sessions", reps: 1, withFixture: false, roles: ["candidate"], run: (context) => runParallelSessionsScenario(context, "sessions") },
  // The same load with every parent dispatching children in a loop; its
  // deciding metric is the catalog churn the client sees, which is zero.
  { name: "parallel-children", reps: 1, withFixture: false, run: (context) => runParallelSessionsScenario(context, "children") },
  { name: "parallel-workflow-agents", reps: MEASURED_REPS, withFixture: false,
    requiredMetrics: (_platform, role) => [
      ...["launchToFirstRequestMs", "launchStateRequestsPerMember", "statusDeliveryP95Ms", "activeHeapMb", "heapSamples", "members", "firstRequests", "statusEdges"].map(name => `parallelWorkflowAgents.${name}`),
      ...(role === "candidate" ? ["parallelWorkflowAgents.statusSnapshotP95Ms"] : ["parallelWorkflowAgents.workflowLiveSnapshotP95Ms"]),
    ], run: runParallelWorkflowAgentsScenario },
  // Candidate only and one run: every ceiling is a maximum over the run, and
  // published baselines predate the work it measures.
  { name: "executor-responsiveness", reps: 1, withFixture: true, roles: ["candidate"], requiredMetrics: executorResponsivenessRequiredMetrics, run: runExecutorResponsivenessScenario },
]

export function parseScenarioSet(value: string | undefined): ScenarioSet {
  if (value !== "startup" && value !== "release") throw new Error(`--set must be startup or release, got ${value}`)
  return value
}

/** The tmux-driven scenarios one variant runs, in order; the first one pays the warm-up. */
export type Comparison = "all" | "published" | "workflow"

export function scenarioRows(set: ScenarioSet, role?: MeasurementRole, only?: string, comparison: Comparison = "all"): readonly ScenarioRow[] {
  const rows = set === "startup" ? STARTUP_SCENARIOS : RELEASE_SCENARIOS
  return rows.filter(row => {
    const workflow = ["workflow-agent-upgrade", "parallel-workflow-agents", "parallel-children"].includes(row.name)
    return (comparison === "all" || workflow === (comparison === "workflow"))
      && (only === undefined || row.name === only) && (role === undefined || row.roles === undefined || row.roles.includes(role))
  })
}

/** The roles that measure the row in one rep, in the order they run. The
 *  order flips every rep, so load that drifts while the gate runs falls on
 *  both binaries alike instead of on whichever one runs second. */
export function repRoles(row: Pick<ScenarioRow, "roles">, rep: number, withBaseline: boolean): readonly MeasurementRole[] {
  const roles = (["candidate", "baseline"] as const).filter(role =>
    (role === "candidate" || withBaseline) && (row.roles === undefined || row.roles.includes(role)))
  return rep % 2 === 1 ? roles : roles.toReversed()
}

/** The row's required metrics that its run left absent or not finite. */
export function missingRequiredMetrics(row: Pick<ScenarioRow, "requiredMetrics">, metrics: MetricValues, platform: NodeJS.Platform = process.platform, role: MeasurementRole = "candidate"): string[] {
  return (row.requiredMetrics?.(platform, role) ?? []).filter((metric) => {
    const value = metrics[metric]
    return value === undefined || !Number.isFinite(value)
  })
}

/** A paired limit belongs only to the scenario that requires its metric. */
export function scenarioPairedBudgets(row: ScenarioRow, budgets: Budgets): Budgets {
  const required = new Set(row.requiredMetrics?.(process.platform, "candidate"))
  return Object.fromEntries(Object.entries(budgets).filter(([key, value]) => required.has(key) && value.paired))
}

/** The account-service scenario measures the candidate only: published
 *  baselines predate the account service, and its metrics are absolute. */
export function measuresAccountService(set: ScenarioSet, role: MeasurementRole): boolean {
  return set === "release" && role === "candidate"
}
