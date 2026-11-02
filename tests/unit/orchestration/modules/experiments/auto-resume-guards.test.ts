import { describe, expect, test } from "bun:test";
import { countConsecutiveDiscardOrCrashRuns } from "../../../../../src/orchestration/modules/experiments/auto-resume-guards.js";
import type { ExperimentRun } from "../../../../../src/orchestration/modules/experiments/types.js";

function run(status: ExperimentRun["status"], segment = 0): ExperimentRun {
  return { run: 1, commit: "", metric: status === "crash" ? 0 : 10, metrics: {}, status, description: "", timestamp: 0, segment, confidence: null, durationMs: null };
}

describe("experiment auto-resume guards", () => {
  test("resets after any other status and at a segment boundary", () => {
    const failures = Array.from({ length: 21 }, () => run("discard"));
    expect(countConsecutiveDiscardOrCrashRuns({ results: [...failures, run("checks_failed")], currentSegment: 0 })).toBe(0);
    expect(countConsecutiveDiscardOrCrashRuns({ results: [...failures, run("crash", 1)], currentSegment: 1 })).toBe(1);
  });
});
