import { describe, it, expect } from "bun:test";
import { SPRINT_FIELDS, renderHandoffInstruction } from "../src/handoff/field-specs";
import { loadConfig } from "../src/config/loader";

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


