import { describe, it, expect, beforeEach } from "bun:test";
import {
  loadConfig,
  FlywheelConfigSchema,
  CONFIG_DEFAULTS,
} from "../src/config";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import type { FlywheelEvent } from "../src/events/types";
import { WorkerResultSchema } from "../src/schemas/worker";
import { HeadlessAdapter } from "../src/tui/adapters/headless";

// ---------------------------------------------------------------------------
// VAL-REV-007: max_revisions config with correct default and range
// ---------------------------------------------------------------------------

describe("max_revisions config field", () => {
  it("defaults to 1", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_revisions).toBe(1);
    }
  });

  it("accepts values 0-5", () => {
    for (const val of [0, 1, 2, 3, 4, 5]) {
      const result = FlywheelConfigSchema.safeParse({ max_revisions: val });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.max_revisions).toBe(val);
      }
    }
  });

  it("rejects max_revisions < 0", () => {
    const result = FlywheelConfigSchema.safeParse({ max_revisions: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects max_revisions > 5", () => {
    const result = FlywheelConfigSchema.safeParse({ max_revisions: 6 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer max_revisions", () => {
    const result = FlywheelConfigSchema.safeParse({ max_revisions: 1.5 });
    expect(result.success).toBe(false);
  });

  it("CONFIG_DEFAULTS includes max_revisions", () => {
    expect(CONFIG_DEFAULTS.max_revisions).toBe(1);
  });

  it("env var FLYWHEEL_MAX_REVISIONS overrides default", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_MAX_REVISIONS: "3",
    });
    expect(config.max_revisions).toBe(3);
  });

  it("env var FLYWHEEL_MAX_REVISIONS=0 disables revisions", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_MAX_REVISIONS: "0",
    });
    expect(config.max_revisions).toBe(0);
  });

  it("rejects out-of-range max_revisions via env", () => {
    expect(() => {
      loadConfig(undefined, {
        FLYWHEEL_MAX_REVISIONS: "6",
      });
    }).toThrow(/Invalid configuration/);
  });
});

// ---------------------------------------------------------------------------
// VAL-REV-009: evaluator:revision-requested event type
// ---------------------------------------------------------------------------

