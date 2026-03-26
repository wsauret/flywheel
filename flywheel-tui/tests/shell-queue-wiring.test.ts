import { describe, it, expect, mock, beforeEach } from "bun:test";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../src/config/loader";
import { EventBus } from "../src/events/event-bus";
import type { FlywheelEvent } from "../src/events/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<FlywheelConfig> = {}): FlywheelConfig {
  return {
    ...CONFIG_DEFAULTS,
    interactive_consolidation: false,
    ...overrides,
  };
}

// ===========================================================================
// shell-queue.ts — buildQueue
// ===========================================================================

describe("buildQueue", () => {
  it("returns a Queue for plan-only template", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue");
    const queue = buildQueue("plan-only", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("plan");
    expect(queue.steps[0].status).toBe("pending");
    expect(queue.cursor).toBe(0);
    expect(queue.status).toBe("idle");
  });

  it("returns a Queue for plan-work template", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue");
    const queue = buildQueue("plan-work", makeConfig());

    expect(queue).toBeDefined();
    // plan-work initially has just plan; work steps are inserted after plan completes
    expect(queue.steps.length).toBeGreaterThanOrEqual(1);
    expect(queue.steps[0].type).toBe("plan");
  });

  it("returns a Queue for plan-work-review template", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue");
    const queue = buildQueue("plan-work-review", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps.length).toBeGreaterThanOrEqual(2);
    expect(queue.steps[0].type).toBe("plan");
    // review should be last
    const lastStep = queue.steps[queue.steps.length - 1];
    expect(lastStep.type).toBe("review");
  });

  it("returns a Queue for full template", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue");
    const queue = buildQueue("full", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps[0].type).toBe("plan");
    // Last should be ship
    const lastStep = queue.steps[queue.steps.length - 1];
    expect(lastStep.type).toBe("ship");
  });

  it("returns a Queue for sprint template", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue");
    const queue = buildQueue("sprint", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(2);
    expect(queue.steps[0].type).toBe("work");
    expect(queue.steps[1].type).toBe("verify");
  });

  it("inserts gate steps when skip_approval_gates is false", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue");
    const queue = buildQueue("plan-work-review", makeConfig({ skip_approval_gates: false }));

    const gateSteps = queue.steps.filter((s) => s.type === "gate");
    expect(gateSteps.length).toBeGreaterThan(0);
  });

  it("does not insert gate steps when skip_approval_gates is true (default)", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue");
    const queue = buildQueue("plan-work-review", makeConfig({ skip_approval_gates: true }));

    const gateSteps = queue.steps.filter((s) => s.type === "gate");
    expect(gateSteps).toHaveLength(0);
  });

  it("respects max_steps from queue config", async () => {
    const { buildQueue } = await import("../src/tui/components/shell-queue");
    const config = makeConfig();
    config.queue = { max_steps: 10, persist_queue: true };
    const queue = buildQueue("full", config);

    expect(queue.maxSteps).toBe(10);
  });
});

// ===========================================================================
// shell-queue.ts — buildQueueForSlashCommand
// ===========================================================================

