/**
 * Tests for evaluator activation in the execution loop.
 *
 * Validates that the evaluator is called after successful phase execution
 * when transport + criteria are available, and that it correctly handles
 * pass/fail/skip/timeout outcomes.
 */

import { describe, it, expect } from "bun:test";
import type { WorkerResult, WorkerFailureReason } from "../src/schemas/worker";
import type { ProcessSpawner, SpawnOptions, SpawnResult } from "../src/worker/spawner";
import type { FlywheelConfig } from "../src/config/loader";
import type { PhaseInfo } from "../src/controller/phase-provider";
import type { WorkflowStepContext } from "../src/prompts/index";
import type { DispatcherDecision } from "../src/schemas/dispatcher";
import type { DispatcherOrchestrator } from "../src/controller/dispatcher-orchestrator";
import type { EvaluatorTransport } from "../src/evaluator/transport";
import type { EvaluatorInput, EvaluatorResult } from "../src/schemas/evaluator";
import type { ValidationCriteria } from "../src/schemas/shared";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { MockAdapter } from "../src/tui/adapters/mock";
import { CONFIG_DEFAULTS } from "../src/config/loader";
import { PhaseExecutor } from "../src/controller/phase-executor";
import { ExecutionLoop } from "../src/controller/execution-loop";
import type { PromptBuilder } from "../src/controller/execution-loop";
import { claudeEngine } from "../src/engines/providers/claude/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function successResult(output: string = "<promise>COMPLETE</promise>"): WorkerResult {
  return {
    output,
    exitCode: 0,
    truncated: false,
    durationMs: 2000,
    failure: undefined,
  };
}

function failureResult(failure: WorkerFailureReason): WorkerResult {
  return {
    output: "",
    exitCode: 1,
    truncated: false,
    durationMs: 500,
    failure,
  };
}

function defaultConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

function makePhases(count: number, overrides?: (Partial<PhaseInfo> | null)[]): PhaseInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    title: `Phase ${i + 1}`,
    description: `Description for phase ${i + 1}`,
    status: "pending" as const,
    steps: [`Step ${i + 1}a`, `Step ${i + 1}b`],
    ...(overrides?.[i] ?? {}),
  }));
}

const testPromptBuilder: PromptBuilder = (phase: PhaseInfo, ctx: WorkflowStepContext) => {
  return `Phase ${phase.index + 1}: ${phase.title}`;
};

class SimplePhaseProvider {
  private _phases: PhaseInfo[];
  constructor(phases: PhaseInfo[]) {
    this._phases = phases;
  }
  getPhases(): PhaseInfo[] {
    return this._phases;
  }
  get phaseCount(): number {
    return this._phases.length;
  }
}

class MockSpawner implements ProcessSpawner {
  results: WorkerResult[] = [];
  calls: Array<{ command: string; args: string[]; options?: SpawnOptions }> = [];
  private callIndex = 0;

  async spawn(command: string, args: string[], options?: SpawnOptions): Promise<SpawnResult> {
    this.calls.push({ command, args, options });
    const result = this.results[this.callIndex] ?? successResult();
    this.callIndex++;
    return { result: Promise.resolve(result) };
  }
}

/** Valid evaluator result that passes */
function passingEvalResult(): EvaluatorResult {
  return {
    passed: true,
    reasoning: "All criteria met",
    suggestions: [],
    confidence: 0.95,
    feedback: "Good work",
    files_to_review: [],
  };
}

/** Evaluator result that fails */
function failingEvalResult(reason?: string): EvaluatorResult {
  return {
    passed: false,
    reasoning: reason ?? "Criteria not met — missing test coverage",
    suggestions: ["Add unit tests"],
    confidence: 0.85,
    feedback: "Needs improvement",
    files_to_review: ["src/index.ts"],
  };
}

/** Standard validation criteria for testing */
function validCriteria(): ValidationCriteria {
  return {
    acceptance_criteria: ["Tests pass", "No type errors"],
    required_tests: true,
    custom_checks: [],
    required_outputs: [],
  };
}

/** Creates a valid dispatcher decision with validation_criteria */
function validDecision(overrides?: Partial<DispatcherDecision>): DispatcherDecision {
  return {
    schema_version: 1,
    phase_index: 0,
    step_index: 0,
    task_content: "Dispatcher-crafted prompt for the worker",
    context_files: ["src/index.ts"],
    validation_criteria: validCriteria(),
    reasoning: "Standard execution",
    warnings: [],
    worker_config: {
      model_override: null,
      timeout_minutes: 30,
      retry_on_failure: true,
      max_retries: 3,
      iteration_budget: 5,
      tool_scoping: { read: true, bash: true, write: true, edit: true },
      parallel: false,
      parallel_variants: null,
    },
    ...overrides,
  };
}

