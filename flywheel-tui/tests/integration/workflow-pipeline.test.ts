/**
 * Integration tests for the full workflow pipeline flow.
 *
 * Tests end-to-end pipeline behavior using mock stage runners,
 * verifying event sequencing, StageResult threading (planPath from
 * plan -> args for work), gate behavior, and QuestionService integration.
 *
 * These tests exercise WorkflowPipeline as a real orchestrator — not
 * individual unit behaviors, but the full flow that /plan triggers:
 * plan -> work -> review in sequence.
 */

import { describe, it, expect } from "bun:test";
import { EventBus } from "../../src/events/event-bus";
import { QuestionService } from "../../src/controller/question-service";
import { CONFIG_DEFAULTS } from "../../src/config/loader";
import type { FlywheelConfig } from "../../src/config/loader";
import {
  WorkflowPipeline,
  type PipelineStage,
  type PipelineStageResult,
  type StageRunner,
} from "../../src/controller/workflow-pipeline";
import type { FlywheelEvent } from "../../src/events/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

/** Collect all pipeline-related events from the bus. */
function collectPipelineEvents(bus: EventBus): FlywheelEvent[] {
  const events: FlywheelEvent[] = [];
  bus.subscribe((event) => {
    if (event.type.startsWith("pipeline:")) {
      events.push(event);
    }
  });
  return events;
}

/**
 * Create a configurable mock StageRunner that simulates the full
 * plan -> work -> review pipeline with realistic data threading.
 *
 * - plan: returns a planPath in its result
 * - work: expects planPath in args, runs "work"
 * - review: runs after work
 */
function realisticStageRunner(opts?: {
  planPath?: string;
  failAt?: string;
  failReason?: string;
  delayMs?: number;
  onStageRun?: (workflow: string, args: Record<string, string>) => void;
}): StageRunner {
  const planPath = opts?.planPath ?? "/tmp/generated-plan.md";

  return async (stage, args, signal) => {
    opts?.onStageRun?.(stage.workflow, { ...args });

    // Respect abort signal
    if (signal.aborted) {
      return { workflow: stage.workflow, completed: false, reason: "aborted" };
    }

    // Optional delay to simulate real work
    if (opts?.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, opts.delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      }).catch(() => {
        return;
      });

      if (signal.aborted) {
        return {
          workflow: stage.workflow,
          completed: false,
          reason: "aborted",
        };
      }
    }

    // Simulate failure at specific stage
    if (opts?.failAt === stage.workflow) {
      return {
        workflow: stage.workflow,
        completed: false,
        reason: opts.failReason ?? `${stage.workflow} stage failed`,
      };
    }

    // Simulate realistic stage behavior
    switch (stage.workflow) {
      case "plan":
        return {
          workflow: "plan",
          completed: true,
          planPath, // Plan stage produces a plan file
        };
      case "work":
        return {
          workflow: "work",
          completed: true,
          // Work uses the planPath from args (threaded from plan result)
        };
      case "review":
        return {
          workflow: "review",
          completed: true,
        };
      default:
        return { workflow: stage.workflow, completed: true };
    }
  };
}

/** Build the standard /plan pipeline stages: plan -> work -> review. */
function planPipelineStages(opts?: {
  gateAfterPlan?: boolean;
  gateAfterWork?: boolean;
}): PipelineStage[] {
  return [
    { workflow: "plan", gateBeforeNext: opts?.gateAfterPlan ?? false },
    { workflow: "work", gateBeforeNext: opts?.gateAfterWork ?? false },
    { workflow: "review" },
  ];
}

// ===========================================================================
// 1. /plan triggers plan -> work -> review in sequence
// ===========================================================================

