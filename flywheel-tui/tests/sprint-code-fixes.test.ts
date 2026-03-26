import { describe, it, expect } from "bun:test";
import { SPRINT_FIELDS, renderHandoffInstruction } from "../src/handoff/field-specs";
import { loadConfig } from "../src/config/loader";
import { MockAdapter } from "../src/tui/adapters/mock";
import { EventBus } from "../src/events/event-bus";
import type {
  SprintStarted,
  SprintIterationStarted,
  SprintVerificationStarted,
  SprintIterationCompleted,
  SprintEscalated,
  SprintCompleted,
} from "../src/events/types";

// ===========================================================================
// FIX 1: needs_plan in SPRINT_FIELDS (VAL-FIX-001)
// ===========================================================================

describe("VAL-FIX-001: needs_plan in SPRINT_FIELDS", () => {
  it("SPRINT_FIELDS includes a needs_plan entry", () => {
    const keys = SPRINT_FIELDS.map((f) => f.key);
    expect(keys).toContain("needs_plan");
  });

  it("needs_plan field has description and example", () => {
    const field = SPRINT_FIELDS.find((f) => f.key === "needs_plan");
    expect(field).toBeDefined();
    expect(field!.description.length).toBeGreaterThan(0);
    expect(field!.example.length).toBeGreaterThan(0);
  });

  it("needs_plan field is optional (not required)", () => {
    const field = SPRINT_FIELDS.find((f) => f.key === "needs_plan");
    expect(field).toBeDefined();
    expect(field!.required).toBeFalsy();
  });

  it("renderHandoffInstruction output includes needs_plan", () => {
    const rendered = renderHandoffInstruction(SPRINT_FIELDS, ".flywheel/handoffs/test.json");
    expect(rendered).toContain("needs_plan");
  });
});

// ===========================================================================
// FIX 2: Env var overrides (VAL-FIX-002, VAL-FIX-003)
// ===========================================================================

describe("VAL-FIX-002: FLYWHEEL_SPRINT_WORKER_CAN_ESCALATE env var", () => {
  it("overrides sprint.worker_can_escalate when set to 'true'", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SPRINT_WORKER_CAN_ESCALATE: "true",
    });
    expect(config.sprint.worker_can_escalate).toBe(true);
  });

  it("overrides sprint.worker_can_escalate when set to '1'", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SPRINT_WORKER_CAN_ESCALATE: "1",
    });
    expect(config.sprint.worker_can_escalate).toBe(true);
  });

  it("defaults to false when not set", () => {
    const { config } = loadConfig(undefined, {});
    expect(config.sprint.worker_can_escalate).toBe(false);
  });

  it("sets false when set to 'false'", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SPRINT_WORKER_CAN_ESCALATE: "false",
    });
    expect(config.sprint.worker_can_escalate).toBe(false);
  });
});

describe("VAL-FIX-003: FLYWHEEL_SPRINT_ESCALATE_ON_STUCK env var", () => {
  it("overrides sprint.escalate_on_stuck when set to 'true'", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SPRINT_ESCALATE_ON_STUCK: "true",
    });
    expect(config.sprint.escalate_on_stuck).toBe(true);
  });

  it("overrides sprint.escalate_on_stuck when set to '1'", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SPRINT_ESCALATE_ON_STUCK: "1",
    });
    expect(config.sprint.escalate_on_stuck).toBe(true);
  });

  it("defaults to false when not set", () => {
    const { config } = loadConfig(undefined, {});
    expect(config.sprint.escalate_on_stuck).toBe(false);
  });

  it("sets false when set to 'false'", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SPRINT_ESCALATE_ON_STUCK: "false",
    });
    expect(config.sprint.escalate_on_stuck).toBe(false);
  });
});

// ===========================================================================
// FIX 3: MockAdapter sprint events (VAL-FIX-004)
// ===========================================================================

