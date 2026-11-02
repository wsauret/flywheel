import { describe, expect, test } from "bun:test"
import { parseExperimentCharter } from "../../../../../src/orchestration/modules/experiments/charter.js"

const charter = `# Experiment

\`\`\`toml
name = "speed"
metric_name = "latency"
metric_unit = "ms"
direction = "lower"
measure_command = "./.experiment/measure.sh"
checks_command = "./.experiment/checks.sh"
work_dir = "."
max_iterations = 20
protected_paths = ["tests/**"]
sealed_paths = ["secret/**"]
\`\`\`

## Objective
Make it faster.
## Metrics
Latency is primary.
## Hard gates
Tests pass.
## Anti-gaming rules
Do not special-case fixtures.
## Files in scope
src/**
## Protected paths
tests/**
## Sealed paths
secret/**
## Commands
Use the recorded commands.
## Baseline
METRIC latency=12.5
## Search strategy
Measure one change at a time.
`

describe("parseExperimentCharter", () => {
  test("strictly parses a complete charter and baseline proof", () => {
    expect(parseExperimentCharter(charter)).toEqual({
      name: "speed", metricName: "latency", metricUnit: "ms", direction: "lower",
      measureCommand: "./.experiment/measure.sh", checksCommand: "./.experiment/checks.sh",
      workDir: ".", maxIterations: 20, protectedPaths: ["tests/**"], sealedPaths: ["secret/**"],
      baselineMetric: 12.5,
    })
  })

  test("rejects missing prose, metric proof, and unknown TOML keys", () => {
    expect(() => parseExperimentCharter(charter.replace("## Search strategy", "## Ideas"))).toThrow("Search strategy")
    expect(() => parseExperimentCharter(charter.replace("METRIC latency=12.5", "no metric"))).toThrow("METRIC latency")
    expect(() => parseExperimentCharter(charter.replace('name = "speed"', 'name = "speed"\nextra = true'))).toThrow("extra")
  })
})
