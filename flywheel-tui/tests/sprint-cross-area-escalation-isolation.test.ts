/**
 * Sprint Cross-Area Integration Tests — Escalation & Isolation
 *
 * Tests the integration boundaries between sprint subsystems:
 * - VAL-CROSS-005: Escalation context reaches pipeline stages
 * - VAL-CROSS-007: Sprint session isolation
 */

import { describe, it, expect } from "bun:test";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { MockAdapter } from "../src/tui/adapters/mock";
import { createSprintLoop } from "../src/sprint/sprint-loop";
import type { SprintLoopResult } from "../src/sprint/sprint-loop";
import { buildEscalationContext } from "../src/sprint/escalation-context";
import type { EscalationContext } from "../src/sprint/escalation-context";
import { createStageLoop } from "../src/controller/stage-loop-factory";
import { WorkflowPipeline } from "../src/controller/workflow-pipeline";
import type {
  PipelineStageResult,
  PipelineStage,
  StageRunner,
} from "../src/controller/workflow-pipeline";
import {
  createSessionRuntimeManager,
  type SessionRuntimeManager,
} from "../src/tui/components/session-runtime";
import {
  createWorkflowSession,
  destroyWorkflowSession,
} from "../src/tui/components/workflow-session";
import {
  defaultConfig,
  makeWorkerResult,
  makeHandoff,
  passingVerification,
  failingVerification,
  failingEvalResult,
  mockExecutor,
  mockEvaluator,
  createTestOptions,
  createTestOptionsWithBus,
} from "./fixtures/sprint-test-helpers";

// ---------------------------------------------------------------------------
// VAL-CROSS-005: Escalation context reaches pipeline stages
// ---------------------------------------------------------------------------

