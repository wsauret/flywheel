import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { WorkerResult, WorkerFailureReason } from "../src/schemas/worker";
import type { ProcessSpawner, SpawnOptions, SpawnResult } from "../src/worker/spawner";
import type { FlywheelEvent } from "../src/events/types";
import type { FlywheelConfig } from "../src/config/loader";
import type { PhaseInfo } from "../src/controller/phase-provider";
import type { WorkflowStepContext } from "../src/prompts/index";
import type { StatePersistence } from "../src/controller/state-persistence";
import type { ApprovalHandler } from "../src/controller/approval-handler";
import type { ParsedStateFile } from "../src/state/reader";
import type { BudgetTracker } from "../src/session/budget-tracker";
import type { BudgetLimits, SessionBudgetStatus } from "../src/schemas/shared";
import type { DispatcherDecision } from "../src/schemas/dispatcher";
import type { DispatcherOrchestrator, PhasePromptOptions } from "../src/controller/dispatcher-orchestrator";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { MockAdapter } from "../src/tui/adapters/mock";
import { CONFIG_DEFAULTS } from "../src/config/loader";
import { PhaseExecutor, WorkerError } from "../src/controller/phase-executor";
import { ExecutionLoop } from "../src/controller/execution-loop";
import type { PromptBuilder, UnifiedExecutionLoopOptions } from "../src/controller/execution-loop";
import { PlanFileProvider } from "../src/controller/plan-file-provider";
import { WorkflowDefinitionProvider } from "../src/controller/workflow-def-provider";
import { FileStatePersistence } from "../src/controller/file-state-persistence";
import { UIApprovalHandler } from "../src/controller/ui-approval-handler";
import { claudeEngine } from "../src/engines/providers/claude/index";
import { parseStateFile } from "../src/state/reader";
import { lockPathFor } from "../src/state/lock";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");
const TMP_DIR = path.join(os.tmpdir(), `flywheel-unified-test-${process.pid}-${Date.now()}`);

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

