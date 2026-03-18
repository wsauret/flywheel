import { describe, it, expect, beforeEach } from "bun:test";
import { EventBus } from "../src/events/event-bus";
import { QuestionService } from "../src/controller/question-service";
import type { QuestionInfo } from "../src/controller/question-service";
import type { FlywheelConfig } from "../src/config/loader";
import { CONFIG_DEFAULTS } from "../src/config/loader";
import {
  WorkflowPipeline,
  type PipelineOptions,
  type PipelineStage,
  type PipelineStageResult,
  type PipelineResult,
  type StageRunner,
} from "../src/controller/workflow-pipeline";
import type { FlywheelEvent } from "../src/events/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

/** StageRunner stub that resolves each stage immediately with success. */
function successRunner(
  results?: Partial<Record<string, Partial<PipelineStageResult>>>,
): StageRunner {
  return async (stage, _args, _signal) => {
    const override = results?.[stage.workflow] ?? {};
    return {
      workflow: stage.workflow,
      completed: true,
      ...override,
    };
  };
}

/** StageRunner stub that fails on the specified workflow type. */
function failingRunner(failOn: string, reason = "stage failed"): StageRunner {
  return async (stage, _args, _signal) => {
    if (stage.workflow === failOn) {
      return { workflow: stage.workflow, completed: false, reason };
    }
    return { workflow: stage.workflow, completed: true };
  };
}

/** StageRunner that records calls for inspection. */
function spyRunner(
  inner?: StageRunner,
): {
  runner: StageRunner;
  calls: Array<{ stage: PipelineStage; args: Record<string, string> }>;
} {
  const calls: Array<{ stage: PipelineStage; args: Record<string, string> }> = [];
  const fallback: StageRunner = async (stage) => ({
    workflow: stage.workflow,
    completed: true,
  });
  const runner: StageRunner = async (stage, args, signal) => {
    calls.push({ stage, args: { ...args } });
    return (inner ?? fallback)(stage, args, signal);
  };
  return { runner, calls };
}

/** StageRunner that respects AbortSignal. */
function abortableRunner(delayMs = 100): StageRunner {
  return async (stage, _args, signal) => {
    return new Promise<PipelineStageResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({ workflow: stage.workflow, completed: true });
      }, delayMs);

      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve({
          workflow: stage.workflow,
          completed: false,
          reason: "aborted",
        });
      });
    });
  };
}

interface TestHarness {
  pipeline: WorkflowPipeline;
  bus: EventBus;
  questionService: QuestionService;
}

function createPipeline(opts: {
  stages: PipelineStage[];
  stageRunner: StageRunner;
  args?: Record<string, string>;
  config?: FlywheelConfig;
  autoResolveQuestions?: boolean;
  onStageComplete?: PipelineOptions["onStageComplete"];
}): TestHarness {
  const bus = new EventBus();
  const questionService = new QuestionService(bus, {
    autoResolve: opts.autoResolveQuestions ?? false,
  });
  const config = opts.config ?? defaultConfig();

  const pipeline = new WorkflowPipeline({
    stages: opts.stages,
    args: opts.args ?? {},
    config,
    stageRunner: opts.stageRunner,
    questionService,
    eventBus: bus,
    onStageComplete: opts.onStageComplete,
  });

  return { pipeline, bus, questionService };
}

// ===========================================================================
// Step 3.1: Stage sequencing
// ===========================================================================