describe("Integration: /plan triggers plan -> work -> review sequence", () => {
  it("runs all three stages in order and completes successfully", async () => {
    const bus = new EventBus();
    const events = collectPipelineEvents(bus);
    const stageOrder: string[] = [];

    const runner = realisticStageRunner({
      onStageRun: (workflow) => stageOrder.push(workflow),
    });

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: { description: "add user authentication" },
      config: makeConfig(),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    const result = await pipeline.run();

    // Pipeline completed successfully
    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(3);
    expect(result.stagesTotal).toBe(3);

    // Stages ran in correct order
    expect(stageOrder).toEqual(["plan", "work", "review"]);

    // Stage results reflect all three stages
    expect(result.stageResults).toHaveLength(3);
    expect(result.stageResults[0].workflow).toBe("plan");
    expect(result.stageResults[1].workflow).toBe("work");
    expect(result.stageResults[2].workflow).toBe("review");
    expect(result.stageResults.every((r) => r.completed)).toBe(true);
  });

  it("emits pipeline:started, stage-transition, and pipeline:completed events", async () => {
    const bus = new EventBus();
    const events = collectPipelineEvents(bus);

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: {},
      config: makeConfig(),
      stageRunner: realisticStageRunner(),
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    await pipeline.run();

    // Event sequence: started -> transition(plan->work) -> transition(work->review) -> completed
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("pipeline:started");

    // Should have exactly 2 stage transitions
    const transitions = events.filter(
      (e) => e.type === "pipeline:stage-transition",
    );
    expect(transitions).toHaveLength(2);

    // Verify transition details
    const t1 = transitions[0] as Extract<
      FlywheelEvent,
      { type: "pipeline:stage-transition" }
    >;
    expect(t1.from).toBe("plan");
    expect(t1.to).toBe("work");

    const t2 = transitions[1] as Extract<
      FlywheelEvent,
      { type: "pipeline:stage-transition" }
    >;
    expect(t2.from).toBe("work");
    expect(t2.to).toBe("review");

    // Last event should be completed
    expect(types[types.length - 1]).toBe("pipeline:completed");
  });

  it("pipeline:started event includes all stage names", async () => {
    const bus = new EventBus();
    const events = collectPipelineEvents(bus);

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: {},
      config: makeConfig(),
      stageRunner: realisticStageRunner(),
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    await pipeline.run();

    const started = events.find(
      (e) => e.type === "pipeline:started",
    ) as Extract<FlywheelEvent, { type: "pipeline:started" }>;
    expect(started).toBeDefined();
    expect(started.stages).toEqual(["plan", "work", "review"]);
  });
});

// ===========================================================================
// 2. Plan file path is extracted and passed to work stage
// ===========================================================================

describe("Integration: planPath threading from plan to work", () => {
  it("plan result's planPath is available in work stage args", async () => {
    const bus = new EventBus();
    const capturedArgs: Record<string, Record<string, string>> = {};

    const runner = realisticStageRunner({
      planPath: "/projects/auth/plan-v1.md",
      onStageRun: (workflow, args) => {
        capturedArgs[workflow] = { ...args };
      },
    });

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: { description: "implement auth" },
      config: makeConfig(),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    await pipeline.run();

    // Plan stage should NOT have planPath in its args (it generates it)
    expect(capturedArgs["plan"].planPath).toBeUndefined();

    // Work stage SHOULD have planPath from plan's result
    expect(capturedArgs["work"].planPath).toBe("/projects/auth/plan-v1.md");

    // Review stage also has planPath (accumulated)
    expect(capturedArgs["review"].planPath).toBe("/projects/auth/plan-v1.md");
  });

  it("original args are preserved alongside threaded planPath", async () => {
    const bus = new EventBus();
    const capturedArgs: Record<string, Record<string, string>> = {};

    const runner = realisticStageRunner({
      planPath: "/plans/feature.md",
      onStageRun: (workflow, args) => {
        capturedArgs[workflow] = { ...args };
      },
    });

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: { description: "add feature", branch: "feat/new" },
      config: makeConfig(),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    await pipeline.run();

    // All stages should see original args
    expect(capturedArgs["plan"].description).toBe("add feature");
    expect(capturedArgs["plan"].branch).toBe("feat/new");
    expect(capturedArgs["work"].description).toBe("add feature");
    expect(capturedArgs["work"].branch).toBe("feat/new");
    expect(capturedArgs["review"].description).toBe("add feature");

    // Work and review also get threaded planPath
    expect(capturedArgs["work"].planPath).toBe("/plans/feature.md");
    expect(capturedArgs["review"].planPath).toBe("/plans/feature.md");
  });

  it("planPath from earlier stage overrides pre-existing planPath in args", async () => {
    const bus = new EventBus();
    const capturedArgs: Record<string, Record<string, string>> = {};

    const runner = realisticStageRunner({
      planPath: "/plans/new-plan.md",
      onStageRun: (workflow, args) => {
        capturedArgs[workflow] = { ...args };
      },
    });

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: { planPath: "/plans/old-plan.md" }, // pre-existing planPath
      config: makeConfig(),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    await pipeline.run();

    // Plan stage sees the old planPath
    expect(capturedArgs["plan"].planPath).toBe("/plans/old-plan.md");

    // Work stage sees the NEW planPath from plan's result (overrides original)
    expect(capturedArgs["work"].planPath).toBe("/plans/new-plan.md");
  });
});

