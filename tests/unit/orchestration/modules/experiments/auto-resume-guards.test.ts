import { describe, expect, test } from "bun:test";
import { autoResumeStopReasonFor } from "../../../../../src/orchestration/modules/experiments/auto-resume-guards.js";
import type { ExperimentRun } from "../../../../../src/orchestration/modules/experiments/types.js";

function run(status: ExperimentRun["status"], segment = 0): ExperimentRun {
  return { run: 1, commit: "", metric: status === "crash" ? 0 : 10, metrics: {}, status, description: "", timestamp: 0, segment, confidence: null, durationMs: null };
}

function stopReason(results: ExperimentRun[], currentSegment: number): string | null {
  return autoResumeStopReasonFor({ autoResumeTurns: 0, state: { results, currentSegment } });
}

describe("experiment auto-resume guards", () => {
  test("stops after more than 20 consecutive failures, and the count resets after any other status and at a segment boundary", () => {
    const failures = Array.from({ length: 21 }, () => run("discard"));
    expect(stopReason(failures, 0)).toBe("Experiment auto-resume stopped: 21 consecutive discards/crashes");
    expect(stopReason([...failures, run("checks_failed")], 0)).toBeNull();
    expect(stopReason([...failures, run("crash", 1)], 1)).toBeNull();
  });
});
