import { describe, expect, test } from "bun:test"

import { parseExperimentFact, type ExperimentFact } from "../../../../../src/orchestration/modules/experiments/facts"

const initialized: ExperimentFact = {
  type: "experiment.initialized",
  version: 1,
  actor: "flywheel",
  payload: {
    segment: 0,
    name: "startup",
    metricName: "latency_ms",
    metricUnit: "ms",
    direction: "lower",
    measureCommand: "bun run measure",
    checksCommand: null,
    workDir: "/repo",
    maxIterations: 10,
    protectedPaths: [".experiment/**"],
    sealedPaths: ["secrets/**"],
  },
}

const run: ExperimentFact = {
  type: "experiment.run.recorded",
  version: 1,
  actor: "flywheel",
  payload: {
    run: 1,
    segment: 0,
    commit: "abc1234",
    metric: 12.5,
    metrics: { memory_mb: 20 },
    status: "keep",
    description: "Reduce startup work",
    asi: { theme: "startup" },
    confidence: null,
    durationMs: 1500,
  },
}

describe("experiment facts", () => {
  test("rejects excess keys, invalid enums, non-finite metrics, and malformed path lists", () => {
    expect(() => parseExperimentFact({ ...initialized, payload: { ...initialized.payload, extra: true } })).toThrow()
    expect(() => parseExperimentFact({ ...initialized, payload: { ...initialized.payload, direction: "fastest" } })).toThrow()
    expect(() => parseExperimentFact({ ...initialized, payload: { ...initialized.payload, protectedPaths: [1] } })).toThrow()
    expect(() => parseExperimentFact({ ...run, payload: { ...run.payload, metric: Number.POSITIVE_INFINITY } })).toThrow()
    expect(() => parseExperimentFact({ ...run, payload: { ...run.payload, metrics: { memory_mb: Number.NaN } } })).toThrow()
    expect(() => parseExperimentFact({ ...run, payload: { ...run.payload, status: "unknown" } })).toThrow()
  })

})
