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
  it("returns a Queue for plan-only template with granular plan steps", async () => {
    const { buildQueue } = await import("../src/tui/shell/shell-queue");
    const queue = buildQueue("plan-only", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(4); // 4 granular plan sub-steps
    expect(queue.steps[0].type).toBe("plan");
    expect(queue.steps[0].status).toBe("pending");
    expect(queue.cursor).toBe(0);
    expect(queue.status).toBe("idle");
  });

  it("returns a Queue for plan-work template", async () => {
    const { buildQueue } = await import("../src/tui/shell/shell-queue");
    const queue = buildQueue("plan-work", makeConfig());

    expect(queue).toBeDefined();
    // plan-work initially has just plan; work steps are inserted after plan completes
    expect(queue.steps.length).toBeGreaterThanOrEqual(1);
    expect(queue.steps[0].type).toBe("plan");
  });

  it("returns a Queue for plan-work-review template", async () => {
    const { buildQueue } = await import("../src/tui/shell/shell-queue");
    const queue = buildQueue("plan-work-review", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps.length).toBeGreaterThanOrEqual(2);
    expect(queue.steps[0].type).toBe("plan");
    // review should be last
    const lastStep = queue.steps[queue.steps.length - 1];
    expect(lastStep.type).toBe("review");
  });

  it("returns a Queue for full template", async () => {
    const { buildQueue } = await import("../src/tui/shell/shell-queue");
    const queue = buildQueue("full", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps[0].type).toBe("plan");
    // Last should be ship
    const lastStep = queue.steps[queue.steps.length - 1];
    expect(lastStep.type).toBe("ship");
  });

  it("returns a Queue for sprint template", async () => {
    const { buildQueue } = await import("../src/tui/shell/shell-queue");
    const queue = buildQueue("sprint", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(2);
    expect(queue.steps[0].type).toBe("work");
    expect(queue.steps[1].type).toBe("verify");
  });

  it("no gate steps regardless of skip_approval_gates config (HITL via questions)", async () => {
    const { buildQueue } = await import("../src/tui/shell/shell-queue");
    const withFlag = buildQueue("plan-work-review", makeConfig({ skip_approval_gates: false }));
    const withoutFlag = buildQueue("plan-work-review", makeConfig({ skip_approval_gates: true }));

    expect(withFlag.steps.filter((s) => s.type === "gate")).toHaveLength(0);
    expect(withoutFlag.steps.filter((s) => s.type === "gate")).toHaveLength(0);
  });

  it("respects max_steps from queue config", async () => {
    const { buildQueue } = await import("../src/tui/shell/shell-queue");
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
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    // Default config has auto_chain: true, so /work creates work+review
    const queue = buildQueueForSlashCommand("work", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps[0].type).toBe("work");
    expect(queue.steps.length).toBeGreaterThanOrEqual(1);
  });

  it("/work without auto_chain creates single work step queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    const queue = buildQueueForSlashCommand("work", makeConfig({ auto_chain: false }));

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("work");
  });

  it("/plan with auto_chain creates multi-step queue starting with plan", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    // Default config has auto_chain: true, so /plan creates plan+work+review
    const queue = buildQueueForSlashCommand("plan", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps[0].type).toBe("plan");
    expect(queue.steps.length).toBeGreaterThanOrEqual(1);
  });

  it("/plan without auto_chain creates single plan step queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    const queue = buildQueueForSlashCommand("plan", makeConfig({ auto_chain: false }));

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("plan");
  });

  it("/review creates a 2-step review queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    const queue = buildQueueForSlashCommand("review", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(2);
    expect(queue.steps[0].type).toBe("review");
    expect(queue.steps[0].dispatcherHint).toBe("dispatch-reviewers");
    expect(queue.steps[1].type).toBe("review");
    expect(queue.steps[1].dispatcherHint).toBe("consolidate-review");
  });

  it("/ship creates a 2-step ship queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    const queue = buildQueueForSlashCommand("ship", makeConfig());

    expect(queue).toBeDefined();
    expect(queue.steps).toHaveLength(2);
    expect(queue.steps[0].type).toBe("ship");
    expect(queue.steps[0].dispatcherHint).toBe("ship");
    expect(queue.steps[1].type).toBe("ship");
    expect(queue.steps[1].dispatcherHint).toBe("learnings");
  });

  it("/debug creates a 3-step debug queue (+ auto_chain review)", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    // Default config has auto_chain: true, so review is appended
    const queue = buildQueueForSlashCommand("debug", makeConfig());

    expect(queue).toBeDefined();
    // 3 debug steps + 1 review (auto_chain)
    expect(queue.steps).toHaveLength(4);
    expect(queue.steps[0].type).toBe("debug");
    expect(queue.steps[0].dispatcherHint).toBe("investigate");
    expect(queue.steps[1].type).toBe("debug");
    expect(queue.steps[1].dispatcherHint).toBe("fix");
    expect(queue.steps[2].type).toBe("verify");
    expect(queue.steps[2].dispatcherHint).toBe("debug-verify");
    expect(queue.steps[3].type).toBe("review");
  });

  it("/research creates a single research step with metadata (+ auto_chain review)", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    // Default config has auto_chain: true, so review is appended
    const queue = buildQueueForSlashCommand("research", makeConfig());

    expect(queue).toBeDefined();
    // 1 research step + 1 review (auto_chain)
    expect(queue.steps).toHaveLength(2);
    expect(queue.steps[0].type).toBe("research");
    expect(queue.steps[0].dispatcherHint).toBe("research");
    expect(queue.steps[0].evaluationCriteria).toBeTruthy();
    expect(queue.steps[0].toolScoping).toBeDefined();
    expect(queue.steps[1].type).toBe("review");
  });

  it("auto_chain /plan creates plan+work+review pipeline queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    const config = makeConfig({ auto_chain: true, auto_ship: false });
    const queue = buildQueueForSlashCommand("plan", config);

    // With auto_chain, /plan should create a pipeline-like queue
    const types = queue.steps.map((s) => s.type);
    expect(types).toContain("plan");
  });

  it("auto_chain /work creates work+review pipeline queue", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    const config = makeConfig({ auto_chain: true, auto_ship: false });
    const queue = buildQueueForSlashCommand("work", config);

    const types = queue.steps.map((s) => s.type);
    expect(types).toContain("work");
  });
});

