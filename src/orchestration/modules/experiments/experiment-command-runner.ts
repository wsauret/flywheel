import type { OwnedCommandResult, OwnedCommandRunner } from "../../../infra/owned-command.js"
import { MAX_OUTPUT_BYTES } from "../../../infra/bounded-stream.js"
import { shellCommandInvocation } from "../../agent-runtime/tools/bash-script.js"
import { parseMetricLines } from "./metric-lines.js"
import type { ExperimentMetricValues } from "./types.js"

const DEFAULT_MEASUREMENT_TIMEOUT_SECONDS = 600
const DEFAULT_CHECKS_TIMEOUT_SECONDS = 300
const MODEL_OUTPUT_LINES = 10
const MODEL_OUTPUT_BYTES = 4_096
const FAILED_CHECK_LINES = 80

type ExperimentCommandStatus = "passed" | "measurement_failed" | "checks_failed"

export interface ExperimentCommandResult {
  readonly status: ExperimentCommandStatus
  readonly metrics: ExperimentMetricValues
  readonly measurementOutput: string
  readonly checksOutput: string | null
  readonly modelOutput: string
  /** Wall-clock milliseconds of the measure command alone; checks are not counted. */
  readonly durationMs: number
}

interface RunExperimentCommandsInput {
  readonly platform: NodeJS.Platform
  readonly cwd: string
  readonly measureCommand: string
  readonly checksCommand: string | null
  readonly timeoutSeconds?: number
  readonly checksTimeoutSeconds?: number
  readonly run: OwnedCommandRunner
}

/** Runs only the commands recorded in an admitted experiment configuration. */
export async function runExperimentCommands(input: RunExperimentCommandsInput): Promise<ExperimentCommandResult> {
  const started = performance.now()
  const measurement = await runRecordedCommand(
    input.run,
    input.platform,
    input.measureCommand,
    input.cwd,
    input.timeoutSeconds ?? DEFAULT_MEASUREMENT_TIMEOUT_SECONDS,
  )
  const durationMs = Math.round(performance.now() - started)
  const metrics = Object.fromEntries(parseMetricLines(measurement.stdout))
  if (!passed(measurement)) {
    return {
      status: "measurement_failed",
      metrics,
      durationMs,
      measurementOutput: measurement.stdout,
      checksOutput: null,
      modelOutput: modelTail(commandOutput(measurement)),
    }
  }

  if (input.checksCommand === null) {
    return {
      status: "passed",
      metrics,
      durationMs,
      measurementOutput: measurement.stdout,
      checksOutput: null,
      modelOutput: modelTail(commandOutput(measurement)),
    }
  }

  const checks = await runRecordedCommand(
    input.run,
    input.platform,
    input.checksCommand,
    input.cwd,
    input.checksTimeoutSeconds ?? DEFAULT_CHECKS_TIMEOUT_SECONDS,
  )
  if (!passed(checks)) {
    return {
      status: "checks_failed",
      metrics,
      durationMs,
      measurementOutput: measurement.stdout,
      checksOutput: checks.stdout,
      modelOutput: lastLines(commandOutput(checks), FAILED_CHECK_LINES),
    }
  }

  return {
    status: "passed",
    metrics,
    durationMs,
    measurementOutput: measurement.stdout,
    checksOutput: checks.stdout,
    modelOutput: modelTail(commandOutput(measurement)),
  }
}

function runRecordedCommand(
  run: OwnedCommandRunner,
  platform: NodeJS.Platform,
  command: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<OwnedCommandResult> {
  return run(shellCommandInvocation(platform, command), {
    cwd,
    timeoutMs: timeoutSeconds * 1_000,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    outputRetention: "tail",
  })
}

function passed(result: OwnedCommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut
}

function commandOutput(result: OwnedCommandResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n")
}

function modelTail(output: string): string {
  const lines = lastLines(output, MODEL_OUTPUT_LINES)
  const bytes = new TextEncoder().encode(lines)
  if (bytes.byteLength <= MODEL_OUTPUT_BYTES) return lines
  return new TextDecoder().decode(bytes.slice(bytes.byteLength - MODEL_OUTPUT_BYTES)).replace(/^\uFFFD/, "")
}

function lastLines(output: string, count: number): string {
  return output.trimEnd().split("\n").slice(-count).join("\n")
}
