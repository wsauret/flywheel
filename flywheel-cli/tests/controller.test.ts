import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { WorkerResult, WorkerFailureReason } from "../src/schemas/worker";
import type { ProcessSpawner, SpawnOptions } from "../src/worker/spawner";
import type { FlywheelEvent } from "../src/events/types";
import type { FlywheelConfig } from "../src/config/loader";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { MockAdapter } from "../src/tui/adapters/mock";
import { CONFIG_DEFAULTS } from "../src/config/loader";
import { PhaseExecutor, WorkerError } from "../src/controller/phase-executor";
import { WorkExecutionLoop } from "../src/controller/execution-loop";
import { WorkController } from "../src/controller/work";
import { claudeEngine } from "../src/engines/providers/claude/index";
import { parseStateFile } from "../src/state/reader";
import { lockPathFor } from "../src/state/lock";
import { buildPhasePrompt, readCachedFile, parseContextFile, clearFileCache } from "../src/controller/templates";
import { parsePlan } from "../src/controller/plan-parser";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");
const TMP_DIR = path.join(os.tmpdir(), `flywheel-ctrl-test-${process.pid}-${Date.now()}`);

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

/** Mock ProcessSpawner that returns predetermined results in sequence. */
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

afterEach(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // May not exist
  }
  clearFileCache();
});

// ---------------------------------------------------------------------------
// 4.3 Template tests
// ---------------------------------------------------------------------------

describe("Templates", () => {
  describe("buildPhasePrompt", () => {
    it("builds prompt with phase content and completion instruction", () => {
      const planContent = readFixture("two-phase-plan.md");
      const phases = parsePlan(planContent);
      const prompt = buildPhasePrompt({
        phase: phases[0],
        keyDecisions: [],
        fileReferences: [],
      });

      expect(prompt).toContain("You are executing Phase 1: Setup project structure");
      expect(prompt).toContain("## Task");
      expect(prompt).toContain("## Completion");
      expect(prompt).toContain("<promise>COMPLETE</promise>");
    });

    it("includes steps checklist", () => {
      const planContent = readFixture("two-phase-plan.md");
      const phases = parsePlan(planContent);
      const prompt = buildPhasePrompt({
        phase: phases[0],
        keyDecisions: [],
        fileReferences: [],
      });

      expect(prompt).toContain("## Steps");
      expect(prompt).toContain("- [ ] Create directory layout");
      expect(prompt).toContain("- [ ] Initialize configuration files");
    });

    it("includes key decisions when provided", () => {
      const planContent = readFixture("two-phase-plan.md");
      const phases = parsePlan(planContent);
      const prompt = buildPhasePrompt({
        phase: phases[0],
        keyDecisions: ["Used TDD approach", "Chose Zod for validation"],
        fileReferences: [],
      });

      expect(prompt).toContain("## Key Decisions");
      expect(prompt).toContain("- Used TDD approach");
      expect(prompt).toContain("- Chose Zod for validation");
    });

    it("includes file references when provided", () => {
      const planContent = readFixture("two-phase-plan.md");
      const phases = parsePlan(planContent);
      const prompt = buildPhasePrompt({
        phase: phases[0],
        keyDecisions: [],
        fileReferences: ["src/index.ts", "tests/main.test.ts"],
      });

      expect(prompt).toContain("## File References");
      expect(prompt).toContain("- src/index.ts");
    });

    it("includes project cwd when provided", () => {
      const planContent = readFixture("two-phase-plan.md");
      const phases = parsePlan(planContent);
      const prompt = buildPhasePrompt({
        phase: phases[0],
        keyDecisions: [],
        fileReferences: [],
        projectCwd: "/home/user/project",
      });

      expect(prompt).toContain("## Working Directory");
      expect(prompt).toContain("/home/user/project");
    });

    it("omits empty sections", () => {
      const planContent = readFixture("two-phase-plan.md");
      const phases = parsePlan(planContent);
      const prompt = buildPhasePrompt({
        phase: phases[0],
        keyDecisions: [],
        fileReferences: [],
      });

      expect(prompt).not.toContain("## Key Decisions");
      expect(prompt).not.toContain("## File References");
      expect(prompt).not.toContain("## Working Directory");
    });
  });

  describe("parseContextFile", () => {
    it("extracts file references from markdown list", () => {
      const content = "# Context\n- src/index.ts\n- tests/main.test.ts\n";
      const refs = parseContextFile(content);
      expect(refs).toEqual(["src/index.ts", "tests/main.test.ts"]);
    });

    it("strips backtick wrapping", () => {
      const content = "- `src/index.ts`\n- `lib/utils.ts`\n";
      const refs = parseContextFile(content);
      expect(refs).toEqual(["src/index.ts", "lib/utils.ts"]);
    });

    it("returns empty array for empty content", () => {
      const refs = parseContextFile("");
      expect(refs).toEqual([]);
    });

    it("ignores non-list lines", () => {
      const content = "# Header\nSome text\n- file.ts\n";
      const refs = parseContextFile(content);
      expect(refs).toEqual(["file.ts"]);
    });
  });

  describe("readCachedFile", () => {
    it("reads file and caches result", () => {
      const dir = ensureTmpDir();
      const filePath = path.join(dir, "test.txt");
      fs.writeFileSync(filePath, "hello");

      const result1 = readCachedFile(filePath);
      expect(result1).toBe("hello");

      // Second read should hit cache (same mtime)
      const result2 = readCachedFile(filePath);
      expect(result2).toBe("hello");
    });

    it("returns null for non-existent file", () => {
      const result = readCachedFile("/nonexistent/path.txt");
      expect(result).toBeNull();
    });

    it("re-reads on mtime change", () => {
      const dir = ensureTmpDir();
      const filePath = path.join(dir, "test.txt");
      fs.writeFileSync(filePath, "first");

      const result1 = readCachedFile(filePath);
      expect(result1).toBe("first");

      // Write new content, then set mtime to the future to guarantee cache invalidation
      fs.writeFileSync(filePath, "second");
      const futureTime = Date.now() / 1000 + 10;
      fs.utimesSync(filePath, futureTime, futureTime);

      const result2 = readCachedFile(filePath);
      expect(result2).toBe("second");
    });
  });
});

