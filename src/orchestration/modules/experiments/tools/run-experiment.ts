import type { OwnedCommandRunner } from "../../../../infra/owned-command.js"
import { captureExperimentTree } from "../git-operations.js"
import {
  runExperimentCommands,
} from "../experiment-command-runner.js"
import type { ExperimentOperation } from "../operation-owner.js"
import type { ExperimentSnapshot } from "../projection.js"
import { runExperimentSchema } from "../../../agent-runtime/tools/experiment-schemas.js"
import type { RuntimeTool, RuntimeToolInput } from "../../../agent-runtime/tools/types.js"

interface RunExperimentDependencies {
  readonly replay: () => Promise<ExperimentSnapshot | undefined>
  readonly operation: ExperimentOperation
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
      let configuration: NonNullable<ExperimentSnapshot["configuration"]>
      try {
        ({ configuration } = await deps.operation.begin(async () => {
          const snapshot = await deps.replay()
          if (snapshot === undefined) throw new Error("Experiment state is unavailable.")
          if (!snapshot.mode.active) throw new Error("Experiment mode is not active.")
          const current = snapshot.configuration
          if (current === null) throw new Error("Experiment is not initialized.")
          if (snapshot.mode.workDir !== current.workDir) {
            throw new Error("The active experiment worktree does not match the initialized experiment.")
          }
          const currentSegmentRuns = snapshot.runs.filter((run) => run.segment === current.segment)
          if (current.maxIterations !== null && currentSegmentRuns.length >= current.maxIterations) {
            throw new Error(`Experiment iteration limit reached (${current.maxIterations}).`)
          }
          await deps.prepareScratch()
          return { configuration: current, command: current.measureCommand, cwd: current.workDir }
        }))
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error))
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
          deps.operation.failed()
          return failure(`Measurement succeeded but did not emit primary METRIC "${configuration.metricName}".`)
        }
        const resultTree = await captureTree({
          cwd: configuration.workDir,
          scratchDir: deps.scratchDir,
          run: deps.run,
        })
        deps.operation.measured({ ...result, measuredTree, resultTree })
        return { outcome: "ok", content: result.modelOutput }
      } catch (error) {
        deps.operation.failed()
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