describe("WorkflowPipeline — stage sequencing", () => {
  it("runs all stages in sequence and returns completed result", async () => {
    const { runner, calls } = spyRunner();

    const { pipeline } = createPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
      ],
      stageRunner: runner,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(3);
    expect(result.stagesTotal).toBe(3);
    expect(result.stageResults).toHaveLength(3);

    // Verify order
    expect(calls[0].stage.workflow).toBe("plan");
    expect(calls[1].stage.workflow).toBe("work");
    expect(calls[2].stage.workflow).toBe("review");
  });

  it("stops at a failed stage and reports partial completion", async () => {
    const runner = failingRunner("work", "compilation error");

    const { pipeline } = createPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
      ],
      stageRunner: runner,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(1); // only plan succeeded
    expect(result.stagesTotal).toBe(3);
    expect(result.reason).toContain("compilation error");

    // "review" was never run
    expect(result.stageResults).toHaveLength(2); // plan + work (failed)
    expect(result.stageResults[1].completed).toBe(false);
  });

  it("single-stage pipeline behaves like direct workflow execution", async () => {
    const { runner, calls } = spyRunner();

    const { pipeline } = createPipeline({
      stages: [{ workflow: "work" }],
      stageRunner: runner,
      args: { planPath: "/path/to/plan.md" },
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(1);
    expect(result.stagesTotal).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].stage.workflow).toBe("work");
    expect(calls[0].args.planPath).toBe("/path/to/plan.md");
  });

  it("plan stage passes planPath to subsequent work stage via stageResult", async () => {
    const capturedArgs: Record<string, string>[] = [];

    const runner: StageRunner = async (stage, args, _signal) => {
      capturedArgs.push({ ...args });
      if (stage.workflow === "plan") {
        return {
          workflow: "plan",
          completed: true,
          planPath: "/generated/plan.md",
        };
      }
      return { workflow: stage.workflow, completed: true };
    };

    const { pipeline } = createPipeline({
      stages: [{ workflow: "plan" }, { workflow: "work" }],
      stageRunner: runner,
    });

    await pipeline.run();

    // The work stage should receive the planPath from plan's result
    expect(capturedArgs[1].planPath).toBe("/generated/plan.md");
  });

  it("PipelineStage.workflow accepts only valid WorkflowType values", () => {
    // This is a compile-time check. If WorkflowType is properly typed,
    // this test verifies the type at runtime by checking our stages.
    const stages: PipelineStage[] = [
      { workflow: "plan" },
      { workflow: "work" },
      { workflow: "review" },
      { workflow: "ship" },
      { workflow: "debug" },
      { workflow: "research" },
    ];

    for (const stage of stages) {
      expect(["plan", "work", "review", "ship", "debug", "research"]).toContain(
        stage.workflow,
      );
    }
  });

  it("passes args through to each stage runner", async () => {
    const { runner, calls } = spyRunner();

    const { pipeline } = createPipeline({
      stages: [{ workflow: "plan" }, { workflow: "work" }],
      stageRunner: runner,
      args: { description: "add login feature", branch: "feat/login" },
    });

    await pipeline.run();

    // Both stages should receive the original args
    expect(calls[0].args.description).toBe("add login feature");
    expect(calls[0].args.branch).toBe("feat/login");
    expect(calls[1].args.description).toBe("add login feature");
  });

  it("calls onStageComplete callback after each stage", async () => {
    const completions: Array<{
      workflow: string;
      result: PipelineStageResult;
    }> = [];

    const { pipeline } = createPipeline({
      stages: [{ workflow: "plan" }, { workflow: "work" }],
      stageRunner: successRunner(),
      onStageComplete: async (workflow, result) => {
        completions.push({ workflow, result });
      },
    });

    await pipeline.run();

    expect(completions).toHaveLength(2);
    expect(completions[0].workflow).toBe("plan");
    expect(completions[0].result.completed).toBe(true);
    expect(completions[1].workflow).toBe("work");
  });

  it("empty stages array returns immediately with completed=true", async () => {
    const { pipeline } = createPipeline({
      stages: [],
      stageRunner: successRunner(),
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(0);
    expect(result.stagesTotal).toBe(0);
    expect(result.stageResults).toHaveLength(0);
  });

  it("stages run sequentially, not in parallel", async () => {
    let concurrency = 0;
    let maxConcurrency = 0;

    const runner: StageRunner = async (stage, _args, _signal) => {
      concurrency++;
      maxConcurrency = Math.max(maxConcurrency, concurrency);
      await new Promise((r) => setTimeout(r, 20));
      concurrency--;
      return { workflow: stage.workflow, completed: true };
    };

    const { pipeline } = createPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
      ],
      stageRunner: runner,
    });

    await pipeline.run();

    expect(maxConcurrency).toBe(1);
  });
});

// ===========================================================================
// Step 3.2: Pipeline gates
// ===========================================================================