describe("evaluator:revision-requested event type", () => {
  it("event type exists in FlywheelEvent union (can be emitted)", () => {
    const bus = new EventBus();
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const event: FlywheelEvent = {
      type: "evaluator:revision-requested",
      workflowId: "wf-1",
      phaseIndex: 0,
      revisionAttempt: 1,
      maxRevisions: 2,
      reason: "Output quality insufficient",
      timestamp: Date.now(),
    };

    bus.emit(event);
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("evaluator:revision-requested");
  });

  it("typed listener receives evaluator:revision-requested", () => {
    const bus = new EventBus();
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("evaluator:revision-requested", (e) => received.push(e));

    bus.emit({
      type: "evaluator:revision-requested",
      workflowId: "wf-1",
      phaseIndex: 0,
      revisionAttempt: 1,
      maxRevisions: 2,
      reason: "Needs improvement",
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    if (received[0].type === "evaluator:revision-requested") {
      expect(received[0].workflowId).toBe("wf-1");
      expect(received[0].phaseIndex).toBe(0);
      expect(received[0].revisionAttempt).toBe(1);
      expect(received[0].maxRevisions).toBe(2);
      expect(received[0].reason).toBe("Needs improvement");
      expect(received[0].timestamp).toBeGreaterThan(0);
    }
  });

  it("FlywheelEmitter.evaluatorRevisionRequested() method exists and emits", () => {
    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));

    emitter.evaluatorRevisionRequested("wf-1", 0, 1, 2, "Needs revision");

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("evaluator:revision-requested");
    if (received[0].type === "evaluator:revision-requested") {
      expect(received[0].workflowId).toBe("wf-1");
      expect(received[0].phaseIndex).toBe(0);
      expect(received[0].revisionAttempt).toBe(1);
      expect(received[0].maxRevisions).toBe(2);
      expect(received[0].reason).toBe("Needs revision");
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-REV-002: WorkerResult.sessionId field
// ---------------------------------------------------------------------------

describe("WorkerResult.sessionId field", () => {
  it("schema accepts sessionId field", () => {
    const result = WorkerResultSchema.safeParse({
      output: "test output",
      exitCode: 0,
      truncated: false,
      durationMs: 1000,
      sessionId: "session-abc-123",
      handoffPath: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionId).toBe("session-abc-123");
    }
  });

  it("schema accepts missing sessionId (optional)", () => {
    const result = WorkerResultSchema.safeParse({
      output: "test output",
      exitCode: 0,
      truncated: false,
      durationMs: 1000,
      handoffPath: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sessionId).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// PhaseExecutor resumeSessionId passthrough
// ---------------------------------------------------------------------------

describe("PhaseExecutor resumeSessionId", () => {
  it("ExecutePhaseOptions has resumeSessionId field", async () => {
    // Type check — verify the interface accepts the field by importing it
    const mod = await import("../src/controller/phase-executor");
    // Create options with resumeSessionId to verify the type allows it
    const options: import("../src/controller/phase-executor").ExecutePhaseOptions = {
      phaseIndex: 0,
      prompt: "test prompt",
      resumeSessionId: "session-123",
    };
    expect(options.resumeSessionId).toBe("session-123");
  });

  it("passes resumeSessionId through to engine.buildCommand()", async () => {
    const { PhaseExecutor } = await import("../src/controller/phase-executor");
    const { EventBus, createFlywheelEmitter } = await import("../src/events/event-bus");

    // Track what buildCommand receives
    let capturedOptions: any = null;
    const mockEngine = {
      metadata: {
        id: "test",
        name: "Test Engine",
        cliBinary: "echo",
        defaultModel: "test-model",
        installCommand: "install test",
        description: "test",
        supportsToolScoping: false,
        supportsStreamingInput: false,
      },
      buildCommand: (options: any) => {
        capturedOptions = options;
        return {
          command: "echo",
          args: ["hello"],
          stdinPrompt: false,
        };
      },
      buildDispatcherCommand: () => ({
        command: "echo",
        args: [],
        stdinPrompt: false,
      }),
      listModels: async () => [],
    };

    const mockSpawner = {
      spawn: async () => ({
        result: Promise.resolve({
          output: "done",
          exitCode: 0,
          truncated: false,
          durationMs: 100,
          handoffPath: "",
        }),
      }),
    };

    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);

    const executor = new PhaseExecutor({
      spawner: mockSpawner as any,
      emitter,
      config: { max_retries: 0 } as any,
      engine: mockEngine as any,
      workflowId: "wf-test",
    });

    await executor.execute({
      phaseIndex: 0,
      prompt: "test prompt",
      resumeSessionId: "session-xyz",
    });

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions.resumeSessionId).toBe("session-xyz");
  });
});

// ---------------------------------------------------------------------------
// VAL-REV-010: TUI adapters display revision status
// ---------------------------------------------------------------------------

describe("TUI adapter: evaluator:revision-requested handling", () => {
  it("HeadlessAdapter logs revision event at verbose level", () => {
    const logs: string[] = [];
    const adapter = new HeadlessAdapter({
      logLevel: "verbose",
      logger: (msg) => logs.push(msg),
      timestamps: false,
    });

    const bus = new EventBus();
    adapter.connect(bus);
    adapter.start();

    bus.emit({
      type: "evaluator:revision-requested",
      workflowId: "wf-1",
      phaseIndex: 0,
      revisionAttempt: 1,
      maxRevisions: 2,
      reason: "Output quality insufficient",
      timestamp: Date.now(),
    } as FlywheelEvent);

    expect(logs.some((l) => l.includes("revision") || l.includes("Revision"))).toBe(true);

    adapter.stop();
    adapter.disconnect();
  });

  it("HeadlessAdapter logs revision event at normal level", () => {
    const logs: string[] = [];
    const adapter = new HeadlessAdapter({
      logLevel: "normal",
      logger: (msg) => logs.push(msg),
      timestamps: false,
    });

    const bus = new EventBus();
    adapter.connect(bus);
    adapter.start();

    bus.emit({
      type: "evaluator:revision-requested",
      workflowId: "wf-1",
      phaseIndex: 0,
      revisionAttempt: 1,
      maxRevisions: 2,
      reason: "Output quality insufficient",
      timestamp: Date.now(),
    } as FlywheelEvent);

    expect(logs.some((l) => l.includes("revision") || l.includes("Revision"))).toBe(true);

    adapter.stop();
    adapter.disconnect();
  });
});
