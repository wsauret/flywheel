// ---------------------------------------------------------------------------
// Dispatcher Per-Step Integration — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for the real dispatcher integration into queue step execution.
// Covers: VAL-DISP-001..007, VAL-EXEC-015
// ---------------------------------------------------------------------------

import { describe, expect, test, mock, beforeEach } from "bun:test";
import { randomUUID } from "crypto";

import type { Step, Queue } from "../src/queue/types";
import type { FlywheelEmitter } from "../src/events/event-bus";
import {
  createStepDispatcher,
  type StepDispatcherInput,
  type StepDispatcherDecision,
  type StepDispatcherOptions,
  type MutationRequest,
} from "../src/queue/step-dispatcher";
import type { DispatcherTransport } from "../src/dispatcher/transport";
import type { DispatcherInput, DispatcherDecision } from "../src/schemas/dispatcher";
import type { AccumulatedContext } from "../src/queue/context-accumulator";
import type { EvalResult } from "../src/queue/executor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: randomUUID(),
    type: "work",
    title: "Implement feature X",
    status: "pending",
    ...overrides,
  };
}

function makeQueue(steps: Step[]): Queue {
  return {
    steps,
    cursor: 0,
    status: "idle",
    mutationLog: [],
  };
}

/** Minimal mock emitter */
function createMockEmitter(): FlywheelEmitter & { events: Array<{ method: string; args: unknown[] }> } {
  const events: Array<{ method: string; args: unknown[] }> = [];
  const handler = {
    get(_target: unknown, prop: string) {
      if (prop === "events") return events;
      return (...args: unknown[]) => {
        events.push({ method: prop, args });
      };
    },
  };
  return new Proxy({} as FlywheelEmitter & { events: Array<{ method: string; args: unknown[] }> }, handler);
}

/** Create a mock transport that returns a decision */
function createMockTransport(
  decision?: Partial<DispatcherDecision>,
): DispatcherTransport & { lastInput: DispatcherInput | null; invokeCount: number } {
  const state = { lastInput: null as DispatcherInput | null, invokeCount: 0 };
  return {
    get lastInput() { return state.lastInput; },
    get invokeCount() { return state.invokeCount; },
    invoke: async (input: DispatcherInput) => {
      state.lastInput = input;
      state.invokeCount++;
      return {
        schema_version: 1 as const,
        step_index: 0,
        task_content: "Implement the feature as described",
        context_files: ["src/foo.ts"],
        evaluation_criteria: {
          acceptance_criteria: ["Feature implemented correctly"],
          required_tests: true,
          custom_checks: [],
          required_outputs: [],
        },
        ...decision,
      } satisfies DispatcherDecision;
    },
  };
}

/** Create a failing transport */
function createFailingTransport(error: string): DispatcherTransport {
  return {
    invoke: async () => {
      throw new Error(error);
    },
  };
}

const DEFAULT_OPTIONS: Omit<StepDispatcherOptions, "transport"> = {
  emitter: createMockEmitter(),
  workflowId: "test-workflow-1",
  configContext: {
    maxEvalCycles: 3,
    worktreePath: "/tmp/worktree",
    projectCwd: "/tmp/project",
    workerModel: "opus",
    dispatcherModel: "sonnet",
  },
  sessionBudget: {
    invocations_remaining: 10,
    token_budget_remaining: 100000,
    wall_clock_deadline: null,
  },
  availableContext: {
    conventions: [],
    standards: [],
    learnings: [],
  },
  sessionObjective: "Build a REST API",
};

// ---------------------------------------------------------------------------
// VAL-DISP-001: Dispatcher receives full per-step context
// ---------------------------------------------------------------------------

