import { expect, test } from "bun:test"
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../../src/infra/owned-command.js"
import { runExperimentCommands } from "../../../../../src/orchestration/modules/experiments/experiment-command-runner.js"

function result(stdout: string, exitCode = 0, timedOut = false): OwnedCommandResult {
  return { exitCode, stdout, stderr: "", stdoutBytes: new TextEncoder().encode(stdout), timedOut }
}

test("runs the recorded measurement and checks commands with exact owned limits", async () => {
  const calls: Array<{ command: readonly string[]; options: Parameters<OwnedCommandRunner>[1] }> = []
  const results = [result("noise\nMETRIC latency=12\nMETRIC memory=4\n"), result("checks passed")]
  const run: OwnedCommandRunner = async (command, options) => {
    calls.push({ command, options })
    return results.shift()!
  }

  const output = await runExperimentCommands({
    platform: "linux",
    cwd: "/experiment",
    measureCommand: "./.experiment/measure.sh",
    checksCommand: "./.experiment/checks.sh",
    run,
  })

  expect(calls).toEqual([
    {
      command: ["bash", "-lc", "./.experiment/measure.sh"],
      options: { cwd: "/experiment", timeoutMs: 600_000, maxOutputBytes: 1_000_000, outputRetention: "tail" },
    },
    {
      command: ["bash", "-lc", "./.experiment/checks.sh"],
      options: { cwd: "/experiment", timeoutMs: 300_000, maxOutputBytes: 1_000_000, outputRetention: "tail" },
    },
  ])
  expect(output).toEqual({
    status: "passed",
    metrics: { latency: 12, memory: 4 },
    durationMs: expect.any(Number),
    measurementOutput: "noise\nMETRIC latency=12\nMETRIC memory=4\n",
    checksOutput: "checks passed",
    modelOutput: "noise\nMETRIC latency=12\nMETRIC memory=4",
  })
})

test("does not run checks after a failed measurement", async () => {
  let calls = 0
  const output = await runExperimentCommands({
    platform: "win32",
    cwd: "C:\\experiment",
    measureCommand: "measure.ps1",
    checksCommand: "checks.ps1",
    run: async () => {
      calls++
      return result("benchmark failed", 1)
    },
  })

  expect(calls).toBe(1)
  expect(output.status).toBe("measurement_failed")
  expect(output.modelOutput).toBe("benchmark failed")
})

test("includes the last eighty check lines when checks fail", async () => {
  const lines = Array.from({ length: 100 }, (_, index) => `failure ${index + 1}`)
  const results = [result("METRIC latency=12"), result(lines.join("\n"), 1)]
  const output = await runExperimentCommands({
    platform: "linux",
    cwd: "/experiment",
    measureCommand: "measure",
    checksCommand: "checks",
    run: async () => results.shift()!,
  })

  expect(output.status).toBe("checks_failed")
  expect(output.modelOutput.split("\n")).toEqual(lines.slice(20))
})