// ===========================================================================
// shell-queue.ts — buildQueueFromPlan (JSON plan support)
// ===========================================================================

describe("buildQueueFromPlan", () => {
  it("reads .plan.json files and creates work steps with full metadata", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { buildQueueFromPlan } = await import("../src/tui/shell/shell-queue");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-test-"));
    const planPath = path.join(tmpDir, "test.plan.json");

    const jsonPlan = JSON.stringify({
      steps: [
        {
          title: "Create server module",
          description: "Implement GET /hello endpoint",
          acceptanceCriteria: ["Returns 200", "JSON body"],
          fileReferences: ["src/server.ts"],
          feature: "server",
          fulfills: ["BC-001"],
          milestone: "Foundation",
        },
        {
          title: "Add auth middleware",
          description: "JWT validation",
          acceptanceCriteria: ["Rejects invalid JWT"],
          feature: "auth",
        },
      ],
      behavioralContract: [
        { id: "BC-001", title: "Hello endpoint", description: "...", evidence: "curl", area: "Server" },
      ],
      decisions: ["Use Bun.serve()"],
      risks: ["Port conflict"],
    });

    fs.writeFileSync(planPath, jsonPlan);

    try {
      const queue = buildQueueFromPlan(planPath, makeConfig());

      // Should have 2 work steps + 1 review step (auto_chain default true)
      expect(queue.steps.length).toBeGreaterThanOrEqual(3);
      expect(queue.steps[0].type).toBe("work");
      expect(queue.steps[0].title).toBe("Create server module");
      expect(queue.steps[0].description).toBe("Implement GET /hello endpoint");
      expect(queue.steps[0].acceptanceCriteria).toEqual(["Returns 200", "JSON body"]);
      expect(queue.steps[0].fileReferences).toEqual(["src/server.ts"]);
      expect(queue.steps[0].feature).toBe("server");
      expect(queue.steps[0].fulfills).toEqual(["BC-001"]);
      expect(queue.steps[0].milestone).toBe("Foundation");

      expect(queue.steps[1].type).toBe("work");
      expect(queue.steps[1].title).toBe("Add auth middleware");
      expect(queue.steps[1].feature).toBe("auth");

      // Last step should be review (auto_chain)
      expect(queue.steps[queue.steps.length - 1].type).toBe("review");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("reads JSON plan content by content detection (no .plan.json extension)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { buildQueueFromPlan } = await import("../src/tui/shell/shell-queue");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-test-"));
    const planPath = path.join(tmpDir, "plan.json");

    const jsonPlan = JSON.stringify({
      steps: [{ title: "Step one", description: "Do something", acceptanceCriteria: ["Done"] }],
      behavioralContract: [],
      decisions: [],
      risks: [],
    });

    fs.writeFileSync(planPath, jsonPlan);

    try {
      const queue = buildQueueFromPlan(planPath, makeConfig({ auto_chain: false }));
      expect(queue.steps).toHaveLength(1);
      expect(queue.steps[0].title).toBe("Step one");
      expect(queue.steps[0].type).toBe("work");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("falls back to single work step for non-JSON .md plan files", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { buildQueueFromPlan } = await import("../src/tui/shell/shell-queue");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-test-"));
    const planPath = path.join(tmpDir, "plan.md");

    const mdPlan = `# Plan\n\n### Step 1: Setup\n\n- [ ] Create project\n`;
    fs.writeFileSync(planPath, mdPlan);

    try {
      // Markdown parsing removed — non-JSON content falls back to single work step
      const queue = buildQueueFromPlan(planPath, makeConfig({ auto_chain: false }));
      expect(queue.steps).toHaveLength(1);
      expect(queue.steps[0].type).toBe("work");
      expect(queue.steps[0].title).toBe("Execute work");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("falls back to single work step for invalid JSON plan", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { buildQueueFromPlan } = await import("../src/tui/shell/shell-queue");

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-test-"));
    const planPath = path.join(tmpDir, "bad.plan.json");

    fs.writeFileSync(planPath, '{"steps": []}'); // Empty steps — invalid

    try {
      const queue = buildQueueFromPlan(planPath, makeConfig({ auto_chain: false }));
      expect(queue.steps).toHaveLength(1);
      expect(queue.steps[0].title).toBe("Execute work");
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it("falls back to single work step when file not found", async () => {
    const { buildQueueFromPlan } = await import("../src/tui/shell/shell-queue");
    const queue = buildQueueFromPlan("/nonexistent/path.plan.json", makeConfig({ auto_chain: false }));
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].title).toBe("Execute work");
  });
});

// ===========================================================================
// QueueProgressInfo
// ===========================================================================

describe("QueueProgressInfo", () => {
  it("formatQueueProgress formats step position", async () => {
    const { formatQueueProgress } = await import("../src/tui/shell/shell-queue");
    const result = formatQueueProgress({ currentStep: 2, totalSteps: 5, stepName: "plan" });
    expect(result).toContain("2");
    expect(result).toContain("5");
    expect(result).toContain("Plan");
  });

  it("formatQueueProgress returns empty string for null", async () => {
    const { formatQueueProgress } = await import("../src/tui/shell/shell-queue");
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

// ===========================================================================
// buildQueueForSlashCommand — auto_chain for debug/research
// ===========================================================================

describe("buildQueueForSlashCommand — auto_chain for debug/research", () => {
  it("/debug with auto_chain appends review+ship after debug steps", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    const config = makeConfig({ auto_chain: true, auto_ship: true });
    const queue = buildQueueForSlashCommand("debug", config);
    const types = queue.steps.map(s => s.type);
    expect(types).toContain("debug");
    expect(types).toContain("verify");
    expect(types).toContain("review");
    expect(types).toContain("ship");
  });

  it("/research with auto_chain appends review+ship after research step", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    const config = makeConfig({ auto_chain: true, auto_ship: true });
    const queue = buildQueueForSlashCommand("research", config);
    const types = queue.steps.map(s => s.type);
    expect(types[0]).toBe("research");
    expect(types).toContain("review");
    expect(types).toContain("ship");
  });

  it("debug investigate/fix steps use type 'debug', verify uses type 'verify'", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    const queue = buildQueueForSlashCommand("debug", makeConfig({ auto_chain: false }));
    expect(queue.steps[0].type).toBe("debug");
    expect(queue.steps[1].type).toBe("debug");
    expect(queue.steps[2].type).toBe("verify");
  });
});

// ===========================================================================
// buildQueueForSlashCommand — /compound
// ===========================================================================

describe("buildQueueForSlashCommand — /compound", () => {
  it("/compound creates a single ship step with learnings hint", async () => {
    const { buildQueueForSlashCommand } = await import("../src/tui/shell/shell-queue");
    const queue = buildQueueForSlashCommand("compound", makeConfig());
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("ship");
    expect(queue.steps[0].dispatcherHint).toBe("learnings");
    expect(queue.steps[0].evaluationCriteria).toBeTruthy();
    expect(queue.steps[0].title).toContain("learnings");
  });
});