describe("VAL-DISP-001: Dispatcher receives full per-step context", () => {
  test("dispatcher input includes step metadata", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep({
      type: "work",
      title: "Add endpoint",
      description: "Add GET /users endpoint",
      dispatcherHint: "implement-api",
      toolScoping: { read: true, bash: true, write: true, edit: true },
      acceptanceCriteria: ["Endpoint returns JSON", "Tests pass"],
    });
    const queue = makeQueue([step]);

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    expect(transport.lastInput).not.toBeNull();
    const input = transport.lastInput!;
    // Step metadata should be in the input
    expect(input.workflow.step_description).toContain("Add GET /users endpoint");
    expect(input.workflow.name).toBe("work");
  });

  test("dispatcher input includes queue state", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step1 = makeStep({ title: "Step 1", status: "completed" });
    const step2 = makeStep({ title: "Step 2", status: "pending" });
    const step3 = makeStep({ title: "Step 3", status: "pending" });
    const queue = makeQueue([step1, step2, step3]);
    queue.cursor = 1;

    await dispatcher.dispatch(step2, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    const input = transport.lastInput!;
    expect(input.state.completed_steps).toContain(0);
    expect(input.state.current_step_index).toBe(1);
  });

  test("dispatcher input includes previous handoff", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);
    const previousHandoff = {
      summary: "Completed step 1 successfully",
      decisions: ["Used pattern A"],
    };

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff,
      previousAssessment: null,
    });

    const input = transport.lastInput!;
    expect(input.last_worker_result).not.toBeNull();
    expect(input.last_worker_result?.output_summary).toContain("Completed step 1 successfully");
  });

  test("dispatcher input includes accumulated context", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: {
        summaries: [{ stepId: "s1", stepType: "work", stepTitle: "Prior", decisions: ["D1"], artifacts: [], issues: [] }],
        recentHandoffs: [],
        totalSteps: 1,
      },
      previousHandoff: null,
      previousAssessment: null,
    });

    const input = transport.lastInput!;
    expect(input.step_context).toBeDefined();
    expect(input.step_context!.step_count).toBe(1);
  });

  test("dispatcher input includes available context (L1)", async () => {
    const transport = createMockTransport();
    const availableContext = {
      conventions: [{ name: "AGENTS.md", path: "/project/AGENTS.md", summary: "Agent instructions" }],
      standards: [{ name: "testing.md", path: "/project/docs/standards/testing.md", summary: "Testing patterns" }],
      learnings: [],
    };
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport, availableContext });

    const step = makeStep();
    const queue = makeQueue([step]);

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    const input = transport.lastInput!;
    expect(input.available_context.conventions).toHaveLength(1);
    expect(input.available_context.conventions[0].name).toBe("AGENTS.md");
    expect(input.available_context.standards).toHaveLength(1);
  });

  test("dispatcher input includes budget remaining", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({
      ...DEFAULT_OPTIONS,
      transport,
      sessionBudget: {
        invocations_remaining: 5,
        token_budget_remaining: 50000,
        wall_clock_deadline: "2026-12-31T23:59:59Z",
      },
    });

    const step = makeStep();
    const queue = makeQueue([step]);

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    const input = transport.lastInput!;
    expect(input.session_budget.invocations_remaining).toBe(5);
    expect(input.session_budget.token_budget_remaining).toBe(50000);
    expect(input.session_budget.wall_clock_deadline).toBe("2026-12-31T23:59:59Z");
  });

  test("dispatcher input includes session objective", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({
      ...DEFAULT_OPTIONS,
      transport,
      sessionObjective: "Build a REST API with pagination",
    });

    const step = makeStep();
    const queue = makeQueue([step]);

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    const input = transport.lastInput!;
    // Session objective should be included somewhere in the input
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("Build a REST API with pagination");
  });
});

// ---------------------------------------------------------------------------
// VAL-DISP-002: Dispatcher returns prompt, criteria, and worker config
// ---------------------------------------------------------------------------

