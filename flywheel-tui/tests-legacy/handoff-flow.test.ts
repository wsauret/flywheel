/**
 * Integration tests for the handoff system end-to-end flow.
 *
 * Tests the complete lifecycle:
 * - Worker writes handoff file → evaluator gets structured data → dispatcher gets lastWorkerResult
 * - Missing handoff + exit 0 → handoff_missing, retry with session resume, succeed
 * - Invalid handoff → handoff_invalid, retry with Zod error in prompt
 * - Summary under 100 chars → schema failure, retry
 * - Evaluator verdict: file written and read
 * - Dispatcher decision: file written and read
 * - Cleanup of handoff files in afterAll
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  readHandoff,
  HandoffMissingError,
  HandoffInvalidError,
} from "../src/workflows/queue/shared/handoff-reader";
import {
  WorkerHandoffSchema,
} from "../src/protocol/handoff-schemas";
import type { WorkerHandoff } from "../src/protocol/handoff-schemas";
import { EvaluatorVerdictSchema, type EvaluatorVerdict } from "../src/workflows/evaluator/schemas";
import { DispatcherDecisionHandoffSchema, type DispatcherDecisionHandoff } from "../src/workflows/dispatcher/schemas";
import {
  renderHandoffInstruction,
  renderEvaluatorHandoffInstruction,
  renderDispatcherHandoffInstruction,
} from "../src/workflows/queue/shared/handoff-render";
import {
  WORK_STEP_FIELDS,
} from "../src/workflows/queue/steps/work/fields";
import {
  PLAN_CONSOLIDATE_FIELDS,
} from "../src/workflows/queue/steps/plan-consolidate/fields";
import {
  REVIEW_FIELDS,
} from "../src/workflows/queue/steps/review-consolidate/fields";

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-handoff-integration-${process.pid}-${Date.now()}`,
);

function handoffDir(): string {
  const dir = path.join(TMP_ROOT, ".flywheel", "handoffs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function handoffPath(id: string): string {
  return path.join(handoffDir(), `${id}.json`);
}

beforeEach(() => {
  fs.mkdirSync(handoffDir(), { recursive: true });
});

afterEach(() => {
  // Clean individual handoff files between tests
  const dir = path.join(TMP_ROOT, ".flywheel", "handoffs");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
  }
});

afterAll(() => {
  // Remove the entire temp directory tree
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validWorkerHandoff(overrides?: Partial<WorkerHandoff>): WorkerHandoff {
  return {
    summary:
      "Implemented the authentication middleware with JWT validation, rate limiting, and session management. " +
      "All 24 tests pass. Created src/auth/jwt.ts, src/auth/session.ts. Modified src/index.ts for route registration.",
    artifacts: {
      files_created: ["src/auth/jwt.ts", "src/auth/session.ts"],
      files_modified: ["src/index.ts", "src/config.ts"],
      commands_run: ["bun test", "bun run lint"],
    },
    decisions: ["Used RS256 for JWT signing", "Rate limiting at router level"],
    warnings: ["JWT secret should be rotated in production"],
    verification: {
      tests_passed: true,
      test_output_summary: "24/24 tests pass in 2.1s",
    },
    files_to_review: ["src/auth/jwt.ts", "tests/auth.test.ts"],
    ...overrides,
  } as WorkerHandoff;
}

function validEvaluatorVerdict(
  overrides?: Partial<EvaluatorVerdict>,
): EvaluatorVerdict {
  return {
    passed: true,
    reasoning:
      "All acceptance criteria met. Tests pass. Implementation follows conventions.",
    suggestions: ["Consider adding edge case tests for token expiry"],
    confidence: 0.92,
    feedback: "Good implementation. Tests are comprehensive.",
    files_to_review: ["src/auth/jwt.ts"],
    ...overrides,
  };
}

function validDispatcherDecision(
  overrides?: Partial<DispatcherDecisionHandoff>,
): DispatcherDecisionHandoff {
  return {
    schema_version: 1 as const,
    step_index: 0,
    task_content:
      "Implement the authentication middleware with JWT validation following the plan.",
    context_files: ["src/index.ts", "docs/standards/auth.md"],
    session_name: "work-session-step-1",
    reasoning: "Standard implementation step, proceeding with plan.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Valid worker handoff → evaluator gets structured data, dispatcher gets lastWorkerResult
// ---------------------------------------------------------------------------

describe("Valid worker handoff flow", () => {
  it("worker handoff file is written, read, and parsed correctly", async () => {
    const hp = handoffPath("worker-valid-001");
    const data = validWorkerHandoff();
    fs.writeFileSync(hp, JSON.stringify(data));

    const parsed = await readHandoff(hp, WorkerHandoffSchema);

    expect(parsed.summary).toContain("authentication middleware");
    expect(parsed.artifacts?.files_created).toContain("src/auth/jwt.ts");
    expect(parsed.verification?.tests_passed).toBe(true);
    expect(parsed.decisions).toContain("Used RS256 for JWT signing");
  });

  it("evaluator gets structured data from worker handoff", async () => {
    const hp = handoffPath("worker-for-eval-001");
    const data = validWorkerHandoff();
    fs.writeFileSync(hp, JSON.stringify(data));

    const parsed = await readHandoff(hp, WorkerHandoffSchema);

    // Evaluator uses handoff.summary, handoff.verification, handoff.artifacts, handoff.files_to_review
    expect(parsed.summary.length).toBeGreaterThanOrEqual(100);
    expect(parsed.verification).toBeDefined();
    expect(parsed.artifacts).toBeDefined();
    expect(parsed.files_to_review).toBeDefined();
    expect(parsed.files_to_review!.length).toBeGreaterThan(0);
  });

});

// ---------------------------------------------------------------------------
// 2. Missing handoff + exit 0 → handoff_missing, retry succeeds
// ---------------------------------------------------------------------------

describe("Missing handoff recovery", () => {
  it("throws HandoffMissingError when file does not exist", async () => {
    const hp = handoffPath("nonexistent-001");

    try {
      await readHandoff(hp, WorkerHandoffSchema);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffMissingError);
      expect((err as HandoffMissingError).path).toBe(hp);
    }
  });

  it("succeeds on second attempt when file is written", async () => {
    const hp = handoffPath("retry-missing-001");

    // First attempt: missing
    let firstFailed = false;
    try {
      await readHandoff(hp, WorkerHandoffSchema);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffMissingError);
      firstFailed = true;
    }
    expect(firstFailed).toBe(true);

    // Simulate worker retry writing the file
    fs.writeFileSync(hp, JSON.stringify(validWorkerHandoff()));

    // Second attempt: succeeds
    const parsed = await readHandoff(hp, WorkerHandoffSchema);
    expect(parsed.summary).toContain("authentication middleware");
  });

  it("error message includes the file path for debugging", async () => {
    const hp = handoffPath("debug-path-001");

    try {
      await readHandoff(hp, WorkerHandoffSchema);
    } catch (err) {
      expect((err as Error).message).toContain(hp);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Invalid handoff → handoff_invalid, retried with Zod error in prompt
// ---------------------------------------------------------------------------

describe("Invalid handoff recovery", () => {
  it("throws HandoffInvalidError for malformed JSON", async () => {
    const hp = handoffPath("bad-json-001");
    fs.writeFileSync(hp, "{ not valid json!!! }");

    try {
      await readHandoff(hp, WorkerHandoffSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
      expect((err as HandoffInvalidError).message).toContain("JSON");
    }
  });

  it("throws HandoffInvalidError with Zod details for schema mismatch", async () => {
    const hp = handoffPath("schema-mismatch-001");
    // Valid JSON but missing required 'summary' field
    fs.writeFileSync(hp, JSON.stringify({ decisions: ["something"] }));

    try {
      await readHandoff(hp, WorkerHandoffSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
      expect((err as HandoffInvalidError).message).toContain("summary");
    }
  });

  it("tolerates unknown fields (.passthrough()) on WorkerHandoffSchema", async () => {
    const hp = handoffPath("extra-fields-001");
    fs.writeFileSync(
      hp,
      JSON.stringify({
        summary: "A".repeat(100),
        hallucinated_field: "should be tolerated by passthrough",
      }),
    );

    // Should succeed now that WorkerHandoffBaseSchema uses .passthrough()
    const result = await readHandoff(hp, WorkerHandoffSchema);
    expect(result.summary).toBe("A".repeat(100));
  });

  it("succeeds after retry with corrected data", async () => {
    const hp = handoffPath("retry-invalid-001");

    // First attempt: invalid
    fs.writeFileSync(hp, JSON.stringify({ decisions: ["incomplete"] }));
    let firstFailed = false;
    try {
      await readHandoff(hp, WorkerHandoffSchema);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
      firstFailed = true;
    }
    expect(firstFailed).toBe(true);

    // Retry: write corrected data
    fs.writeFileSync(hp, JSON.stringify(validWorkerHandoff()));
    const parsed = await readHandoff(hp, WorkerHandoffSchema);
    expect(parsed.summary.length).toBeGreaterThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// 4. Summary quality enforcement — min 20 chars, sentence count, no newlines
// ---------------------------------------------------------------------------

describe("Summary length validation", () => {
  it("rejects summary under 20 characters", async () => {
    const hp = handoffPath("short-summary-001");
    fs.writeFileSync(hp, JSON.stringify({ summary: "Too short" }));

    try {
      await readHandoff(hp, WorkerHandoffSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
      expect((err as HandoffInvalidError).message).toContain("summary");
    }
  });

  it("rejects summary of exactly 19 characters", async () => {
    const hp = handoffPath("boundary-19-001");
    // Exactly 19 chars, 1 sentence
    fs.writeFileSync(hp, JSON.stringify({ summary: "Nineteen chars here" }));

    try {
      await readHandoff(hp, WorkerHandoffSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
    }
  });

  it("accepts summary at boundary (20+ chars, 1 sentence)", async () => {
    const hp = handoffPath("boundary-20-001");
    // Valid summary: >= 20 chars, 1 sentence, no newlines
    const summary = "Implemented the feature successfully.";
    fs.writeFileSync(hp, JSON.stringify({ summary }));

    const parsed = await readHandoff(hp, WorkerHandoffSchema);
    expect(parsed.summary.length).toBeGreaterThanOrEqual(20);
  });

  it("accepts summary of 100+ characters (backward compat)", async () => {
    const hp = handoffPath("boundary-100-compat-001");
    const summary = "Implemented the full authentication middleware with JWT validation and all tests pass with coverage.";
    fs.writeFileSync(hp, JSON.stringify({ summary }));

    const parsed = await readHandoff(hp, WorkerHandoffSchema);
    expect(parsed.summary.length).toBeGreaterThanOrEqual(20);
  });

  it("rejects summary over 5000 characters", async () => {
    const hp = handoffPath("long-summary-001");
    // Single long sentence to avoid sentence count issues
    fs.writeFileSync(hp, JSON.stringify({ summary: "A".repeat(5001) }));

    try {
      await readHandoff(hp, WorkerHandoffSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
    }
  });

  it("succeeds after retry with properly-sized summary", async () => {
    const hp = handoffPath("retry-summary-001");

    // First: too short
    fs.writeFileSync(hp, JSON.stringify({ summary: "Short" }));
    try {
      await readHandoff(hp, WorkerHandoffSchema);
    } catch {
      /* expected */
    }

    // Retry: correct length with proper sentences
    fs.writeFileSync(hp, JSON.stringify(validWorkerHandoff()));
    const parsed = await readHandoff(hp, WorkerHandoffSchema);
    expect(parsed.summary.length).toBeGreaterThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// 5. Evaluator verdict: file written and read