// ===========================================================================
// 3. Review runs on the work output
// ===========================================================================

describe("Integration: review runs after work completes", () => {
  it("review stage only runs after work completes successfully", async () => {
    const bus = new EventBus();
    const stageOrder: string[] = [];

    const runner = realisticStageRunner({
      onStageRun: (workflow) => stageOrder.push(workflow),
    });

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: {},
      config: makeConfig(),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    await pipeline.run();

    // Review must come after work
    const workIdx = stageOrder.indexOf("work");
    const reviewIdx = stageOrder.indexOf("review");
    expect(workIdx).toBeLessThan(reviewIdx);
  });

  it("review does NOT run if work fails", async () => {
    const bus = new EventBus();
    const stagesRun: string[] = [];

    const runner = realisticStageRunner({
      failAt: "work",
      failReason: "compilation error in src/main.ts",
      onStageRun: (workflow) => stagesRun.push(workflow),
    });

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: {},
      config: makeConfig(),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(1); // only plan
    expect(result.reason).toContain("compilation error");

    // Review never ran
    expect(stagesRun).toEqual(["plan", "work"]);
    expect(stagesRun).not.toContain("review");
  });

  it("review receives accumulated args from both plan and work stages", async () => {
    const bus = new EventBus();
    const capturedReviewArgs: Record<string, string> = {};

    const runner: StageRunner = async (stage, args) => {
      if (stage.workflow === "review") {
        Object.assign(capturedReviewArgs, args);
      }
      if (stage.workflow === "plan") {
        return {
          workflow: "plan",
          completed: true,
          planPath: "/plans/review-target.md",
        };
      }
      return { workflow: stage.workflow, completed: true };
    };

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: { description: "test review" },
      config: makeConfig(),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    await pipeline.run();

    // Review should have both the original description and the threaded planPath
    expect(capturedReviewArgs.description).toBe("test review");
    expect(capturedReviewArgs.planPath).toBe("/plans/review-target.md");
  });
});

// ===========================================================================
// 4. Stopping at any stage halts the pipeline
// ===========================================================================

