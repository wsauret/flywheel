import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createPlanOnStepComplete,
  PLAN_QUESTION_DIRECTIVE,
} from "../src/workflows/plan-output-extractor";
import type { WorkerResult } from "../src/schemas/worker";
import {
  QuestionService,
  QuestionRejectedError,
  type QuestionInfo,
  type QuestionAnswer,
} from "../src/controller/question-service";
import { EventBus } from "../src/events/event-bus";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = path.join(os.tmpdir(), `flywheel-plan-extract-${process.pid}-${Date.now()}`);

function ensureTmpDir(): string {
  const dir = path.join(TMP_DIR, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

// ---------------------------------------------------------------------------
// createPlanOnStepComplete — handoff-based question handling
// ---------------------------------------------------------------------------

/** Review step index in the plan workflow. */
const REVIEW_STEP = 2;

/** Consolidation step index in the plan workflow. */
const CONSOLIDATION_STEP = 3;

/** Helper to create a WorkerResult with the given output and optional handoff path. */
function workerResult(output: string, handoffPath = ""): WorkerResult {
  return {
    output,
    exitCode: 0,
    truncated: false,
    durationMs: 1000,
    failure: undefined,
    handoffPath,
  };
}

/** A summary string that satisfies the 100-char minimum. */
const VALID_SUMMARY = "Review of the plan is complete. All questions have been identified and documented. The review covered architecture, security, and performance concerns across all phases.";

/** Write a handoff JSON file with open_questions and return its path. */
function writeHandoffWithQuestions(dir: string, questions: object[]): string {
  const handoffPath = path.join(dir, "handoff.json");
  const handoff: Record<string, unknown> = {
    summary: VALID_SUMMARY,
  };
  if (questions.length > 0) {
    handoff.open_questions = questions;
  }
  fs.writeFileSync(handoffPath, JSON.stringify(handoff));
  return handoffPath;
}

/** Write a handoff JSON file with plan_file_path and return its path. */
function writeHandoffWithPlanPath(dir: string, planFilePath: string): string {
  const handoffPath = path.join(dir, "handoff.json");
  const handoff = {
    summary: VALID_SUMMARY,
    plan_file_path: planFilePath,
  };
  fs.writeFileSync(handoffPath, JSON.stringify(handoff));
  return handoffPath;
}

describe("createPlanOnStepComplete — question handling (handoff-based)", () => {
  it("handoff with questions + interactive: true + user answers → resolvedQuestions", async () => {
    const dir = ensureTmpDir();
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    const handoffPath = writeHandoffWithQuestions(dir, [
      { question: "Should auto_chain default to true or false?", options: ["true", "false"], header: "auto_chain default" },
      { question: "How should sessions be managed?", options: [], header: "Session mgmt" },
    ]);

    const hook = createPlanOnStepComplete("/tmp/test", {
      questionService: qs,
      interactive: true,
    });

    bus.subscribe((event) => {
      if (event.type === "question:asked") {
        const requestId = (event as any).requestId;
        qs.reply(requestId, [["true"], ["custom answer"]]);
      }
    });

    const result = await hook(REVIEW_STEP, workerResult("", handoffPath), {});

    expect(result.resolvedQuestions).toBeDefined();
    const resolved = result.resolvedQuestions as Array<{
      question: string;
      answers: string[];
      source: string;
    }>;
    expect(resolved).toHaveLength(2);
    expect(resolved[0].source).toBe("user");
    expect(resolved[0].answers).toEqual(["true"]);
    expect(resolved[1].source).toBe("user");
    expect(resolved[1].answers).toEqual(["custom answer"]);

    expect(result.unresolvedQuestions).toBeUndefined();
    expect(result.questionDirective).toBeUndefined();
  });

  it("handoff with questions + user dismisses → unresolvedQuestions + directive", async () => {
    const dir = ensureTmpDir();
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    const handoffPath = writeHandoffWithQuestions(dir, [
      { question: "Should auto_chain default to true or false?", options: ["true", "false"] },
      { question: "How should sessions be managed?", options: [] },
    ]);

    const hook = createPlanOnStepComplete("/tmp/test", {
      questionService: qs,
      interactive: true,
    });

    bus.subscribe((event) => {
      if (event.type === "question:asked") {
        const requestId = (event as any).requestId;
        qs.reject(requestId);
      }
    });

    const result = await hook(REVIEW_STEP, workerResult("", handoffPath), {});

    expect(result.unresolvedQuestions).toBeDefined();
    const unresolved = result.unresolvedQuestions as Array<{ question: string }>;
    expect(unresolved).toHaveLength(2);
    expect(result.questionDirective).toBe(PLAN_QUESTION_DIRECTIVE);
    expect(result.resolvedQuestions).toBeUndefined();
  });

  it("handoff with questions + interactive: false → unresolvedQuestions + directive", async () => {
    const dir = ensureTmpDir();
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    let askCalled = false;
    bus.subscribe((event) => {
      if (event.type === "question:asked") askCalled = true;
    });

    const handoffPath = writeHandoffWithQuestions(dir, [
      { question: "Q1?", options: ["a", "b"] },
    ]);

    const hook = createPlanOnStepComplete("/tmp/test", {
      questionService: qs,
      interactive: false,
    });

    const result = await hook(REVIEW_STEP, workerResult("", handoffPath), {});

    expect(askCalled).toBe(false);
    expect(result.unresolvedQuestions).toBeDefined();
    expect(result.questionDirective).toBe(PLAN_QUESTION_DIRECTIVE);
  });

  it("no handoff → returns empty object (no questions)", async () => {
    const hook = createPlanOnStepComplete("/tmp/test", { interactive: true });
    const result = await hook(REVIEW_STEP, workerResult("output with questions in stdout"), {});
    expect(result).toEqual({});
  });

  it("handoff with no questions → returns empty object", async () => {
    const dir = ensureTmpDir();
    const handoffPath = writeHandoffWithQuestions(dir, []);
    const hook = createPlanOnStepComplete("/tmp/test", { interactive: true });
    const result = await hook(REVIEW_STEP, workerResult("", handoffPath), {});
    expect(result).toEqual({});
  });

  it("unexpected error from ask() → logs error, returns empty object", async () => {
    const dir = ensureTmpDir();
    const bus = new EventBus();
    const qs = new QuestionService(bus);

    qs.ask = async () => {
      throw new Error("Unexpected network failure");
    };

    const handoffPath = writeHandoffWithQuestions(dir, [
      { question: "Q1?", options: ["a"] },
    ]);

    const hook = createPlanOnStepComplete("/tmp/test", {
      questionService: qs,
      interactive: true,
    });

    const result = await hook(REVIEW_STEP, workerResult("", handoffPath), {});
    expect(result).toEqual({});
  });

  it("non-review step returns empty object", async () => {
    const hook = createPlanOnStepComplete("/tmp/test");
    const result = await hook(0, workerResult("Research done."), {});
    expect(result).toEqual({});
    const result1 = await hook(1, workerResult("Draft done."), {});
    expect(result1).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// createPlanOnStepComplete — consolidation step (handoff-based)
// ---------------------------------------------------------------------------

describe("createPlanOnStepComplete — consolidation step", () => {
  it("handoff with plan_file_path that exists on disk → returns planFilePath", async () => {
    const dir = ensureTmpDir();
    const plansDir = path.join(dir, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    const planFile = path.join(plansDir, "feat-test.md");
    fs.writeFileSync(planFile, "# Plan");

    const handoffPath = writeHandoffWithPlanPath(dir, "docs/plans/feat-test.md");

    const hook = createPlanOnStepComplete(dir);
    const result = await hook(CONSOLIDATION_STEP, workerResult("", handoffPath), {});

    expect(result.planFilePath).toBe(planFile);
    expect(result.planFileName).toBe("feat-test.md");
  });

  it("handoff with plan_file_path that does NOT exist on disk → returns warning", async () => {
    const dir = ensureTmpDir();
    const handoffPath = writeHandoffWithPlanPath(dir, "docs/plans/feat-nonexistent.md");

    const hook = createPlanOnStepComplete(dir);
    const result = await hook(CONSOLIDATION_STEP, workerResult("", handoffPath), {});

    expect(result.planFileWarning).toBeDefined();
  });

  it("no handoff → returns planFileWarning", async () => {
    const hook = createPlanOnStepComplete("/tmp/test");
    const result = await hook(CONSOLIDATION_STEP, workerResult("Plan created at docs/plans/feat-test.md"), {});
    expect(result.planFileWarning).toBeDefined();
  });
});