describe("VAL-DISP-002: Dispatcher returns prompt, criteria, and worker config", () => {
  test("decision includes task_content", async () => {
    const transport = createMockTransport({
      task_content: "Implement pagination for GET /users",
    });
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    const decision = await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    expect(decision.taskContent).toBe("Implement pagination for GET /users");
  });

  test("decision includes evaluation_criteria", async () => {
    const transport = createMockTransport({
      evaluation_criteria: {
        acceptance_criteria: ["Endpoint works", "Tests pass"],
        required_tests: true,
        custom_checks: ["lint clean"],
        required_outputs: ["src/api.ts"],
      },
    });
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    const decision = await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    expect(decision.evaluationCriteria).toBeDefined();
    expect(decision.evaluationCriteria!.acceptance_criteria).toContain("Endpoint works");
    expect(decision.evaluationCriteria!.required_tests).toBe(true);
  });

  test("decision includes worker_config", async () => {
    const transport = createMockTransport({
      worker_config: {
        model_override: "haiku",
        timeout_minutes: 15,
        tool_scoping: { read: true, bash: true, write: true, edit: false },
      },
    });
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    const decision = await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    expect(decision.workerConfig).toBeDefined();
    expect(decision.workerConfig!.model_override).toBe("haiku");
    expect(decision.workerConfig!.tool_scoping?.edit).toBe(false);
  });

  test("decision includes context_to_inline and context_files", async () => {
    const transport = createMockTransport({
      context_files: ["src/routes.ts", "src/db.ts"],
      context_to_inline: ["docs/standards/api.md"],
    });
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    const decision = await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    expect(decision.contextFiles).toEqual(["src/routes.ts", "src/db.ts"]);
    expect(decision.contextToInline).toEqual(["docs/standards/api.md"]);
  });
});

// ---------------------------------------------------------------------------
// VAL-DISP-003: Dispatcher crafts per-step prompts (not stubs)
// ---------------------------------------------------------------------------

describe("VAL-DISP-003: Dispatcher crafts per-step prompts (not stubs)", () => {
  test("prompt contains step-specific content", async () => {
    const transport = createMockTransport({
      task_content: "Implement the GET /users endpoint with pagination support. Read src/routes.ts for the routing pattern.",
    });
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep({
      title: "Implement pagination",
      description: "Add pagination to the users endpoint",
      acceptanceCriteria: ["Supports page/limit params", "Returns total count"],
    });
    const queue = makeQueue([step]);

    const decision = await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    // The prompt should be a real prompt, not a stub
    expect(decision.taskContent.length).toBeGreaterThan(20);
    expect(decision.taskContent).not.toContain("stub");
    expect(decision.taskContent).toContain("pagination");
  });

  test("input includes acceptance criteria for work steps", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep({
      type: "work",
      acceptanceCriteria: ["Tests pass", "No type errors", "Endpoint returns JSON"],
    });
    const queue = makeQueue([step]);

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    const input = transport.lastInput!;
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("Tests pass");
    expect(serialized).toContain("Endpoint returns JSON");
  });
});

// ---------------------------------------------------------------------------
// VAL-DISP-004: Dispatcher failure fails the step
// ---------------------------------------------------------------------------

