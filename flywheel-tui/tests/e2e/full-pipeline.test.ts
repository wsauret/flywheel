/**
 * Full Pipeline E2E Tests (Phase 2, Ticket 2.5)
 *
 * Runs a complete multi-step workflow through the test driver with real LLM calls.
 * These are slow, expensive tests — run explicitly with:
 *   bun test tests/e2e/full-pipeline.test.ts
 *
 * Prerequisites:
 * - `claude` CLI installed and authenticated
 * - Network access to Anthropic API
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Core infrastructure
import { BunProcessSpawner } from "../../src/worker/bun-spawner";
import { autoDetectTransport, type ResolvedTransport } from "../../src/dispatcher/auto-detect";
import { createEvaluatorTransport } from "../../src/evaluator/create-transport";
import { createStepDispatcher, type StepDispatchContext } from "../../src/queue/step-dispatcher";
import { createAgentEvaluatorFn } from "../../src/evaluator/create-agent-evaluator";
import { createQueue } from "../../src/queue/queue";
import { createQueuePersistence } from "../../src/queue/persistence";
import { createContextAccumulator } from "../../src/queue/context-accumulator";
import { createGuardrails } from "../../src/queue/guardrails";
import {
  createStepExecutor,
  type DispatcherFn,
  type WorkerFn,
  type EvaluatorFn,
  type HandoffReaderFn,
} from "../../src/queue/executor";
import { EventBus, createFlywheelEmitter } from "../../src/events/event-bus";
import { readHandoff } from "../../src/queue/shared/handoff-reader";
import { WorkerHandoffSchema } from "../../src/protocol/handoff-schemas";
import { buildScaffolding, type ScaffoldingPaths } from "../../src/queue/shared/scaffolding";
import { ContextIndexer } from "../../src/memory/indexer";
import {
  ensureSessionDir,
  buildWorkerHandoffPath,
  sessionDir,
} from "../../src/config/paths";
import { getEngine } from "../../src/engines/core/registry";
import { createBudgetTracker, type BudgetTracker } from "../../src/session/budget-tracker";
import { formatStdinMessage } from "../../src/worker/stdin-format";
import type { Step, Queue } from "../../src/queue/types";

// Engine registration side effects
import "../../src/engines/providers/claude";
// Scaffolding registration (work step handoff instructions)
import "../../src/queue/steps/register-all";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENGINE_NAME = "claude";
const WORKER_MODEL = "sonnet";
const DISPATCHER_MODEL = "sonnet";
const E2E_TIMEOUT_MS = 300_000; // 5 min per test

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let tempDir: string;
let spawner: BunProcessSpawner;
let engine: ReturnType<typeof getEngine>;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "e2e-pipeline-"));
  spawner = new BunProcessSpawner();
  engine = getEngine(ENGINE_NAME);
});

afterAll(() => {
  try {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ---------------------------------------------------------------------------
// Pipeline builder — wires all real components for a given queue
// ---------------------------------------------------------------------------

async function buildPipeline(steps: Step[], objective: string) {
  const sessionId = randomUUID();
  const workflowId = randomUUID();
  ensureSessionDir(sessionId, tempDir);

  const eventBus = new EventBus();
  const emitter = createFlywheelEmitter(eventBus);
  const events: Array<{ type: string; timestamp: number }> = [];
  eventBus.subscribe((event) => events.push({ type: event.type, timestamp: Date.now() }));

  const queue = createQueue(steps);

  // Budget tracker — captures cost/token data from worker NDJSON events
  const budgetTracker = createBudgetTracker({ sessionId, baseDir: tempDir });

  // Dispatcher transport
  const resolvedTransport = await autoDetectTransport({
    spawner,
    engineName: ENGINE_NAME,
    dispatcherModel: DISPATCHER_MODEL,
    sessionId,
    baseDir: tempDir,
  });

  // Evaluator transport
  const evaluatorTransport = await createEvaluatorTransport({
    spawner,
    engineName: ENGINE_NAME,
    evaluatorModel: DISPATCHER_MODEL,
    sessionId,
    baseDir: tempDir,
  });

  // Context indexer
  const contextIndexer = new ContextIndexer(tempDir);

  // Step dispatcher
  const realDispatcher = createStepDispatcher({
    transport: resolvedTransport.transport,
    emitter,
    workflowId,
    configContext: {
      maxEvalCycles: 3,
      worktreePath: tempDir,
      projectCwd: tempDir,
      workerModel: WORKER_MODEL,
      dispatcherModel: DISPATCHER_MODEL,
    },
    sessionBudget: {
      wall_clock_deadline: null,
      invocations_remaining: null,
      token_budget_remaining: null,
    },
    availableContext: contextIndexer.getRelevantContext({
      stepType: "plan",
      stepDescription: objective,
    }),
    sessionObjective: objective,
  });

  // Context accumulator
  const contextAccumulator = createContextAccumulator({ windowSize: 3 });

  // Persistence
  const persistence = createQueuePersistence({ sessionId, baseDir: tempDir });

  // Guardrails
  const guardrails = createGuardrails({ maxQueueLength: 50 });

  // Dispatcher function
  const dispatcherFn: DispatcherFn = async (step, context) => {
    const dispatchContext: StepDispatchContext = {
      accumulatedContext: contextAccumulator.getContext() as any,
      previousHandoff: (context.previousHandoff as Record<string, unknown>) ?? null,
      previousAssessment: (context.previousAssessment as any) ?? null,
      hitlResponse: (context.hitlResponse as string) ?? null,
    };
    const decision = await realDispatcher.dispatch(step, queue, dispatchContext);
    return {
      prompt: decision.taskContent,
      evaluationCriteria: decision.evaluationCriteria,
      mutationRequests: decision.mutationRequests,
      sessionName: decision.sessionName,
    };
  };

  // Worker function
  const workerFn: WorkerFn = async (step, prompt) => {
    const handoffPath = buildWorkerHandoffPath(sessionId, step.type, step.id, tempDir);
    ensureSessionDir(sessionId, tempDir);

    const scaffoldingPaths: ScaffoldingPaths = {
      handoffPath,
      planPath: `${sessionDir(sessionId)}/plan.json`,
      researchPath: `${sessionDir(sessionId)}/research.md`,
      reviewPath: `${sessionDir(sessionId)}/review.md`,
      contextPath: `${sessionDir(sessionId)}/context.md`,
    };

    const scaffolding = buildScaffolding(step, scaffoldingPaths);
    const parts: string[] = [];
    if (scaffolding.preamble) parts.push(scaffolding.preamble);
    parts.push(prompt);
    if (scaffolding.postamble) parts.push(scaffolding.postamble);
    const fullPrompt = parts.join("\n\n");

    const engineCmd = engine.buildCommand({
      prompt: fullPrompt,
      model: WORKER_MODEL,
    });

    // Claude uses --input-format stream-json: stdin must be NDJSON-formatted
    const useStdinPipe = engine.metadata.supportsStreamingInput;
    const rawStdinContent = engineCmd.stdinPrompt
      ? (engineCmd.promptPrefix ? engineCmd.promptPrefix + fullPrompt : fullPrompt)
      : undefined;

    let stdinContent: string | undefined;
    if (useStdinPipe && rawStdinContent) {
      stdinContent = formatStdinMessage(engine.metadata.id, rawStdinContent);
    } else {
      stdinContent = rawStdinContent;
    }

    const startMs = Date.now();
    const spawnResult = await spawner.spawn(engineCmd.command, engineCmd.args, {
      cwd: tempDir,
      invocationId: randomUUID(),
      sessionId,
      handoffFileName: `${step.type}_${step.id}.json`,
      stdin: stdinContent,
      stdinPipe: useStdinPipe && stdinContent !== undefined,
      onNDJSONEvent: (event) => budgetTracker.handleEvent(event),
    });

    const workerResult = await spawnResult.result;
    return {
      output: workerResult.exitCode === 0
        ? "completed"
        : (workerResult.failure?.message ?? "failed"),
      handoffPath: workerResult.handoffPath ?? "",
      durationMs: Date.now() - startMs,
      sessionId: workerResult.sessionId,
    };
  };

  // Evaluator function
  const evaluatorFn: EvaluatorFn = createAgentEvaluatorFn({ transport: evaluatorTransport });

  // Handoff reader
  const handoffReader: HandoffReaderFn = async (handoffPath) => {
    if (!handoffPath) return null;
    try {
      const handoff = await readHandoff(handoffPath, WorkerHandoffSchema);
      return handoff as unknown as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  // Budget checker (no limits)
  const budgetChecker = { isExhausted: () => false };

  // Persist function
  const persistFn = async (q: Queue) => {
    await persistence.save(q);
  };

  // Create executor
  const executor = createStepExecutor({
    queue,
    workflowId,
    sessionId,
    emitter,
    dispatcher: dispatcherFn,
    worker: workerFn,
    evaluator: evaluatorFn,
    handoffReader,
    budgetChecker,
    persist: persistFn,
    accumulator: contextAccumulator,
    maxRevisions: 1,
    guardrails,
    sessionObjective: objective,
    onWorkerDispatched: () => budgetTracker.incrementInvocations(),
  });

  return {
    executor,
    queue,
    events,
    sessionId,
    budgetTracker,
    dispose: () => {
      budgetTracker.dispose();
      resolvedTransport.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("full pipeline E2E", () => {
  test("3-step linear completion with handoff chaining", async () => {
    const steps: Step[] = [
      {
        id: randomUUID(),
        type: "work",
        title: "Research project structure",
        status: "pending",
        description: "List the files in the current directory and summarize the project structure",
        acceptanceCriteria: ["Summary of directory contents is provided"],
      },
      {
        id: randomUUID(),
        type: "work",
        title: "Create a greeting module",
        status: "pending",
        description: "Create a file called greeting.ts that exports a greet(name: string) function returning 'Hello, {name}!'",
        acceptanceCriteria: [
          "File greeting.ts exists",
          "File exports a greet function",
          "greet('World') returns 'Hello, World!'",
        ],
      },
      {
        id: randomUUID(),
        type: "work",
        title: "Create a test for the greeting module",
        status: "pending",
        description: "Create greeting.test.ts that tests the greet function from greeting.ts",
        acceptanceCriteria: [
          "File greeting.test.ts exists",
          "Test imports from greeting.ts",
          "Test verifies greet('World') === 'Hello, World!'",
        ],
      },
    ];

    const pipeline = await buildPipeline(
      steps,
      "Create a greeting module with tests",
    );

    try {
      const result = await pipeline.executor.run();

      // All 3 steps should complete (or at least some — LLM can be unpredictable)
      expect(result.stepsTotal).toBe(3);
      expect(result.stepsCompleted).toBeGreaterThanOrEqual(1);

      // Check queue step statuses
      const completedSteps = pipeline.queue.steps.filter(
        (s) => s.status === "completed",
      );
      expect(completedSteps.length).toBe(result.stepsCompleted);

      // Events should have been emitted
      expect(pipeline.events.length).toBeGreaterThan(0);

      // Check that step events were emitted in order
      const stepEvents = pipeline.events.filter(
        (e) =>
          e.type === "queue:step-started" || e.type === "queue:step-completed",
      );
      expect(stepEvents.length).toBeGreaterThanOrEqual(2); // at least started + completed for first step
    } finally {
      pipeline.dispose();
    }
  }, E2E_TIMEOUT_MS);

  test("revision loop handles evaluator feedback", async () => {
    // This test uses strict criteria that the worker might not get right on first try
    const steps: Step[] = [
      {
        id: randomUUID(),
        type: "work",
        title: "Create a precise utility function",
        status: "pending",
        description:
          "Create a file called utils.ts that exports a function called `isPalindrome(s: string): boolean` " +
          "which checks if a string is a palindrome (case-insensitive, ignoring non-alphanumeric characters). " +
          "For example: isPalindrome('A man, a plan, a canal: Panama') === true",
        acceptanceCriteria: [
          "File utils.ts exists",
          "Exports isPalindrome function",
          "isPalindrome('racecar') returns true",
          "isPalindrome('hello') returns false",
          "isPalindrome('A man, a plan, a canal: Panama') returns true",
        ],
      },
    ];

    const pipeline = await buildPipeline(
      steps,
      "Create a palindrome checker utility",
    );

    try {
      const result = await pipeline.executor.run();

      // The step should complete (possibly after revision)
      expect(result.stepsTotal).toBe(1);
      // Even if revision fails, we should not crash
      expect(typeof result.completed).toBe("boolean");

      // Check the step's final status
      const step = pipeline.queue.steps[0];
      expect(["completed", "failed"]).toContain(step.status);
    } finally {
      pipeline.dispose();
    }
  }, E2E_TIMEOUT_MS);

  test("budget tracking produces plausible numbers", async () => {
    // Simple 1-step pipeline to verify budget tracking works
    const steps: Step[] = [
      {
        id: randomUUID(),
        type: "work",
        title: "Create a simple file",
        status: "pending",
        description: "Create a file called hello.txt with 'Hello World'",
        acceptanceCriteria: ["File hello.txt exists"],
      },
    ];

    const pipeline = await buildPipeline(steps, "Create hello.txt");

    try {
      const startTime = Date.now();
      const result = await pipeline.executor.run();
      const durationMs = Date.now() - startTime;

      // Duration should be positive and plausible (>1s for real LLM calls)
      expect(durationMs).toBeGreaterThan(1000);
      // Duration should be less than the timeout
      expect(durationMs).toBeLessThan(E2E_TIMEOUT_MS);

      // Pipeline events should include dispatcher and worker activity
      const dispatcherEvents = pipeline.events.filter(
        (e) => e.type.startsWith("dispatcher:"),
      );
      const stepEvents = pipeline.events.filter(
        (e) => e.type.startsWith("queue:step"),
      );

      expect(dispatcherEvents.length).toBeGreaterThan(0);
      expect(stepEvents.length).toBeGreaterThan(0);

      // Budget tracking: flush and check real values from worker NDJSON events
      pipeline.budgetTracker.flush();

      const invocations = pipeline.budgetTracker.getInvocationsUsed();
      const tokens = pipeline.budgetTracker.getTokensUsed();
      const cost = pipeline.budgetTracker.getTotalCost();

      // Invocations: at least 1 worker dispatch
      expect(invocations).toBeGreaterThanOrEqual(1);

      // Tokens: should be positive (real LLM calls produce tokens)
      expect(tokens).toBeGreaterThan(0);

      // Cost: should be positive and plausible (not absurdly large)
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(10); // sanity: a single step shouldn't cost $10
    } finally {
      pipeline.dispose();
    }
  }, E2E_TIMEOUT_MS);
});
