import { Schema } from "effect"
import type { ExperimentInitializedFact } from "../facts.js"
import type { ExperimentExecutionState } from "../execution-state.js"
import type { ExperimentOperationOwner } from "../operation-owner.js"
import { MANDATORY_PROTECTED_PATHS, parseExperimentCharter, type ExperimentCharter } from "../charter.js"
import { initExperimentSchema } from "../../../agent-runtime/tools/experiment-schemas.js"
import type { RuntimeTool, RuntimeToolInput } from "../../../agent-runtime/tools/types.js"

/** The model restates the charter in the tool's snake_case argument names;
 *  absent optional fields take the same defaults the charter parser applies. */
const InitExperimentInputSchema = Schema.Struct({
  name: Schema.String,
  metric_name: Schema.String,
  metric_unit: Schema.optionalKey(Schema.String),
  direction: Schema.optionalKey(Schema.Literals(["lower", "higher"])),
  measure_command: Schema.String,
  checks_command: Schema.optionalKey(Schema.NullOr(Schema.String)),
  work_dir: Schema.String,
  max_iterations: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  protected_paths: Schema.optionalKey(Schema.Array(Schema.String)),
  sealed_paths: Schema.optionalKey(Schema.Array(Schema.String)),
})

interface InitSnapshot {
  readonly mode: { readonly active: boolean; readonly workDir: string | null }
  readonly configuration: unknown
  readonly segments: readonly unknown[]
  readonly runs: readonly unknown[]
}

interface InitExperimentDependencies {
  readonly snapshot: () => Promise<InitSnapshot> | InitSnapshot
  readonly readCharter: () => Promise<string>
  readonly validateWorktree: (input: { workDir: string; executionCwd: string; projectRoot: string }) => Promise<string>
  readonly record: (fact: ExperimentInitializedFact) => Promise<void>
  readonly executionState: ExperimentExecutionState
  readonly operation: ExperimentOperationOwner
  readonly parseCharter?: (markdown: string) => ExperimentCharter
}

export function createInitExperimentTool(deps: InitExperimentDependencies): RuntimeTool {
  return {
    name: "init_experiment",
    action: "ui_meta",
    description: "Initialize the active experiment from its approved charter.",
    inputSchema: initExperimentSchema,
    isConcurrencySafe: false,
    execute: async (input, context) => {
      try {
        const blocker = await deps.operation.blocker()
        if (blocker) return failure(blocker)
        const snapshot = await deps.snapshot()
        if (!snapshot.mode.active) return failure("Experiment mode is not active.")
        if (deps.executionState.snapshot().status !== "idle") return failure("Experiment execution is not idle.")
        const charter = (deps.parseCharter ?? parseExperimentCharter)(await deps.readCharter())
        const supplied = decodeInput(input)
        if (!sameConfig(charter, supplied)) return failure("init_experiment arguments do not match the active charter.")
        const workDir = await deps.validateWorktree({
          workDir: charter.workDir,
          executionCwd: context.executionCwd,
          projectRoot: context.projectRoot,
        })
        if (snapshot.mode.workDir !== null && snapshot.mode.workDir !== workDir) return failure("The active experiment worktree does not match the charter.")
        const protectedPaths = unique([...charter.protectedPaths, ...MANDATORY_PROTECTED_PATHS])
        const fact: ExperimentInitializedFact = {
          type: "experiment.initialized",
          version: 1,
          actor: "flywheel",
          payload: {
            segment: snapshot.segments.length + 1,
            name: charter.name,
            metricName: charter.metricName,
            metricUnit: charter.metricUnit,
            direction: charter.direction,
            measureCommand: charter.measureCommand,
            checksCommand: charter.checksCommand,
            workDir,
            maxIterations: charter.maxIterations,
            protectedPaths,
            sealedPaths: unique(charter.sealedPaths),
          },
        }
        await deps.record(fact)
        return { outcome: "ok", content: `Experiment initialized as segment ${fact.payload.segment}.` }
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

function decodeInput(input: RuntimeToolInput): Omit<ExperimentCharter, "baselineMetric"> {
  const decoded = Schema.decodeUnknownSync(InitExperimentInputSchema)(input)
  return {
    name: decoded.name,
    metricName: decoded.metric_name,
    metricUnit: decoded.metric_unit ?? "",
    direction: decoded.direction ?? "lower",
    measureCommand: decoded.measure_command,
    checksCommand: decoded.checks_command ?? null,
    workDir: decoded.work_dir,
    maxIterations: decoded.max_iterations ?? null,
    protectedPaths: decoded.protected_paths ?? [],
    sealedPaths: decoded.sealed_paths ?? [],
  }
}

function sameConfig(charter: ExperimentCharter, supplied: Omit<ExperimentCharter, "baselineMetric">): boolean {
  const { baselineMetric: _, ...expected } = charter
  return JSON.stringify(expected) === JSON.stringify(supplied)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function failure(content: string) {
  return { outcome: "error" as const, content }
}