// ---------------------------------------------------------------------------
// 4.3 PhaseExecutor tests
// ---------------------------------------------------------------------------

describe("PhaseExecutor", () => {
  let bus: EventBus;
  let adapter: MockAdapter;
  let spawner: MockSpawner;

  beforeEach(() => {
    bus = new EventBus();
    adapter = new MockAdapter();
    adapter.connect(bus);
    spawner = new MockSpawner();
  });

  it("executes phase and returns result on success", async () => {
    spawner.results = [successResult()];

    const executor = new PhaseExecutor({
      spawner,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig(),
      engine: claudeEngine,
      workflowId: "test-wf",
    });

    const result = await executor.execute({
      phaseIndex: 0,
      prompt: "test prompt",
    });

    expect(result.exitCode).toBe(0);
    expect(result.failure).toBeUndefined();
    expect(spawner.calls).toHaveLength(1);
  });

  it("emits worker:spawned and worker:completed on success", async () => {
    spawner.results = [successResult()];

    const executor = new PhaseExecutor({
      spawner,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig(),
      engine: claudeEngine,
      workflowId: "test-wf",
    });

    await executor.execute({ phaseIndex: 0, prompt: "test" });

    const eventTypes = adapter.events.map((e) => e.type);
    expect(eventTypes).toContain("worker:spawned");
    expect(eventTypes).toContain("worker:completed");
  });

  it("retries on retryable failure", async () => {
    spawner.results = [
      failureResult({ kind: "transient", message: "connection reset" }),
      successResult(),
    ];

    const executor = new PhaseExecutor({
      spawner,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig({ max_retries: 3 }),
      engine: claudeEngine,
      workflowId: "test-wf",
    });

    const result = await executor.execute({ phaseIndex: 0, prompt: "test" });

    expect(result.exitCode).toBe(0);
    expect(spawner.calls).toHaveLength(2); // initial + 1 retry
  });

  it("emits worker:retrying on retry", async () => {
    spawner.results = [
      failureResult({ kind: "timeout", timeoutMs: 60000, message: "timed out" }),
      successResult(),
    ];

    const executor = new PhaseExecutor({
      spawner,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig({ max_retries: 3 }),
      engine: claudeEngine,
      workflowId: "test-wf",
    });

    await executor.execute({ phaseIndex: 0, prompt: "test" });

    const retryEvents = adapter.events.filter((e) => e.type === "worker:retrying");
    expect(retryEvents).toHaveLength(1);
    expect((retryEvents[0] as any).attempt).toBe(1);
  });

  it("throws on non-retryable failure", async () => {
    spawner.results = [
      failureResult({ kind: "exit_code", exitCode: 1, message: "Process exited with code 1" }),
    ];

    const executor = new PhaseExecutor({
      spawner,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig({ max_retries: 3 }),
      engine: claudeEngine,
      workflowId: "test-wf",
    });

    await expect(
      executor.execute({ phaseIndex: 0, prompt: "test" }),
    ).rejects.toThrow("Process exited with code 1");

    // Should only call once (no retries for non-retryable)
    expect(spawner.calls).toHaveLength(1);
  });

  it("exhausts retries on persistent retryable failure", async () => {
    const transientFailure = failureResult({
      kind: "transient",
      message: "ECONNRESET",
    });
    spawner.results = [transientFailure, transientFailure, transientFailure, transientFailure];

    const executor = new PhaseExecutor({
      spawner,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig({ max_retries: 2 }),
      engine: claudeEngine,
      workflowId: "test-wf",
    });

    await expect(
      executor.execute({ phaseIndex: 0, prompt: "test" }),
    ).rejects.toThrow("ECONNRESET");

    // initial + 2 retries = 3 total
    expect(spawner.calls).toHaveLength(3);
  });

  it("passes cwd and timeout to spawner", async () => {
    spawner.results = [successResult()];

    const executor = new PhaseExecutor({
      spawner,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig({ timeout_minutes: 30 }),
      engine: claudeEngine,
      workflowId: "test-wf",
    });

    await executor.execute({
      phaseIndex: 0,
      prompt: "test",
      cwd: "/some/dir",
    });

    expect(spawner.calls[0].options?.cwd).toBe("/some/dir");
    expect(spawner.calls[0].options?.timeoutMs).toBe(30 * 60_000);
  });

  it("uses engine to build command and passes prompt via stdin", async () => {
    spawner.results = [successResult()];

    const executor = new PhaseExecutor({
      spawner,
      emitter: createFlywheelEmitter(bus),
      config: defaultConfig(),
      engine: claudeEngine,
      workflowId: "test-wf",
    });

    await executor.execute({ phaseIndex: 0, prompt: "do stuff" });

    expect(spawner.calls[0].command).toBe("claude");
    expect(spawner.calls[0].args).toContain("--print");
    expect(spawner.calls[0].args).toContain("--output-format");
    expect(spawner.calls[0].args).toContain("stream-json");
    expect(spawner.calls[0].args).toContain("--dangerously-skip-permissions");
    // Prompt is passed via stdin, not as an arg
    expect(spawner.calls[0].options?.stdin).toBe("do stuff");
  });
});