/** Creates a mock DispatcherOrchestrator */
function mockDispatcherOrchestrator(decision: DispatcherDecision | null) {
  return {
    getPhaseDecision: async () => decision,
  } as unknown as DispatcherOrchestrator;
}

/** Creates a mock EvaluatorTransport */
function mockEvaluatorTransport(result: EvaluatorResult | Error): EvaluatorTransport {
  const calls: EvaluatorInput[] = [];
  return {
    invoke: async (input: EvaluatorInput) => {
      calls.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
    _calls: calls,
  } as EvaluatorTransport & { _calls: EvaluatorInput[] };
}

/** Creates a mock transport that tracks calls and allows checking */
function trackingEvaluatorTransport(result: EvaluatorResult): EvaluatorTransport & { calls: EvaluatorInput[] } {
  const calls: EvaluatorInput[] = [];
  return {
    calls,
    invoke: async (input: EvaluatorInput) => {
      calls.push(input);
      return result;
    },
  };
}

/** Creates an evaluator transport that times out */
function timeoutEvaluatorTransport(): EvaluatorTransport {
  return {
    invoke: async () => {
      // Simulate timeout — return a promise that never resolves
      return new Promise<EvaluatorResult>((_, reject) => {
        setTimeout(() => {
          const err = new Error("Evaluation timed out");
          err.name = "TimeoutError";
          reject(err);
        }, 10);
      });
    },
  };
}

/** Creates the full test setup with evaluator support */
function createEvaluatorTestLoop(opts: {
  phases?: PhaseInfo[];
  spawnerResults?: WorkerResult[];
  config?: Partial<FlywheelConfig>;
  evaluatorTransport?: EvaluatorTransport;
  decision?: DispatcherDecision | null;
  withDispatcher?: boolean;
}) {
  const bus = new EventBus();
  const emitter = createFlywheelEmitter(bus);
  const adapter = new MockAdapter();
  adapter.connect(bus);
  adapter.start();

  const spawner = new MockSpawner();
  if (opts.spawnerResults) spawner.results = opts.spawnerResults;

  const config = defaultConfig(opts.config);
  const executor = new PhaseExecutor({
    spawner,
    emitter,
    config,
    engine: claudeEngine,
    workflowId: "test-eval",
  });

  const phases = opts.phases ?? makePhases(1);
  const provider = new SimplePhaseProvider(phases);

  // Determine if dispatcher should be wired
  const useDispatcher = opts.withDispatcher !== false && (opts.decision !== undefined || opts.withDispatcher);

  const loop = new ExecutionLoop({
    phaseProvider: provider,
    promptBuilder: testPromptBuilder,
    executor,
    emitter,
    config,
    ui: adapter,
    workflowId: "test-eval",
    workflowLabel: "test-workflow",
    evaluatorTransport: opts.evaluatorTransport,
    ...(useDispatcher
      ? {
          dispatcherOrchestrator: mockDispatcherOrchestrator(opts.decision ?? null),
          planContent: "# Test plan",
        }
      : {}),
  });

  return { loop, bus, emitter, adapter, spawner, config };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Evaluator activation in execution loop", () => {
  describe("evaluator invocation when transport + criteria available", () => {
    it("calls the evaluator after successful phase execution when transport + decision.validation_criteria exist", async () => {
      const transport = trackingEvaluatorTransport(passingEvalResult());
      const decision = validDecision();

      const { loop } = createEvaluatorTestLoop({
        spawnerResults: [successResult("worker output here")],
        evaluatorTransport: transport,
        decision,
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0].worker_output).toBe("worker output here");
    });

    it("passes correct inputs to the evaluator transport", async () => {
      const transport = trackingEvaluatorTransport(passingEvalResult());
      const criteria = validCriteria();
      const decision = validDecision({
        validation_criteria: criteria,
        context_files: ["src/foo.ts", "src/bar.ts"],
      });

      const { loop } = createEvaluatorTestLoop({
        spawnerResults: [successResult("output text")],
        evaluatorTransport: transport,
        decision,
      });

      await loop.run();

      expect(transport.calls).toHaveLength(1);
      const input = transport.calls[0];
      expect(input.worker_output).toBe("output text");
      // validation_criteria is serialized to string
      expect(input.validation_criteria).toContain("Tests pass");
      expect(input.validation_criteria).toContain("No type errors");
      // context_files from the decision
      expect(input.context_files).toEqual(["src/foo.ts", "src/bar.ts"]);
      // duration_seconds derived from durationMs (2000ms = 2s)
      expect(input.duration_seconds).toBe(2);
      // tests_passed is null (not available from WorkerResult)
      expect(input.tests_passed).toBeNull();
      // artifacts_produced is empty array
      expect(input.artifacts_produced).toEqual([]);
    });
  });

  describe("evaluator NOT called when guards fail", () => {
    it("is NOT called when evaluatorTransport is undefined", async () => {
      const decision = validDecision();

      const { loop } = createEvaluatorTestLoop({
        spawnerResults: [successResult()],
        evaluatorTransport: undefined, // no transport
        decision,
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      // No evaluator call (we can only verify by checking events)
    });

    it("is NOT called when decision is null (no dispatcher)", async () => {
      const transport = trackingEvaluatorTransport(passingEvalResult());

      const { loop } = createEvaluatorTestLoop({
        spawnerResults: [successResult()],
        evaluatorTransport: transport,
        withDispatcher: false, // no dispatcher
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(transport.calls).toHaveLength(0);
    });

    it("is NOT called when dispatcher returns null decision", async () => {
      const transport = trackingEvaluatorTransport(passingEvalResult());

      const { loop } = createEvaluatorTestLoop({
        spawnerResults: [successResult()],
        evaluatorTransport: transport,
        decision: null, // dispatcher returned null
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(transport.calls).toHaveLength(0);
    });

    it("is NOT called when decision.validation_criteria is missing", async () => {
      const transport = trackingEvaluatorTransport(passingEvalResult());
      // Create decision without validation_criteria
      const decision = validDecision();
      // Override validation_criteria to be undefined
      (decision as any).validation_criteria = undefined;

      const { loop } = createEvaluatorTestLoop({
        spawnerResults: [successResult()],
        evaluatorTransport: transport,
        decision,
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(transport.calls).toHaveLength(0);
    });
  });

  describe("evaluator pass/fail outcomes", () => {
    it("phase proceeds when evaluator returns passed=true", async () => {
      const transport = trackingEvaluatorTransport(passingEvalResult());
      const decision = validDecision();

      const { loop } = createEvaluatorTestLoop({
        phases: makePhases(2),
        spawnerResults: [successResult(), successResult()],
        evaluatorTransport: transport,
        decision,
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
      // Evaluator called for each phase
      expect(transport.calls).toHaveLength(2);
    });

    it("phase fails when evaluator returns passed=false with correct reason", async () => {
      const evalResult = failingEvalResult("Worker did not implement all acceptance criteria");
      const transport = trackingEvaluatorTransport(evalResult);
      const decision = validDecision();

      const { loop, adapter } = createEvaluatorTestLoop({
        spawnerResults: [successResult()],
        evaluatorTransport: transport,
        decision,
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toContain("Worker did not implement all acceptance criteria");

      // Phase failed events should be emitted
      const phaseFailed = adapter.events.find((e) => e.type === "phase:failed");
      expect(phaseFailed).toBeDefined();

      // Workflow failed events should be emitted
      const workflowFailed = adapter.events.find((e) => e.type === "workflow:failed");
      expect(workflowFailed).toBeDefined();
    });

    it("phase proceeds when evaluator returns skipped=true (timeout graceful degradation)", async () => {
      // Use a transport that simulates timeout behavior
      const transport = timeoutEvaluatorTransport();

      const decision = validDecision();

      const { loop } = createEvaluatorTestLoop({
        spawnerResults: [successResult()],
        evaluatorTransport: transport,
        decision,
        config: { max_eval_cycles: 1 },
      });

      const result = await loop.run();

      // Phase should proceed (timeout = graceful degradation)
      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(1);
    });
  });

  describe("skip_evaluation config", () => {
    it("skip_evaluation config prevents evaluator invocation", async () => {
      const transport = trackingEvaluatorTransport(passingEvalResult());
      const decision = validDecision();

      const { loop } = createEvaluatorTestLoop({
        spawnerResults: [successResult()],
        evaluatorTransport: transport,
        decision,
        config: { skip_evaluation: true },
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      // When skip_evaluation is true, evaluatorTransport would be null in production.
      // But our test wires it directly. The Evaluator class's skipEvaluation flag handles this.
      // The execution loop should still skip when config says so.
      // Let's verify by checking invocations.
      expect(transport.calls).toHaveLength(0);
    });
  });

  describe("max_eval_cycles config", () => {
    it("max_eval_cycles config is passed through to Evaluator constructor", async () => {
      // Use an error-throwing evaluator that should retry up to max_eval_cycles times.
      // Valid passed:false returns immediately (no retry), so we use errors to test maxCycles.
      let invokeCount = 0;
      const transport: EvaluatorTransport = {
        invoke: async () => {
          invokeCount++;
          throw new Error("Schema parse error");
        },
      };

      const decision = validDecision();

      const { loop } = createEvaluatorTestLoop({
        spawnerResults: [successResult()],
        evaluatorTransport: transport,
        decision,
        config: { max_eval_cycles: 2 },
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      // Evaluator should have retried max_eval_cycles (2) times on errors
      expect(invokeCount).toBe(2);
    });
  });

  describe("event emission", () => {
    it("emits evaluator:invoked event when evaluator is called", async () => {
      const transport = trackingEvaluatorTransport(passingEvalResult());
      const decision = validDecision();

      const { loop, adapter } = createEvaluatorTestLoop({
        spawnerResults: [successResult()],
        evaluatorTransport: transport,
        decision,
      });

      await loop.run();

      const invokedEvents = adapter.events.filter((e) => e.type === "evaluator:invoked");
      expect(invokedEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("emits evaluator:completed event when evaluator passes", async () => {
      const transport = trackingEvaluatorTransport(passingEvalResult());
      const decision = validDecision();

      const { loop, adapter } = createEvaluatorTestLoop({
        spawnerResults: [successResult()],
        evaluatorTransport: transport,
        decision,
      });

      await loop.run();

      const completedEvents = adapter.events.filter((e) => e.type === "evaluator:completed");
      expect(completedEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("emits evaluator:failed event on timeout", async () => {
      const transport = timeoutEvaluatorTransport();
      const decision = validDecision();

      const { loop, adapter } = createEvaluatorTestLoop({
        spawnerResults: [successResult()],
        evaluatorTransport: transport,
        decision,
        config: { max_eval_cycles: 1 },
      });

      await loop.run();

      const failedEvents = adapter.events.filter((e) => e.type === "evaluator:failed");
      expect(failedEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("does NOT emit evaluator events when evaluator is not configured", async () => {
      const { loop, adapter } = createEvaluatorTestLoop({
        spawnerResults: [successResult()],
        evaluatorTransport: undefined,
        withDispatcher: false,
      });

      await loop.run();

      const evalEvents = adapter.events.filter((e) =>
        e.type === "evaluator:invoked" || e.type === "evaluator:completed" || e.type === "evaluator:failed",
      );
      expect(evalEvents).toHaveLength(0);
    });
  });

  describe("existing flow unchanged without evaluator", () => {
    it("phase execution flow is unchanged when evaluator is not configured", async () => {
      const { loop, spawner } = createEvaluatorTestLoop({
        phases: makePhases(2),
        spawnerResults: [successResult(), successResult()],
        evaluatorTransport: undefined,
        withDispatcher: false,
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
      expect(spawner.calls).toHaveLength(2);
    });

    it("phase execution flow is unchanged when dispatcher is configured but returns null", async () => {
      const transport = trackingEvaluatorTransport(passingEvalResult());

      const { loop, spawner } = createEvaluatorTestLoop({
        phases: makePhases(2),
        spawnerResults: [successResult(), successResult()],
        evaluatorTransport: transport,
        decision: null, // dispatcher returns null
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
      expect(transport.calls).toHaveLength(0);
    });

    it("worker failure still handled correctly when evaluator is configured", async () => {
      const transport = trackingEvaluatorTransport(passingEvalResult());
      const decision = validDecision();

      const { loop, adapter } = createEvaluatorTestLoop({
        spawnerResults: [failureResult({ kind: "exit_code", exitCode: 1, message: "Worker crashed" })],
        evaluatorTransport: transport,
        decision,
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toContain("Worker crashed");
      // Evaluator should NOT be called when the phase execution itself fails
      expect(transport.calls).toHaveLength(0);
    });
  });
});
