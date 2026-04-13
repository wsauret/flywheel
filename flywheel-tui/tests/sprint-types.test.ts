// ---------------------------------------------------------------------------
// Sprint Types — Unit Tests
// ---------------------------------------------------------------------------
//
// Validates:
//   - SprintIterationRecord shape and field types
//   - SprintLoopState discriminated union transitions
//   - SprintConfig derivation from FlywheelConfig['sprint']
//   - SPRINT_HINT typed constant
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";

import type {
  SprintIterationRecord,
  SprintLoopState,
  SprintConfig,
} from "../src/workflows/queue/steps/sprint/types";
import { SPRINT_HINT } from "../src/workflows/queue/steps/sprint/types";

import { FlywheelConfigSchema } from "../src/orchestration/config/schema";

// ---------------------------------------------------------------------------
// SprintIterationRecord
// ---------------------------------------------------------------------------

describe("SprintIterationRecord", () => {
  test("minimal record has required fields", () => {
    const record: SprintIterationRecord = {
      iteration: 1,
      workerSummary: "Implemented auth middleware",
    };
    expect(record.iteration).toBe(1);
    expect(record.workerSummary).toBe("Implemented auth middleware");
  });

  test("full record includes optional fields", () => {
    const record: SprintIterationRecord = {
      iteration: 2,
      workerSummary: "Fixed failing tests",
      evalFeedback: "Tests still fail for edge case",
      nativeCheckPassed: false,
      workerCrashed: false,
    };
    expect(record.iteration).toBe(2);
    expect(record.evalFeedback).toBe("Tests still fail for edge case");
    expect(record.nativeCheckPassed).toBe(false);
    expect(record.workerCrashed).toBe(false);
  });

  test("workerCrashed flag is optional and defaults to undefined", () => {
    const record: SprintIterationRecord = {
      iteration: 1,
      workerSummary: "Worker output",
    };
    expect(record.workerCrashed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SprintLoopState — discriminated union
// ---------------------------------------------------------------------------

describe("SprintLoopState", () => {
  test("running state", () => {
    const state: SprintLoopState = {
      status: "running",
      iterationCount: 2,
      history: [],
    };
    expect(state.status).toBe("running");
    expect(state.iterationCount).toBe(2);
  });

  test("completed state", () => {
    const state: SprintLoopState = {
      status: "completed",
      iterationCount: 3,
      history: [
        { iteration: 1, workerSummary: "First pass" },
        { iteration: 2, workerSummary: "Second pass" },
        { iteration: 3, workerSummary: "Final pass", nativeCheckPassed: true },
      ],
    };
    expect(state.status).toBe("completed");
    expect(state.history).toHaveLength(3);
  });

  test("exhausted state", () => {
    const state: SprintLoopState = {
      status: "exhausted",
      iterationCount: 5,
      history: [],
      reason: "Max iterations reached",
    };
    expect(state.status).toBe("exhausted");
    expect(state.reason).toBe("Max iterations reached");
  });

  test("status is a discriminated union — only valid values compile", () => {
    const statuses: SprintLoopState["status"][] = [
      "running",
      "completed",
      "exhausted",
    ];
    expect(statuses).toHaveLength(3);
  });

  test("history accumulates iteration records", () => {
    const history: SprintIterationRecord[] = [];
    for (let i = 1; i <= 3; i++) {
      history.push({ iteration: i, workerSummary: `Iteration ${i}` });
    }

    const state: SprintLoopState = {
      status: "running",
      iterationCount: 3,
      history,
    };
    expect(state.history).toHaveLength(3);
    expect(state.history[2].iteration).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SprintConfig — derived from FlywheelConfig['sprint']
// ---------------------------------------------------------------------------

describe("SprintConfig", () => {
  test("FlywheelConfig sprint block parses with defaults", () => {
    const config = FlywheelConfigSchema.parse({});
    const sprint: SprintConfig = config.sprint;
    expect(sprint.max_iterations).toBe(5);
    expect(sprint.detect_stuck).toBe(false);
  });

  test("FlywheelConfig sprint block accepts overrides", () => {
    const config = FlywheelConfigSchema.parse({
      sprint: {
        max_iterations: 3,
        detect_stuck: true,
      },
    });
    const sprint: SprintConfig = config.sprint;
    expect(sprint.max_iterations).toBe(3);
    expect(sprint.detect_stuck).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SPRINT_HINT constant
// ---------------------------------------------------------------------------

describe("SPRINT_HINT", () => {
  test("value is 'sprint'", () => {
    expect(SPRINT_HINT).toBe("sprint");
  });

  test("is a const literal (type-level check — compiles only if correct)", () => {
    const hint: "sprint" = SPRINT_HINT;
    expect(hint).toBe("sprint");
  });
});