describe("VAL-CROSS-005: Escalation context reaches pipeline stages", () => {
  it("sprint returning shouldEscalate=true stores sprintResult in extraAccumulator", async () => {
    // Sprint with max_iterations=1 and failing evaluator forces escalation
    const config = defaultConfig({
      sprint: {
        max_iterations: 1,
        verification_timeout_ms: 5000,
        escalate_to_full: true,
        worker_can_escalate: false,
        escalate_on_stuck: false,
      },
    });

    const opts = createTestOptions({
      config,
      evaluatorTransport: mockEvaluator([failingEvalResult("Iteration 1 fail")]),
      _readHandoff: async () => makeHandoff({ summary: "Attempted hello endpoint" }),
      _runVerification: async () => failingVerification("FAIL: test output"),
    });

    const handle = createSprintLoop(opts);
    const result = await handle.run();

    // Sprint should have escalated after 1 iteration
    expect(result.escalated).toBe(true);
    expect(result.completed).toBe(false);
    expect(result.iterationsUsed).toBe(1);
    expect(result.iterationHistory).toHaveLength(1);
    expect(result.iterationHistory[0].workerSummary).toBe("Attempted hello endpoint");
  });

  it("extraAccumulator contains sprintResult and iterationHistory after escalation", async () => {
    const config = defaultConfig({
      sprint: {
        max_iterations: 2,
        verification_timeout_ms: 5000,
        escalate_to_full: true,
        worker_can_escalate: false,
        escalate_on_stuck: false,
      },
    });

    const eventBus = new EventBus();
    const adapter = new MockAdapter();
    adapter.connect(eventBus);

    // Use createStageLoop to test the factory path that wraps SprintLoop
    const handle = createStageLoop({
      workflow: "sprint",
      args: { description: "Test escalation context propagation" },
      config,
      spawner: {
        spawn: async () => ({
          output: "done",
          exitCode: 0,
          truncated: false,
          durationMs: 500,
          failure: undefined,
          handoffPath: "/tmp/handoff.json",
        }),
      } as any,
      engine: {
        name: "claude",
        buildCommand: () => ({ binary: "echo", args: ["test"] }),
      } as any,
      ui: adapter,
      eventBus,
    });

    // Run the sprint — with no DI overrides, the real readHandoff will fail,
    // counting as failed iterations. After 2 iterations, it escalates.
    await handle.loop.run();

    const extra = handle.getAccumulatedExtra();

    // Verify sprintResult is stored in extraAccumulator
    expect(extra.sprintResult).toBeDefined();
    const sprintResult = extra.sprintResult as SprintLoopResult;
    expect(sprintResult.escalated).toBe(true);
    expect(sprintResult.iterationsUsed).toBe(2);

    // Verify iterationHistory is also stored
    expect(extra.iterationHistory).toBeDefined();
    const history = extra.iterationHistory as SprintLoopResult["iterationHistory"];
    expect(history).toHaveLength(2);
  });

  it("buildEscalationContext produces valid EscalationContext from SprintLoopResult", () => {
    const sprintResult: SprintLoopResult = {
      completed: false,
      iterationsUsed: 3,
      escalated: true,
      reason: "Max iterations reached",
      iterationHistory: [
        {
          iteration: 1,
          workerSummary: "First attempt at hello endpoint",
          verificationResult: {
            passed: false,
            stdout: "FAIL: 404\n",
            stderr: "",
            exitCode: 1,
            durationMs: 300,
          },
          evaluatorPassed: false,
          evaluatorFeedback: {
            implementation: "Missing route handler",
            script: "Script is correct",
          },
        },
        {
          iteration: 2,
          workerSummary: "Added route, still failing",
          verificationResult: {
            passed: false,
            stdout: "FAIL: wrong status\n",
            stderr: "",
            exitCode: 1,
            durationMs: 250,
          },
          evaluatorPassed: false,
          evaluatorFeedback: {
            implementation: "Wrong HTTP method",
            script: "Script is correct",
          },
        },
        {
          iteration: 3,
          workerSummary: "Tried different approach",
          workerCrashed: true,
        },
      ],
    };

    const ctx = buildEscalationContext(sprintResult);

    expect(ctx.iterationsUsed).toBe(3);
    expect(ctx.reason).toBe("Max iterations reached");
    expect(ctx.iterationHistory).toHaveLength(3);
    expect(ctx.iterationHistory[0].workerSummary).toBe("First attempt at hello endpoint");
    expect(ctx.iterationHistory[1].evaluatorFeedback?.implementation).toBe("Wrong HTTP method");
    expect(ctx.iterationHistory[2].workerCrashed).toBe(true);
  });

  it("escalationContext in PipelineStageResult triggers dynamic stage appending", async () => {
    const config = defaultConfig({
      sprint: {
        max_iterations: 2,
        verification_timeout_ms: 5000,
        escalate_to_full: true,
        worker_can_escalate: false,
        escalate_on_stuck: false,
      },
    });

    const escalationCtx: EscalationContext = {
      iterationsUsed: 2,
      reason: "Max iterations reached",
      iterationHistory: [
        { iteration: 1, workerSummary: "Attempt 1" },
        { iteration: 2, workerSummary: "Attempt 2" },
      ],
    };

    // Track which stages are run
    const stagesRun: string[] = [];
    const argsReceived: Record<string, string>[] = [];

    const stageRunner: StageRunner = async (stage, args) => {
      stagesRun.push(stage.workflow);
      argsReceived.push({ ...args });

      if (stage.workflow === "sprint") {
        // Sprint returns escalation context
        return {
          workflow: "sprint" as const,
          completed: true,
          escalationContext: escalationCtx,
        };
      }
      // All other stages succeed normally
      return {
        workflow: stage.workflow as any,
        completed: true,
        planPath: stage.workflow === "plan" ? "/tmp/plan.md" : undefined,
      };
    };

    // Minimal QuestionService mock (gates won't be used)
    const questionService = {
      ask: async () => [],
      answer: () => {},
      reject: () => {},
      list: () => [],
    } as any;

    const eventBus = new EventBus();

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Test escalation flow" },
      config,
      stageRunner,
      questionService,
      eventBus,
    });

    const result = await pipeline.run();

    // Pipeline should have completed (sprint + appended plan + work + review)
    expect(result.completed).toBe(true);
    expect(stagesRun).toEqual(["sprint", "plan", "work", "review"]);

    // Verify sprintEscalationContext was threaded into args for plan stage
    const planArgs = argsReceived[1]; // plan is the 2nd stage
    expect(planArgs.sprintEscalationContext).toBeDefined();
    const parsed = JSON.parse(planArgs.sprintEscalationContext);
    expect(parsed.iterationsUsed).toBe(2);
    expect(parsed.reason).toBe("Max iterations reached");
    expect(parsed.iterationHistory).toHaveLength(2);
  });

  it("escalation disabled: pipeline fails when sprint exhausts with escalate_to_full=false", async () => {
    const config = defaultConfig({
      sprint: {
        max_iterations: 1,
        verification_timeout_ms: 5000,
        escalate_to_full: false, // Disabled
        worker_can_escalate: false,
        escalate_on_stuck: false,
      },
    });

    const escalationCtx: EscalationContext = {
      iterationsUsed: 1,
      reason: "Max iterations reached",
      iterationHistory: [{ iteration: 1, workerSummary: "Only attempt" }],
    };

    const stageRunner: StageRunner = async (stage) => {
      if (stage.workflow === "sprint") {
        return {
          workflow: "sprint" as const,
          completed: true,
          escalationContext: escalationCtx,
        };
      }
      return { workflow: stage.workflow as any, completed: true };
    };

    const questionService = {
      ask: async () => [],
      answer: () => {},
      reject: () => {},
      list: () => [],
    } as any;

    const pipeline = new WorkflowPipeline({
      stages: [{ workflow: "sprint" }],
      args: { description: "Test disabled escalation" },
      config,
      stageRunner,
      questionService,
      eventBus: new EventBus(),
    });

    const result = await pipeline.run();

    // Pipeline should fail — escalation disabled
    expect(result.completed).toBe(false);
    expect(result.reason).toContain("escalate_to_full is disabled");
    expect(result.stagesCompleted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-007: Sprint session isolation
// ---------------------------------------------------------------------------

describe("VAL-CROSS-007: Sprint session isolation", () => {
  it("two sessions have independent EventBus instances", () => {
    const sessionA = createWorkflowSession("/tmp/planA.md");
    const sessionB = createWorkflowSession("/tmp/planB.md");

    try {
      // Each session gets its own EventBus
      expect(sessionA.eventBus).not.toBe(sessionB.eventBus);
      expect(sessionA.eventBus).toBeInstanceOf(EventBus);
      expect(sessionB.eventBus).toBeInstanceOf(EventBus);
    } finally {
      destroyWorkflowSession(sessionA);
      destroyWorkflowSession(sessionB);
    }
  });

  it("two sessions have independent adapter instances", () => {
    const sessionA = createWorkflowSession("/tmp/planA.md");
    const sessionB = createWorkflowSession("/tmp/planB.md");

    try {
      expect(sessionA.adapter).not.toBe(sessionB.adapter);
    } finally {
      destroyWorkflowSession(sessionA);
      destroyWorkflowSession(sessionB);
    }
  });

  it("sprint event on session A bus is NOT received by session B adapter", () => {
    const sessionA = createWorkflowSession("/tmp/planA.md");
    const sessionB = createWorkflowSession("/tmp/planB.md");

    try {
      const eventsA: string[] = [];
      const eventsB: string[] = [];

      // Subscribe to events on each session's bus
      sessionA.eventBus.subscribe((e) => eventsA.push(e.type));
      sessionB.eventBus.subscribe((e) => eventsB.push(e.type));

      // Emit a sprint event on session A's bus only
      sessionA.eventBus.emit({
        type: "sprint:started",
        workflowId: "sprint-a",
        taskDescription: "Task for session A",
        maxIterations: 5,
        timestamp: new Date().toISOString(),
      });

      // Session A should have received the event
      expect(eventsA).toContain("sprint:started");

      // Session B should NOT have received the event
      expect(eventsB).not.toContain("sprint:started");
      expect(eventsB).toHaveLength(0);
    } finally {
      destroyWorkflowSession(sessionA);
      destroyWorkflowSession(sessionB);
    }
  });

  it("SessionRuntimeManager registers independent sessions", () => {
    const manager = createSessionRuntimeManager({
      destroyWorkflowSession,
    });

    const sessionA = createWorkflowSession("/tmp/planA.md");
    const sessionB = createWorkflowSession("/tmp/planB.md");

    try {
      manager.register("a", {
        kind: "pending", sessionId: "a", session: sessionA,
      });
      manager.register("b", {
        kind: "pending", sessionId: "b", session: sessionB,
      });

      expect(manager.size).toBe(2);
      expect(manager.has("a")).toBe(true);
      expect(manager.has("b")).toBe(true);

      const rtA = manager.get("a");
      const rtB = manager.get("b");
      expect(rtA).toBeDefined();
      expect(rtB).toBeDefined();
      expect(rtA!.session).not.toBe(rtB!.session);
      expect(rtA!.session.eventBus).not.toBe(rtB!.session.eventBus);
      expect(rtA!.session.adapter).not.toBe(rtB!.session.adapter);
    } finally {
      manager.teardownAll();
    }
  });

  it("concurrent sprint loops have independent state", async () => {
    // Two independent sprint loops with different configs
    const configA = defaultConfig({
      sprint: {
        max_iterations: 1,
        verification_timeout_ms: 5000,
        escalate_to_full: true,
        worker_can_escalate: false,
        escalate_on_stuck: false,
      },
    });
    const configB = defaultConfig({
      sprint: {
        max_iterations: 3,
        verification_timeout_ms: 5000,
        escalate_to_full: true,
        worker_can_escalate: false,
        escalate_on_stuck: false,
      },
    });

    const optsA = createTestOptions({
      config: configA,
      workflowId: "sprint-session-a",
      _readHandoff: async () => makeHandoff({ summary: "Session A work" }),
      _runVerification: async () => passingVerification(),
    });
    const optsB = createTestOptions({
      config: configB,
      workflowId: "sprint-session-b",
      _readHandoff: async () => makeHandoff({ summary: "Session B work" }),
      _runVerification: async () => failingVerification("Session B fails"),
    });

    const handleA = createSprintLoop(optsA);
    const handleB = createSprintLoop(optsB);

    // Run both concurrently
    const [resultA, resultB] = await Promise.all([
      handleA.run(),
      handleB.run(),
    ]);

    // Session A: passes on iteration 1
    expect(resultA.completed).toBe(true);
    expect(resultA.iterationsUsed).toBe(1);
    expect(resultA.iterationHistory[0].workerSummary).toBe("Session A work");

    // Session B: fails all 3 iterations, escalates
    expect(resultB.completed).toBe(false);
    expect(resultB.escalated).toBe(true);
    expect(resultB.iterationsUsed).toBe(3);

    // Results are completely independent
    expect(resultA.escalated).toBe(false);
    expect(resultB.completed).toBe(false);
  });
});
