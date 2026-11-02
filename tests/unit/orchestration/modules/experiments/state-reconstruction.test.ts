import { describe, expect, test } from "bun:test";
import { reconstructExperimentState } from "../../../../../src/orchestration/modules/experiments/state-reconstruction.js";
import type { ExperimentMetricValues, ExperimentStateEntry, ExperimentRunValue } from "../../../../../src/orchestration/modules/experiments/types.js";

const initialized = (segment: number, name: string, direction: "lower" | "higher" = "lower"): ExperimentStateEntry => ({
  type: "initialized",
  value: { segment, name, metricName: "total_ms", metricUnit: "ms", bestDirection: direction },
});

function run(segment: number, runNumber: number, metric: number, status: ExperimentRunValue["status"], metrics: ExperimentMetricValues = {}): ExperimentStateEntry {
  return { type: "run", value: { segment, run: runNumber, commit: "abc", metric, metrics, status, description: "change", timestamp: runNumber, confidence: null, durationMs: null } };
}

describe("reconstructExperimentState", () => {
  test("preserves segments, first-run baseline, kept best, inferred metrics, and confidence", () => {
    const state = reconstructExperimentState([
      initialized(0, "one"),
      run(0, 1, 10, "keep", { compile_ms: 4 }),
      run(0, 2, 12, "discard", { size_kb: 8 }),
      run(0, 3, 8, "keep", { compile_ms: 3 }),
    ]);

    expect(state.results.map(({ segment }) => segment)).toEqual([0, 0, 0]);
    expect(state.baselineMetric).toBe(10);
    expect(state.bestMetric).toBe(8);
    expect(state.secondaryMetrics).toEqual([{ name: "compile_ms", unit: "ms" }, { name: "size_kb", unit: "kb" }]);
    expect(state.confidence).toBe(1);
  });

  test("resets secondary metrics and analysis for each initialized segment", () => {
    const state = reconstructExperimentState([
      initialized(1, "one"),
      run(1, 1, 10, "keep", { compile_ms: 4 }),
      initialized(2, "two", "higher"),
      run(2, 2, 7, "discard", { render_µs: 2 }),
      run(2, 3, 9, "keep", { memory_mb: 3 }),
    ]);

    expect(state.currentSegment).toBe(2);
    expect(state.results.map(({ run: runNumber, segment }) => [runNumber, segment])).toEqual([[1, 1], [2, 2], [3, 2]]);
    expect(state.name).toBe("two");
    expect(state.baselineMetric).toBe(7);
    expect(state.bestMetric).toBe(9);
    expect(state.secondaryMetrics).toEqual([{ name: "render_µs", unit: "µs" }, { name: "memory_mb", unit: "mb" }]);
    expect(state.confidence).toBeNull();
  });

});