// ---------------------------------------------------------------------------

describe("Evaluator verdict handoff", () => {
  it("writes and reads a valid evaluator verdict", async () => {
    const hp = handoffPath("eval-verdict-001");
    const verdict = validEvaluatorVerdict();
    fs.writeFileSync(hp, JSON.stringify(verdict));

    const parsed = await readHandoff(hp, EvaluatorVerdictSchema);

    expect(parsed.passed).toBe(true);
    expect(parsed.reasoning).toContain("All acceptance criteria met");
    expect(parsed.confidence).toBe(0.92);
    expect(parsed.feedback).toContain("Good implementation");
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.files_to_review).toContain("src/auth/jwt.ts");
  });

  it("writes and reads a failing verdict", async () => {
    const hp = handoffPath("eval-fail-001");
    const verdict = validEvaluatorVerdict({
      passed: false,
      reasoning: "Tests do not pass. Missing implementation for token refresh.",
      confidence: 0.85,
      feedback: "Add token refresh logic and re-run tests.",
      suggestions: ["Implement refresh token endpoint", "Add integration test"],
    });
    fs.writeFileSync(hp, JSON.stringify(verdict));

    const parsed = await readHandoff(hp, EvaluatorVerdictSchema);

    expect(parsed.passed).toBe(false);
    expect(parsed.reasoning).toContain("Tests do not pass");
    expect(parsed.confidence).toBe(0.85);
    expect(parsed.suggestions).toHaveLength(2);
  });

  it("rejects verdict missing required fields", async () => {
    const hp = handoffPath("eval-incomplete-001");
    // Missing reasoning, feedback, files_to_review
    fs.writeFileSync(hp, JSON.stringify({ passed: true, confidence: 0.9 }));

    try {
      await readHandoff(hp, EvaluatorVerdictSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
    }
  });

  it("rejects verdict with confidence out of range", async () => {
    const hp = handoffPath("eval-badconf-001");
    const verdict = validEvaluatorVerdict({ confidence: 1.5 });
    fs.writeFileSync(hp, JSON.stringify(verdict));

    try {
      await readHandoff(hp, EvaluatorVerdictSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
    }
  });

  it("tolerates verdict with unknown fields (.passthrough())", async () => {
    const hp = handoffPath("eval-strict-001");
    const verdict = {
      ...validEvaluatorVerdict(),
      unknown_extra: "should be tolerated",
    };
    fs.writeFileSync(hp, JSON.stringify(verdict));

    // Should succeed now that EvaluatorVerdictSchema uses .passthrough()
    const result = await readHandoff(hp, EvaluatorVerdictSchema);
    expect(result.passed).toBe(true);
  });

  it("evaluator handoff instruction includes all required fields", () => {
    const instruction = renderEvaluatorHandoffInstruction("/tmp/eval.json");
    for (const field of [
      "passed",
      "reasoning",
      "suggestions",
      "confidence",
      "feedback",
      "files_to_review",
    ]) {
      expect(instruction).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Dispatcher decision: file written and read
// ---------------------------------------------------------------------------

describe("Dispatcher decision handoff", () => {
  it("writes and reads a valid dispatcher decision", async () => {
    const hp = handoffPath("dispatch-valid-001");
    const decision = validDispatcherDecision();
    fs.writeFileSync(hp, JSON.stringify(decision));

    const parsed = await readHandoff(hp, DispatcherDecisionHandoffSchema);

    expect(parsed.schema_version).toBe(1);
    expect(parsed.step_index).toBe(0);
    expect(parsed.task_content).toContain("authentication middleware");
    expect(parsed.context_files).toContain("src/index.ts");
    expect(parsed.session_name).toBe("work-session-step-1");
    expect(parsed.reasoning).toContain("Standard implementation");
  });

  it("accepts dispatcher decision with minimal fields", async () => {
    const hp = handoffPath("dispatch-minimal-001");
    const decision = {
      schema_version: 1 as const,
      step_index: 2,
      task_content: "Execute step 3 of the plan.",
      context_files: [],
    };
    fs.writeFileSync(hp, JSON.stringify(decision));

    const parsed = await readHandoff(hp, DispatcherDecisionHandoffSchema);

    expect(parsed.schema_version).toBe(1);
    expect(parsed.step_index).toBe(2);
    expect(parsed.task_content).toBe("Execute step 3 of the plan.");
    expect(parsed.context_files).toEqual([]);
    expect(parsed.session_name).toBeUndefined();
    expect(parsed.reasoning).toBeUndefined();
  });

  it("rejects dispatcher decision with wrong schema_version", async () => {
    const hp = handoffPath("dispatch-badver-001");
    const decision = {
      schema_version: 2,
      step_index: 0,
      task_content: "Do something",
      context_files: [],
    };
    fs.writeFileSync(hp, JSON.stringify(decision));

    try {
      await readHandoff(hp, DispatcherDecisionHandoffSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
    }
  });

  it("tolerates dispatcher decision with unknown fields (.passthrough())", async () => {
    const hp = handoffPath("dispatch-strict-001");
    const decision = {
      ...validDispatcherDecision(),
      unknown_field: "should be tolerated",
    };
    fs.writeFileSync(hp, JSON.stringify(decision));

    // Should succeed now that DispatcherDecisionHandoffSchema uses .passthrough()
    const result = await readHandoff(hp, DispatcherDecisionHandoffSchema);
    expect(result.schema_version).toBe(1);
  });

  it("dispatcher handoff instruction includes all required fields", () => {
    const instruction = renderDispatcherHandoffInstruction("/tmp/dispatch.json");
    for (const field of [
      "schema_version",
      "step_index",
      "task_content",
      "context_files",
    ]) {
      expect(instruction).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Cross-role flow: worker → evaluator → dispatcher
// ---------------------------------------------------------------------------

describe("Cross-role handoff flow", () => {
  it("worker handoff feeds evaluator and dispatcher in sequence", async () => {
    const workerHp = handoffPath("flow-worker-001");
    const evalHp = handoffPath("flow-eval-001");
    const dispatchHp = handoffPath("flow-dispatch-001");

    // Step 1: Worker writes handoff
    const workerData = validWorkerHandoff();
    fs.writeFileSync(workerHp, JSON.stringify(workerData));

    const workerHandoff = await readHandoff(workerHp, WorkerHandoffSchema);
    expect(workerHandoff.summary).toContain("authentication middleware");

    // Step 2: Evaluator writes verdict based on worker handoff
    const evalVerdict = validEvaluatorVerdict();
    fs.writeFileSync(evalHp, JSON.stringify(evalVerdict));

    const parsedVerdict = await readHandoff(evalHp, EvaluatorVerdictSchema);
    expect(parsedVerdict.passed).toBe(true);

    // Step 3: Dispatcher writes decision for next step
    const dispatchDecision = validDispatcherDecision({ step_index: 1 });
    fs.writeFileSync(dispatchHp, JSON.stringify(dispatchDecision));

    const parsedDecision = await readHandoff(
      dispatchHp,
      DispatcherDecisionHandoffSchema,
    );
    expect(parsedDecision.step_index).toBe(1);

    // Verify all three files exist and are valid
    expect(fs.existsSync(workerHp)).toBe(true);
    expect(fs.existsSync(evalHp)).toBe(true);
    expect(fs.existsSync(dispatchHp)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Workflow-specific handoff fields
// ---------------------------------------------------------------------------

describe("Workflow-specific handoff fields", () => {
  it("PLAN_CONSOLIDATE handoff includes plan_file_path", async () => {
    const hp = handoffPath("plan-consolidate-001");
    const handoff = validWorkerHandoff({
      summary:
        "Consolidated the 6-step implementation plan with user decisions applied. " +
        "Updated step ordering and removed deprecated steps. Plan saved to docs/plans/auth-plan.md.",
      plan_file_path: "docs/plans/auth-plan.md",
      decisions: ["User chose Auth0 over Cognito", "Split step 3 into 3a and 3b"],
    });
    fs.writeFileSync(hp, JSON.stringify(handoff));

    const parsed = await readHandoff(hp, WorkerHandoffSchema);
    expect(parsed.plan_file_path).toBe("docs/plans/auth-plan.md");
    expect(parsed.decisions).toHaveLength(2);

    // Verify the instruction includes plan_file_path
    const instruction = renderHandoffInstruction(
      PLAN_CONSOLIDATE_FIELDS,
      hp,
    );
    expect(instruction).toContain("plan_file_path");
  });

  it("REVIEW handoff includes review_file_path and finding_counts", async () => {
    const hp = handoffPath("review-001");
    const handoff = validWorkerHandoff({
      summary:
        "Code review completed for 15 files across 4 modules. Found 1 critical issue (SQL injection), " +
        "3 important issues (missing error handling), and 8 suggestions. Full report saved.",
      review_file_path: "docs/reviews/auth-review.md",
      finding_counts: {
        p1_critical: 1,
        p2_important: 3,
        p3_suggestion: 8,
      },
      p3_findings: [
        {
          description: "Consider adding input validation",
          location: "src/api.ts:42",
          suggestion: "Add zod schema for request body",
        },
      ],
      files_to_review: [
        "src/auth/jwt.ts",
        "src/auth/session.ts",
        "src/api.ts",
      ],
    });
    fs.writeFileSync(hp, JSON.stringify(handoff));

    const parsed = await readHandoff(hp, WorkerHandoffSchema);
    expect(parsed.review_file_path).toBe("docs/reviews/auth-review.md");
    expect(parsed.finding_counts?.p1_critical).toBe(1);
    expect(parsed.finding_counts?.p2_important).toBe(3);
    expect(parsed.finding_counts?.p3_suggestion).toBe(8);
    expect(parsed.p3_findings).toHaveLength(1);
    expect(parsed.files_to_review).toHaveLength(3);

    // Verify the instruction includes review fields
    const instruction = renderHandoffInstruction(REVIEW_FIELDS, hp);
    expect(instruction).toContain("review_file_path");
    expect(instruction).toContain("finding_counts");
    expect(instruction).toContain("p3_findings");
  });

  it("WORK handoff includes artifacts and verification", async () => {
    const hp = handoffPath("work-001");
    const handoff = validWorkerHandoff();
    fs.writeFileSync(hp, JSON.stringify(handoff));

    const parsed = await readHandoff(hp, WorkerHandoffSchema);
    expect(parsed.artifacts?.files_created).toContain("src/auth/jwt.ts");
    expect(parsed.artifacts?.commands_run).toContain("bun test");
    expect(parsed.verification?.tests_passed).toBe(true);

    // Verify the instruction includes work fields
    const instruction = renderHandoffInstruction(WORK_STEP_FIELDS, hp);
    expect(instruction).toContain("artifacts");
    expect(instruction).toContain("verification");
    expect(instruction).toContain("files_to_review");
  });
});

// ---------------------------------------------------------------------------
// 9. Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("empty file throws HandoffInvalidError", async () => {
    const hp = handoffPath("empty-001");
    fs.writeFileSync(hp, "");

    try {
      await readHandoff(hp, WorkerHandoffSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
    }
  });

  it("whitespace-only file throws HandoffInvalidError", async () => {
    const hp = handoffPath("whitespace-001");
    fs.writeFileSync(hp, "   \n  \t  ");

    try {
      await readHandoff(hp, WorkerHandoffSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
    }
  });

  it("handoff paths are unique per invocation", () => {
    const path1 = handoffPath("inv-001");
    const path2 = handoffPath("inv-002");
    expect(path1).not.toBe(path2);
    expect(path1).toContain("inv-001.json");
    expect(path2).toContain("inv-002.json");
  });

  it("concurrent handoff reads do not interfere", async () => {
    const hp1 = handoffPath("concurrent-001");
    const hp2 = handoffPath("concurrent-002");

    const data1 = validWorkerHandoff({ summary: "A".repeat(100) + " first step" });
    const data2 = validWorkerHandoff({ summary: "B".repeat(100) + " second step" });

    fs.writeFileSync(hp1, JSON.stringify(data1));
    fs.writeFileSync(hp2, JSON.stringify(data2));

    const [parsed1, parsed2] = await Promise.all([
      readHandoff(hp1, WorkerHandoffSchema),
      readHandoff(hp2, WorkerHandoffSchema),
    ]);

    expect(parsed1.summary).toContain("first step");
    expect(parsed2.summary).toContain("second step");
  });
});
