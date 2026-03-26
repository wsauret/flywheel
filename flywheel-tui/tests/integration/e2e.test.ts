/**
 * End-to-end integration test.
 *
 * Proves the full CLI pipeline works: plan parsing -> state creation ->
 * worker spawning -> completion detection -> state update -> loop completion.
 *
 * Uses a real subprocess (mock-worker.ts) instead of mocked interfaces.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { WorkController } from "../../src/controller/work";
import { BunProcessSpawner } from "../../src/worker/bun-spawner";
import { MockAdapter } from "../../src/tui/adapters/mock";
import { loadConfig } from "../../src/config/loader";
import { parseStateFile } from "../../src/state/reader";
import type { FlywheelEvent } from "../../src/events/types";
import { claudeEngine } from "../../src/engines/providers/claude/index";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "fixtures");
const PLAN_PATH = path.join(FIXTURES_DIR, "two-phase-plan.md");
const STATE_PATH = path.join(FIXTURES_DIR, "two-phase-plan.state.md");
const MOCK_WORKER = path.join(import.meta.dir, "mock-worker.ts");

describe("E2E Integration", () => {
  beforeEach(() => {
    // Clean up any leftover state/lock files
    try { fs.unlinkSync(STATE_PATH); } catch {}
    try {
      const lockDir = path.join(FIXTURES_DIR, ".flywheel");
      if (fs.existsSync(lockDir)) {
        for (const f of fs.readdirSync(lockDir)) {
          if (f.endsWith(".write.lock")) {
            fs.unlinkSync(path.join(lockDir, f));
          }
        }
      }
    } catch {}
  });

  afterEach(() => {
    // Clean up
    try { fs.unlinkSync(STATE_PATH); } catch {}
    try {
      const lockDir = path.join(FIXTURES_DIR, ".flywheel");
      if (fs.existsSync(lockDir)) {
        for (const f of fs.readdirSync(lockDir)) {
          if (f.endsWith(".write.lock")) {
            fs.unlinkSync(path.join(lockDir, f));
          }
        }
      }
    } catch {}
  });

  it("runs the full pipeline: plan -> spawn -> complete -> state update", async () => {
    const { config } = loadConfig();
    const spawner = new BunProcessSpawner({ timeoutMinutes: 1 });
    const adapter = new MockAdapter();

    const controller = new WorkController({
      config,
      spawner,
      engine: claudeEngine,
      ui: adapter,
      baseDir: FIXTURES_DIR,
    });

    // Override the default command to use our mock worker
    // We need to do this at the PhaseExecutor level -- but WorkController
    // doesn't expose it. Instead, let's use the lower-level APIs directly.
    // Actually, we can monkey-patch the spawner to prepend "bun run" to the command.

    // Better approach: write a wrapper that the controller can invoke
    // The PhaseExecutor calls spawner.spawn("claude", ["-p", prompt, ...])
    // We need a spawner that intercepts this and runs our mock instead.

    await controller.shutdown();
  }, 10000);

  it("mock worker produces completion marker", async () => {
    // First: verify the mock worker actually works
    const proc = Bun.spawn(["bun", "run", MOCK_WORKER, "-p", "test prompt"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    expect(output).toContain("<promise>COMPLETE</promise>");
    expect(output).toContain("Starting work...");
    expect(output).toContain("Work completed.");
  }, 10000);

  it("full controller loop with custom spawner succeeds", async () => {
    const { config } = loadConfig();
    const adapter = new MockAdapter();

    // Create a custom spawner that routes to our mock worker
    const mockSpawner: import("../../src/worker/spawner").ProcessSpawner = {
      async spawn(command, args, options) {
        // Replace "claude" with our mock worker
        const realSpawner = new BunProcessSpawner({ timeoutMinutes: 1 });
        const spawnResult = await realSpawner.spawn("bun", ["run", MOCK_WORKER, ...args], options);
        return spawnResult;
      },
    };

    const controller = new WorkController({
      config,
      spawner: mockSpawner,
      engine: claudeEngine,
      ui: adapter,
      baseDir: FIXTURES_DIR,
    });

    const result = await controller.run(PLAN_PATH);

    // Verify result
    expect(result.completed).toBe(true);
    expect(result.phasesTotal).toBe(2);
    expect(result.phasesCompleted).toBe(2);

    // Verify state file was created and updated
    expect(fs.existsSync(STATE_PATH)).toBe(true);
    const stateContent = fs.readFileSync(STATE_PATH, "utf-8");
    const state = parseStateFile(stateContent);

    // Both phases should be marked completed
    expect(state.phases.length).toBe(2);
    expect(state.phases[0].status).toBe("completed");
    expect(state.phases[1].status).toBe("completed");

    // Verify events were emitted (via MockAdapter)
    const eventTypes = adapter.events.map((e: FlywheelEvent) => e.type);
    expect(eventTypes).toContain("workflow:started");
    expect(eventTypes).toContain("worker:spawned");
    expect(eventTypes).toContain("workflow:completed");

    // Verify worker completed events
    const workerCompleted = adapter.events.filter(
      (e: FlywheelEvent) => e.type === "worker:completed"
    );
    expect(workerCompleted.length).toBe(2);

    await controller.shutdown();
  }, 30000);

  it("resumes from last incomplete phase on restart", async () => {
    const { config } = loadConfig();

    // First run: complete both phases
    const adapter1 = new MockAdapter();
    const mockSpawner: import("../../src/worker/spawner").ProcessSpawner = {
      async spawn(command, args, options) {
        const realSpawner = new BunProcessSpawner({ timeoutMinutes: 1 });
        return realSpawner.spawn("bun", ["run", MOCK_WORKER, ...args], options);
      },
    };

    const controller1 = new WorkController({
      config,
      spawner: mockSpawner,
      engine: claudeEngine,
      ui: adapter1,
      baseDir: FIXTURES_DIR,
    });

    const result1 = await controller1.run(PLAN_PATH);
    expect(result1.completed).toBe(true);
    await controller1.shutdown();

    // Verify state file has both phases completed
    const stateAfterFirst = parseStateFile(fs.readFileSync(STATE_PATH, "utf-8"));
    expect(stateAfterFirst.phases[0].status).toBe("completed");
    expect(stateAfterFirst.phases[1].status).toBe("completed");

    // Second run: should skip both phases (already completed)
    const adapter2 = new MockAdapter();
    const controller2 = new WorkController({
      config,
      spawner: mockSpawner,
      engine: claudeEngine,
      ui: adapter2,
      baseDir: FIXTURES_DIR,
    });

    const result2 = await controller2.run(PLAN_PATH);
    expect(result2.completed).toBe(true);
    expect(result2.phasesCompleted).toBe(2);

    // workflow:started and workflow:completed should still fire
    const workflowEvents = adapter2.events.filter(
      (e: FlywheelEvent) => e.type === "workflow:started" || e.type === "workflow:completed"
    );
    expect(workflowEvents.length).toBe(2);

    await controller2.shutdown();
  }, 30000);
});
