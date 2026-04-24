// Capture canonical sprint prompt baselines into fixture files.
// Run against an unmodified source tree before refactoring prompts to
// readFileSync-backed MD files, so the regression tests have a pin.

import "../src/workflows/handoff-types/register-all.js";
import "../src/workflows/queue/steps/register-all.js";
import { join } from "node:path";

import { buildScaffolding } from "../src/workflows/queue/shared/scaffolding.js";
import { buildSprintEvaluationCriteria } from "../src/workflows/queue/steps/sprint/evaluator-criteria.js";
import { SPRINT_HINT } from "../src/workflows/queue/steps/sprint/types.js";
import type { SprintIterationRecord } from "../src/workflows/queue/steps/sprint/types.js";
import type { Step } from "../src/workflows/queue/types.js";

const FIXTURE_DIR = join(import.meta.dir, "..", "tests", "fixtures");

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

const scaffolding = buildScaffolding(canonicalSprintStep, { handoffPath: "/tmp/h.json" });
await Bun.write(
  join(FIXTURE_DIR, "sprint-scaffolding-baseline.txt"),
  scaffolding.preamble + scaffolding.postamble,
);

const criteriaNoHistory = buildSprintEvaluationCriteria();
await Bun.write(
  join(FIXTURE_DIR, "sprint-evaluator-criteria-baseline-no-history.txt"),
  criteriaNoHistory,
);

const criteriaWithHistory = buildSprintEvaluationCriteria(historyFixture);
await Bun.write(
  join(FIXTURE_DIR, "sprint-evaluator-criteria-baseline-with-history.txt"),
  criteriaWithHistory,
);

console.log("Captured sprint baselines to tests/fixtures/");