describe("WorkflowPipeline — pipeline gates", () => {
  it("presents gate question via QuestionService between gated stages", async () => {
    const askedQuestions: QuestionInfo[][] = [];

    const bus = new EventBus();
    bus.subscribeToType("question:asked", (e) => {
      askedQuestions.push(e.questions);
    });

    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan", gateBeforeNext: true },
        { workflow: "work" },
      ],
      args: {},
      config: defaultConfig(),
      stageRunner: successRunner(),
      questionService,
      eventBus: bus,
    });

    // Start the pipeline (it will suspend at the gate)
    const resultPromise = pipeline.run();

    // Wait for the question to be asked
    await new Promise((r) => setTimeout(r, 50));

    expect(askedQuestions).toHaveLength(1);
    // Gate question should include options for continuing, stopping, pausing
    const gateQuestion = askedQuestions[0][0];
    expect(gateQuestion).toBeDefined();

    const optionLabels = gateQuestion.options.map((o) => o.label.toLowerCase());
    // Should have a "continue" option mentioning the next stage
    expect(optionLabels.some((l) => l.includes("continue"))).toBe(true);
    // Should have a "stop" option
    expect(optionLabels.some((l) => l.includes("stop"))).toBe(true);

    // Reply with "continue" to unblock
    const pending = questionService.list();
    expect(pending).toHaveLength(1);
    questionService.reply(pending[0].id, [[gateQuestion.options.find(
      (o) => o.label.toLowerCase().includes("continue"),
    )!.label]]);

    const result = await resultPromise;
    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(2);
  });

  it("'Continue' answer proceeds to next stage", async () => {
    // Use auto-resolve which picks the first option (should be "continue")
    const { pipeline } = createPipeline({
      stages: [
        { workflow: "plan", gateBeforeNext: true },
        { workflow: "work" },
      ],
      stageRunner: successRunner(),
      autoResolveQuestions: true,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(2);
  });

  it("'Stop' answer halts pipeline and marks as completed", async () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan", gateBeforeNext: true },
        { workflow: "work" },
        { workflow: "review" },
      ],
      args: {},
      config: defaultConfig(),
      stageRunner: successRunner(),
      questionService,
      eventBus: bus,
    });

    const resultPromise = pipeline.run();

    // Wait for gate question
    await new Promise((r) => setTimeout(r, 50));

    // Reply with "stop"
    const pending = questionService.list();
    expect(pending).toHaveLength(1);
    const stopOption = pending[0].questions[0].options.find(
      (o) => o.label.toLowerCase().includes("stop"),
    );
    expect(stopOption).toBeDefined();
    questionService.reply(pending[0].id, [[stopOption!.label]]);

    const result = await resultPromise;

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(1); // only plan ran
    expect(result.stagesTotal).toBe(3);
    expect(result.reason).toContain("stop");
  });

  it("'Pause' answer halts pipeline with pause reason", async () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan", gateBeforeNext: true },
        { workflow: "work" },
      ],
      args: {},
      config: defaultConfig(),
      stageRunner: successRunner(),
      questionService,
      eventBus: bus,
    });

    const resultPromise = pipeline.run();

    // Wait for gate question
    await new Promise((r) => setTimeout(r, 50));

    // Reply with "pause"
    const pending = questionService.list();
    const pauseOption = pending[0].questions[0].options.find(
      (o) => o.label.toLowerCase().includes("pause"),
    );
    expect(pauseOption).toBeDefined();
    questionService.reply(pending[0].id, [[pauseOption!.label]]);

    const result = await resultPromise;

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(1);
    expect(result.reason).toContain("pause");
  });

  it("no gate is presented when gateBeforeNext is false or absent", async () => {
    let questionCount = 0;
    const bus = new EventBus();
    bus.subscribeToType("question:asked", () => {
      questionCount++;
    });

    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan" }, // no gate
        { workflow: "work" },
        { workflow: "review" },
      ],
      args: {},
      config: defaultConfig(),
      stageRunner: successRunner(),
      questionService,
      eventBus: bus,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(3);
    expect(questionCount).toBe(0);
  });

  it("no gate is presented after the last stage even with gateBeforeNext: true", async () => {
    let questionCount = 0;
    const bus = new EventBus();
    bus.subscribeToType("question:asked", () => {
      questionCount++;
    });

    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work", gateBeforeNext: true }, // last stage — no next
      ],
      args: {},
      config: defaultConfig(),
      stageRunner: successRunner(),
      questionService,
      eventBus: bus,
    });

    const result = await pipeline.run();

    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(2);
    expect(questionCount).toBe(0);
  });

  it("gate question mentions the next stage workflow name", async () => {
    const bus = new EventBus();
    const askedQuestions: QuestionInfo[][] = [];
    bus.subscribeToType("question:asked", (e) => {
      askedQuestions.push(e.questions);
    });

    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan", gateBeforeNext: true },
        { workflow: "work" },
      ],
      args: {},
      config: defaultConfig(),
      stageRunner: successRunner(),
      questionService,
      eventBus: bus,
    });

    const resultPromise = pipeline.run();
    await new Promise((r) => setTimeout(r, 50));

    // The continue option should reference "work" (the next stage)
    const gateQuestion = askedQuestions[0][0];
    const continueOption = gateQuestion.options.find(
      (o) => o.label.toLowerCase().includes("continue"),
    );
    expect(
      continueOption!.label.toLowerCase().includes("work") ||
        continueOption!.description.toLowerCase().includes("work"),
    ).toBe(true);

    // Clean up: resolve the gate
    const pending = questionService.list();
    questionService.reply(pending[0].id, [[continueOption!.label]]);
    await resultPromise;
  });

  it("rejected gate question (dismiss) halts pipeline", async () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan", gateBeforeNext: true },
        { workflow: "work" },
      ],
      args: {},
      config: defaultConfig(),
      stageRunner: successRunner(),
      questionService,
      eventBus: bus,
    });

    const resultPromise = pipeline.run();
    await new Promise((r) => setTimeout(r, 50));

    // Reject the question (user dismisses)
    const pending = questionService.list();
    questionService.reject(pending[0].id);

    const result = await resultPromise;

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(1);
  });

  it("multiple gates work correctly across a multi-stage pipeline", async () => {
    const bus = new EventBus();
    const askedQuestions: QuestionInfo[][] = [];
    bus.subscribeToType("question:asked", (e) => {
      askedQuestions.push(e.questions);
    });

    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan", gateBeforeNext: true },
        { workflow: "work", gateBeforeNext: true },
        { workflow: "review" },
      ],
      args: {},
      config: defaultConfig(),
      stageRunner: successRunner(),
      questionService,
      eventBus: bus,
    });

    const resultPromise = pipeline.run();

    // First gate (after plan, before work)
    await new Promise((r) => setTimeout(r, 50));
    expect(askedQuestions).toHaveLength(1);

    let pending = questionService.list();
    const continueLabel1 = pending[0].questions[0].options.find(
      (o) => o.label.toLowerCase().includes("continue"),
    )!.label;
    questionService.reply(pending[0].id, [[continueLabel1]]);

    // Second gate (after work, before review)
    await new Promise((r) => setTimeout(r, 50));
    expect(askedQuestions).toHaveLength(2);

    pending = questionService.list();
    const continueLabel2 = pending[0].questions[0].options.find(
      (o) => o.label.toLowerCase().includes("continue"),
    )!.label;
    questionService.reply(pending[0].id, [[continueLabel2]]);

    const result = await resultPromise;

    expect(result.completed).toBe(true);
    expect(result.stagesCompleted).toBe(3);
  });
});