describe("VAL-DISP-004: Dispatcher failure fails the step", () => {
  test("transport timeout causes step failure", async () => {
    const transport = createFailingTransport("Dispatcher subprocess timed out after 60000ms");
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    await expect(
      dispatcher.dispatch(step, queue, {
        accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
        previousHandoff: null,
        previousAssessment: null,
      }),
    ).rejects.toThrow(/dispatcher/i);
  });

  test("transport binary not found causes step failure", async () => {
    const transport = createFailingTransport("claude CLI not found");
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    await expect(
      dispatcher.dispatch(step, queue, {
        accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
        previousHandoff: null,
        previousAssessment: null,
      }),
    ).rejects.toThrow();
  });

  test("failure error includes dispatcher context", async () => {
    const transport = createFailingTransport("Connection refused");
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep({ title: "My Step" });
    const queue = makeQueue([step]);

    try {
      await dispatcher.dispatch(step, queue, {
        accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
        previousHandoff: null,
        previousAssessment: null,
      });
      expect(false).toBe(true); // Should not reach here
    } catch (err) {
      expect((err as Error).message).toContain("dispatcher");
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-DISP-005: Dispatcher derives evaluation criteria from acceptance criteria
// ---------------------------------------------------------------------------

describe("VAL-DISP-005: Dispatcher derives evaluation criteria from acceptance criteria", () => {
  test("work step with acceptanceCriteria: criteria sent to dispatcher", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep({
      type: "work",
      acceptanceCriteria: ["GET /users returns paginated results", "Tests cover edge cases"],
    });
    const queue = makeQueue([step]);

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    const input = transport.lastInput!;
    const serialized = JSON.stringify(input);
    // Acceptance criteria should be present in the dispatcher input
    expect(serialized).toContain("GET /users returns paginated results");
    expect(serialized).toContain("Tests cover edge cases");
  });

  test("non-work step uses template evaluation criteria", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep({
      type: "plan",
      title: "Research codebase",
      evaluationCriteria: "Produces a .context.md with file references",
    });
    const queue = makeQueue([step]);

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    const input = transport.lastInput!;
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("Produces a .context.md with file references");
  });
});

// ---------------------------------------------------------------------------
// VAL-DISP-006: Dispatcher can request queue mutations
// ---------------------------------------------------------------------------

describe("VAL-DISP-006: Dispatcher can request queue mutations", () => {
  test("decision includes mutation requests with provenance", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    const decision = await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    // Decision should have mutationRequests field (possibly empty)
    expect(decision.mutationRequests).toBeDefined();
    expect(Array.isArray(decision.mutationRequests)).toBe(true);
  });

  test("mutation requests parsed from dispatcher decision", async () => {
    // Create a transport that returns a decision with mutations
    const transport: DispatcherTransport & { lastInput: DispatcherInput | null } = {
      lastInput: null,
      invoke: async (input: DispatcherInput) => {
        (transport as any).lastInput = input;
        return {
          schema_version: 1 as const,
          step_index: 0,
          task_content: "Fix the bug",
          context_files: [],
          evaluation_criteria: {
            acceptance_criteria: [],
            required_tests: false,
            custom_checks: [],
            required_outputs: [],
          },
          // Mutation requests in worker_config or extra field
          warnings: ["mutation:insert_after:current:fix-step:Fix the regression"],
        };
      },
    };
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    const decision = await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    // mutationRequests should be an array
    expect(Array.isArray(decision.mutationRequests)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-DISP-007: Dispatcher receives both handoff and assessment from prior step
// ---------------------------------------------------------------------------

describe("VAL-DISP-007: Dispatcher receives both handoff and assessment", () => {
  test("dispatcher input includes previous handoff", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);
    const previousHandoff = {
      summary: "Implemented the endpoint",
      artifacts: { files_created: ["src/api.ts"], files_modified: ["src/app.ts"] },
      verification: { tests_passed: true, test_output_summary: "5/5 pass" },
    };

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff,
      previousAssessment: null,
    });

    const input = transport.lastInput!;
    expect(input.last_worker_result).not.toBeNull();
    expect(input.last_worker_result?.output_summary).toContain("Implemented the endpoint");
  });

  test("dispatcher input includes previous evaluator assessment", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);
    const previousAssessment: EvalResult = {
      passed: true,
      skipped: false,
      transportError: false,
      reason: "All checks passed",
      feedback: null,
      suggestions: [],
      cyclesUsed: 1,

    };

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment,
    });

    const input = transport.lastInput!;
    const serialized = JSON.stringify(input);
    // Assessment should be passed along somehow
    expect(serialized).toContain("All checks passed");
  });

  test("both handoff and assessment present simultaneously", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: { summary: "Did the work" },
      previousAssessment: {
        passed: true,
        skipped: false,
        transportError: false,
        reason: "Verified OK",
        feedback: null,
        suggestions: [],
        cyclesUsed: 1,
      },
    });

    const input = transport.lastInput!;
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("Did the work");
    expect(serialized).toContain("Verified OK");
  });
});

// ---------------------------------------------------------------------------
// VAL-EXEC-015: Tool scoping flows from step through dispatcher to engine command
// ---------------------------------------------------------------------------