describe("Integration: stopping at any stage halts the pipeline", () => {
  it("stopping during plan stage halts before work runs", async () => {
    const bus = new EventBus();
    const events = collectPipelineEvents(bus);
    const stagesRun: string[] = [];

    const runner = realisticStageRunner({
      failAt: "plan",
      failReason: "plan generation failed — AI error",
      onStageRun: (workflow) => stagesRun.push(workflow),
    });

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: {},
      config: makeConfig(),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(0);
    expect(result.reason).toContain("plan generation failed");
    expect(stagesRun).toEqual(["plan"]);
    expect(stagesRun).not.toContain("work");
    expect(stagesRun).not.toContain("review");

    // Should emit pipeline:failed, not pipeline:completed
    const types = events.map((e) => e.type);
    expect(types).toContain("pipeline:failed");
    expect(types).not.toContain("pipeline:completed");
  });

  it("stopping during work stage halts before review runs", async () => {
    const bus = new EventBus();
    const stagesRun: string[] = [];

    const runner = realisticStageRunner({
      failAt: "work",
      failReason: "worker process crashed",
      onStageRun: (workflow) => stagesRun.push(workflow),
    });

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: {},
      config: makeConfig(),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(1); // plan completed
    expect(result.reason).toContain("worker process crashed");
    expect(stagesRun).toEqual(["plan", "work"]);
  });

  it("stopping during review stage reports partial completion", async () => {
    const bus = new EventBus();
    const stagesRun: string[] = [];

    const runner = realisticStageRunner({
      failAt: "review",
      failReason: "review checks found critical issues",
      onStageRun: (workflow) => stagesRun.push(workflow),
    });

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: {},
      config: makeConfig(),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(2); // plan + work completed
    expect(result.reason).toContain("review checks found critical issues");
    expect(stagesRun).toEqual(["plan", "work", "review"]);
  });

  it("requestShutdown() during an active stage aborts the pipeline", async () => {
    const bus = new EventBus();
    const events = collectPipelineEvents(bus);

    // Use a delay so we can abort mid-stage
    const runner: StageRunner = async (stage, _args, signal) => {
      return new Promise<PipelineStageResult>((resolve) => {
        const timer = setTimeout(() => {
          resolve({ workflow: stage.workflow, completed: true });
        }, 300);

        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve({
            workflow: stage.workflow,
            completed: false,
            reason: "shutdown requested",
          });
        });
      });
    };

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: {},
      config: makeConfig(),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    const resultPromise = pipeline.run();

    // Let the first stage start, then shutdown
    await new Promise((r) => setTimeout(r, 50));
    pipeline.requestShutdown();

    const result = await resultPromise;

    expect(result.completed).toBe(false);
    expect(result.reason).toBeDefined();

    const types = events.map((e) => e.type);
    expect(types).toContain("pipeline:started");
    expect(types).toContain("pipeline:failed");
    expect(types).not.toContain("pipeline:completed");
  });

  it("requestShutdown() between stages (at a gate) halts the pipeline", async () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages({ gateAfterPlan: true }),
      args: {},
      config: makeConfig(),
      stageRunner: realisticStageRunner(),
      questionService,
      eventBus: bus,
    });

    const resultPromise = pipeline.run();

    // Wait for gate question to appear
    await new Promise((r) => setTimeout(r, 50));
    expect(questionService.list()).toHaveLength(1);

    // Shutdown while waiting at gate
    pipeline.requestShutdown();

    const result = await resultPromise;

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(1); // plan completed, gate blocked work
  });
});

// ===========================================================================
// 5. Pausing at a gate transitions to incomplete with pause reason
// ===========================================================================

