/**
 * Evaluator Transport Integration Tests (Phase 2, Ticket 2.4)
 *
 * Verifies that the real evaluator transport correctly assesses worker output.
 *
 * Tests 1-2 require real API calls (Claude with sonnet model).
 * Tests 3-4 use mocks.
 *
 * Run: bun test tests/integration/evaluator-transport.test.ts
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessSpawner } from "../../src/worker/bun-spawner";
import { createEvaluatorTransport } from "../../src/evaluator/create-transport";
import { createAgentEvaluatorFn } from "../../src/evaluator/create-agent-evaluator";
import { ensureSessionDir } from "../../src/config/paths";
import type { EvaluatorTransport } from "../../src/evaluator/transport";
import type { EvalResult } from "../../src/queue/executor";
import type { Step } from "../../src/queue/types";
import type { ProcessSpawner, SpawnResult } from "../../src/worker/spawner";

// Engine registration side effects
import "../../src/engines/providers/claude";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const ENGINE = "claude";
const EVALUATOR_MODEL = "sonnet";
const TIMEOUT_MS = 120_000; // 2 min per test

let tempDir: string;
let sessionId: string;
let evaluatorTransport: EvaluatorTransport;
let evaluatorFn: ReturnType<typeof createAgentEvaluatorFn>;

function makeStep(title: string): Step {
  return {
    id: randomUUID(),
    type: "work",
    title,
    status: "completed",
    description: "Test step for evaluator",
    acceptanceCriteria: [
      "File hello.txt exists",
      "File contains 'Hello World'",
    ],
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "evaluator-transport-test-"));
  sessionId = randomUUID();
  ensureSessionDir(sessionId, tempDir);

  const spawner = new BunProcessSpawner();
  evaluatorTransport = await createEvaluatorTransport({
    spawner,
    engineName: ENGINE,
    evaluatorModel: EVALUATOR_MODEL,
    sessionId,
    baseDir: tempDir,
  });

  evaluatorFn = createAgentEvaluatorFn({ transport: evaluatorTransport });
});

afterAll(() => {
  try {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("evaluator transport integration", () => {
  test("evaluator passes good work", async () => {
    const step = makeStep("Create hello.txt");

    // Simulate a handoff where the worker successfully created the file
    const handoffData: Record<string, unknown> = {
      summary: "Created hello.txt with content 'Hello World'. File verified to exist and contain expected content.",
      artifacts: {
        files_created: ["hello.txt"],
        files_modified: [],
      },
      verification: {
        tests_passed: true,
        test_output_summary: "File exists and contains 'Hello World'",
      },
      decisions: ["Created file in project root"],
    };

    const evaluationCriteria = {
      acceptance_criteria: [
        "File hello.txt exists",
        "File contains 'Hello World'",
      ],
      required_tests: false,
      custom_checks: [],
      required_outputs: ["hello.txt"],
    };

    const result = await evaluatorFn(
      step,
      "Worker output: completed successfully",
      evaluationCriteria,
      handoffData,
    );

    expect(result.passed).toBe(true);
    expect(result.transportError).toBe(false);
    expect(result.skipped).toBe(false);
  }, TIMEOUT_MS);

  test("evaluator fails bad work", async () => {
    const step = makeStep("Create database module");

    // Simulate a handoff where worker claims success but artifacts are suspect
    const handoffData: Record<string, unknown> = {
      summary: "Attempted to create database module but encountered errors. Did not complete the task.",
      artifacts: {
        files_created: [],
        files_modified: [],
      },
      verification: {
        tests_passed: false,
        test_output_summary: "No files were created. Tests failed.",
      },
      warnings: ["Could not connect to database", "No files written"],
    };

    const evaluationCriteria = {
      acceptance_criteria: [
        "File db.ts exists and exports a connect() function",
        "Database connection can be established",
        "Tests pass",
      ],
      required_tests: true,
      custom_checks: ["db.ts exports connect()"],
      required_outputs: ["db.ts"],
    };

    const result = await evaluatorFn(
      step,
      "Worker output: failed to complete task",
      evaluationCriteria,
      handoffData,
    );

    expect(result.passed).toBe(false);
    expect(result.transportError).toBe(false);
    // Should have feedback about what went wrong
    expect(result.feedback).not.toBeNull();
    if (result.feedback) {
      expect(result.feedback.length).toBeGreaterThan(0);
    }
  }, TIMEOUT_MS);

  test("evaluator degrades gracefully on transport error", async () => {
    // Create a mock spawner that simulates transport failure
    const failingSpawner: ProcessSpawner = {
      spawn: async (): Promise<SpawnResult> => ({
        result: Promise.resolve({
          output: "",
          rawOutput: "",
          rawStderr: "Internal Server Error",
          exitCode: 1,
          truncated: false,
          durationMs: 50,
          failure: { kind: "completed" as const, message: "Process exited with code 1" },
          handoffPath: "/nonexistent/path",
        }),
      }),
    };

    const failingTransport = await createEvaluatorTransport({
      spawner: failingSpawner,
      engineName: ENGINE,
      evaluatorModel: EVALUATOR_MODEL,
      sessionId,
      baseDir: tempDir,
    });

    const failingEvaluator = createAgentEvaluatorFn({ transport: failingTransport });
    const step = makeStep("Test step");

    const result = await failingEvaluator(
      step,
      "worker output",
      {
        acceptance_criteria: ["File exists"],
        required_tests: false,
        custom_checks: [],
        required_outputs: [],
      },
      { summary: "Test" },
    );

    // Should degrade gracefully — transport error, not a crash
    expect(result.transportError).toBe(true);
    // When transport errors occur, the evaluator passes by default (graceful degradation)
    expect(result.passed).toBe(true);
  }, 30_000);

  test("evaluator handles missing evaluation criteria", async () => {
    const step = makeStep("Simple task");

    // Call with null evaluation criteria
    const result = await evaluatorFn(
      step,
      "Worker output: completed task",
      null,
      { summary: "Completed the task successfully" },
    );

    // Should not crash — either passes with generic criteria or skips
    expect(result).toBeDefined();
    expect(typeof result.passed).toBe("boolean");
    expect(result.transportError).toBe(false);
  }, TIMEOUT_MS);
});