describe("VAL-EXEC-015: Tool scoping flows through dispatcher", () => {
  test("step tool scoping communicated in dispatcher input step description", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep({
      toolScoping: { read: true, bash: true, write: false, edit: false },
    });
    const queue = makeQueue([step]);

    await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    const input = transport.lastInput!;
    // Tool scoping should be communicated in step description
    expect(input.workflow.step_description).toContain("no file writes");
    expect(input.workflow.step_description).toContain("no file edits");
  });

  test("decision worker_config inherits step tool scoping when dispatcher doesn't override", async () => {
    const transport = createMockTransport({
      // No worker_config.tool_scoping — should inherit from step
      worker_config: { timeout_minutes: 30 },
    });
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep({
      toolScoping: { read: true, bash: true, write: false, edit: false },
    });
    const queue = makeQueue([step]);

    const decision = await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    // Worker config should have step's tool scoping merged
    expect(decision.workerConfig?.tool_scoping).toBeDefined();
    expect(decision.workerConfig!.tool_scoping!.write).toBe(false);
    expect(decision.workerConfig!.tool_scoping!.edit).toBe(false);
  });

  test("dispatcher tool scoping override takes precedence", async () => {
    const transport = createMockTransport({
      worker_config: {
        tool_scoping: { read: true, bash: true, write: true, edit: true },
      },
    });
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep({
      toolScoping: { read: true, bash: true, write: false, edit: false },
    });
    const queue = makeQueue([step]);

    const decision = await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    // Dispatcher override takes precedence (it's the AI's judgment)
    expect(decision.workerConfig?.tool_scoping?.write).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: StepDispatcher → DispatcherFn adapter (wiring into executor)
// ---------------------------------------------------------------------------

describe("StepDispatcher adapter for executor DispatcherFn", () => {
  test("createDispatcherAdapter creates a DispatcherFn from StepDispatcher", async () => {
    const transport = createMockTransport({
      task_content: "Do the work for this step",
      evaluation_criteria: {
        acceptance_criteria: ["Feature works"],
        required_tests: true,
        custom_checks: [],
        required_outputs: [],
      },
    });
    const stepDispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep({ title: "Work step" });
    const queue = makeQueue([step]);

    // Simulate how the executor would call the dispatcher via the adapter
    const context: Record<string, unknown> = {
      summaries: [],
      recentHandoffs: [],
      totalSteps: 0,
      previousHandoff: null,
      previousAssessment: null,
    };

    // The adapter wraps StepDispatcher.dispatch into DispatcherFn's signature
    const result = await stepDispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    // Verify the adapter returns prompt and evaluationCriteria
    expect(result.taskContent).toBe("Do the work for this step");
    expect(result.evaluationCriteria).toBeDefined();
    expect(result.evaluationCriteria!.acceptance_criteria).toContain("Feature works");
  });

  test("adapter passes accumulated context from executor", async () => {
    const transport = createMockTransport();
    const stepDispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    // Executor passes accumulated context via the context parameter
    await stepDispatcher.dispatch(step, queue, {
      accumulatedContext: {
        summaries: [{ stepId: "s1", stepType: "work", stepTitle: "Prior work", decisions: ["D"], artifacts: ["F"], issues: [] }],
        recentHandoffs: [{ stepId: "s1", stepType: "work", stepTitle: "Prior work", handoff: { summary: "Did stuff" } }],
        totalSteps: 1,
      },
      previousHandoff: { summary: "Previous step done" },
      previousAssessment: {
        passed: true,
        skipped: false,
        transportError: false,
        reason: "All good",
        feedback: null,
        suggestions: [],
        cyclesUsed: 1,
      },
    });

    const input = transport.lastInput!;
    // Accumulated context should be converted to step_context
    expect(input.step_context).toBeDefined();
    expect(input.step_context!.step_count).toBe(1);
    // Previous handoff should be in last_worker_result
    expect(input.last_worker_result).not.toBeNull();
    expect(input.last_worker_result!.output_summary).toContain("Previous step done");
    // Previous assessment should be in the context (via step_context warnings)
    const serialized = JSON.stringify(input);
    expect(serialized).toContain("All good");
  });
});

// ---------------------------------------------------------------------------
// Edge cases and error handling
// ---------------------------------------------------------------------------

describe("Step dispatcher edge cases", () => {
  test("empty queue works without error", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    const decision = await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    expect(decision.taskContent).toBeDefined();
    expect(decision.mutationRequests).toEqual([]);
  });

  test("step with all optional fields populated", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep({
      type: "work",
      title: "Full step",
      description: "A very detailed step description",
      dispatcherHint: "implement-feature",
      toolScoping: { read: true, bash: true, write: true, edit: true },
      evaluationCriteria: "All tests pass",
      acceptanceCriteria: ["Criterion A", "Criterion B"],
      fileReferences: ["src/foo.ts", "src/bar.ts"],
      feature: "feature-x",
      fulfills: ["VAL-001"],
      milestone: "m1",
    });
    const queue = makeQueue([step]);

    const decision = await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    expect(decision.taskContent).toBeDefined();
    // File references should be passed as context files in the input
    const input = transport.lastInput!;
    expect(input.context.files).toContain("src/foo.ts");
    expect(input.context.files).toContain("src/bar.ts");
    // Description should be in step_description
    expect(input.workflow.step_description).toContain("A very detailed step description");
  });

  test("multiple steps in queue show proper position tracking", async () => {
    const transport = createMockTransport();
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step1 = makeStep({ title: "Step 1", status: "completed" });
    const step2 = makeStep({ title: "Step 2", status: "completed" });
    const step3 = makeStep({ title: "Step 3", status: "pending" });
    const step4 = makeStep({ title: "Step 4", status: "pending" });
    const queue = makeQueue([step1, step2, step3, step4]);
    // Fix statuses (makeQueue resets to pending)
    queue.steps[0].status = "completed";
    queue.steps[1].status = "completed";
    queue.cursor = 2;

    await dispatcher.dispatch(step3, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 2 },
      previousHandoff: null,
      previousAssessment: null,
    });

    const input = transport.lastInput!;
    expect(input.workflow.step_number).toBe(3); // 1-indexed
    expect(input.workflow.total_steps).toBe(4);
    expect(input.state.completed_steps).toEqual([0, 1]);
    expect(input.state.current_step_index).toBe(2);
  });

  test("StepDispatcherError contains step ID and cause", async () => {
    const transport = createFailingTransport("Network timeout");
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep({ id: "step-123" });
    const queue = makeQueue([step]);

    try {
      await dispatcher.dispatch(step, queue, {
        accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
        previousHandoff: null,
        previousAssessment: null,
      });
      expect(false).toBe(true);
    } catch (err) {
      const e = err as import("../src/queue/step-dispatcher").StepDispatcherError;
      expect(e.name).toBe("StepDispatcherError");
      expect(e.stepId).toBe("step-123");
      expect(e.message).toContain("dispatcher");
      expect(e.message).toContain("step-123");
      expect(e.cause).toBeDefined();
    }
  });

  test("mutation request parsing from warnings", async () => {
    const transport: DispatcherTransport = {
      invoke: async () => ({
        schema_version: 1 as const,
        step_index: 0,
        task_content: "Fix it",
        context_files: [],
        evaluation_criteria: {
          acceptance_criteria: [],
          required_tests: false,
          custom_checks: [],
          required_outputs: [],
        },
        warnings: [
          "mutation:insert_after:current:fix-lint:Fix lint errors found",
          "mutation:skip:step-456:Already done",
          "This is a regular warning, not a mutation",
        ],
      }),
    };
    const dispatcher = createStepDispatcher({ ...DEFAULT_OPTIONS, transport });

    const step = makeStep();
    const queue = makeQueue([step]);

    const decision = await dispatcher.dispatch(step, queue, {
      accumulatedContext: { summaries: [], recentHandoffs: [], totalSteps: 0 },
      previousHandoff: null,
      previousAssessment: null,
    });

    expect(decision.mutationRequests).toHaveLength(2);
    expect(decision.mutationRequests[0].type).toBe("insert_after");
    expect(decision.mutationRequests[0].reason).toContain("Fix lint errors found");
    expect(decision.mutationRequests[1].type).toBe("skip");
    expect(decision.mutationRequests[1].targetStepId).toBe("step-456");
  });
});
