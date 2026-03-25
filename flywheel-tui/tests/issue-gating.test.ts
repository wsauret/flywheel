/**
 * Issue Gating Tests — verifies that evaluator structured issues are wired
 * into the execution loop for deterministic gating.
 *
 * Covers:
 * - VAL-GATE-001: Blocking issues halt pipeline
 * - VAL-GATE-002: Blocking issues surface via approval gate
 * - VAL-GATE-003: Non-blocking issues accumulate in stage context
 * - VAL-GATE-004: No issues means normal continuation
 * - VAL-GATE-005: Issue gating independent of pass/fail
 * - VAL-CROSS-001: Handoff-to-evaluator-to-dispatcher chain
 * - VAL-CROSS-002: Issue gating to approval gate chain
 * - VAL-CROSS-005: Stage context feeds evaluator
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { WorkerResult, WorkerFailureReason } from "../src/schemas/worker";
import type { ProcessSpawner, SpawnOptions, SpawnResult } from "../src/worker/spawner";
import type { FlywheelConfig } from "../src/config/loader";
import type { PhaseInfo } from "../src/controller/phase-provider";
import type { WorkflowStepContext } from "../src/prompts/index";
import type { ApprovalHandler } from "../src/controller/approval-handler";
import type { EvaluatorTransport } from "../src/evaluator/transport";
import type { EvaluatorInput, EvaluatorResult } from "../src/schemas/evaluator";
import type { EvaluatorIssue } from "../src/schemas/handoff";
import type { DispatcherDecision } from "../src/schemas/dispatcher";
import type { DispatcherOrchestrator, PhasePromptOptions } from "../src/controller/dispatcher-orchestrator";
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

const TMP_DIR = path.join(os.tmpdir(), `flywheel-issue-gating-test-${process.pid}-${Date.now()}`);

function ensureTmpDir(): string {
  const dir = path.join(TMP_DIR, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function successResult(output: string = "COMPLETE"): WorkerResult {
  return {
    output,
    exitCode: 0,
    truncated: false,
    durationMs: 1000,
    failure: undefined,
    handoffPath: "",
  };
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

  reset(): void {
    this.calls = [];
    this.callIndex = 0;
  }
}

function defaultConfig(overrides?: Partial<FlywheelConfig>): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

const testPromptBuilder: PromptBuilder = (phase: PhaseInfo, ctx: WorkflowStepContext) => {
  return `Phase ${phase.index + 1}: ${phase.title}`;
};

class SimplePhaseProvider {
  private _phases: PhaseInfo[];
  constructor(phases: PhaseInfo[]) { this._phases = phases; }
  getPhases(): PhaseInfo[] { return this._phases; }
  get phaseCount(): number { return this._phases.length; }
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

/**
 * Mock EvaluatorTransport that returns configurable results.
 */
class MockEvaluatorTransport implements EvaluatorTransport {
  results: EvaluatorResult[] = [];
  calls: EvaluatorInput[] = [];
  private callIndex = 0;
  /** If set, will throw on invoke instead of returning a result */
  throwError?: Error;

  async invoke(input: EvaluatorInput): Promise<EvaluatorResult> {
    this.calls.push(input);
    if (this.throwError) {
      throw this.throwError;
    }
    const result = this.results[this.callIndex] ?? passedResult();
    this.callIndex++;
    return result;
  }
}

function passedResult(overrides?: Partial<EvaluatorResult>): EvaluatorResult {
  return {
    passed: true,
    reasoning: "All good",
    confidence: 0.95,
    feedback: "Looks great",
    files_to_review: [],
    suggestions: [],
    issues: [],
    ...overrides,
  };
}

function failedResult(overrides?: Partial<EvaluatorResult>): EvaluatorResult {
  return {
    passed: false,
    reasoning: "Tests failed",
    confidence: 0.8,
    feedback: "Fix the tests",
    files_to_review: [],
    suggestions: ["Run the tests"],
    issues: [],
    ...overrides,
  };
}

function blockingIssue(description: string): EvaluatorIssue {
  return {
    description,
    severity: "blocking",
    category: "test_failure",
  };
}

function nonBlockingIssue(description: string): EvaluatorIssue {
  return {
    description,
    severity: "non_blocking",
    category: "incomplete",
  };
}