function ensureTmpDir(): string {
  const dir = path.join(TMP_DIR, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function successResult(output: string = "<promise>COMPLETE</promise>"): WorkerResult {
  return {
    output,
    exitCode: 0,
    truncated: false,
    durationMs: 1000,
    failure: undefined,
    handoffPath: "",
  };
}

function failureResult(failure: WorkerFailureReason): WorkerResult {
  return {
    output: "",
    exitCode: 1,
    truncated: false,
    durationMs: 500,
    failure,
    handoffPath: "",
  };
}

/** Non-retryable failure for testing. */
function nonRetryableError(message: string): WorkerFailureReason {
  return { kind: "exit_code", exitCode: 1, message };
}

/** Retryable failure for testing. */
function retryableError(message: string): WorkerFailureReason {
  return { kind: "timeout", message, timeoutMs: 60000 };
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

/** Simple prompt builder for testing. */
const testPromptBuilder: PromptBuilder = (phase: PhaseInfo, ctx: WorkflowStepContext) => {
  const parts = [`Phase ${phase.index + 1}: ${phase.title}`];
  if (ctx.previousResult) parts.push(`Previous: ${ctx.previousResult}`);
  return parts.join("\n");
};

/** Creates a simple PhaseProvider from a list of phases. */
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
 * Mock BudgetTracker for testing budget enforcement in the execution loop.
 * Lets tests control `isExhausted()` return value and verify `incrementInvocations()` calls.
 */
class MockBudgetTracker implements BudgetTracker {
  exhausted = false;
  invocations = 0;
  tokens = 0;
  cost = 0;
  private _limits: BudgetLimits = { max_invocations: 0, max_tokens: null, wall_clock_deadline: null };

  handleEvent(): void { /* no-op */ }
  getTotalCost(): number { return this.cost; }
  getInvocationsUsed(): number { return this.invocations; }
  getTokensUsed(): number { return this.tokens; }

  incrementInvocations(): void {
    this.invocations += 1;
  }

  isExhausted(_budgetLimits: BudgetLimits): boolean {
    return this.exhausted;
  }

  getBudgetStatus(budgetLimits: BudgetLimits): SessionBudgetStatus {
    const invocationsRemaining = budgetLimits.max_invocations > 0
      ? Math.max(0, budgetLimits.max_invocations - this.invocations)
      : null;
    const tokenBudgetRemaining = budgetLimits.max_tokens !== null
      ? Math.max(0, budgetLimits.max_tokens - this.tokens)
      : null;
    return {
      invocations_remaining: invocationsRemaining,
      token_budget_remaining: tokenBudgetRemaining,
      wall_clock_deadline: budgetLimits.wall_clock_deadline,
    };
  }

  flush(): void { /* no-op */ }
  dispose(): void { /* no-op */ }
}

function createUnifiedLoop(opts: {
  phases?: PhaseInfo[];
  spawnerResults?: WorkerResult[];
  config?: Partial<FlywheelConfig>;
  statePersistence?: StatePersistence;
  approvalHandler?: ApprovalHandler;
  keyDecisions?: string[];
  fileReferences?: string[];
  budgetTracker?: BudgetTracker;
  budgetLimits?: BudgetLimits;
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
    workflowId: "test-wf",
  });

  const phases = opts.phases ?? makePhases(2);
  const provider = new SimplePhaseProvider(phases);

  const loop = new ExecutionLoop({
    phaseProvider: provider,
    promptBuilder: testPromptBuilder,
    executor,
    emitter,
    config,
    ui: adapter,
    workflowId: "test-wf",
    workflowLabel: "test-workflow",
    statePersistence: opts.statePersistence,
    approvalHandler: opts.approvalHandler,
    keyDecisions: opts.keyDecisions,
    fileReferences: opts.fileReferences,
    budgetTracker: opts.budgetTracker,
    budgetLimits: opts.budgetLimits,
  });

  return { loop, bus, emitter, adapter, spawner, config };
}

afterEach(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExecutionLoop (unified)", () => {
  describe("basic execution", () => {
    it("runs pending phases from PhaseProvider", async () => {
      const { loop, adapter } = createUnifiedLoop({
        spawnerResults: [successResult(), successResult()],
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
      expect(result.phasesTotal).toBe(2);
    });

    it("emits workflow:started and workflow:completed", async () => {
      const { loop, adapter } = createUnifiedLoop({
        spawnerResults: [successResult(), successResult()],
      });

      await loop.run();

      const started = adapter.events.find((e) => e.type === "workflow:started");
      const completed = adapter.events.find((e) => e.type === "workflow:completed");

      expect(started).toBeDefined();
      expect(completed).toBeDefined();
    });

    it("returns empty result for provider with no phases", async () => {
      const { loop } = createUnifiedLoop({
        phases: [],
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.phasesTotal).toBe(0);
      expect(result.reason).toContain("No phases found");
    });
  });

  describe("previousResult chaining", () => {
    it("chains previousResult between phases", async () => {
      const capturedPrompts: string[] = [];
      const customBuilder: PromptBuilder = (phase, ctx) => {
        const prompt = `Phase ${phase.index + 1}${ctx.previousResult ? ` [prev: ${ctx.previousResult}]` : ""}`;
        capturedPrompts.push(prompt);
        return prompt;
      };

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [
        successResult("output from phase 1"),
        successResult("output from phase 2"),
      ];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner,
        emitter,
        config,
        engine: claudeEngine,
        workflowId: "test-chain",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(2)),
        promptBuilder: customBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-chain",
        workflowLabel: "test",
      });

      await loop.run();

      // First phase should have no previous result
      expect(capturedPrompts[0]).toBe("Phase 1");
      // Second phase should have the first phase's output
      expect(capturedPrompts[1]).toContain("[prev: output from phase 1]");
    });

    it("passes full previousResult without truncation when no handoff", async () => {
      const capturedCtx: WorkflowStepContext[] = [];
      const customBuilder: PromptBuilder = (phase, ctx) => {
        capturedCtx.push({ ...ctx });
        return `Phase ${phase.index + 1}`;
      };

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      // Output bigger than 200K chars
      const largeOutput = "x".repeat(300_000);
      spawner.results = [successResult(largeOutput), successResult("done")];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner,
        emitter,
        config,
        engine: claudeEngine,
        workflowId: "test-trunc",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(2)),
        promptBuilder: customBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-trunc",
        workflowLabel: "test",
      });

      await loop.run();

      // Without handoff, raw output is passed directly (no truncation)
      const prevResult = capturedCtx[1]?.previousResult ?? "";
      expect(prevResult.length).toBe(300_000);
      expect(prevResult).not.toContain("truncated");
    });
  });

  describe("completed phase skipping", () => {
    it("skips completed phases and emits events for them", async () => {
      const phases = makePhases(3, [
        { status: "completed" },
        { status: "completed" },
        null,
      ]);

      const { loop, adapter, spawner } = createUnifiedLoop({
        phases,
        spawnerResults: [successResult()],
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(3);
      // Only one spawn call (the pending phase)
      expect(spawner.calls).toHaveLength(1);
    });
  });

  describe("failure handling", () => {
    it("emits workflowFailed on phase failure", async () => {
      const { loop, adapter } = createUnifiedLoop({
        spawnerResults: [
          failureResult(nonRetryableError("Worker crashed")),
        ],
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toContain("Worker crashed");

      const workflowFailed = adapter.events.find((e) => e.type === "workflow:failed");
      expect(workflowFailed).toBeDefined();
    });

    it("emits workerFailed for WorkerError failures", async () => {
      const { loop, adapter } = createUnifiedLoop({
        spawnerResults: [
          failureResult(nonRetryableError("Worker timeout")),
        ],
      });

      await loop.run();

      const workerFailed = adapter.events.find((e) => e.type === "worker:failed");
      expect(workerFailed).toBeDefined();
    });
  });

  describe("shutdown handling", () => {
    it("stops on shutdown request and emits workflow:interrupted", async () => {
      const { loop, adapter, spawner } = createUnifiedLoop({
        phases: makePhases(3),
        spawnerResults: [successResult()],
      });

      // Request shutdown before running — will stop after first phase
      // We need to request shutdown during execution. Use a spawner that triggers shutdown.
      let firstPhaseRan = false;
      const originalSpawn = spawner.spawn.bind(spawner);
      spawner.spawn = async (cmd, args, opts) => {
        if (!firstPhaseRan) {
          firstPhaseRan = true;
          const result = await originalSpawn(cmd, args, opts);
          // Request shutdown after first phase completes (but before the next one starts)
          loop.requestShutdown();
          return result;
        }
        return await originalSpawn(cmd, args, opts);
      };

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.phasesCompleted).toBe(1);
      expect(result.reason).toBe("Shutdown requested");

      const interrupted = adapter.events.find((e) => e.type === "workflow:interrupted");
      expect(interrupted).toBeDefined();
    });
  });

  describe("with StatePersistence", () => {
    it("updates state on phase completion", async () => {
      const dir = ensureTmpDir();
      const planPath = path.join(dir, "test.md");
      const statePath = path.join(dir, "test.state.md");
      const planContent = readFixture("two-phase-plan.md");
      fs.writeFileSync(planPath, planContent);

      const persistence = new FileStatePersistence(planPath, statePath, dir);
      const state = persistence.load(planContent);

      const provider = new PlanFileProvider(planContent, state);

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult(), successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-persist",
      });

      const loop = new ExecutionLoop({
        phaseProvider: provider,
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-persist",
        workflowLabel: planPath,
        statePersistence: persistence,
        keyDecisions: state.keyDecisions,
      });
      loop.setLoadedState(state);

      const result = await loop.run();
      expect(result.completed).toBe(true);

      // Read state file from disk
      const diskContent = fs.readFileSync(statePath, "utf-8");
      const diskState = parseStateFile(diskContent);
      expect(diskState.phases[0].status).toBe("completed");
      expect(diskState.phases[1].status).toBe("completed");
    });

    it("writes error to state on phase failure", async () => {
      const dir = ensureTmpDir();
      const planPath = path.join(dir, "test.md");
      const statePath = path.join(dir, "test.state.md");
      const planContent = readFixture("two-phase-plan.md");
      fs.writeFileSync(planPath, planContent);

      const persistence = new FileStatePersistence(planPath, statePath, dir);
      const state = persistence.load(planContent);

      const provider = new PlanFileProvider(planContent, state);

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [
        failureResult(nonRetryableError("Build failed")),
      ];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-fail",
      });

      const loop = new ExecutionLoop({
        phaseProvider: provider,
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-fail",
        workflowLabel: planPath,
        statePersistence: persistence,
      });
      loop.setLoadedState(state);

      const result = await loop.run();
      expect(result.completed).toBe(false);

      // Read state file — should have error log
      const diskContent = fs.readFileSync(statePath, "utf-8");
      const diskState = parseStateFile(diskContent);
      expect(diskState.phases[0].status).toBe("pending");
      expect(diskState.errorLog).toHaveLength(1);
      expect(diskState.errorLog[0].error).toContain("Build failed");
    });
  });

  describe("with ApprovalHandler", () => {
    it("handles in_progress phases via ApprovalHandler", async () => {
      const phases = makePhases(2, [
        { status: "in_progress" },
        null,
      ]);

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const config = defaultConfig();
      const handler = new UIApprovalHandler(emitter, config, adapter, "test-approval");

      // Install a callback that auto-approves
      adapter.onApprovalDecision = () => {};

      const spawner = new MockSpawner();
      spawner.results = [successResult()];

      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-approval",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(phases),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-approval",
        workflowLabel: "test",
        approvalHandler: handler,
      });

      // Schedule the approval callback to fire
      setTimeout(() => {
        adapter.onApprovalDecision!(true);
      }, 10);

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
    });

    it("returns false when approval rejected", async () => {
      const phases = makePhases(2, [
        { status: "in_progress" },
        null,
      ]);

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const config = defaultConfig();
      const handler = new UIApprovalHandler(emitter, config, adapter, "test-reject");

      adapter.onApprovalDecision = () => {};

      const spawner = new MockSpawner();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-reject",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(phases),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-reject",
        workflowLabel: "test",
        approvalHandler: handler,
      });

      setTimeout(() => {
        adapter.onApprovalDecision!(false);
      }, 10);

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toContain("approval rejected");
    });

    it("auto-proceeds in_progress phases when no ApprovalHandler", async () => {
      const phases = makePhases(2, [
        { status: "in_progress" },
        null,
      ]);

      const { loop, spawner } = createUnifiedLoop({
        phases,
        spawnerResults: [successResult()],
        // No approvalHandler
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
      // Only one spawn call (the pending phase)
      expect(spawner.calls).toHaveLength(1);
    });
  });

  describe("without StatePersistence (non-work path)", () => {
    it("runs without state persistence", async () => {
      const { loop } = createUnifiedLoop({
        spawnerResults: [successResult(), successResult()],
        // No statePersistence
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
    });

    it("does not crash on failure without state persistence", async () => {
      const { loop } = createUnifiedLoop({
        spawnerResults: [
          failureResult(nonRetryableError("Oops")),
        ],
        // No statePersistence
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toContain("Oops");
    });
  });

  describe("WorkflowDefinitionProvider integration", () => {
    it("runs workflow-style steps from WorkflowDefinitionProvider", async () => {
      const workflow = {
        name: "test-workflow",
        description: "Test",
        steps: [
          { description: "Step 1: Analyze" },
          { description: "Step 2: Implement" },
          { description: "Step 3: Verify" },
        ],
      };

      const provider = new WorkflowDefinitionProvider(workflow);

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult("r1"), successResult("r2"), successResult("r3")];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-wfdef",
      });

      const loop = new ExecutionLoop({
        phaseProvider: provider,
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-wfdef",
        workflowLabel: workflow.name,
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(3);
      expect(result.phasesTotal).toBe(3);
    });
  });

  describe("handoff path in prompt", () => {
    it("does NOT include <promise>COMPLETE</promise> marker (removed)", async () => {
      const spawner = new MockSpawner();
      spawner.results = [successResult()];

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-marker",
      });

      const rawBuilder: PromptBuilder = (phase) => `Do phase ${phase.index + 1}`;

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(1)),
        promptBuilder: rawBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-marker",
        workflowLabel: "test",
      });

      await loop.run();

      // The spawner should have received a prompt WITHOUT the completion marker
      expect(spawner.calls).toHaveLength(1);
      const stdinPrompt = spawner.calls[0].options?.stdin ?? "";
      expect(stdinPrompt).not.toContain("<promise>COMPLETE</promise>");
    });
  });

  describe("budget enforcement", () => {
    it("stops with 'Budget exhausted' when isExhausted() returns true before first phase", async () => {
      const tracker = new MockBudgetTracker();
      tracker.exhausted = true; // already exhausted

      const limits: BudgetLimits = { max_invocations: 5, max_tokens: null, wall_clock_deadline: null };

      const { loop, spawner } = createUnifiedLoop({
        phases: makePhases(2),
        spawnerResults: [successResult(), successResult()],
        budgetTracker: tracker,
        budgetLimits: limits,
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.phasesCompleted).toBe(0);
      expect(result.phasesTotal).toBe(2);
      expect(result.reason).toBe("Budget exhausted");
      // No phases should have been dispatched
      expect(spawner.calls).toHaveLength(0);
    });

    it("stops between phases when budget becomes exhausted", async () => {
      const tracker = new MockBudgetTracker();
      const limits: BudgetLimits = { max_invocations: 5, max_tokens: null, wall_clock_deadline: null };

      const { loop, spawner } = createUnifiedLoop({
        phases: makePhases(3),
        spawnerResults: [successResult(), successResult(), successResult()],
        budgetTracker: tracker,
        budgetLimits: limits,
      });

      // Exhaust budget after first phase completes (spawner triggers it)
      let firstDone = false;
      const originalSpawn = spawner.spawn.bind(spawner);
      spawner.spawn = async (cmd, args, opts) => {
        const result = await originalSpawn(cmd, args, opts);
        if (!firstDone) {
          firstDone = true;
          // Mark budget as exhausted after first phase
          tracker.exhausted = true;
        }
        return result;
      };

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.phasesCompleted).toBe(1);
      expect(result.reason).toBe("Budget exhausted");
      // Only one phase should have been dispatched
      expect(spawner.calls).toHaveLength(1);
    });

    it("passes when limits are 0/null (unlimited)", async () => {
      const tracker = new MockBudgetTracker();
      // Unlimited: max_invocations=0, max_tokens=null, no deadline
      const limits: BudgetLimits = { max_invocations: 0, max_tokens: null, wall_clock_deadline: null };

      const { loop, spawner } = createUnifiedLoop({
        phases: makePhases(2),
        spawnerResults: [successResult(), successResult()],
        budgetTracker: tracker,
        budgetLimits: limits,
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
      expect(spawner.calls).toHaveLength(2);
    });

    it("passes when under all limits", async () => {
      const tracker = new MockBudgetTracker();
      tracker.invocations = 2;
      tracker.tokens = 1000;
      // Well under limits
      const limits: BudgetLimits = { max_invocations: 10, max_tokens: 100000, wall_clock_deadline: null };

      const { loop } = createUnifiedLoop({
        phases: makePhases(2),
        spawnerResults: [successResult(), successResult()],
        budgetTracker: tracker,
        budgetLimits: limits,
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
    });

    it("runs normally without budget tracker (backward compat)", async () => {
      // No budgetTracker or budgetLimits provided
      const { loop } = createUnifiedLoop({
        spawnerResults: [successResult(), successResult()],
      });

      const result = await loop.run();

      expect(result.completed).toBe(true);
      expect(result.phasesCompleted).toBe(2);
    });

    it("increments invocation count after each executor.execute() call", async () => {
      const tracker = new MockBudgetTracker();
      const limits: BudgetLimits = { max_invocations: 0, max_tokens: null, wall_clock_deadline: null };

      const { loop } = createUnifiedLoop({
        phases: makePhases(3),
        spawnerResults: [successResult(), successResult(), successResult()],
        budgetTracker: tracker,
        budgetLimits: limits,
      });

      expect(tracker.invocations).toBe(0);

      await loop.run();

      // 3 phases executed = 3 increments
      expect(tracker.invocations).toBe(3);
    });

    it("does not increment invocations for skipped (completed) phases", async () => {
      const tracker = new MockBudgetTracker();
      const limits: BudgetLimits = { max_invocations: 0, max_tokens: null, wall_clock_deadline: null };

      const phases = makePhases(3, [
        { status: "completed" },
        null, // pending
        null, // pending
      ]);

      const { loop } = createUnifiedLoop({
        phases,
        spawnerResults: [successResult(), successResult()],
        budgetTracker: tracker,
        budgetLimits: limits,
      });

      await loop.run();

      // Only 2 phases actually executed (first was already completed)
      expect(tracker.invocations).toBe(2);
    });

    it("does not increment invocations on failed phase", async () => {
      const tracker = new MockBudgetTracker();
      const limits: BudgetLimits = { max_invocations: 0, max_tokens: null, wall_clock_deadline: null };

      const { loop } = createUnifiedLoop({
        phases: makePhases(2),
        spawnerResults: [failureResult(nonRetryableError("Crash"))],
        budgetTracker: tracker,
        budgetLimits: limits,
      });

      await loop.run();

      // Phase failed, incrementInvocations is only called on success
      expect(tracker.invocations).toBe(0);
    });

    it("checkpoints state (current phase stays pending) on budget stop", async () => {
      const dir = ensureTmpDir();
      const planPath = path.join(dir, "test.md");
      const statePath = path.join(dir, "test.state.md");
      const planContent = readFixture("two-phase-plan.md");
      fs.writeFileSync(planPath, planContent);

      const persistence = new FileStatePersistence(planPath, statePath, dir);
      const state = persistence.load(planContent);
      const provider = new PlanFileProvider(planContent, state);

      const tracker = new MockBudgetTracker();
      tracker.exhausted = true; // exhausted immediately
      const limits: BudgetLimits = { max_invocations: 1, max_tokens: null, wall_clock_deadline: null };

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-budget-state",
      });

      const loop = new ExecutionLoop({
        phaseProvider: provider,
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-budget-state",
        workflowLabel: planPath,
        statePersistence: persistence,
        budgetTracker: tracker,
        budgetLimits: limits,
      });
      loop.setLoadedState(state);

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toBe("Budget exhausted");
      // No phases dispatched — state file should still have pending phases
      expect(spawner.calls).toHaveLength(0);

      // Verify state was not modified (phases remain pending)
      if (fs.existsSync(statePath)) {
        const diskState = parseStateFile(fs.readFileSync(statePath, "utf-8"));
        for (const phase of diskState.phases) {
          expect(phase.status).toBe("pending");
        }
      }
      // If state file doesn't exist, that's also fine — no state was written
    });

    it("returns sessionBudget with real remaining values from tracker", async () => {
      // This test verifies the dispatcher receives real budget values.
      // We use the dispatcherOrchestrator path to capture what sessionBudget is passed.
      let capturedSessionBudget: SessionBudgetStatus | undefined;

      const tracker = new MockBudgetTracker();
      tracker.invocations = 3;
      tracker.tokens = 5000;
      const limits: BudgetLimits = {
        max_invocations: 10,
        max_tokens: 50000,
        wall_clock_deadline: "2099-12-31T23:59:59Z",
      };

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-budget-status",
      });

      // Mock dispatcher orchestrator that captures the sessionBudget
      const mockDispatcher = {
        getPhaseDecision: async (
          _phase: any,
          _planContent: string,
          _stateContent: string,
          _contextContent: string | undefined,
          _previousResult: string | undefined,
          extra: any,
        ): Promise<DispatcherDecision | null> => {
          capturedSessionBudget = extra.sessionBudget;
          return {
            schema_version: 1,
            phase_index: 0,
            task_content: "dispatched prompt",
            context_files: [],
            validation_criteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
            reasoning: "",
            warnings: [],
            worker_config: {
              model_override: null, timeout_minutes: 30, retry_on_failure: true,
              max_retries: 3, iteration_budget: 5,
              tool_scoping: { read: true, bash: true, write: true, edit: true },
              parallel: false, parallel_variants: null,
            },
          };
        },
      };

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(1)),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-budget-status",
        workflowLabel: "test",
        budgetTracker: tracker,
        budgetLimits: limits,
        dispatcherOrchestrator: mockDispatcher as any,
        planContent: "fake plan",
      });

      await loop.run();

      expect(capturedSessionBudget).toBeDefined();
      expect(capturedSessionBudget!.invocations_remaining).toBe(7); // 10 - 3
      expect(capturedSessionBudget!.token_budget_remaining).toBe(45000); // 50000 - 5000
      expect(capturedSessionBudget!.wall_clock_deadline).toBe("2099-12-31T23:59:59Z");
    });

    it("returns null sessionBudget values when no budget tracker", async () => {
      // When no budget tracker is configured, the dispatcher should get unlimited values.
      let capturedSessionBudget: SessionBudgetStatus | undefined;

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-no-budget",
      });

      const mockDispatcher = {
        getPhaseDecision: async (
          _phase: any,
          _planContent: string,
          _stateContent: string,
          _contextContent: string | undefined,
          _previousResult: string | undefined,
          extra: any,
        ): Promise<DispatcherDecision | null> => {
          capturedSessionBudget = extra.sessionBudget;
          return {
            schema_version: 1,
            phase_index: 0,
            task_content: "dispatched prompt",
            context_files: [],
            validation_criteria: { acceptance_criteria: [], required_tests: false, custom_checks: [], required_outputs: [] },
            reasoning: "",
            warnings: [],
            worker_config: {
              model_override: null, timeout_minutes: 30, retry_on_failure: true,
              max_retries: 3, iteration_budget: 5,
              tool_scoping: { read: true, bash: true, write: true, edit: true },
              parallel: false, parallel_variants: null,
            },
          };
        },
      };

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(1)),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-no-budget",
        workflowLabel: "test",
        // No budgetTracker or budgetLimits
        dispatcherOrchestrator: mockDispatcher as any,
        planContent: "fake plan",
      });

      await loop.run();

      expect(capturedSessionBudget).toBeDefined();
      expect(capturedSessionBudget!.invocations_remaining).toBeNull();
      expect(capturedSessionBudget!.token_budget_remaining).toBeNull();
      expect(capturedSessionBudget!.wall_clock_deadline).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Dispatcher decision flow-through (worker_config overrides)
  // -------------------------------------------------------------------------

  describe("dispatcher decision flow-through", () => {
    /** Helper to build a valid DispatcherDecision for tests */
    function validDecision(overrides?: Partial<DispatcherDecision>): DispatcherDecision {
      return {
        schema_version: 1,
        phase_index: 0,
        task_content: "Dispatcher-crafted prompt for the worker",
        context_files: ["src/index.ts"],
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
        ...overrides,
      };
    }

    /** Creates a mock DispatcherOrchestrator that returns a specific decision */
    function mockDispatcherOrchestrator(decision: DispatcherDecision | null) {
      return {
        getPhaseDecision: async () => decision,
      } as unknown as DispatcherOrchestrator;
    }

    /** Creates a loop with dispatcher orchestrator */
    function createLoopWithDispatcher(opts: {
      decision: DispatcherDecision | null;
      phases?: PhaseInfo[];
      spawnerResults?: WorkerResult[];
      config?: Partial<FlywheelConfig>;
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
        workflowId: "test-wf",
      });

      const phases = opts.phases ?? makePhases(1);
      const provider = new SimplePhaseProvider(phases);

      const loop = new ExecutionLoop({
        phaseProvider: provider,
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-wf",
        workflowLabel: "test-workflow",
        dispatcherOrchestrator: mockDispatcherOrchestrator(opts.decision),
        planContent: "# Test plan",
      });

      return { loop, bus, emitter, adapter, spawner, config };
    }

    it("when dispatcher returns worker_config.timeout_minutes, it overrides config", async () => {
      const decision = validDecision({
        worker_config: {
          model_override: null,
          timeout_minutes: 10, // override: 10 min instead of config's 60
          retry_on_failure: true,
          max_retries: 3,
          iteration_budget: 5,
          tool_scoping: { read: true, bash: true, write: true, edit: true },
          parallel: false,
          parallel_variants: null,
        },
      });

      const { loop, spawner } = createLoopWithDispatcher({
        decision,
        spawnerResults: [successResult()],
        config: { timeout_minutes: 60 },
      });

      await loop.run();

      // The spawner should have received the overridden timeout (10 * 60000 = 600000)
      expect(spawner.calls).toHaveLength(1);
      const spawnOpts = spawner.calls[0].options;
      expect(spawnOpts?.timeoutMs).toBe(10 * 60_000);
    });

    it("when dispatcher returns worker_config.model_override, it's passed to engine", async () => {
      const decision = validDecision({
        worker_config: {
          model_override: "sonnet",
          timeout_minutes: 30,
          retry_on_failure: true,
          max_retries: 3,
          iteration_budget: 5,
          tool_scoping: { read: true, bash: true, write: true, edit: true },
          parallel: false,
          parallel_variants: null,
        },
      });

      const { loop, spawner } = createLoopWithDispatcher({
        decision,
        spawnerResults: [successResult()],
      });

      await loop.run();

      expect(spawner.calls).toHaveLength(1);
      // Claude engine passes model via --model flag in args
      const args = spawner.calls[0].args;
      expect(args).toContain("sonnet");
    });

    it("when dispatcher returns worker_config.max_retries, it overrides config", async () => {
      // To verify max_retries override, we need a retryable failure followed by success.
      // With max_retries=1 from dispatcher (vs config's 3), it should retry once then succeed.
      const decision = validDecision({
        worker_config: {
          model_override: null,
          timeout_minutes: 30,
          retry_on_failure: true,
          max_retries: 1, // override: only 1 retry
          iteration_budget: 5,
          tool_scoping: { read: true, bash: true, write: true, edit: true },
          parallel: false,
          parallel_variants: null,
        },
      });

      const { loop, spawner } = createLoopWithDispatcher({
        decision,
        spawnerResults: [
          failureResult(retryableError("Timeout")),
          successResult(), // succeeds on retry
        ],
        config: { max_retries: 3 }, // config says 3 but dispatcher says 1
      });

      const result = await loop.run();

      // Should succeed — 1 retry was enough
      expect(result.completed).toBe(true);
      expect(spawner.calls).toHaveLength(2); // initial + 1 retry
    });

    it("when worker_config.parallel === true, logs warning and proceeds single-threaded", async () => {
      const decision = validDecision({
        worker_config: {
          model_override: null,
          timeout_minutes: 30,
          retry_on_failure: true,
          max_retries: 3,
          iteration_budget: 5,
          tool_scoping: { read: true, bash: true, write: true, edit: true },
          parallel: true, // parallel requested
          parallel_variants: [
            { name: "variant-a", prompt: "Approach A" },
            { name: "variant-b", prompt: "Approach B" },
          ],
        },
      });

      const { loop, spawner } = createLoopWithDispatcher({
        decision,
        spawnerResults: [successResult()],
      });

      const result = await loop.run();

      // Should still complete (single-threaded fallback)
      expect(result.completed).toBe(true);
      // Only one spawn call — parallel was not actually executed
      expect(spawner.calls).toHaveLength(1);
    });

    it("when dispatcher disabled, falls through to prompt builder (existing behavior)", async () => {
      const capturedPrompts: string[] = [];
      const customBuilder: PromptBuilder = (phase, ctx) => {
        const prompt = `Fallback: Phase ${phase.index + 1}`;
        capturedPrompts.push(prompt);
        return prompt;
      };

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
        workflowId: "test-wf",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(1)),
        promptBuilder: customBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-wf",
        workflowLabel: "test",
        // Dispatcher returns null (simulating dispatcher failure fallback)
        dispatcherOrchestrator: mockDispatcherOrchestrator(null),
        planContent: "# Test plan",
      });

      await loop.run();

      // Should have used the fallback prompt builder
      expect(capturedPrompts).toHaveLength(1);
      expect(capturedPrompts[0]).toBe("Fallback: Phase 1");
    });
  });

  // -------------------------------------------------------------------------
  // Rate limit exhaustion handling
  // -------------------------------------------------------------------------

  describe("rate limit exhaustion", () => {
    /** Rate-limited failure for testing. */
    function rateLimitedError(message: string): WorkerFailureReason {
      return { kind: "rate_limited", message };
    }

    it("returns { completed: false } with rate-limit reason (not a thrown error)", async () => {
      // max_retries: 0 so rate-limited error propagates immediately without retry delay
      const { loop, adapter } = createUnifiedLoop({
        spawnerResults: [
          failureResult(rateLimitedError("Rate limited by API")),
        ],
        config: { max_retries: 0 },
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toContain("Rate limit exhausted");
      expect(result.reason).toContain("paused for resumption");
    });

    it("emits workflow:interrupted (not workflow:failed) for rate limit exhaustion", async () => {
      const { loop, adapter } = createUnifiedLoop({
        spawnerResults: [
          failureResult(rateLimitedError("Rate limited by API")),
        ],
        config: { max_retries: 0 },
      });

      await loop.run();

      const interrupted = adapter.events.find((e) => e.type === "workflow:interrupted");
      const failed = adapter.events.find((e) => e.type === "workflow:failed");

      expect(interrupted).toBeDefined();
      expect(failed).toBeUndefined();
    });

    it("still emits worker:failed for the rate-limited worker", async () => {
      const { loop, adapter } = createUnifiedLoop({
        spawnerResults: [
          failureResult(rateLimitedError("Rate limited by API")),
        ],
        config: { max_retries: 0 },
      });

      await loop.run();

      const workerFailed = adapter.events.find((e) => e.type === "worker:failed");
      expect(workerFailed).toBeDefined();
    });

    it("returns same shape as budget exhaustion (completed: false, reason, phasesCompleted, phasesTotal)", async () => {
      const { loop } = createUnifiedLoop({
        phases: makePhases(3),
        spawnerResults: [
          successResult(),
          failureResult(rateLimitedError("Rate limited by API")),
        ],
        config: { max_retries: 0 },
      });

      const result = await loop.run();

      expect(result).toEqual({
        completed: false,
        phasesCompleted: 1,
        phasesTotal: 3,
        reason: "Rate limit exhausted — workflow paused for resumption",
      });
    });

    it("non-rate-limit failures still emit workflow:failed (existing behavior)", async () => {
      const { loop, adapter } = createUnifiedLoop({
        spawnerResults: [
          failureResult(nonRetryableError("Worker crashed")),
        ],
      });

      await loop.run();

      const failed = adapter.events.find((e) => e.type === "workflow:failed");
      const interrupted = adapter.events.find((e) => e.type === "workflow:interrupted");

      expect(failed).toBeDefined();
      expect(interrupted).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // ContextIndexer integration
  // -------------------------------------------------------------------------

  describe("contextIndexer integration", () => {
    /** Mock ContextIndexer that captures calls and returns controlled data */
    class MockContextIndexer {
      calls: Array<{ workflowType: string; phaseDescription: string }> = [];
      contextToReturn = {
        conventions: [{ name: "AGENTS.md", path: "AGENTS.md", summary: "Project conventions" }],
        standards: [{ name: "coding-style", path: "docs/standards/coding-style.md", summary: "Code style rules" }],
        learnings: [{ name: "fix-race-condition", path: "docs/solutions/fix-race-condition.md", summary: "How we fixed a race condition" }],
      };

      getRelevantContext(query: { workflowType: string; phaseDescription: string }) {
        this.calls.push(query);
        return this.contextToReturn;
      }

      dispose(): void { /* no-op */ }
    }

    it("accepts contextIndexer via options (DI)", async () => {
      const indexer = new MockContextIndexer();

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-indexer",
      });

      // Should not throw — contextIndexer is accepted as an optional DI parameter
      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(1)),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-indexer",
        workflowLabel: "test",
        contextIndexer: indexer as any,
      });

      const result = await loop.run();
      expect(result.completed).toBe(true);
    });

    it("calls indexer.getRelevantContext() when dispatcher is active and indexer present", async () => {
      const indexer = new MockContextIndexer();
      let capturedAvailableContext: any;

      const mockDispatcher = {
        getPhaseDecision: async (
          _phase: any,
          _planContent: string,
          _stateContent: string,
          _contextContent: string | undefined,
          _previousResult: string | undefined,
          extra: any,
        ): Promise<DispatcherDecision | null> => {
          capturedAvailableContext = extra.availableContext;
          return null; // fall through to prompt builder
        },
      };

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-indexer-ctx",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(1)),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-indexer-ctx",
        workflowLabel: "work",
        dispatcherOrchestrator: mockDispatcher as any,
        planContent: "# Test plan",
        contextIndexer: indexer as any,
      });

      await loop.run();

      // Context is cached once per phase (shared between dispatcher and template)
      expect(indexer.calls).toHaveLength(1);
      expect(indexer.calls[0].workflowType).toBe("work");
      expect(indexer.calls[0].phaseDescription).toBe("Phase 1");

      // The dispatcher should have received populated availableContext
      expect(capturedAvailableContext).toBeDefined();
      expect(capturedAvailableContext.conventions).toHaveLength(1);
      expect(capturedAvailableContext.conventions[0].name).toBe("AGENTS.md");
      expect(capturedAvailableContext.standards).toHaveLength(1);
      expect(capturedAvailableContext.standards[0].name).toBe("coding-style");
      expect(capturedAvailableContext.learnings).toHaveLength(1);
      expect(capturedAvailableContext.learnings[0].name).toBe("fix-race-condition");
    });

    it("falls back to empty arrays when indexer is absent", async () => {
      let capturedAvailableContext: any;

      const mockDispatcher = {
        getPhaseDecision: async (
          _phase: any,
          _planContent: string,
          _stateContent: string,
          _contextContent: string | undefined,
          _previousResult: string | undefined,
          extra: any,
        ): Promise<DispatcherDecision | null> => {
          capturedAvailableContext = extra.availableContext;
          return null;
        },
      };

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-no-indexer",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(1)),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-no-indexer",
        workflowLabel: "test",
        dispatcherOrchestrator: mockDispatcher as any,
        planContent: "# Test plan",
        // No contextIndexer — should fall back to empty arrays
      });

      await loop.run();

      expect(capturedAvailableContext).toBeDefined();
      expect(capturedAvailableContext.conventions).toEqual([]);
      expect(capturedAvailableContext.standards).toEqual([]);
      expect(capturedAvailableContext.learnings).toEqual([]);
    });

    it("calls indexer for each phase when dispatcher is active", async () => {
      const indexer = new MockContextIndexer();
      const phases = makePhases(3);

      const mockDispatcher = {
        getPhaseDecision: async (): Promise<DispatcherDecision | null> => null,
      };

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult(), successResult(), successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-multi-phase",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(phases),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-multi-phase",
        workflowLabel: "plan",
        dispatcherOrchestrator: mockDispatcher as any,
        planContent: "# Test plan",
        contextIndexer: indexer as any,
      });

      await loop.run();

      // Context is cached once per phase (shared between dispatcher and template)
      expect(indexer.calls).toHaveLength(3);
      expect(indexer.calls[0].phaseDescription).toBe("Phase 1");
      expect(indexer.calls[1].phaseDescription).toBe("Phase 2");
      expect(indexer.calls[2].phaseDescription).toBe("Phase 3");
    });

    it("calls indexer from non-dispatcher fallback path when no dispatcher is configured", async () => {
      const indexer = new MockContextIndexer();

      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner, emitter, config, engine: claudeEngine, workflowId: "test-no-dispatcher",
      });

      const loopNoDispatcher = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(1)),
        promptBuilder: testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-no-dispatcher",
        workflowLabel: "test",
        contextIndexer: indexer as any,
        // No dispatcherOrchestrator — dispatcher path skipped, but non-dispatcher
        // fallback still calls getRelevantContext to populate ctx.extra
      });

      await loopNoDispatcher.run();

      // Indexer IS called from the non-dispatcher fallback path (once per phase)
      expect(indexer.calls).toHaveLength(1);
      expect(indexer.calls[0].workflowType).toBe("test");
      expect(indexer.calls[0].phaseDescription).toBe("Phase 1");
    });
  });

  // -------------------------------------------------------------------------
  // Dispatcher-template composition (Phase 3 refactor)
  // -------------------------------------------------------------------------

  describe("dispatcher-template composition", () => {
    /** Helper to build a valid DispatcherDecision for composition tests */
    function validDecision(overrides?: Partial<DispatcherDecision>): DispatcherDecision {
      return {
        schema_version: 1,
        phase_index: 0,
        task_content: "Dispatcher task instructions",
        context_files: [],
        validation_criteria: {
          acceptance_criteria: [],
          required_tests: false,
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
        ...overrides,
      };
    }

    /** Creates a mock DispatcherOrchestrator that returns a specific decision */
    function mockDispatcherOrchestrator(decision: DispatcherDecision | null) {
      return {
        getPhaseDecision: async () => decision,
      } as unknown as DispatcherOrchestrator;
    }

    /** Creates a loop with a dispatcher and a custom prompt builder */
    function createCompositionLoop(opts: {
      decision: DispatcherDecision | null;
      promptBuilder?: PromptBuilder;
      phases?: PhaseInfo[];
      spawnerResults?: WorkerResult[];
      onSessionName?: (name: string) => void;
    }) {
      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      if (opts.spawnerResults) spawner.results = opts.spawnerResults;
      else spawner.results = [successResult()];

      const config = defaultConfig();
      const executor = new PhaseExecutor({
        spawner,
        emitter,
        config,
        engine: claudeEngine,
        workflowId: "test-compose",
      });

      const phases = opts.phases ?? makePhases(1);
      const provider = new SimplePhaseProvider(phases);

      const loop = new ExecutionLoop({
        phaseProvider: provider,
        promptBuilder: opts.promptBuilder ?? testPromptBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-compose",
        workflowLabel: "test-workflow",
        dispatcherOrchestrator: mockDispatcherOrchestrator(opts.decision),
        planContent: "# Test plan",
        onSessionName: opts.onSessionName,
      });

      return { loop, bus, emitter, adapter, spawner, config };
    }

    it("when dispatcher returns task_content, prompt builder receives it as ctx.planContent", async () => {
      let capturedPlanContent: string | undefined;

      const customBuilder: PromptBuilder = (_phase, ctx) => {
        capturedPlanContent = ctx.planContent;
        return `built: ${ctx.planContent}`;
      };

      const decision = validDecision({
        task_content: "Dispatcher task instructions",
      });

      const { loop } = createCompositionLoop({
        decision,
        promptBuilder: customBuilder,
      });

      await loop.run();

      expect(capturedPlanContent).toBe("Dispatcher task instructions");
    });

    it("when dispatcher fails (returns null), ctx.planContent is phase.description", async () => {
      let capturedPlanContent: string | undefined;

      const customBuilder: PromptBuilder = (_phase, ctx) => {
        capturedPlanContent = ctx.planContent;
        return `built: ${ctx.planContent}`;
      };

      const { loop } = createCompositionLoop({
        decision: null,
        promptBuilder: customBuilder,
      });

      await loop.run();

      // phase.description from makePhases(1) is "Description for phase 1"
      expect(capturedPlanContent).toBe("Description for phase 1");
    });

    it("prompt builder is ALWAYS called, even when dispatcher succeeds", async () => {
      let promptBuilderCalled = false;

      const customBuilder: PromptBuilder = (_phase, _ctx) => {
        promptBuilderCalled = true;
        return "template output";
      };

      const decision = validDecision({
        task_content: "Dispatcher crafted content",
      });

      const { loop } = createCompositionLoop({
        decision,
        promptBuilder: customBuilder,
      });

      await loop.run();

      expect(promptBuilderCalled).toBe(true);
    });

    it("worker_config overrides still flow correctly from dispatcher decision", async () => {
      const decision = validDecision({
        task_content: "Dispatcher crafted content",
        worker_config: {
          model_override: "sonnet",
          timeout_minutes: 10,
          retry_on_failure: true,
          max_retries: 3,
          iteration_budget: 5,
          tool_scoping: { read: true, bash: true, write: true, edit: true },
          parallel: false,
          parallel_variants: null,
        },
      });

      const { loop, spawner } = createCompositionLoop({
        decision,
      });

      await loop.run();

      expect(spawner.calls).toHaveLength(1);
      // Model override: claude engine passes via --model flag
      const args = spawner.calls[0].args;
      expect(args).toContain("sonnet");
      // Timeout override: 10 * 60000 = 600000
      expect(spawner.calls[0].options?.timeoutMs).toBe(10 * 60_000);
    });

    it("enrichPromptWithContext is applied to the template output when context_to_inline is present", async () => {
      const dir = ensureTmpDir();
      const filePath = path.join(dir, "standard.md");
      fs.writeFileSync(filePath, "# Coding Standard\nUse TypeScript strict mode.");

      const customBuilder: PromptBuilder = (_phase, _ctx) => {
        return "template output for worker";
      };

      const decision = validDecision({
        task_content: "Dispatcher crafted content",
        context_to_inline: [filePath],
      });

      // Need a custom loop with project_cwd set to the temp dir so the file passes path security
      const bus = new EventBus();
      const emitter = createFlywheelEmitter(bus);
      const adapter = new MockAdapter();
      adapter.connect(bus);
      adapter.start();

      const spawner = new MockSpawner();
      spawner.results = [successResult()];

      const config = defaultConfig({ project_cwd: dir });
      const executor = new PhaseExecutor({
        spawner,
        emitter,
        config,
        engine: claudeEngine,
        workflowId: "test-enrich",
      });

      const loop = new ExecutionLoop({
        phaseProvider: new SimplePhaseProvider(makePhases(1)),
        promptBuilder: customBuilder,
        executor,
        emitter,
        config,
        ui: adapter,
        workflowId: "test-enrich",
        workflowLabel: "test-workflow",
        dispatcherOrchestrator: mockDispatcherOrchestrator(decision),
        planContent: "# Test plan",
      });

      await loop.run();

      expect(spawner.calls).toHaveLength(1);
      const stdinPrompt = spawner.calls[0].options?.stdin ?? "";
      // The enriched prompt should contain the context header
      expect(stdinPrompt).toContain("Relevant Context");
      expect(stdinPrompt).toContain("Coding Standard");
      // The template output should also be in the prompt
      expect(stdinPrompt).toContain("template output for worker");
    });

    it("when dispatcher returns empty string task_content, ctx.planContent falls back to phase.description", async () => {
      let capturedPlanContent: string | undefined;

      const customBuilder: PromptBuilder = (_phase, ctx) => {
        capturedPlanContent = ctx.planContent;
        return `built: ${ctx.planContent}`;
      };

      const decision = validDecision({
        task_content: "   ", // whitespace-only treated as empty
      });

      const { loop } = createCompositionLoop({
        decision,
        promptBuilder: customBuilder,
      });

      await loop.run();

      expect(capturedPlanContent).toBe("Description for phase 1");
    });

    it("session_name extraction still works from dispatcher decision", async () => {
      let capturedSessionName: string | undefined;

      const decision = validDecision({
        session_name: "Test Session Name",
      });

      const { loop } = createCompositionLoop({
        decision,
        onSessionName: (name) => {
          capturedSessionName = name;
        },
      });

      await loop.run();

      expect(capturedSessionName).toBe("Test Session Name");
    });

    it("session_name is only emitted once across multiple phases", async () => {
      const sessionNames: string[] = [];

      const decision = validDecision({
        session_name: "Multi Phase Session",
      });

      const { loop } = createCompositionLoop({
        decision,
        phases: makePhases(3),
        spawnerResults: [successResult(), successResult(), successResult()],
        onSessionName: (name) => {
          sessionNames.push(name);
        },
      });

      await loop.run();

      // Fire-once: should only be called once despite 3 phases
      expect(sessionNames).toHaveLength(1);
      expect(sessionNames[0]).toBe("Multi Phase Session");
    });
  });
});
