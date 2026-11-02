import { Schema } from "effect"
import type { ExperimentExecutionState, PendingExperimentResult } from "../execution-state.js"
import { ExperimentPreCommitCandidateMismatchError } from "../git-operations.js"
import type { ExperimentOperationOwner } from "../operation-owner.js"
import { computeConfidence, findBaselineMetric, findBestMetric } from "../result-analysis.js"
import type { ExperimentMetricValues, ExperimentRun, ExperimentSideInformation } from "../types.js"
import type { ExperimentRunRecordedFact } from "../facts.js"
import type { ExperimentSnapshot } from "../projection.js"
import { logExperimentSchema } from "../../../agent-runtime/tools/experiment-schemas.js"
import type { RuntimeTool, RuntimeToolInput } from "../../../agent-runtime/tools/types.js"

interface LogExperimentDependencies {
  readonly replay: () => Promise<ExperimentSnapshot | undefined>
  readonly executionState: ExperimentExecutionState<PendingExperimentResult>
  readonly operation: ExperimentOperationOwner
  readonly captureTree: () => Promise<string>
  readonly settle: (
    cwd: string,
    fact: ExperimentRunRecordedFact,
    deactivate: boolean,
  ) => Promise<void>
}

export function createLogExperimentTool(deps: LogExperimentDependencies): RuntimeTool {
  return {
    name: "log_experiment",
    action: "ui_meta",
    description: "Settle and record the pending experiment result.",
    inputSchema: logExperimentSchema,
    isConcurrencySafe: false,
    execute: async (input) => {
      const blocker = await deps.operation.blocker()
      if (blocker) return failure(blocker)
      const pending = deps.executionState.pending()
      if (pending === undefined) return failure("No experiment result is pending.")
      const snapshot = await deps.replay()
      if (snapshot === undefined) return failure("Experiment state is unavailable.")
      if (!snapshot.mode.active || snapshot.configuration === null) return failure("Experiment mode is not active.")

      const status = requiredStatus(input)
      if (status === "keep" && pending.status === "checks_failed") {
        return failure("Cannot keep an experiment whose checks failed.")
      }
      if (status === "keep" && pending.status === "measurement_failed") {
        return failure("Cannot keep an experiment whose measurement failed.")
      }
      let currentTree: string
      try {
        currentTree = await deps.captureTree()
      } catch (error) {
        deps.operation.interrupt()
        return failure(error instanceof Error ? error.message : String(error))
      }
      if (pending.resultTree !== currentTree) {
        if (status === "keep") {
          return failure(`Cannot keep experiment: candidate tree changed after measurement (${pending.resultTree} != ${currentTree}). Restore the captured tree before settling the pending result.`)
        }
        return failure(`Cannot ${status} experiment: candidate tree changed after the result was captured (${pending.resultTree} != ${currentTree}). Restore the captured tree before settling the result.`)
      }
      if (status === "keep" && pending.measuredTree !== pending.resultTree) {
        return failure(`Cannot keep experiment: measurement or checks changed candidate content (${pending.measuredTree} != ${pending.resultTree}). Discard the pending result explicitly.`)
      }

      const configuration = snapshot.configuration
      const runNumber = snapshot.runs.length + 1
      const metric = requiredFiniteNumber(input, "metric")
      const measuredPrimary = pending.metrics[configuration.metricName]
      if (measuredPrimary !== undefined && metric !== measuredPrimary) {
        return failure(`metric must equal the pending "${configuration.metricName}" measurement.`)
      }
      const metrics: ExperimentMetricValues = {
        ...withoutPrimary(pending.metrics, configuration.metricName),
        ...(input.metrics === undefined ? {} : decodeMetrics(input.metrics)),
      }
      const projectedRun: ExperimentRun = {
        run: runNumber,
        segment: configuration.segment,
        commit: "pending",
        metric,
        metrics,
        status,
        description: requiredString(input, "description"),
        timestamp: Date.now(),
        confidence: null,
        durationMs: pending.durationMs,
        ...(input.asi === undefined ? {} : { asi: decodeSideInformation(input.asi) }),
      }
      const projected = [...snapshot.runs, projectedRun]
      const fact: ExperimentRunRecordedFact = {
        type: "experiment.run.recorded",
        version: 1,
        actor: "flywheel",
        payload: {
          run: runNumber,
          segment: configuration.segment,
          commit: "pending",
          metric,
          metrics,
          status,
          description: projectedRun.description,
          ...(projectedRun.asi === undefined ? {} : { asi: projectedRun.asi }),
          confidence: computeConfidence(projected, configuration.segment, configuration.direction),
          durationMs: pending.durationMs,
        },
      }
      const segmentRuns = projected.filter((run) => run.segment === configuration.segment)
      const deactivate = configuration.maxIterations !== null
        && segmentRuns.length >= configuration.maxIterations

      try {
        await deps.settle(configuration.workDir, fact, deactivate)
        deps.executionState.clear()
      } catch (error) {
        if (!(error instanceof ExperimentPreCommitCandidateMismatchError)) deps.operation.interrupt()
        return failure(error instanceof Error ? error.message : String(error))
      }

      const baseline = findBaselineMetric(projected, configuration.segment)
      const best = findBestMetric(projected, configuration.segment, configuration.direction)
      const confidence = computeConfidence(projected, configuration.segment, configuration.direction)
      return {
        outcome: "ok",
        content: JSON.stringify({ run: runNumber, baseline, best, confidence, active: !deactivate }),
      }
    },
  }
}

function withoutPrimary(metrics: ExperimentMetricValues, primary: string): ExperimentMetricValues {
  return Object.fromEntries(Object.entries(metrics).filter(([name]) => name !== primary))
}

const decodeMetrics: (value: unknown) => ExperimentMetricValues = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Finite))
const decodeSideInformation: (value: unknown) => ExperimentSideInformation = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

function requiredString(input: RuntimeToolInput, key: string): string {
  const value = input[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string.`)
  return value
}

function requiredFiniteNumber(input: RuntimeToolInput, key: string): number {
  const value = input[key]
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be finite.`)
  return value
}

function requiredStatus(input: RuntimeToolInput): ExperimentRun["status"] {
  const value = input.status
  if (value === "keep" || value === "discard" || value === "crash" || value === "checks_failed") return value
  throw new Error("status is invalid.")
}

function failure(content: string) {
  return { outcome: "error" as const, content }
}
