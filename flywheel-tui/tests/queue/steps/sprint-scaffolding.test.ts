import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import "../../../src/workflows/handoff-types/register-all.js";
import "../../../src/workflows/queue/steps/register-all.js";

import { buildScaffolding } from "../../../src/workflows/queue/shared/scaffolding.js";
import { buildSprintEvaluationCriteria } from "../../../src/workflows/queue/steps/sprint/evaluator-criteria.js";
import { SPRINT_HINT } from "../../../src/workflows/queue/steps/sprint/types.js";
import type { SprintIterationRecord } from "../../../src/workflows/queue/steps/sprint/types.js";
import type { Step } from "../../../src/workflows/queue/types.js";
import { formatChecklistNumbered } from "../../../src/workflows/queue/shared/quality-checklist.js";

const SPRINT_DIR = join(import.meta.dir, "..", "..", "..", "src", "workflows", "queue", "steps", "sprint");

const FIXTURE_DIR = join(import.meta.dir, "..", "..", "fixtures");

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf-8");
}

const canonicalSprintStep: Step = {
  id: "test-sprint-step-001",
  type: "work",
  title: "Implement feature X",
  status: "running",
  dispatcherHint: SPRINT_HINT,
};

const historyFixture: SprintIterationRecord[] = [
  {
    iteration: 1,
    workerSummary: "Added endpoint and initial tests.",
    evalFeedback: "Missing tests for error path.",
    nativeCheckPassed: true,
  },
  {
    iteration: 2,
    workerSummary: "Added error-path test and fixed null handling.",
    nativeCheckPassed: true,
  },
];

describe("sprint scaffolding + evaluator criteria baselines", () => {
  it("buildScaffolding on canonical sprint step matches fixture", () => {
    const result = buildScaffolding(canonicalSprintStep, { handoffPath: "/tmp/h.json" });
    const combined = result.preamble + result.postamble;
    const expected = readFixture("sprint-scaffolding-baseline.txt");
    expect(combined).toBe(expected);
  });

  it("buildSprintEvaluationCriteria() without history matches fixture", () => {
    const expected = readFixture("sprint-evaluator-criteria-baseline-no-history.txt");
    expect(buildSprintEvaluationCriteria()).toBe(expected);
  });

  it("buildSprintEvaluationCriteria(history) matches fixture", () => {
    const expected = readFixture("sprint-evaluator-criteria-baseline-with-history.txt");
    expect(buildSprintEvaluationCriteria(historyFixture)).toBe(expected);
  });

  it("evaluator-criteria-prefix.md contains formatChecklistNumbered() output", () => {
    const onDisk = readFileSync(join(SPRINT_DIR, "evaluator-criteria-prefix.md"), "utf-8");
    expect(onDisk).toContain(formatChecklistNumbered());
  });
});
