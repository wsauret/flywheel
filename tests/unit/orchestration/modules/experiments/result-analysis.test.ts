import { describe, expect, test } from "bun:test";
import { computeConfidence } from "../../../../../src/orchestration/modules/experiments/result-analysis.js";
import type { ExperimentRun } from "../../../../../src/orchestration/modules/experiments/types.js";

function run(metric: number, status: ExperimentRun["status"], segment = 0): ExperimentRun {
  return { run: 1, commit: "abc", metric, metrics: {}, status, description: "", timestamp: 1, segment, confidence: null, durationMs: null };
}

describe("experiment result analysis", () => {
  test("computes confidence from current-segment MAD and best kept improvement", () => {
    const results = [run(10, "keep"), run(12, "discard"), run(8, "keep"), run(100, "keep", 1)];
    expect(computeConfidence(results, 0, "lower")).toBe(1);
    expect(computeConfidence(results.slice(0, 2), 0, "lower")).toBeNull();
    expect(computeConfidence([run(10, "keep"), run(10, "discard"), run(10, "keep")], 0, "lower")).toBeNull();
  });

  test("ignores non-positive measurements when estimating confidence", () => {
    expect(computeConfidence([run(10, "keep"), run(0, "crash"), run(8, "keep")], 0, "lower")).toBeNull();
  });
});