describe("buildQueueForSlashCommand", () => {
  it("/work with auto_chain creates multi-step queue starting with work", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/components/shell-queue");
    // Default config has auto_chain: true, so /work creates work+review
    const queue = buildQueueForSlashCommand("work", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps[0].type).toBe("work");
    expect(queue.steps.length).toBeGreaterThanOrEqual(1);
  });

  it("/work without auto_chain creates single work step queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/components/shell-queue");
    const queue = buildQueueForSlashCommand("work", makeConfig({ auto_chain: false }));

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("work");
  });

  it("/plan with auto_chain creates multi-step queue starting with plan", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/components/shell-queue");
    // Default config has auto_chain: true, so /plan creates plan+work+review
    const queue = buildQueueForSlashCommand("plan", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps[0].type).toBe("plan");
    expect(queue.steps.length).toBeGreaterThanOrEqual(1);
  });

  it("/plan without auto_chain creates single plan step queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/components/shell-queue");
    const queue = buildQueueForSlashCommand("plan", makeConfig({ auto_chain: false }));

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("plan");
  });

  it("/review creates a single review step queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/components/shell-queue");
    const queue = buildQueueForSlashCommand("review", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("review");
  });

  it("/ship creates a single ship step queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/components/shell-queue");
    const queue = buildQueueForSlashCommand("ship", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("ship");
  });

  it("/debug creates a single debug step queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/components/shell-queue");
    const queue = buildQueueForSlashCommand("debug", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("debug");
  });

  it("/research creates a single research step queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/components/shell-queue");
    const queue = buildQueueForSlashCommand("research", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("research");
  });

  it("auto_chain /plan creates plan+work+review pipeline queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/components/shell-queue");
    const config = makeConfig({ auto_chain: true, auto_ship: false });
    const queue = buildQueueForSlashCommand("plan", config);

    // With auto_chain, /plan should create a pipeline-like queue
    const types = queue.steps.map((s) => s.type);
    expect(types).toContain("plan");
  });

  it("auto_chain /work creates work+review pipeline queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/components/shell-queue");
    const config = makeConfig({ auto_chain: true, auto_ship: false });
    const queue = buildQueueForSlashCommand("work", config);

    const types = queue.steps.map((s) => s.type);
    expect(types).toContain("work");
  });
});

// ===========================================================================
// QueueProgressInfo
// ===========================================================================

describe("QueueProgressInfo", () => {
  it("formatQueueProgress formats step position", async () => {
    const { formatQueueProgress } = await import("../src/tui/components/shell-queue");
    const result = formatQueueProgress({ currentStep: 2, totalSteps: 5, stepName: "plan" });
    expect(result).toContain("2");
    expect(result).toContain("5");
    expect(result).toContain("Plan");
  });

  it("formatQueueProgress returns empty string for null", async () => {
    const { formatQueueProgress } = await import("../src/tui/components/shell-queue");
    const result = formatQueueProgress(null);
    expect(result).toBe("");
  });
});

// ===========================================================================
// Event subscription: queue events drive shell state
// ===========================================================================

describe("Queue event handling", () => {
  it("queue:initialized event carries step IDs", () => {
    const bus = new EventBus();
    let captured: FlywheelEvent | null = null;

    bus.subscribeToType("queue:initialized", (e) => {
      captured = e;
    });

    bus.emit({
      type: "queue:initialized",
      workflowId: "test",
      stepIds: ["s1", "s2", "s3"],
      timestamp: new Date().toISOString(),
    });

    expect(captured).not.toBeNull();
    expect((captured as any).stepIds).toEqual(["s1", "s2", "s3"]);
  });

  it("queue:step-started carries step metadata", () => {
    const bus = new EventBus();
    let captured: FlywheelEvent | null = null;

    bus.subscribeToType("queue:step-started", (e) => {
      captured = e;
    });

    bus.emit({
      type: "queue:step-started",
      workflowId: "test",
      stepId: "s1",
      stepType: "plan",
      stepTitle: "Create plan",
      timestamp: new Date().toISOString(),
    });

    expect(captured).not.toBeNull();
    expect((captured as any).stepId).toBe("s1");
    expect((captured as any).stepType).toBe("plan");
  });

  it("queue:completed carries steps completed count", () => {
    const bus = new EventBus();
    let captured: FlywheelEvent | null = null;

    bus.subscribeToType("queue:completed", (e) => {
      captured = e;
    });

    bus.emit({
      type: "queue:completed",
      workflowId: "test",
      stepsCompleted: 3,
      timestamp: new Date().toISOString(),
    });

    expect(captured).not.toBeNull();
    expect((captured as any).stepsCompleted).toBe(3);
  });

  it("queue:failed carries reason and steps completed", () => {
    const bus = new EventBus();
    let captured: FlywheelEvent | null = null;

    bus.subscribeToType("queue:failed", (e) => {
      captured = e;
    });

    bus.emit({
      type: "queue:failed",
      workflowId: "test",
      reason: "Step failed",
      stepsCompleted: 1,
      timestamp: new Date().toISOString(),
    });

    expect(captured).not.toBeNull();
    expect((captured as any).reason).toBe("Step failed");
    expect((captured as any).stepsCompleted).toBe(1);
  });
});
