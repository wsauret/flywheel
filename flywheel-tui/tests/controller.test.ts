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
import { WorkController } from "../src/controller/work";
import { claudeEngine } from "../src/engines/providers/claude/index";
import { parseStateFile } from "../src/state/reader";
import { lockPathFor } from "../src/state/lock";
import { readCachedFile, parseContextFile, clearFileCache } from "../src/controller/templates";
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

// NOTE: WorkExecutionLoop and approval handling tests removed.
// Equivalent tests now live in:
//   - tests/unified-execution-loop.test.ts (ExecutionLoop)
//   - tests/approval-handler.test.ts (UIApprovalHandler)
//   - tests/state-persistence.test.ts (FileStatePersistence)

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
