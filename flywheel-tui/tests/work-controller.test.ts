import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "node:path";
import { WorkController, type WorkOptions } from "../src/controller/work";
import { ExecutionLoop } from "../src/controller/execution-loop";
import { EventBus } from "../src/events/event-bus";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../src/config/loader";
import type { ProcessSpawner } from "../src/worker/spawner";
import type { Engine } from "../src/engines/core/types";
import type { IWorkflowUI } from "../src/tui/adapters/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<FlywheelConfig> = {}): FlywheelConfig {
  return { ...CONFIG_DEFAULTS, ...overrides };
}

function makeFakeEngine(): Engine {
  return {
    metadata: {
      id: "test",
      name: "Test",
      cliBinary: "test-engine",
      defaultModel: "test-model",
      installCommand: "npm install test",
      description: "Test engine",
      order: 1,
      supportsStreamingInput: false,
      supportsToolScoping: false,
    },
    buildCommand: () => ({
      command: "test-engine",
      args: [],
      stdinPrompt: true,
    }),
    listModels: async () => [],
  } as unknown as Engine;
}

function makeFakeSpawner(): ProcessSpawner {
  return {
    spawn: async () => ({
      result: Promise.resolve({
        output: "test output",
        exitCode: 0,
        truncated: false,
        durationMs: 100,
      }),
    }),
  } as unknown as ProcessSpawner;
}

function makeFakeUI(): IWorkflowUI {
  return {
    connect: () => {},
    start: () => {},
    stop: () => {},
    disconnect: () => {},
    isConnected: () => true,
    isRunning: () => true,
    onApprovalDecision: undefined,
  } as unknown as IWorkflowUI;
}

const PLAN_FIXTURE = path.resolve(__dirname, "fixtures/two-phase-plan.md");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkController", () => {
  let eventBus: EventBus;
  let controller: WorkController;

  beforeEach(() => {
    eventBus = new EventBus();
    controller = new WorkController({
      config: makeConfig(),
      spawner: makeFakeSpawner(),
      engine: makeFakeEngine(),
      ui: makeFakeUI(),
      eventBus,
    });
  });

  describe("getLoop()", () => {
    it("returns null before run() is called", () => {
      expect(controller.getLoop()).toBeNull();
    });
  });

  describe("onLoopReady callback", () => {
    it("fires with the ExecutionLoop before loop.run() starts", async () => {
      let callbackLoop: ExecutionLoop | null = null;
      let callbackFired = false;

      // Use onLoopReady to capture the loop and immediately shut it down
      // so it doesn't try to spawn real workers.
      const result = await controller.run(PLAN_FIXTURE, (loop) => {
        callbackFired = true;
        callbackLoop = loop;
        // Shut down immediately to prevent actual worker spawning
        loop.requestShutdown();
      });

      expect(callbackFired).toBe(true);
      expect(callbackLoop).toBeInstanceOf(ExecutionLoop);
      // The loop should be the same instance as getLoop()
      expect(callbackLoop).not.toBeNull();
      expect(controller.getLoop()).toBe(callbackLoop);
      // Since we shut down immediately, it should not have completed
      expect(result.completed).toBe(false);
      expect(result.reason).toContain("Shutdown");
    });

    it("getLoop() returns the same instance as the callback argument", async () => {
      let callbackLoop: ExecutionLoop | null = null;

      await controller.run(PLAN_FIXTURE, (loop) => {
        callbackLoop = loop;
        // Also verify getLoop() returns the loop at callback time
        expect(controller.getLoop()).toBe(loop);
        loop.requestShutdown();
      });

      expect(callbackLoop).not.toBeNull();
    });

    it("run() works without onLoopReady (backward compatible)", async () => {
      // Shut down the controller quickly via event-driven approach
      // by requesting shutdown after a short delay
      const runPromise = controller.run(PLAN_FIXTURE);

      // Give run() a tick to set up the loop, then shut it down
      await new Promise((r) => setTimeout(r, 10));
      await controller.shutdown();

      const result = await runPromise;
      // Should complete (possibly with shutdown) without errors
      expect(result).toBeDefined();
      expect(typeof result.completed).toBe("boolean");
    });
  });
});
