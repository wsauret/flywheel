import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { WorkerResult, WorkerFailureReason } from "../src/schemas/worker";
import type { ProcessSpawner, SpawnOptions } from "../src/worker/spawner";
import type { FlywheelEvent } from "../src/events/types";
import type { FlywheelConfig } from "../src/config/loader";
import type { PhaseInfo } from "../src/controller/phase-provider";
import type { WorkflowStepContext } from "../src/prompts/index";
import type { StatePersistence } from "../src/controller/state-persistence";
import type { ApprovalHandler } from "../src/controller/approval-handler";
import type { ParsedStateFile } from "../src/state/reader";
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

  async spawn(command: string, args: string[], options?: SpawnOptions): Promise<WorkerResult> {
    this.calls.push({ command, args, options });
    const result = this.results[this.callIndex] ?? successResult();
    this.callIndex++;
    return result;
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

function createUnifiedLoop(opts: {
  phases?: PhaseInfo[];
  spawnerResults?: WorkerResult[];
  config?: Partial<FlywheelConfig>;
  statePersistence?: StatePersistence;
  approvalHandler?: ApprovalHandler;
  keyDecisions?: string[];
  fileReferences?: string[];
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

    it("emits phase:started and phase:completed for each phase", async () => {
      const { loop, adapter } = createUnifiedLoop({
        spawnerResults: [successResult(), successResult()],
      });

      await loop.run();

      const phaseStarted = adapter.events.filter((e) => e.type === "phase:started");
      const phaseCompleted = adapter.events.filter((e) => e.type === "phase:completed");

      expect(phaseStarted).toHaveLength(2);
      expect(phaseCompleted).toHaveLength(2);
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

    it("truncates large previousResult to 200K chars", async () => {
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

      // Second phase's previousResult should be truncated
      const prevResult = capturedCtx[1]?.previousResult ?? "";
      expect(prevResult.length).toBeLessThanOrEqual(200_100); // 200K + truncation notice
      expect(prevResult).toContain("truncated");
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

      // All three phases should emit events
      const phaseStarted = adapter.events.filter((e) => e.type === "phase:started");
      expect(phaseStarted).toHaveLength(3);
    });
  });

  describe("failure handling", () => {
    it("emits phaseFailed + workflowFailed on phase failure", async () => {
      const { loop, adapter } = createUnifiedLoop({
        spawnerResults: [
          failureResult(nonRetryableError("Worker crashed")),
        ],
      });

      const result = await loop.run();

      expect(result.completed).toBe(false);
      expect(result.reason).toContain("Worker crashed");

      const phaseFailed = adapter.events.find((e) => e.type === "phase:failed");
      const workflowFailed = adapter.events.find((e) => e.type === "workflow:failed");

      expect(phaseFailed).toBeDefined();
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

  describe("completion marker", () => {
    it("applies wrapCompletionInstruction to all prompts", async () => {
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

      // The spawner should have received a prompt with the completion marker
      expect(spawner.calls).toHaveLength(1);
      const stdinPrompt = spawner.calls[0].options?.stdin;
      // The prompt goes through the engine which passes it via stdin
      // Check the args or the stdin content
      // The prompt is built and passed to executor.execute({ prompt })
      // which builds engine command. Let's check the args contain our text.
      const allArgs = spawner.calls[0].args.join(" ");
      // The completion instruction is in the prompt passed via stdin
      // Since Claude engine passes prompt via stdin, check that
      expect(spawner.calls[0].options?.stdin).toContain("<promise>COMPLETE</promise>");
    });
  });
});