describe("VAL-FIX-004: MockAdapter handles sprint events", () => {
  function createMockWithBus(): { adapter: MockAdapter; bus: EventBus } {
    const bus = new EventBus();
    const adapter = new MockAdapter();
    adapter.connect(bus);
    return { adapter, bus };
  }

  const ts = new Date().toISOString();
  const wid = "test-workflow";

  it("records sprint:started event", () => {
    const { adapter, bus } = createMockWithBus();
    const event: SprintStarted = {
      type: "sprint:started",
      workflowId: wid,
      taskDescription: "Add hello world",
      maxIterations: 5,
      timestamp: ts,
    };
    bus.emit(event);
    expect(adapter.events).toHaveLength(1);
    expect(adapter.events[0].type).toBe("sprint:started");
  });

  it("records sprint:iteration-started event", () => {
    const { adapter, bus } = createMockWithBus();
    const event: SprintIterationStarted = {
      type: "sprint:iteration-started",
      workflowId: wid,
      iteration: 1,
      maxIterations: 5,
      timestamp: ts,
    };
    bus.emit(event);
    expect(adapter.events).toHaveLength(1);
    expect(adapter.events[0].type).toBe("sprint:iteration-started");
  });

  it("records sprint:verification-started event", () => {
    const { adapter, bus } = createMockWithBus();
    const event: SprintVerificationStarted = {
      type: "sprint:verification-started",
      workflowId: wid,
      iteration: 1,
      scriptPath: ".flywheel/verify/test.ts",
      timestamp: ts,
    };
    bus.emit(event);
    expect(adapter.events).toHaveLength(1);
    expect(adapter.events[0].type).toBe("sprint:verification-started");
  });

  it("records sprint:iteration-completed event", () => {
    const { adapter, bus } = createMockWithBus();
    const event: SprintIterationCompleted = {
      type: "sprint:iteration-completed",
      workflowId: wid,
      iteration: 1,
      passed: true,
      timestamp: ts,
    };
    bus.emit(event);
    expect(adapter.events).toHaveLength(1);
    expect(adapter.events[0].type).toBe("sprint:iteration-completed");
  });

  it("records sprint:escalated event", () => {
    const { adapter, bus } = createMockWithBus();
    const event: SprintEscalated = {
      type: "sprint:escalated",
      workflowId: wid,
      iterationsUsed: 5,
      reason: "Max iterations exhausted",
      timestamp: ts,
    };
    bus.emit(event);
    expect(adapter.events).toHaveLength(1);
    expect(adapter.events[0].type).toBe("sprint:escalated");
  });

  it("records sprint:completed event", () => {
    const { adapter, bus } = createMockWithBus();
    const event: SprintCompleted = {
      type: "sprint:completed",
      workflowId: wid,
      completed: true,
      iterationsUsed: 3,
      escalated: false,
      timestamp: ts,
    };
    bus.emit(event);
    expect(adapter.events).toHaveLength(1);
    expect(adapter.events[0].type).toBe("sprint:completed");
  });

  it("records all 6 sprint events in sequence", () => {
    const { adapter, bus } = createMockWithBus();
    bus.emit({ type: "sprint:started", workflowId: wid, taskDescription: "test", maxIterations: 5, timestamp: ts });
    bus.emit({ type: "sprint:iteration-started", workflowId: wid, iteration: 1, maxIterations: 5, timestamp: ts });
    bus.emit({ type: "sprint:verification-started", workflowId: wid, iteration: 1, scriptPath: ".flywheel/verify/t.ts", timestamp: ts });
    bus.emit({ type: "sprint:iteration-completed", workflowId: wid, iteration: 1, passed: false, reason: "test fail", timestamp: ts });
    bus.emit({ type: "sprint:escalated", workflowId: wid, iterationsUsed: 1, reason: "stuck", timestamp: ts });
    bus.emit({ type: "sprint:completed", workflowId: wid, completed: false, iterationsUsed: 1, escalated: true, timestamp: ts });
    expect(adapter.events).toHaveLength(6);
    const types = adapter.events.map((e) => e.type);
    expect(types).toEqual([
      "sprint:started",
      "sprint:iteration-started",
      "sprint:verification-started",
      "sprint:iteration-completed",
      "sprint:escalated",
      "sprint:completed",
    ]);
  });
});