describe("Integration: pausing at a gate transitions to incomplete", () => {
  it("selecting Pause at a gate returns incomplete with pause reason", async () => {
    const bus = new EventBus();
    const events = collectPipelineEvents(bus);
    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages({ gateAfterPlan: true }),
      args: {},
      config: makeConfig(),
      stageRunner: realisticStageRunner(),
      questionService,
      eventBus: bus,
    });

    const resultPromise = pipeline.run();

    // Wait for gate question
    await new Promise((r) => setTimeout(r, 50));

    const pending = questionService.list();
    expect(pending).toHaveLength(1);

    // Find and select the Pause option
    const pauseOption = pending[0].questions[0].options.find((o) =>
      o.label.toLowerCase().includes("pause"),
    );
    expect(pauseOption).toBeDefined();
    questionService.reply(pending[0].id, [[pauseOption!.label]]);

    const result = await resultPromise;

    // Pipeline should be incomplete
    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(1); // plan ran
    expect(result.stagesTotal).toBe(3);
    expect(result.reason).toContain("pause");

    // pipeline:failed event should be emitted (not completed)
    const types = events.map((e) => e.type);
    expect(types).toContain("pipeline:failed");
    expect(types).not.toContain("pipeline:completed");

    // Verify the failed event includes the pause reason
    const failedEvent = events.find(
      (e) => e.type === "pipeline:failed",
    ) as Extract<FlywheelEvent, { type: "pipeline:failed" }>;
    expect(failedEvent.reason).toContain("pause");
    expect(failedEvent.stagesCompleted).toBe(1);
  });

  it("selecting Stop at a gate returns incomplete with stop reason", async () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages({ gateAfterPlan: true }),
      args: {},
      config: makeConfig(),
      stageRunner: realisticStageRunner(),
      questionService,
      eventBus: bus,
    });

    const resultPromise = pipeline.run();

    await new Promise((r) => setTimeout(r, 50));

    const pending = questionService.list();
    const stopOption = pending[0].questions[0].options.find((o) =>
      o.label.toLowerCase().includes("stop"),
    );
    expect(stopOption).toBeDefined();
    questionService.reply(pending[0].id, [[stopOption!.label]]);

    const result = await resultPromise;

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(1);
    expect(result.reason).toContain("stop");
  });

  it("selecting Continue at a gate proceeds to the next stage", async () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus);
    const stagesRun: string[] = [];

    const runner = realisticStageRunner({
      onStageRun: (workflow) => stagesRun.push(workflow),
    });

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages({ gateAfterPlan: true }),
      args: {},
      config: makeConfig(),
      stageRunner: runner,
      questionService,
      eventBus: bus,
    });

    const resultPromise = pipeline.run();

    await new Promise((r) => setTimeout(r, 50));

    const pending = questionService.list();
    const continueOption = pending[0].questions[0].options.find((o) =>
      o.label.toLowerCase().includes("continue"),
    );
    expect(continueOption).toBeDefined();
    questionService.reply(pending[0].id, [[continueOption!.label]]);

    const result = await resultPromise;

    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(3);
    expect(stagesRun).toEqual(["plan", "work", "review"]);
  });

  it("dismissing a gate question halts the pipeline", async () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages({ gateAfterPlan: true }),
      args: {},
      config: makeConfig(),
      stageRunner: realisticStageRunner(),
      questionService,
      eventBus: bus,
    });

    const resultPromise = pipeline.run();

    await new Promise((r) => setTimeout(r, 50));

    // Reject (dismiss) the gate question
    const pending = questionService.list();
    expect(pending).toHaveLength(1);
    questionService.reject(pending[0].id);

    const result = await resultPromise;

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(1);
    expect(result.reason).toContain("dismissed");
  });

  it("multiple gates: pause at second gate after continuing past first", async () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus);
    const stagesRun: string[] = [];

    const runner = realisticStageRunner({
      onStageRun: (workflow) => stagesRun.push(workflow),
    });

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages({
        gateAfterPlan: true,
        gateAfterWork: true,
      }),
      args: {},
      config: makeConfig(),
      stageRunner: runner,
      questionService,
      eventBus: bus,
    });

    const resultPromise = pipeline.run();

    // First gate: Continue past plan -> work
    await new Promise((r) => setTimeout(r, 50));
    let pending = questionService.list();
    expect(pending).toHaveLength(1);
    const continueOption1 = pending[0].questions[0].options.find((o) =>
      o.label.toLowerCase().includes("continue"),
    );
    questionService.reply(pending[0].id, [[continueOption1!.label]]);

    // Second gate: Pause after work -> before review
    await new Promise((r) => setTimeout(r, 50));
    pending = questionService.list();
    expect(pending).toHaveLength(1);
    const pauseOption = pending[0].questions[0].options.find((o) =>
      o.label.toLowerCase().includes("pause"),
    );
    questionService.reply(pending[0].id, [[pauseOption!.label]]);

    const result = await resultPromise;

    // Plan and work ran, review did not
    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(2);
    expect(result.reason).toContain("pause");
    expect(stagesRun).toEqual(["plan", "work"]);
  });
});

// ===========================================================================
// End-to-end: full /plan pipeline with realistic scenario
// ===========================================================================

