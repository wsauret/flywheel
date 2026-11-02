import type { OwnedCommandRunner } from "../../../../infra/owned-command.js"
import { captureExperimentTree } from "../git-operations.js"
import {
  runExperimentCommands,
} from "../experiment-command-runner.js"
import type { ExperimentExecutionState, PendingExperimentResult } from "../execution-state.js"
import type { ExperimentOperationOwner } from "../operation-owner.js"
import type { ExperimentSnapshot } from "../projection.js"
import { runExperimentSchema } from "../../../agent-runtime/tools/experiment-schemas.js"
import type { RuntimeTool, RuntimeToolInput } from "../../../agent-runtime/tools/types.js"

interface RunExperimentDependencies {
  readonly replay: () => Promise<ExperimentSnapshot | undefined>
  readonly executionState: ExperimentExecutionState<PendingExperimentResult>
  readonly operation: ExperimentOperationOwner
  readonly run: OwnedCommandRunner
  readonly platform: NodeJS.Platform
  readonly scratchDir: string
  readonly prepareScratch: () => Promise<void>
  readonly captureTree?: typeof captureExperimentTree
}

export function createRunExperimentTool(deps: RunExperimentDependencies): RuntimeTool {
  return {
    name: "run_experiment",
    action: "shell_exec",
    description: "Run the active experiment's approved measurement and checks commands.",
    inputSchema: runExperimentSchema,
    isConcurrencySafe: false,
    unboundedDuration: true,
    execute: async (input) => {
      const blocker = await deps.operation.blocker()
      if (blocker) return failure(blocker)
      const snapshot = await deps.replay()
      if (snapshot === undefined) return failure("Experiment state is unavailable.")
      if (!snapshot.mode.active) return failure("Experiment mode is not active.")
      const configuration = snapshot.configuration
      if (configuration === null) return failure("Experiment is not initialized.")
      if (snapshot.mode.workDir !== configuration.workDir) {
        return failure("The active experiment worktree does not match the initialized experiment.")
      }
      const currentSegmentRuns = snapshot.runs.filter((run) => run.segment === configuration.segment)
      if (configuration.maxIterations !== null && currentSegmentRuns.length >= configuration.maxIterations) {
        return failure(`Experiment iteration limit reached (${configuration.maxIterations}).`)
      }
      if (deps.executionState.snapshot().status !== "idle") return failure("Experiment execution is not idle.")
      try {
        await deps.prepareScratch()
        await deps.operation.begin(configuration.measureCommand, configuration.workDir)
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
      }
      if (!deps.executionState.start(configuration.measureCommand)) {
        return failure("Experiment execution is not idle.")
      }

      try {
        const captureTree = deps.captureTree ?? captureExperimentTree
        const measuredTree = await captureTree({
          cwd: configuration.workDir,
          scratchDir: deps.scratchDir,
          run: deps.run,
        })
        const result = await runExperimentCommands({
          platform: deps.platform,
          cwd: configuration.workDir,
          measureCommand: configuration.measureCommand,
          checksCommand: configuration.checksCommand,
          timeoutSeconds: optionalNumber(input, "timeout_seconds"),
          checksTimeoutSeconds: optionalNumber(input, "checks_timeout_seconds"),
          run: deps.run,
        })
        if (result.status !== "measurement_failed" && result.metrics[configuration.metricName] === undefined) {
          deps.operation.interrupt()
          deps.executionState.fail()
          return failure(`Measurement succeeded but did not emit primary METRIC "${configuration.metricName}".`)
        }
        const resultTree = await captureTree({
          cwd: configuration.workDir,
          scratchDir: deps.scratchDir,
          run: deps.run,
        })
        deps.executionState.finish({ ...result, measuredTree, resultTree })
        return { outcome: "ok", content: result.modelOutput }
      } catch (error) {
        deps.operation.interrupt()
        deps.executionState.fail()
        return failure(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/** The dispatcher has already validated declared types, so a present value is a number. */
function optionalNumber(input: RuntimeToolInput, key: string): number | undefined {
  const value = input[key]
  return typeof value === "number" ? value : undefined
}

function failure(content: string) {
  return { outcome: "error" as const, content }
}
