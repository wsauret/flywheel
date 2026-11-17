import { describe, expect, test } from "bun:test";
import { emptyExperimentState, recordExperimentRun, startExperimentSegment } from "../../../../../src/orchestration/modules/experiments/state-reconstruction.js";
import type { ExperimentMetricValues, ExperimentRun, ExperimentState } from "../../../../../src/orchestration/modules/experiments/types.js";

type Step =
  | { readonly segment: number; readonly direction: "lower" | "higher" }
  | ExperimentRun;

function run(segment: number, runNumber: number, metric: number, status: ExperimentRun["status"], metrics: ExperimentMetricValues = {}): ExperimentRun {
  return { segment, run: runNumber, commit: "abc", metric, metrics, status, description: "change", timestamp: runNumber, confidence: null, durationMs: null };
}

function fold(steps: readonly Step[]): ExperimentState {
  const state = emptyExperimentState();
  for (const step of steps) {
    if ("direction" in step) startExperimentSegment(state, step.segment, step.direction);
    else recordExperimentRun(state, step);
  }
  return state;
}

describe("the experiment state fold", () => {
  test("preserves segments, first-run baseline, kept best, inferred metrics, and confidence", () => {
    const state = fold([
      { segment: 0, direction: "lower" },
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
    const state = fold([
      { segment: 1, direction: "lower" },
      run(1, 1, 10, "keep", { compile_ms: 4 }),
      { segment: 2, direction: "higher" },
      run(2, 2, 7, "discard", { render_µs: 2 }),
      run(2, 3, 9, "keep", { memory_mb: 3 }),
    ]);

    expect(state.currentSegment).toBe(2);
    expect(state.results.map(({ run: runNumber, segment }) => [runNumber, segment])).toEqual([[1, 1], [2, 2], [3, 2]]);
    expect(state.baselineMetric).toBe(7);
    expect(state.bestMetric).toBe(9);
    expect(state.secondaryMetrics).toEqual([{ name: "render_µs", unit: "µs" }, { name: "memory_mb", unit: "mb" }]);
    expect(state.confidence).toBeNull();
  });

  test("a new run leaves the results and metrics read before it unchanged", () => {
    const state = fold([{ segment: 1, direction: "lower" }, run(1, 1, 10, "keep", { compile_ms: 4 })]);
    const results = state.results;
    const secondaryMetrics = state.secondaryMetrics;

    recordExperimentRun(state, run(1, 2, 8, "keep", { size_kb: 2 }));

    expect(results.map((entry) => entry.run)).toEqual([1]);
    expect(secondaryMetrics.map((metric) => metric.name)).toEqual(["compile_ms"]);
    expect(state.results.map((entry) => entry.run)).toEqual([1, 2]);
  });
});