describe("Integration: end-to-end /plan pipeline scenario", () => {
  it("full scenario: plan generates path, work uses it, review completes, events are correct", async () => {
    const bus = new EventBus();
    const allEvents: FlywheelEvent[] = [];
    bus.subscribe((event) => allEvents.push(event));

    const capturedArgs: Record<string, Record<string, string>> = {};
    const stageCompletions: Array<{
      workflow: string;
      result: PipelineStageResult;
    }> = [];

    const runner = realisticStageRunner({
      planPath: "/workspace/plans/auth-feature.md",
      onStageRun: (workflow, args) => {
        capturedArgs[workflow] = { ...args };
      },
    });

    const pipeline = new WorkflowPipeline({
      stages: planPipelineStages(),
      args: { description: "implement OAuth2 login" },
      config: makeConfig(),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
      onStageComplete: async (workflow, result) => {
        stageCompletions.push({ workflow, result });
      },
    });

    const result = await pipeline.run();

    // 1. Pipeline completed
    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(3);
    expect(result.stagesTotal).toBe(3);

    // 2. Plan generated a planPath
    expect(result.stageResults[0].planPath).toBe(
      "/workspace/plans/auth-feature.md",
    );

    // 3. Work received the planPath
    expect(capturedArgs["work"].planPath).toBe(
      "/workspace/plans/auth-feature.md",
    );
    expect(capturedArgs["work"].description).toBe("implement OAuth2 login");

    // 4. Review received the accumulated context
    expect(capturedArgs["review"].planPath).toBe(
      "/workspace/plans/auth-feature.md",
    );

    // 5. onStageComplete called for each stage
    expect(stageCompletions).toHaveLength(3);
    expect(stageCompletions.map((c) => c.workflow)).toEqual([
      "plan",
      "work",
      "review",
    ]);

    // 6. Event sequence is correct
    const pipelineEvents = allEvents.filter((e) =>
      e.type.startsWith("pipeline:"),
    );
    const types = pipelineEvents.map((e) => e.type);
    expect(types).toEqual([
      "pipeline:started",
      "pipeline:stage-transition", // plan -> work
      "pipeline:stage-transition", // work -> review
      "pipeline:completed",
    ]);

    // 7. All pipeline events share the same pipelineId
    const pipelineIds = new Set(
      pipelineEvents.map((e) => (e as { pipelineId: string }).pipelineId),
    );
    expect(pipelineIds.size).toBe(1);
  });

  it("four-stage pipeline with ship: plan -> work -> review -> ship", async () => {
    const bus = new EventBus();
    const stagesRun: string[] = [];

    const runner: StageRunner = async (stage, args) => {
      stagesRun.push(stage.workflow);
      if (stage.workflow === "plan") {
        return {
          workflow: "plan",
          completed: true,
          planPath: "/plans/ship-test.md",
        };
      }
      return { workflow: stage.workflow, completed: true };
    };

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
        { workflow: "ship" },
      ],
      args: {},
      config: makeConfig({ auto_ship: true }),
      stageRunner: runner,
      questionService: new QuestionService(bus),
      eventBus: bus,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(4);
    expect(stagesRun).toEqual(["plan", "work", "review", "ship"]);
  });

  it("QuestionService auto-resolve mode skips gates automatically", async () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus, { autoResolve: true });
    const stagesRun: string[] = [];

    const runner = realisticStageRunner({
      onStageRun: (workflow) => stagesRun.push(workflow),
    });

    // All stages have gates, but auto-resolve should skip them all
    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan", gateBeforeNext: true },
        { workflow: "work", gateBeforeNext: true },
        { workflow: "review" },
      ],
      args: {},
      config: makeConfig(),
      stageRunner: runner,
      questionService,
      eventBus: bus,
    });

    const result = await pipeline.run();

    // All stages should run (auto-resolve picks first option = "Continue")
    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(3);
    expect(stagesRun).toEqual(["plan", "work", "review"]);
  });
});