/** Mock approval handler that records calls and returns configurable results */
class MockApprovalHandler implements ApprovalHandler {
  approvalCalls: Array<{ phaseIndex: number; title: string }> = [];
  issueApprovalCalls: Array<{ phaseIndex: number; title: string; issues: EvaluatorIssue[] }> = [];
  private _skipRemainingGates = false;
  /** What to return from requestApproval */
  approvalResult = true;
  /** What to return from requestIssueApproval */
  issueApprovalResult = true;

  get skipRemainingGates(): boolean { return this._skipRemainingGates; }

  async requestApproval(phaseIndex: number, title: string): Promise<boolean> {
    this.approvalCalls.push({ phaseIndex, title });
    return this.approvalResult;
  }

  async requestIssueApproval(phaseIndex: number, title: string, issues: EvaluatorIssue[]): Promise<boolean> {
    this.issueApprovalCalls.push({ phaseIndex, title, issues });
    return this.issueApprovalResult;
  }
}

/** Mock DispatcherOrchestrator that returns a valid decision with validation_criteria */
function mockDispatcherOrchestrator(decisionOverrides?: Partial<DispatcherDecision>) {
  return {
    getPhaseDecision: async (): Promise<DispatcherDecision | null> => ({
      schema_version: 1,
      phase_index: 0,
      task_content: "Do the work",
      context_files: [],
      validation_criteria: {
        acceptance_criteria: ["Tests pass"],
        required_tests: true,
        custom_checks: [],
        required_outputs: [],
      },
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
      ...decisionOverrides,
    }),
  } as unknown as DispatcherOrchestrator;
}

/** Creates a loop with evaluator and approval handler for issue gating tests */
function createIssueGatingLoop(opts: {
  phases?: PhaseInfo[];
  spawnerResults?: WorkerResult[];
  evalResults?: EvaluatorResult[];
  evalError?: Error;
  approvalHandler?: MockApprovalHandler;
  config?: Partial<FlywheelConfig>;
  dispatcherOverrides?: Partial<DispatcherDecision>;
}) {
  const bus = new EventBus();
  const emitter = createFlywheelEmitter(bus);
  const adapter = new MockAdapter();
  adapter.connect(bus);
  adapter.start();

  const spawner = new MockSpawner();
  if (opts.spawnerResults) spawner.results = opts.spawnerResults;
  else spawner.results = [successResult()];

  const config = defaultConfig(opts.config);
  const executor = new PhaseExecutor({
    spawner,
    emitter,
    config,
    engine: claudeEngine,
    workflowId: "test-issue-gating",
  });

  const evalTransport = new MockEvaluatorTransport();
  if (opts.evalResults) evalTransport.results = opts.evalResults;
  if (opts.evalError) evalTransport.throwError = opts.evalError;

  const phases = opts.phases ?? makePhases(1);
  const provider = new SimplePhaseProvider(phases);
  const approvalHandler = opts.approvalHandler ?? new MockApprovalHandler();

  const loop = new ExecutionLoop({
    phaseProvider: provider,
    promptBuilder: testPromptBuilder,
    executor,
    emitter,
    config,
    ui: adapter,
    workflowId: "test-issue-gating",
    workflowLabel: "test",
    evaluatorTransport: evalTransport,
    dispatcherOrchestrator: mockDispatcherOrchestrator(opts.dispatcherOverrides),
    planContent: "# Test Plan",
    approvalHandler,
  });

  return { loop, bus, emitter, adapter, spawner, evalTransport, approvalHandler };
}

