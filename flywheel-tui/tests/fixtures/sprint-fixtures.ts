// Shared sprint scaffolding/evaluator fixtures — used by the regression test
// at tests/queue/steps/sprint-scaffolding.test.ts and the capture script at
// scripts/capture-sprint-baselines.ts. Both consumers must produce identical
// fixture output, so the canonical inputs live here.

import { SPRINT_HINT } from "../../src/workflows/queue/steps/sprint/types.js";
import type { SprintIterationRecord } from "../../src/workflows/queue/steps/sprint/types.js";
import type { Step } from "../../src/workflows/queue/types.js";

export const canonicalSprintStep: Step = {
  id: "test-sprint-step-001",
  type: "work",
  title: "Implement feature X",
  status: "running",
  dispatcherHint: SPRINT_HINT,
};

export const historyFixture: SprintIterationRecord[] = [
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