// ---------------------------------------------------------------------------
// 4.3 WorkExecutionLoop tests
// ---------------------------------------------------------------------------

describe("WorkExecutionLoop", () => {
  let bus: EventBus;
  let adapter: MockAdapter;
  let spawner: MockSpawner;
  let tmpDir: string;

  beforeEach(() => {
    bus = new EventBus();
    adapter = new MockAdapter();
    adapter.connect(bus);
    spawner = new MockSpawner();
    tmpDir = ensureTmpDir();
  });

  function createLoop(
    planFixture: string,
    overrides?: {
      config?: Partial<FlywheelConfig>;
      stateContent?: string;
    },
  ): WorkExecutionLoop {
    const planPath = path.join(FIXTURES_DIR, planFixture);
    const statePath = path.join(tmpDir, "test.state.md");
    const config = defaultConfig(overrides?.config);

    if (overrides?.stateContent) {
      fs.writeFileSync(statePath, overrides.stateContent);
    }

    const workflowId = "test-workflow-id";
    const emitter = createFlywheelEmitter(bus);

    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId,
    });

    return new WorkExecutionLoop({
      planPath,
      statePath,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId,
      baseDir: tmpDir,
    });
  }

  it("reads plan, parses phases, finds first unchecked phase", async () => {
    spawner.results = [successResult(), successResult()];

    const loop = createLoop("two-phase-plan.md");
    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(result.phasesCompleted).toBe(2);
    expect(result.phasesTotal).toBe(2);
  });

  it("assembles static prompt with phase content + completion wrapper", async () => {
    spawner.results = [successResult(), successResult()];

    const loop = createLoop("two-phase-plan.md");
    await loop.run();

    // Verify the prompt was passed to spawner via stdin
    expect(spawner.calls).toHaveLength(2);
    const firstPrompt = spawner.calls[0].options?.stdin;
    expect(firstPrompt).toContain("Phase 1: Setup project structure");
    expect(firstPrompt).toContain("<promise>COMPLETE</promise>");
  });

  it("spawns worker and writes updated state file on success", async () => {
    spawner.results = [successResult(), successResult()];
    const statePath = path.join(tmpDir, "test.state.md");

    const loop = createLoop("two-phase-plan.md");
    await loop.run();

    // Verify state file was created/updated
    expect(fs.existsSync(statePath)).toBe(true);
    const state = parseStateFile(fs.readFileSync(statePath, "utf-8"));
    expect(state.phases[0].status).toBe("completed");
    expect(state.phases[1].status).toBe("completed");
  });

  it("loops to next phase until all complete", async () => {
    spawner.results = [successResult(), successResult()];

    const loop = createLoop("two-phase-plan.md");
    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(spawner.calls).toHaveLength(2);
  });

  it("resumes from last incomplete phase on restart", async () => {
    // State file with phase 1 completed
    const stateContent = `---
plan: two-phase-plan.md
status: in_progress
schema_version: 3
---

# Execution State: two-phase-plan

## Progress
- [x] Phase 1: Setup project structure
- [ ] Phase 2: Implement core logic

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;

    spawner.results = [successResult()];

    const loop = createLoop("two-phase-plan.md", { stateContent });
    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(result.phasesCompleted).toBe(2);
    // Only one spawn call (phase 2), since phase 1 was already completed
    expect(spawner.calls).toHaveLength(1);
  });

  it("emits correct FlywheelEvent types (verified via MockAdapter)", async () => {
    spawner.results = [successResult(), successResult()];

    const loop = createLoop("two-phase-plan.md");
    await loop.run();

    const eventTypes = adapter.events.map((e) => e.type);

    expect(eventTypes).toContain("workflow:started");
    expect(eventTypes).toContain("phase:started");
    expect(eventTypes).toContain("worker:spawned");
    expect(eventTypes).toContain("worker:completed");
    expect(eventTypes).toContain("phase:completed");
    expect(eventTypes).toContain("workflow:completed");
  });

  it("emits phase:started and phase:completed for each phase", async () => {
    spawner.results = [successResult(), successResult()];

    const loop = createLoop("two-phase-plan.md");
    await loop.run();

    const phaseStarted = adapter.events.filter((e) => e.type === "phase:started") as any[];
    const phaseCompleted = adapter.events.filter((e) => e.type === "phase:completed") as any[];

    expect(phaseStarted).toHaveLength(2);
    expect(phaseCompleted).toHaveLength(2);
    expect(phaseStarted[0].phaseIndex).toBe(0);
    expect(phaseStarted[0].phaseName).toBe("Setup project structure");
    expect(phaseStarted[1].phaseIndex).toBe(1);
  });

  it("acquires full-cycle lock before state file writes", async () => {
    spawner.results = [successResult()];

    const loop = createLoop("two-phase-plan.md");
    await loop.run();

    // Lock should have been released (file should not exist)
    const lockPath_ = lockPathFor("two-phase-plan", tmpDir);
    expect(fs.existsSync(lockPath_)).toBe(false);
  });

  it("handles worker failure and stops execution", async () => {
    spawner.results = [
      failureResult({ kind: "exit_code", exitCode: 1, message: "Process failed" }),
    ];

    const loop = createLoop("two-phase-plan.md");
    const result = await loop.run();

    expect(result.completed).toBe(false);
    expect(result.phasesCompleted).toBe(0);
    expect(result.reason).toContain("Process failed");

    const eventTypes = adapter.events.map((e) => e.type);
    expect(eventTypes).toContain("phase:failed");
    expect(eventTypes).toContain("worker:failed");
    expect(eventTypes).not.toContain("workflow:completed");
  });

  it("adds error to Error Log on failure", async () => {
    spawner.results = [
      failureResult({ kind: "exit_code", exitCode: 1, message: "Build failed" }),
    ];

    const statePath = path.join(tmpDir, "test.state.md");
    const loop = createLoop("two-phase-plan.md");
    await loop.run();

    const state = parseStateFile(fs.readFileSync(statePath, "utf-8"));
    expect(state.errorLog.length).toBeGreaterThan(0);
    expect(state.errorLog[state.errorLog.length - 1].error).toContain("Build failed");
  });

  it("emits workflow:failed when plan has no phases", async () => {
    // Create an empty plan file
    const emptyPlanPath = path.join(tmpDir, "empty.md");
    fs.writeFileSync(emptyPlanPath, "# Empty Plan\n\nNo phases here.\n");

    const config = defaultConfig();
    const workflowId = "test-wf-empty";
    const emitter = createFlywheelEmitter(bus);
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId,
    });

    const loop = new WorkExecutionLoop({
      planPath: emptyPlanPath,
      statePath: path.join(tmpDir, "empty.state.md"),
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId,
      baseDir: tmpDir,
    });

    const result = await loop.run();

    expect(result.completed).toBe(false);
    expect(result.reason).toBe("No phases found in plan");

    const eventTypes = adapter.events.map((e) => e.type);
    expect(eventTypes).toContain("workflow:failed");
  });

  it("handles shutdown request mid-execution", async () => {
    // Phase 1 succeeds, then shutdown is requested
    spawner.results = [successResult(), successResult()];

    const loop = createLoop("two-phase-plan.md");

    // Request shutdown after first phase completes
    bus.subscribeToType("phase:completed", (event) => {
      if (event.phaseIndex === 0) {
        loop.requestShutdown();
      }
    });

    const result = await loop.run();

    expect(result.completed).toBe(false);
    expect(result.phasesCompleted).toBe(1);
    expect(result.reason).toBe("Shutdown requested");

    const eventTypes = adapter.events.map((e) => e.type);
    expect(eventTypes).toContain("workflow:interrupted");
  });

  it("checks for active skill session on startup", async () => {
    // Create .flywheel/session.md with active_skill: work-implementation
    const sessionDir = path.join(tmpDir, ".flywheel");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session.md"),
      "---\nactive_skill: work-implementation\n---\n",
    );

    spawner.results = [successResult(), successResult()];

    // Capture console.warn
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnings.push(args.join(" "));
    };

    const loop = createLoop("two-phase-plan.md");
    await loop.run();

    console.warn = origWarn;

    expect(warnings.some((w) => w.includes("Active skill session detected"))).toBe(true);
  });

  it("creates initial state file when none exists", async () => {
    spawner.results = [successResult(), successResult()];
    const statePath = path.join(tmpDir, "test.state.md");

    expect(fs.existsSync(statePath)).toBe(false);

    const loop = createLoop("two-phase-plan.md");
    await loop.run();

    expect(fs.existsSync(statePath)).toBe(true);
    const state = parseStateFile(fs.readFileSync(statePath, "utf-8"));
    expect(state.phases).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4.3 WorkExecutionLoop: [~] approval tests
// ---------------------------------------------------------------------------

describe("WorkExecutionLoop — [~] approval handling", () => {
  let bus: EventBus;
  let adapter: MockAdapter;
  let spawner: MockSpawner;
  let tmpDir: string;

  beforeEach(() => {
    bus = new EventBus();
    adapter = new MockAdapter();
    adapter.connect(bus);
    spawner = new MockSpawner();
    tmpDir = ensureTmpDir();
  });

  function createLoopWithState(stateContent: string): WorkExecutionLoop {
    const planPath = path.join(FIXTURES_DIR, "two-phase-plan.md");
    const statePath = path.join(tmpDir, "test.state.md");
    const config = defaultConfig();

    fs.writeFileSync(statePath, stateContent);

    const workflowId = "test-wf-approval";
    const emitter = createFlywheelEmitter(bus);
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId,
    });

    return new WorkExecutionLoop({
      planPath,
      statePath,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId,
      baseDir: tmpDir,
    });
  }

  it("prompts user via onApprovalDecision for [~] phases", async () => {
    const stateContent = `---
plan: two-phase-plan.md
status: in_progress
schema_version: 3
---

# Execution State: two-phase-plan

## Progress
- [~] Phase 1: Setup project structure
- [ ] Phase 2: Implement core logic

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;

    // Set up approval callback to auto-approve
    adapter.onApprovalDecision = (approved: boolean) => {};
    bus.subscribeToType("approval:requested", () => {
      // Simulate user approving
      if (adapter.onApprovalDecision) {
        adapter.onApprovalDecision(true);
      }
    });

    spawner.results = [successResult()]; // For phase 2

    const loop = createLoopWithState(stateContent);
    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(result.phasesCompleted).toBe(2);

    const eventTypes = adapter.events.map((e) => e.type);
    expect(eventTypes).toContain("approval:requested");
    expect(eventTypes).toContain("approval:received");
  });

  it("handles [~] rejection: writes [~] to state and adds to Error Log", async () => {
    const stateContent = `---
plan: two-phase-plan.md
status: in_progress
schema_version: 3
---

# Execution State: two-phase-plan

## Progress
- [~] Phase 1: Setup project structure
- [ ] Phase 2: Implement core logic

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;

    // Set up rejection
    adapter.onApprovalDecision = (approved: boolean) => {};
    bus.subscribeToType("approval:requested", () => {
      if (adapter.onApprovalDecision) {
        adapter.onApprovalDecision(false);
      }
    });

    const loop = createLoopWithState(stateContent);
    const result = await loop.run();

    expect(result.completed).toBe(false);
    expect(result.reason).toContain("approval rejected");

    // Verify state still has [~]
    const statePath = path.join(tmpDir, "test.state.md");
    const state = parseStateFile(fs.readFileSync(statePath, "utf-8"));
    expect(state.phases[0].status).toBe("in_progress");

    // Error log should have rejection entry
    expect(state.errorLog.length).toBeGreaterThan(0);
    expect(state.errorLog[state.errorLog.length - 1].error).toContain("approval rejected");
  });

  it("on resume after [~] rejection: re-prompts user for approval", async () => {
    // First run with rejection
    const stateContent1 = `---
plan: two-phase-plan.md
status: in_progress
schema_version: 3
---

# Execution State: two-phase-plan

## Progress
- [~] Phase 1: Setup project structure
- [ ] Phase 2: Implement core logic

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;

    // First run: reject
    adapter.onApprovalDecision = (approved: boolean) => {};
    const unsub1 = bus.subscribeToType("approval:requested", () => {
      if (adapter.onApprovalDecision) {
        adapter.onApprovalDecision(false);
      }
    });

    const loop1 = createLoopWithState(stateContent1);
    await loop1.run();

    // Second run: the state still has [~], so it should prompt again
    // Remove the rejection listener and reset adapter
    unsub1();
    adapter.reset();
    spawner.reset();

    // This time approve
    adapter.onApprovalDecision = (approved: boolean) => {};
    bus.subscribeToType("approval:requested", () => {
      if (adapter.onApprovalDecision) {
        adapter.onApprovalDecision(true);
      }
    });

    spawner.results = [successResult()]; // For phase 2

    // Load updated state (which still has [~])
    const statePath = path.join(tmpDir, "test.state.md");
    const updatedState = fs.readFileSync(statePath, "utf-8");

    const planPath = path.join(FIXTURES_DIR, "two-phase-plan.md");
    const config = defaultConfig();
    const workflowId = "test-wf-resume";
    const emitter = createFlywheelEmitter(bus);
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId,
    });

    const loop2 = new WorkExecutionLoop({
      planPath,
      statePath,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId,
      baseDir: tmpDir,
    });

    const result2 = await loop2.run();

    expect(result2.completed).toBe(true);

    // Verify approval was requested again
    const approvalEvents = adapter.events.filter((e) => e.type === "approval:requested");
    expect(approvalEvents).toHaveLength(1);
  });

  it("skips approval when skip_approval_gates is true", async () => {
    const stateContent = `---
plan: two-phase-plan.md
status: in_progress
schema_version: 3
---

# Execution State: two-phase-plan

## Progress
- [~] Phase 1: Setup project structure
- [ ] Phase 2: Implement core logic

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;

    spawner.results = [successResult()]; // For phase 2

    const planPath = path.join(FIXTURES_DIR, "two-phase-plan.md");
    const statePath = path.join(tmpDir, "test.state.md");
    const config = defaultConfig({ skip_approval_gates: true });

    fs.writeFileSync(statePath, stateContent);

    const workflowId = "test-wf-skip";
    const emitter = createFlywheelEmitter(bus);
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId,
    });

    const loop = new WorkExecutionLoop({
      planPath,
      statePath,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId,
      baseDir: tmpDir,
    });

    const result = await loop.run();

    expect(result.completed).toBe(true);
    expect(result.phasesCompleted).toBe(2);
  });

  it("auto-approves when no onApprovalDecision callback is set", async () => {
    const stateContent = `---
plan: two-phase-plan.md
status: in_progress
schema_version: 3
---

# Execution State: two-phase-plan

## Progress
- [~] Phase 1: Setup project structure
- [ ] Phase 2: Implement core logic

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;

    spawner.results = [successResult()]; // For phase 2

    // Don't set any onApprovalDecision
    adapter.onApprovalDecision = undefined;

    const planPath = path.join(FIXTURES_DIR, "two-phase-plan.md");
    const statePath = path.join(tmpDir, "test.state.md");
    const config = defaultConfig();

    fs.writeFileSync(statePath, stateContent);

    const workflowId = "test-wf-autoapprove";
    const emitter = createFlywheelEmitter(bus);
    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine: claudeEngine,
      workflowId,
    });

    const loop = new WorkExecutionLoop({
      planPath,
      statePath,
      executor,
      emitter,
      config,
      ui: adapter,
      workflowId,
      baseDir: tmpDir,
    });

    const result = await loop.run();

    expect(result.completed).toBe(true);

    const approvalReceived = adapter.events.filter((e) => e.type === "approval:received") as any[];
    expect(approvalReceived).toHaveLength(1);
    expect(approvalReceived[0].skipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4.3 WorkController tests
// ---------------------------------------------------------------------------

describe("WorkController", () => {
  let spawner: MockSpawner;
  let adapter: MockAdapter;
  let tmpDir: string;

  beforeEach(() => {
    spawner = new MockSpawner();
    adapter = new MockAdapter();
    tmpDir = ensureTmpDir();
  });

  it("composes all components and runs workflow", async () => {
    spawner.results = [successResult(), successResult()];

    // Copy fixture to tmp dir
    const planPath = path.join(tmpDir, "test-plan.md");
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "two-phase-plan.md"),
      planPath,
    );

    const controller = new WorkController({
      config: defaultConfig(),
      spawner,
      engine: claudeEngine,
      ui: adapter,
      baseDir: tmpDir,
    });

    const result = await controller.run(planPath);

    expect(result.completed).toBe(true);
    expect(result.phasesCompleted).toBe(2);

    await controller.shutdown();
  });

  it("shutdown stops UI and disconnects", async () => {
    const controller = new WorkController({
      config: defaultConfig(),
      spawner,
      engine: claudeEngine,
      ui: adapter,
      baseDir: tmpDir,
    });

    expect(adapter.isRunning()).toBe(true);
    expect(adapter.isConnected()).toBe(true);

    await controller.shutdown();

    expect(adapter.isRunning()).toBe(false);
    expect(adapter.isConnected()).toBe(false);
  });

  it("events are visible on the event bus", async () => {
    spawner.results = [successResult()];

    const planPath = path.join(tmpDir, "test-plan.md");
    fs.copyFileSync(
      path.join(FIXTURES_DIR, "two-phase-plan.md"),
      planPath,
    );

    const controller = new WorkController({
      config: defaultConfig(),
      spawner,
      engine: claudeEngine,
      ui: adapter,
      baseDir: tmpDir,
    });

    await controller.run(planPath);

    // Events should be captured by the MockAdapter
    const eventTypes = adapter.events.map((e) => e.type);
    expect(eventTypes).toContain("workflow:started");
    expect(eventTypes).toContain("workflow:completed");

    await controller.shutdown();
  });
});

// ---------------------------------------------------------------------------
// CLI args tests are in cli.test.ts
// ---------------------------------------------------------------------------