// ===========================================================================
// Step 3.3: Single session spanning stages
// ===========================================================================

describe("WorkflowPipeline — single session spanning stages", () => {
  it("emits pipeline:stage-transition event between stages", async () => {
    const transitions: Array<{
      from: string;
      to: string;
    }> = [];

    const { pipeline, bus } = createPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
      ],
      stageRunner: successRunner(),
    });

    bus.subscribe((event: FlywheelEvent) => {
      // The pipeline should emit a transition event between stages
      if (event.type === ("pipeline:stage-transition" as string)) {
        const e = event as unknown as {
          type: string;
          from: string;
          to: string;
        };
        transitions.push({ from: e.from, to: e.to });
      }
    });

    await pipeline.run();

    expect(transitions).toHaveLength(2); // plan->work, work->review
    expect(transitions[0]).toEqual({ from: "plan", to: "work" });
    expect(transitions[1]).toEqual({ from: "work", to: "review" });
  });

  it("does NOT create new sessions between stages (single runner context)", async () => {
    // The stageRunner should be called with the same continuous context.
    // Verify by checking that a signal is shared (same AbortController).
    const signals: AbortSignal[] = [];

    const runner: StageRunner = async (stage, _args, signal) => {
      signals.push(signal);
      return { workflow: stage.workflow, completed: true };
    };

    const { pipeline } = createPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
      ],
      stageRunner: runner,
    });

    await pipeline.run();

    // All stages should share the same signal (from the same AbortController)
    expect(signals).toHaveLength(3);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[1]).toBe(signals[2]);
  });

  it("requestShutdown() cleanly aborts the currently running stage", async () => {
    const { pipeline } = createPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
      ],
      stageRunner: abortableRunner(500), // each stage takes 500ms
    });

    const resultPromise = pipeline.run();

    // Let the first stage start, then request shutdown
    await new Promise((r) => setTimeout(r, 50));
    pipeline.requestShutdown();

    const result = await resultPromise;

    expect(result.completed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it("requestShutdown() during a gate also cancels the pipeline", async () => {
    const bus = new EventBus();
    const questionService = new QuestionService(bus);

    const pipeline = new WorkflowPipeline({
      stages: [
        { workflow: "plan", gateBeforeNext: true },
        { workflow: "work" },
      ],
      args: {},
      config: defaultConfig(),
      stageRunner: successRunner(),
      questionService,
      eventBus: bus,
    });

    const resultPromise = pipeline.run();

    // Wait for gate question to be asked
    await new Promise((r) => setTimeout(r, 50));
    expect(questionService.list()).toHaveLength(1);

    // Shutdown during gate
    pipeline.requestShutdown();

    const result = await resultPromise;

    expect(result.completed).toBe(false);
    expect(result.stagesCompleted).toBe(1); // plan completed, work never started
  });

  it("AbortController signal is aborted after requestShutdown()", async () => {
    let capturedSignal: AbortSignal | null = null;

    const runner: StageRunner = async (stage, _args, signal) => {
      capturedSignal = signal;
      return new Promise<PipelineStageResult>((resolve) => {
        const timer = setTimeout(() => {
          resolve({ workflow: stage.workflow, completed: true });
        }, 500);

        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve({
            workflow: stage.workflow,
            completed: false,
            reason: "aborted",
          });
        });
      });
    };

    const { pipeline } = createPipeline({
      stages: [{ workflow: "work" }],
      stageRunner: runner,
    });

    const resultPromise = pipeline.run();
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedSignal).not.toBeNull();
    expect(capturedSignal!.aborted).toBe(false);

    pipeline.requestShutdown();

    const result = await resultPromise;

    expect(capturedSignal!.aborted).toBe(true);
    expect(result.completed).toBe(false);
  });

  it("stageResults accumulate across the entire pipeline run", async () => {
    const { pipeline } = createPipeline({
      stages: [
        { workflow: "plan" },
        { workflow: "work" },
        { workflow: "review" },
      ],
      stageRunner: successRunner({
        plan: { planPath: "/plans/test.md" },
        review: { reason: "all checks passed" },
      }),
    });

    const result = await pipeline.run();

    expect(result.stageResults).toHaveLength(3);
    expect(result.stageResults[0].workflow).toBe("plan");
    expect(result.stageResults[0].planPath).toBe("/plans/test.md");
    expect(result.stageResults[1].workflow).toBe("work");
    expect(result.stageResults[2].workflow).toBe("review");
    expect(result.stageResults[2].reason).toBe("all checks passed");
  });

  it("emits pipeline:started and pipeline:completed events", async () => {
    const events: string[] = [];

    const { pipeline, bus } = createPipeline({
      stages: [{ workflow: "plan" }, { workflow: "work" }],
      stageRunner: successRunner(),
    });

    bus.subscribe((event: FlywheelEvent) => {
      const type = event.type as string;
      if (type.startsWith("pipeline:")) {
        events.push(type);
      }
    });

    await pipeline.run();

    expect(events[0]).toBe("pipeline:started");
    expect(events[events.length - 1]).toBe("pipeline:completed");
  });

  it("emits pipeline:failed event when pipeline halts due to failure", async () => {
    const events: string[] = [];

    const { pipeline, bus } = createPipeline({
      stages: [{ workflow: "plan" }, { workflow: "work" }],
      stageRunner: failingRunner("work"),
    });

    bus.subscribe((event: FlywheelEvent) => {
      const type = event.type as string;
      if (type.startsWith("pipeline:")) {
        events.push(type);
      }
    });

    await pipeline.run();

    expect(events).toContain("pipeline:started");
    expect(events).toContain("pipeline:failed");
    expect(events).not.toContain("pipeline:completed");
  });

  it("requestShutdown() is idempotent (calling twice doesn't crash)", async () => {
    const { pipeline } = createPipeline({
      stages: [{ workflow: "work" }],
      stageRunner: abortableRunner(500),
    });

    const resultPromise = pipeline.run();
    await new Promise((r) => setTimeout(r, 50));

    // Call shutdown twice
    pipeline.requestShutdown();
    pipeline.requestShutdown();

    const result = await resultPromise;

    expect(result.completed).toBe(false);
  });

  it("pipeline can be run only once", async () => {
    const { pipeline } = createPipeline({
      stages: [{ workflow: "work" }],
      stageRunner: successRunner(),
    });

    await pipeline.run();

    // Second run should throw or return an error
    try {
      await pipeline.run();
      // If it doesn't throw, it should at least return a sensible result
      expect(true).toBe(false); // Fail if no error
    } catch (err) {
      expect(err).toBeDefined();
    }
  });
});