afterEach(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch { /* may not exist */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Issue Gating in Execution Loop", () => {

  // VAL-GATE-004: No issues means normal continuation
  describe("no issues — normal continuation", () => {
    it("continues normally when evaluator returns passed:true with empty issues", async () => {
      const { loop } = createIssueGatingLoop({
        phases: makePhases(2),
        spawnerResults: [successResult(), successResult()],
        evalResults: [passedResult({ issues: [] }), passedResult({ issues: [] })],
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
    });

    it("continues normally when evaluator returns passed:true with undefined issues (backward compat)", async () => {
      // Simulate older evaluator that doesn't return issues field
      const { loop } = createIssueGatingLoop({
        evalResults: [passedResult({ issues: undefined as any })],
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(1);
    });
  });

  // VAL-GATE-001: Blocking issues halt pipeline
  describe("blocking issues halt pipeline", () => {
    it("halts pipeline when evaluator returns blocking issues even with passed:true", async () => {
      const approvalHandler = new MockApprovalHandler();
      approvalHandler.issueApprovalResult = false; // user rejects

      const { loop } = createIssueGatingLoop({
        phases: makePhases(2),
        spawnerResults: [successResult(), successResult()],
        evalResults: [
          passedResult({
            issues: [blockingIssue("Tests are failing in CI")],
          }),
        ],
        approvalHandler,
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.phasesCompleted).toBe(0);
      expect(result.reason).toContain("blocking");
    });

    it("halts after current phase, does not proceed to next", async () => {
      const approvalHandler = new MockApprovalHandler();
      approvalHandler.issueApprovalResult = false;

      const { loop, spawner } = createIssueGatingLoop({
        phases: makePhases(3),
        spawnerResults: [successResult(), successResult(), successResult()],
        evalResults: [
          passedResult({
            issues: [blockingIssue("Security vulnerability found")],
          }),
        ],
        approvalHandler,
      });

      const result = await loop.run();

      // Only first phase was executed
      expect(spawner.calls).toHaveLength(1);
      expect(result.phasesCompleted).toBe(0);
    });
  });

  // VAL-GATE-002: Blocking issues surface via approval gate
  describe("blocking issues surface via approval gate", () => {
    it("calls requestIssueApproval with blocking issues", async () => {
      const approvalHandler = new MockApprovalHandler();
      approvalHandler.issueApprovalResult = true; // user approves

      const blockingIssues = [
        blockingIssue("Test suite has 3 failures"),
        blockingIssue("TypeScript errors in src/auth.ts"),
      ];

      const { loop } = createIssueGatingLoop({
        evalResults: [
          passedResult({ issues: [...blockingIssues, nonBlockingIssue("Minor style issue")] }),
        ],
        approvalHandler,
      });

      await loop.run();

      // The approval handler should have received the blocking issues
      expect(approvalHandler.issueApprovalCalls).toHaveLength(1);
      const call = approvalHandler.issueApprovalCalls[0];
      expect(call.issues).toHaveLength(2);
      expect(call.issues[0].description).toBe("Test suite has 3 failures");
      expect(call.issues[1].description).toBe("TypeScript errors in src/auth.ts");
    });

    it("continues pipeline when user approves blocking issues", async () => {
      const approvalHandler = new MockApprovalHandler();
      approvalHandler.issueApprovalResult = true;

      const { loop } = createIssueGatingLoop({
        phases: makePhases(2),
        spawnerResults: [successResult(), successResult()],
        evalResults: [
          passedResult({ issues: [blockingIssue("Known flaky test")] }),
          passedResult({ issues: [] }),
        ],
        approvalHandler,
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
    });

    it("halts pipeline when user rejects blocking issues", async () => {
      const approvalHandler = new MockApprovalHandler();
      approvalHandler.issueApprovalResult = false;

      const { loop } = createIssueGatingLoop({
        evalResults: [
          passedResult({ issues: [blockingIssue("Critical security issue")] }),
        ],
        approvalHandler,
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toContain("blocking");
    });
  });

  // VAL-GATE-003: Non-blocking issues accumulate in stage context
  describe("non-blocking issues accumulate in stage context", () => {
    it("appends non-blocking issues to stage context cumulative_issues", async () => {
      const { loop } = createIssueGatingLoop({
        phases: makePhases(2),
        spawnerResults: [successResult(), successResult()],
        evalResults: [
          passedResult({
            issues: [
              nonBlockingIssue("Could improve error handling"),
              nonBlockingIssue("Missing edge case test"),
            ],
          }),
          passedResult({
            issues: [nonBlockingIssue("Unused import in utils.ts")],
          }),
        ],
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      const ctx = loop.getStageContext();
      expect(ctx.cumulative_issues.length).toBeGreaterThanOrEqual(2);
      // Phase 1 should have 2 issues
      const phase1Issues = ctx.cumulative_issues.find(i => i.phase_index === 0);
      expect(phase1Issues).toBeDefined();
      expect(phase1Issues!.issues.length).toBe(2);
      expect(phase1Issues!.issues[0]).toContain("Could improve error handling");
      // Phase 2 should have 1 issue
      const phase2Issues = ctx.cumulative_issues.find(i => i.phase_index === 1);
      expect(phase2Issues).toBeDefined();
      expect(phase2Issues!.issues.length).toBe(1);
    });

    it("pipeline continues normally with only non-blocking issues", async () => {
      const { loop, spawner } = createIssueGatingLoop({
        phases: makePhases(3),
        spawnerResults: [successResult(), successResult(), successResult()],
        evalResults: [
          passedResult({ issues: [nonBlockingIssue("Minor issue 1")] }),
          passedResult({ issues: [nonBlockingIssue("Minor issue 2")] }),
          passedResult({ issues: [nonBlockingIssue("Minor issue 3")] }),
        ],
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(3);
      expect(spawner.calls).toHaveLength(3);
    });
  });

  // VAL-GATE-005: Issue gating independent of pass/fail
  describe("issue gating independent of pass/fail", () => {
    it("passed:true + blocking issues still halts pipeline", async () => {
      const approvalHandler = new MockApprovalHandler();
      approvalHandler.issueApprovalResult = false;

      const { loop } = createIssueGatingLoop({
        evalResults: [
          passedResult({
            passed: true,
            issues: [blockingIssue("Despite passing, this is blocking")],
          }),
        ],
        approvalHandler,
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(approvalHandler.issueApprovalCalls).toHaveLength(1);
    });

    it("passed:false triggers revision loop, blocking issues checked only on pass", async () => {
      // When evaluation fails (passed:false), revision loop kicks in (existing behavior)
      // Issue gating only fires AFTER evaluation passes (or revision loop exhausted)
      const { loop } = createIssueGatingLoop({
        evalResults: [
          failedResult({
            issues: [blockingIssue("Test failures")],
          }),
        ],
        config: { max_revisions: 0 }, // no revisions, immediate failure
      });

      const result = await loop.run();

      // Should fail due to evaluation failure, not issue gating
      expect(result.completed).toBe(false);
      expect(result.reason).toContain("Evaluation failed");
    });

    it("mixed blocking and non-blocking: blocking triggers gate, non-blocking accumulate", async () => {
      const approvalHandler = new MockApprovalHandler();
      approvalHandler.issueApprovalResult = true; // approve to continue

      const { loop } = createIssueGatingLoop({
        evalResults: [
          passedResult({
            issues: [
              blockingIssue("Blocking: security vulnerability"),
              nonBlockingIssue("Non-blocking: unused variable"),
            ],
          }),
        ],
        approvalHandler,
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      // Blocking issues triggered the approval gate
      expect(approvalHandler.issueApprovalCalls).toHaveLength(1);
      expect(approvalHandler.issueApprovalCalls[0].issues).toHaveLength(1);
      expect(approvalHandler.issueApprovalCalls[0].issues[0].severity).toBe("blocking");
      // Non-blocking issues accumulated in context
      const ctx = loop.getStageContext();
      const phaseIssues = ctx.cumulative_issues.find(i => i.phase_index === 0);
      expect(phaseIssues).toBeDefined();
      expect(phaseIssues!.issues).toContain("Non-blocking: unused variable");
    });
  });

  // Evaluator transport failure — graceful degradation
  describe("evaluator transport failure — graceful degradation", () => {
    it("continues execution when evaluator transport throws an error", async () => {
      const { loop } = createIssueGatingLoop({
        evalError: new Error("Transport connection failed"),
      });

      const result = await loop.run();

      // Should continue — evaluator failures are non-fatal
      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(1);
    });

    it("continues execution when evaluator transport times out", async () => {
      const timeoutErr = new Error("Evaluation timed out");
      timeoutErr.name = "TimeoutError";

      const { loop } = createIssueGatingLoop({
        evalError: timeoutErr,
      });

      const result = await loop.run();

      // Should continue — timeout is treated as skip
      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(1);
    });
  });

  // VAL-CROSS-005: Stage context feeds evaluator
  describe("stage context feeds evaluator", () => {
    it("evaluator for phase N receives cumulative stage context from prior phases", async () => {
      const evalTransport = new MockEvaluatorTransport();
      evalTransport.results = [
        passedResult({ issues: [nonBlockingIssue("Issue from phase 1")] }),
        passedResult({ issues: [] }),
      ];

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult(), successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner,
        emitter,
        config,
        engine: claudeEngine,
        workflowId: "test-ctx-eval",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(2)),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-ctx-eval",
        workflowLabel: "test",
        evaluatorTransport: evalTransport,
        dispatcherOrchestrator: mockDispatcherOrchestrator(),
        planContent: "# Test Plan",
      });

      await loop.run();

      // Second evaluator call should have received stage_context
      expect(evalTransport.calls.length).toBe(2);
      const secondCall = evalTransport.calls[1];
      expect(secondCall.stage_context).toBeDefined();
      expect(secondCall.stage_context!.phase_count).toBeGreaterThanOrEqual(1);
    });

    it("first phase evaluator gets no stage context (empty or undefined)", async () => {
      const evalTransport = new MockEvaluatorTransport();
      evalTransport.results = [passedResult()];

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner,
        emitter,
        config,
        engine: claudeEngine,
        workflowId: "test-first-eval",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(1)),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-first-eval",
        workflowLabel: "test",
        evaluatorTransport: evalTransport,
        dispatcherOrchestrator: mockDispatcherOrchestrator(),
        planContent: "# Test Plan",
      });

      await loop.run();

      // First evaluator call — no prior phases, so no stage context
      expect(evalTransport.calls.length).toBe(1);
      const firstCall = evalTransport.calls[0];
      // stage_context should be undefined or have phase_count === 0
      if (firstCall.stage_context) {
        expect(firstCall.stage_context.phase_count).toBe(0);
      }
    });
  });

  // VAL-CROSS-001: Handoff-to-evaluator-to-dispatcher chain  
  describe("cross-role chain: handoff → evaluator → stage context → dispatcher", () => {
    it("non-blocking issues from evaluator flow into stage context for next dispatcher", async () => {
      let capturedStageContext: any;

      const mockDispatcher = {
        getPhaseDecision: async (
          _phase: any,
          _planContent: string,
          _stateContent: string,
          _contextContent: string | undefined,
          _previousResult: string | undefined,
          extra: any,
        ): Promise<DispatcherDecision | null> => {
          capturedStageContext = extra.stageContext;
          return {
            schema_version: 1,
            phase_index: 0,
            task_content: "Do the work",
            context_files: [],
            validation_criteria: {
              acceptance_criteria: ["Tests pass"],
              required_tests: true,
              custom_checks: [],
              required_outputs: [],
            },
            reasoning: "",
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
          };
        },
      } as unknown as DispatcherOrchestrator;

      const evalTransport = new MockEvaluatorTransport();
      evalTransport.results = [
        passedResult({ issues: [nonBlockingIssue("Non-blocking issue from phase 1")] }),
        passedResult({ issues: [] }),
      ];

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult(), successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner,
        emitter,
        config,
        engine: claudeEngine,
        workflowId: "test-cross-chain",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(2)),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-cross-chain",
        workflowLabel: "test",
        evaluatorTransport: evalTransport,
        dispatcherOrchestrator: mockDispatcher,
        planContent: "# Test Plan",
      });

      await loop.run();

      // The second dispatcher call should have received stage context with issues from phase 1
      expect(capturedStageContext).toBeDefined();
      expect(capturedStageContext.cumulative_issues.length).toBeGreaterThanOrEqual(1);
      expect(capturedStageContext.cumulative_issues[0].issues).toContain(
        "Non-blocking issue from phase 1",
      );
    });
  });

  // Approval gate is not invoked when no approval handler is present  
  describe("no approval handler — blocking issues halt without gate", () => {
    it("halts pipeline with blocking issues even without approval handler", async () => {
      const evalTransport = new MockEvaluatorTransport();
      evalTransport.results = [
        passedResult({ issues: [blockingIssue("Critical issue")] }),
      ];

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner,
        emitter,
        config,
        engine: claudeEngine,
        workflowId: "test-no-handler",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(1)),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-no-handler",
        workflowLabel: "test",
        evaluatorTransport: evalTransport,
        dispatcherOrchestrator: mockDispatcherOrchestrator(),
        planContent: "# Test Plan",
        // No approvalHandler
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toContain("blocking");
    });
  });
});
