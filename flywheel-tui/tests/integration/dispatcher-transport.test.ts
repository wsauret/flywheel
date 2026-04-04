/**
 * Dispatcher Transport Integration Tests (Phase 2, Ticket 2.2)
 *
 * Verifies that the real dispatcher transport produces valid prompts and
 * evaluation criteria when invoked through the StepDispatcher.
 *
 * Tests 1-4 require real API calls (use Claude with sonnet model for cheapness).
 * Test 5 uses a mock spawner to simulate transport errors.
 *
 * Run: bun test tests/integration/dispatcher-transport.test.ts
 * These are slow tests — they spawn real CLI subprocesses.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessSpawner } from "../../src/worker/bun-spawner";
import { autoDetectTransport, type ResolvedTransport } from "../../src/dispatcher/auto-detect";
import {
  createStepDispatcher,
  StepDispatcherError,
  type StepDispatcher,
  type StepDispatchContext,
} from "../../src/queue/step-dispatcher";
import { createQueue } from "../../src/queue/queue";
import { EventBus, createFlywheelEmitter } from "../../src/events/event-bus";
import { ensureSessionDir } from "../../src/config/paths";
import type { Step, Queue } from "../../src/queue/types";
import type { ProcessSpawner, SpawnResult } from "../../src/worker/spawner";

// Engine registration side effects
import "../../src/engines/providers/claude";
import "../../src/engines/providers/opencode";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const ENGINE = "claude";
const DISPATCHER_MODEL = "sonnet";
const TIMEOUT_MS = 120_000; // 2 min per test (real LLM calls)

let spawner: BunProcessSpawner;
let resolvedTransport: ResolvedTransport;
let dispatcher: StepDispatcher;
let eventBus: EventBus;
let sessionId: string;
let tempDir: string;

function makeWorkStep(overrides: Partial<Step> = {}): Step {
  return {
    id: randomUUID(),
    type: "work",
    title: "Create hello.txt",
    status: "pending",
    description: "Create a file called hello.txt containing 'Hello World'",
    acceptanceCriteria: [
      "File hello.txt exists",
      "File contains the text 'Hello World'",
    ],
    fileReferences: ["hello.txt"],
    ...overrides,
  };
}

function makeQueue(steps: Step[]): Queue {
  return createQueue(steps);
}

function makeDispatchContext(overrides: Partial<StepDispatchContext> = {}): StepDispatchContext {
  return {
    accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
    previousHandoff: null,
    previousAssessment: null,
    hitlResponse: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "dispatcher-transport-test-"));
  sessionId = randomUUID();
  ensureSessionDir(sessionId, tempDir);

  spawner = new BunProcessSpawner();
  eventBus = new EventBus();
  const emitter = createFlywheelEmitter(eventBus);
  const workflowId = randomUUID();

  resolvedTransport = await autoDetectTransport({
    spawner,
    engineName: ENGINE,
    dispatcherModel: DISPATCHER_MODEL,
    sessionId,
    baseDir: tempDir,
  });

  dispatcher = createStepDispatcher({
    transport: resolvedTransport.transport,
    emitter,
    workflowId,
    configContext: {
      maxEvalCycles: 3,
      worktreePath: tempDir,
      projectCwd: tempDir,
      workerModel: "sonnet",
      dispatcherModel: DISPATCHER_MODEL,
    },
    sessionBudget: {
      wall_clock_deadline: null,
      invocations_remaining: null,
      token_budget_remaining: null,
    },
    availableContext: { files: [] },
    sessionObjective: "Integration test objective",
  });
});

afterAll(() => {
  resolvedTransport?.dispose();
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatcher transport integration", () => {
  test("dispatcher returns valid prompt for work step", async () => {
    const step = makeWorkStep();
    const queue = makeQueue([step]);
    const context = makeDispatchContext();

    const decision = await dispatcher.dispatch(step, queue, context);

    // taskContent should be a non-empty string
    expect(decision.taskContent).toBeDefined();
    expect(typeof decision.taskContent).toBe("string");
    expect(decision.taskContent.length).toBeGreaterThan(0);

    // contextFiles and contextToInline should be arrays
    expect(Array.isArray(decision.contextFiles)).toBe(true);
    expect(Array.isArray(decision.contextToInline)).toBe(true);

    // mutationRequests should be an array
    expect(Array.isArray(decision.mutationRequests)).toBe(true);
  }, TIMEOUT_MS);

  test("dispatcher returns evaluation criteria for work steps", async () => {
    const step = makeWorkStep({
      acceptanceCriteria: [
        "File hello.txt exists in the project root",
        "File contains exactly the text 'Hello World' with no trailing newline",
      ],
    });
    const queue = makeQueue([step]);
    const context = makeDispatchContext();

    const decision = await dispatcher.dispatch(step, queue, context);

    // evaluationCriteria should be non-null for work steps with acceptance criteria
    // It's an EvaluationCriteria object: { acceptance_criteria, required_tests, custom_checks, required_outputs }
    expect(decision.evaluationCriteria).not.toBeNull();
    if (decision.evaluationCriteria) {
      expect(typeof decision.evaluationCriteria).toBe("object");
      const criteria = decision.evaluationCriteria as { acceptance_criteria: string[] };
      expect(Array.isArray(criteria.acceptance_criteria)).toBe(true);
      expect(criteria.acceptance_criteria.length).toBeGreaterThan(0);
    }
  }, TIMEOUT_MS);

  test("dispatcher receives accumulated context from previous steps", async () => {
    const step1 = makeWorkStep({
      title: "Create config file",
      description: "Create a config.json with database settings",
    });
    const step2 = makeWorkStep({
      title: "Create database connection module",
      description: "Create db.ts that reads from config.json",
    });
    const queue = makeQueue([step1, step2]);
    // Simulate step1 already completed
    step1.status = "completed";
    queue.cursor = 1;

    const context = makeDispatchContext({
      accumulatedContext: {
        summaries: [],
        recentHandoffs: [
          {
            stepId: step1.id,
            stepType: "work",
            stepTitle: "Create config file",
            handoff: {
              summary: "Created config.json with PostgreSQL connection settings",
              artifacts: {
                files_created: ["config.json"],
                files_modified: [],
              },
              decisions: ["Used PostgreSQL as the database engine"],
            },
          },
        ],
        totalSteps: 1,
      },
      previousHandoff: {
        summary: "Created config.json with PostgreSQL connection settings",
        artifacts: { files_created: ["config.json"] },
      },
    });

    const decision = await dispatcher.dispatch(step2, queue, context);

    // The dispatcher should produce a prompt — we can't assert exact content
    // since LLM output varies, but the prompt should exist and be non-trivial
    expect(decision.taskContent).toBeDefined();
    expect(decision.taskContent.length).toBeGreaterThan(10);
  }, TIMEOUT_MS);

  test("dispatcher handles missing optional fields", async () => {
    // Step with NO description, NO acceptanceCriteria, NO fileReferences
    const step = makeWorkStep({
      title: "Do a simple task",
      description: undefined,
      acceptanceCriteria: undefined,
      fileReferences: undefined,
    });
    const queue = makeQueue([step]);
    const context = makeDispatchContext();

    // Should not throw — dispatcher handles missing fields gracefully
    const decision = await dispatcher.dispatch(step, queue, context);

    expect(decision.taskContent).toBeDefined();
    expect(typeof decision.taskContent).toBe("string");
    expect(decision.taskContent.length).toBeGreaterThan(0);
  }, TIMEOUT_MS);

  test("dispatcher throws typed error on transport failure", async () => {
    // Create a mock spawner that simulates process failure
    const failingSpawner: ProcessSpawner = {
      spawn: async (): Promise<SpawnResult> => ({
        result: Promise.resolve({
          output: "",
          rawOutput: "",
          rawStderr: "Connection refused",
          exitCode: 1,
          truncated: false,
          durationMs: 100,
          failure: { kind: "completed" as const, message: "Process exited with code 1" },
          handoffPath: "/nonexistent/path",
        }),
      }),
    };

    const failingTransportResult = await autoDetectTransport({
      spawner: failingSpawner,
      engineName: ENGINE,
      dispatcherModel: DISPATCHER_MODEL,
      sessionId,
      baseDir: tempDir,
    });

    const failingDispatcher = createStepDispatcher({
      transport: failingTransportResult.transport,
      emitter: createFlywheelEmitter(eventBus),
      workflowId: randomUUID(),
      configContext: {
        maxEvalCycles: 3,
        worktreePath: tempDir,
        projectCwd: tempDir,
        workerModel: "sonnet",
        dispatcherModel: DISPATCHER_MODEL,
      },
      sessionBudget: {
        wall_clock_deadline: null,
        invocations_remaining: null,
        token_budget_remaining: null,
      },
      availableContext: { files: [] },
    });

    const step = makeWorkStep();
    const queue = makeQueue([step]);
    const context = makeDispatchContext();

    // Should throw a StepDispatcherError (not an unhandled crash)
    try {
      await failingDispatcher.dispatch(step, queue, context);
      // If we get here, the test should fail
      expect(true).toBe(false); // unreachable
    } catch (err) {
      expect(err).toBeInstanceOf(StepDispatcherError);
      expect((err as StepDispatcherError).stepId).toBe(step.id);
    }
  }, TIMEOUT_MS);
});
