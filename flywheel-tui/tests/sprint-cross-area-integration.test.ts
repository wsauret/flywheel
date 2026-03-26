/**
 * Sprint Cross-Area Integration Tests
 *
 * Tests the integration boundaries between sprint subsystems:
 * - VAL-CROSS-001: Config flows to sprint execution
 * - VAL-CROSS-002: Handoff flows worker through evaluator
 * - VAL-CROSS-003: Prompt and evaluator path alignment
 */

import { describe, it, expect } from "bun:test";
import type { EvaluatorInput } from "../src/schemas/evaluator";
import type { EvaluatorTransport } from "../src/evaluator/transport";
import type { EvaluatorResult } from "../src/schemas/evaluator";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { MockAdapter } from "../src/tui/adapters/mock";
import { createSprintLoop } from "../src/sprint/sprint-loop";
import { createStageLoop } from "../src/controller/stage-loop-factory";
import {
  SPRINT_FIELDS,
  renderHandoffInstruction,
} from "../src/handoff/field-specs";
import { buildSprintPhasePrompt } from "../src/prompts/sprint/phase-prompt";
import { buildSprintEvaluatorPrompt } from "../src/prompts/sprint/evaluator-prompt";
import {
  defaultConfig,
  makeWorkerResult,
  makeHandoff,
  passingVerification,
  failingVerification,
  passingEvalResult,
  failingEvalResult,
  mockExecutor,
  mockEvaluator,
  collectEvents,
  createTestOptions,
  createTestOptionsWithBus,
} from "./fixtures/sprint-test-helpers";

// ---------------------------------------------------------------------------
// VAL-CROSS-001: Config flows to sprint execution
// ---------------------------------------------------------------------------

