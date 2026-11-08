import { Schema } from "effect"
import { ExperimentPreCommitCandidateMismatchError } from "../git-operations.js"
import type { ExperimentOperation } from "../operation-owner.js"
import { computeConfidence, findBaselineMetric, findBestMetric } from "../result-analysis.js"
import type { ExperimentMetricValues, ExperimentRun, ExperimentSideInformation } from "../types.js"
import type { ExperimentRunRecordedFact } from "../facts.js"
import type { ExperimentSnapshot } from "../projection.js"
import { logExperimentSchema } from "../../../agent-runtime/tools/experiment-schemas.js"
import type { RuntimeTool, RuntimeToolInput, ToolResult } from "../../../agent-runtime/tools/types.js"

interface LogExperimentDependencies {
  readonly replay: () => Promise<ExperimentSnapshot | undefined>
  readonly operation: ExperimentOperation
  readonly captureTree: () => Promise<string>
  readonly settle: (
    cwd: string,
    fact: ExperimentRunRecordedFact,
    deactivate: boolean,
    measuredTree: string,
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
      try {
        const status = requiredStatus(input)
        const metric = requiredFiniteNumber(input, "metric")
        const description = requiredString(input, "description")
        const suppliedMetrics = input.metrics === undefined ? {} : decodeMetrics(input.metrics)
        const asi = input.asi === undefined ? undefined : decodeSideInformation(input.asi)
        return await deps.operation.settle<ToolResult>(async (pending) => {
          const refuse = (content: string) => ({ outcome: "kept-pending" as const, result: failure(content) })
          const snapshot = await deps.replay()
          if (snapshot === undefined) return refuse("Experiment state is unavailable.")
          if (!snapshot.mode.active || snapshot.configuration === null) return refuse("Experiment mode is not active.")
          if (status === "keep" && pending.status === "checks_failed") return refuse("Cannot keep an experiment whose checks failed.")
          if (status === "keep" && pending.status === "measurement_failed") return refuse("Cannot keep an experiment whose measurement failed.")
          let currentTree: string
          try {
            currentTree = await deps.captureTree()
          } catch (error) {
            return { outcome: "unresolved" as const, result: failure(errorText(error)) }
          }
          if (pending.resultTree !== currentTree) {
            if (status === "keep") {
              return refuse(`Cannot keep experiment: candidate tree changed after measurement (${pending.resultTree} != ${currentTree}). Restore the captured tree before settling the pending result.`)
            }
            return refuse(`Cannot ${status} experiment: candidate tree changed after the result was captured (${pending.resultTree} != ${currentTree}). Restore the captured tree before settling the result.`)
          }
          if (status === "keep" && pending.measuredTree !== pending.resultTree) {
            return refuse(`Cannot keep experiment: measurement or checks changed candidate content (${pending.measuredTree} != ${pending.resultTree}). Discard the pending result explicitly.`)
          }

          const configuration = snapshot.configuration
          const runNumber = snapshot.runs.length + 1
          const measuredPrimary = pending.metrics[configuration.metricName]
          if (measuredPrimary !== undefined && metric !== measuredPrimary) {
            return refuse(`metric must equal the pending "${configuration.metricName}" measurement.`)
          }
          const metrics: ExperimentMetricValues = {
            ...withoutPrimary(pending.metrics, configuration.metricName),
            ...suppliedMetrics,
          }
          const projectedRun: ExperimentRun = {
            run: runNumber,
            segment: configuration.segment,
            commit: "pending",
            metric,
            metrics,
            status,
            description,
            timestamp: Date.now(),
            confidence: null,
            durationMs: pending.durationMs,
            ...(asi === undefined ? {} : { asi }),
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
              description,
              ...(asi === undefined ? {} : { asi }),
              confidence: computeConfidence(projected, configuration.segment, configuration.direction),
              durationMs: pending.durationMs,
            },
          }
          const segmentRuns = projected.filter((run) => run.segment === configuration.segment)
          const deactivate = configuration.maxIterations !== null
            && segmentRuns.length >= configuration.maxIterations

          try {
            await deps.settle(configuration.workDir, fact, deactivate, pending.measuredTree)
          } catch (error) {
            const outcome = error instanceof ExperimentPreCommitCandidateMismatchError ? "kept-pending" as const : "unresolved" as const
            return { outcome, result: failure(errorText(error)) }
          }

          const baseline = findBaselineMetric(projected, configuration.segment)
          const best = findBestMetric(projected, configuration.segment, configuration.direction)
          const confidence = computeConfidence(projected, configuration.segment, configuration.direction)
          return {
            outcome: "settled" as const,
            result: { outcome: "ok" as const, content: JSON.stringify({ run: runNumber, baseline, best, confidence, active: !deactivate }) },
          }
        })
      } catch (error) {
        return failure(errorText(error))
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failure(content: string) {
  return { outcome: "error" as const, content }
}