describe("VAL-CROSS-001: Config flows to sprint execution", () => {
  it("custom max_iterations=2 causes loop to stop after 2 iterations", async () => {
    const config = defaultConfig({
      sprint: {
        max_iterations: 2,
        verification_timeout_ms: 5000,
        escalate_to_full: true,
        worker_can_escalate: false,
        escalate_on_stuck: false,
      },
    });

    // Executor that always returns a handoff path
    const executor = mockExecutor([
      makeWorkerResult("/tmp/h1.json"),
      makeWorkerResult("/tmp/h2.json"),
      makeWorkerResult("/tmp/h3.json"), // should never be reached
    ]);

    // Evaluator that always fails — forces retries until cap
    const evaluator = mockEvaluator([
      failingEvalResult("Iteration 1 fail"),
      failingEvalResult("Iteration 2 fail"),
    ]);

    const opts = createTestOptions({
      config,
      executor,
      evaluatorTransport: evaluator,
    });

    const handle = createSprintLoop(opts);
    const result = await handle.run();

    // With max_iterations=2, should use exactly 2 iterations then escalate
    expect(result.iterationsUsed).toBe(2);
    expect(result.escalated).toBe(true);
    expect(result.completed).toBe(false);
    expect(result.iterationHistory).toHaveLength(2);
  });

  it("custom verification_timeout_ms flows to verification runner", async () => {
    const config = defaultConfig({
      sprint: {
        max_iterations: 1,
        verification_timeout_ms: 7500,
        escalate_to_full: true,
        worker_can_escalate: false,
        escalate_on_stuck: false,
      },
    });

    let capturedTimeoutMs: number | undefined;

    const opts = createTestOptions({
      config,
      _readHandoff: async () =>
        makeHandoff({ verification_script_path: ".flywheel/verify/test.ts" }),
      _runVerification: async (_path, options) => {
        capturedTimeoutMs = options.timeoutMs;
        return passingVerification();
      },
    });

    const handle = createSprintLoop(opts);
    await handle.run();

    expect(capturedTimeoutMs).toBe(7500);
  });

  it("config values propagate through createStageLoop factory", async () => {
    const config = defaultConfig({
      sprint: {
        max_iterations: 2,
        verification_timeout_ms: 4000,
        escalate_to_full: true,
        worker_can_escalate: false,
        escalate_on_stuck: false,
      },
    });

    let iterationCount = 0;

    // Mock spawner that the factory will use for PhaseExecutor
    const mockSpawner = {
      spawn: async () => ({
        output: "done",
        exitCode: 0,
        truncated: false,
        durationMs: 500,
        failure: undefined,
        handoffPath: "/tmp/handoff.json",
      }),
    };

    const eventBus = new EventBus();
    const adapter = new MockAdapter();
    adapter.connect(eventBus);

    // Use createStageLoop to test the full factory path
    const handle = createStageLoop({
      workflow: "sprint",
      args: { description: "Test config propagation task" },
      config,
      spawner: mockSpawner as any,
      engine: { name: "claude", buildCommand: () => ({ binary: "echo", args: ["test"] }) } as any,
      ui: adapter,
      eventBus,
    });

    // The loop adapter wraps the sprint loop; verify by running
    // it and checking iteration count matches max_iterations
    const result = await handle.loop.run();

    // Sprint with no evaluator + passing verification = completes on iter 1
    // (default _readHandoff returns handoff, default _runVerification passes)
    // But the factory doesn't inject DI overrides, so it uses real readHandoff
    // which will fail (no actual file). This counts as a failed iteration.
    // With max_iterations=2, it should use at most 2 iterations.
    expect(result.phasesTotal).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-002: Handoff flows worker through evaluator
// ---------------------------------------------------------------------------

describe("VAL-CROSS-002: Handoff flows worker through evaluator", () => {
  it("worker handoff verification_script_path reaches verification runner", async () => {
    let capturedScriptPath: string | undefined;

    const opts = createTestOptions({
      _readHandoff: async () =>
        makeHandoff({
          verification_script_path: ".flywheel/verify/my-sprint-test.ts",
        }),
      _runVerification: async (scriptPath, _options) => {
        capturedScriptPath = scriptPath;
        return passingVerification();
      },
    });

    const handle = createSprintLoop(opts);
    await handle.run();

    expect(capturedScriptPath).toBe(".flywheel/verify/my-sprint-test.ts");
  });

  it("evaluator receives handoff fields + verification output + iteration number", async () => {
    let capturedEvalInput: EvaluatorInput | undefined;

    const workerHandoff = makeHandoff({
      summary: "Implemented the hello endpoint with verification.",
      verification_script_path: ".flywheel/verify/sprint-e2e.ts",
      artifacts: {
        files_created: ["src/hello.ts", ".flywheel/verify/sprint-e2e.ts"],
        files_modified: ["src/app.ts"],
      },
      verification: {
        tests_passed: true,
        test_output_summary: "All 5 tests pass successfully",
      },
    });

    const verificationOutput = {
      passed: false,
      stdout: "FAIL: expected 200 got 404\n",
      stderr: "Error in test\n",
      exitCode: 1,
      durationMs: 300,
    };

    const evalTransport: EvaluatorTransport = {
      invoke: async (input: EvaluatorInput): Promise<EvaluatorResult> => {
        capturedEvalInput = input;
        return passingEvalResult();
      },
    };

    const opts = createTestOptions({
      evaluatorTransport: evalTransport,
      _readHandoff: async () => workerHandoff,
      _runVerification: async () => verificationOutput,
    });

    const handle = createSprintLoop(opts);
    await handle.run();

    // Evaluator must have been called
    expect(capturedEvalInput).toBeDefined();

    // Check handoff fields forwarded to evaluator
    expect(capturedEvalInput!.worker_output).toBe(workerHandoff.summary);
    expect(capturedEvalInput!.artifacts_produced).toContain("src/hello.ts");
    expect(capturedEvalInput!.artifacts_produced).toContain("src/app.ts");
    expect(capturedEvalInput!.tests_passed).toBe(true);
    expect(capturedEvalInput!.task_context).toBe("Add a hello world endpoint");

    // Verification output is embedded in validation_criteria (the evaluator prompt)
    const evalPrompt = capturedEvalInput!.validation_criteria;
    expect(evalPrompt).toContain("FAIL: expected 200 got 404");
    expect(evalPrompt).toContain("Error in test");
    expect(evalPrompt).toContain("Iteration 1 of");
  });

  it("iteration number comes from loop counter, not worker handoff", async () => {
    const evalPrompts: string[] = [];

    const evalTransport: EvaluatorTransport = {
      invoke: async (input: EvaluatorInput): Promise<EvaluatorResult> => {
        evalPrompts.push(input.validation_criteria);
        // Fail first iteration, pass second
        if (evalPrompts.length === 1) return failingEvalResult("Try again");
        return passingEvalResult();
      },
    };

    const config = defaultConfig({
      sprint: {
        max_iterations: 3,
        verification_timeout_ms: 5000,
        escalate_to_full: true,
        worker_can_escalate: false,
        escalate_on_stuck: false,
      },
    });

    // Worker always reports iteration_number: 99 (wrong), loop should use its own counter
    const opts = createTestOptions({
      config,
      evaluatorTransport: evalTransport,
      _readHandoff: async () =>
        makeHandoff({ iteration_number: 99 }),
      _runVerification: async () => failingVerification("FAIL"),
    });

    const handle = createSprintLoop(opts);
    const result = await handle.run();

    // Loop used 2 iterations (fail then pass)
    expect(result.iterationsUsed).toBe(2);

    // Evaluator prompts should show iteration 1 and 2 from loop counter
    expect(evalPrompts[0]).toContain("Iteration 1 of 3");
    expect(evalPrompts[1]).toContain("Iteration 2 of 3");
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-003: Prompt and evaluator path alignment
// ---------------------------------------------------------------------------

describe("VAL-CROSS-003: Prompt and evaluator path alignment", () => {
  it("SPRINT_FIELDS keys are all present in phase prompt handoff section", () => {
    const fieldKeys = SPRINT_FIELDS.map((f) => f.key);

    // Build a phase prompt and check it contains all field keys
    const prompt = buildSprintPhasePrompt({
      planContent: "Test alignment task",
      keyDecisions: [],
      fileReferences: [],
      projectCwd: "/test",
      extra: { handoffPath: "/tmp/test-handoff.json" },
    });

    for (const key of fieldKeys) {
      expect(prompt).toContain(`**${key}**`);
    }
  });

  it("SPRINT_FIELDS keys match renderHandoffInstruction output", () => {
    const fieldKeys = SPRINT_FIELDS.map((f) => f.key);
    const rendered = renderHandoffInstruction(SPRINT_FIELDS, "/tmp/test.json");

    // Each field key should appear as a bold label in the rendered instruction
    for (const key of fieldKeys) {
      expect(rendered).toContain(`**${key}**`);
    }

    // Verify needs_plan is included (VAL-FIX-001 dependency)
    expect(fieldKeys).toContain("needs_plan");
    expect(rendered).toContain("**needs_plan**");
  });

  it("evaluator prompt references same fields as worker handoff", () => {
    // Build an evaluator prompt with typical sprint data
    const evalPrompt = buildSprintEvaluatorPrompt({
      taskDescription: "Test alignment",
      iterationNumber: 1,
      maxIterations: 3,
      workerHandoff: {
        summary: "Did the work",
        artifacts: { files_created: ["src/test.ts"] },
        verification: { tests_passed: true, test_output_summary: "All pass" },
        verification_script_path: ".flywheel/verify/test.ts",
      },
      verificationResult: {
        stdout: "OK",
        stderr: "",
        exitCode: 0,
        passed: true,
      },
      currentScriptContent: "exit 0",
      handoffPath: "/tmp/eval-handoff.json",
    });

    // The evaluator prompt should reference the key handoff concepts
    // that the worker was instructed to produce via SPRINT_FIELDS.
    // Use section headers for reliable matching.
    expect(evalPrompt).toContain("Worker Summary");
    expect(evalPrompt).toContain("Verification Script Result");
    expect(evalPrompt).toContain("## Artifacts");
    expect(evalPrompt).toContain("Files created:");
    expect(evalPrompt).toContain("Implementation Quality");
    expect(evalPrompt).toContain("Verification Script Quality");
  });

  it("no field in SPRINT_FIELDS is missing from rendered handoff instructions", () => {
    const fieldKeys = new Set(SPRINT_FIELDS.map((f) => f.key));
    const rendered = renderHandoffInstruction(SPRINT_FIELDS, "/tmp/test.json");

    // Extract field names from the rendered markdown (pattern: **fieldName**)
    const renderedFieldKeys = new Set<string>();
    const regex = /\*\*(\w+)\*\*/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(rendered)) !== null) {
      renderedFieldKeys.add(match[1]);
    }

    // Every SPRINT_FIELDS key must appear in the rendered output
    for (const key of fieldKeys) {
      expect(renderedFieldKeys.has(key)).toBe(true);
    }

    // No extra fields in rendered output that aren't in SPRINT_FIELDS
    // (renderHandoffInstruction may add "summary" if not present, but
    // SPRINT_FIELDS already includes summary, so this should be exact)
    for (const rendered of renderedFieldKeys) {
      expect(fieldKeys.has(rendered as any)).toBe(true);
    }
  });
});
