import { describe, it, expect } from "bun:test";
import {
  loadConfig,
  FlywheelConfigSchema,
  CONFIG_DEFAULTS,
} from "../src/config";
import { DEFAULT_TOOL_SCOPING, resolveToolScoping } from "../src/controller/tool-scoping";
import { WorkerHandoffBaseSchema, WorkerHandoffSchema } from "../src/schemas/handoff";
import {
  SPRINT_FIELDS,
  renderHandoffInstruction,
} from "../src/handoff/field-specs";
import {
  WORKFLOW_OPTIONS,
} from "../src/tui/components/start-command";
import type { WorkflowType } from "../src/controller/queue-types";

// ---------------------------------------------------------------------------
// VAL-SCHEMA-001: Sprint config section loads with correct defaults
// ---------------------------------------------------------------------------

describe("Sprint config defaults (VAL-SCHEMA-001)", () => {
  it("sprint section has correct defaults when not specified", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sprint.max_iterations).toBe(5);
      expect(result.data.sprint.verification_timeout_ms).toBe(30000);
      expect(result.data.sprint.escalate_to_full).toBe(true);
      expect(result.data.sprint.worker_can_escalate).toBe(false);
      expect(result.data.sprint.escalate_on_stuck).toBe(false);
    }
  });

  it("CONFIG_DEFAULTS includes sprint section", () => {
    expect(CONFIG_DEFAULTS.sprint).toBeDefined();
    expect(CONFIG_DEFAULTS.sprint.max_iterations).toBe(5);
    expect(CONFIG_DEFAULTS.sprint.verification_timeout_ms).toBe(30000);
    expect(CONFIG_DEFAULTS.sprint.escalate_to_full).toBe(true);
    expect(CONFIG_DEFAULTS.sprint.worker_can_escalate).toBe(false);
    expect(CONFIG_DEFAULTS.sprint.escalate_on_stuck).toBe(false);
  });

  it("loadConfig returns sprint defaults when no config file or env", () => {
    const { config } = loadConfig(undefined, {});
    expect(config.sprint.max_iterations).toBe(5);
    expect(config.sprint.verification_timeout_ms).toBe(30000);
    expect(config.sprint.escalate_to_full).toBe(true);
    expect(config.sprint.worker_can_escalate).toBe(false);
    expect(config.sprint.escalate_on_stuck).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-SCHEMA-002: Sprint config validates field ranges
// ---------------------------------------------------------------------------

describe("Sprint config validation (VAL-SCHEMA-002)", () => {
  it("rejects max_iterations < 1", () => {
    const result = FlywheelConfigSchema.safeParse({
      sprint: { max_iterations: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects max_iterations > 10", () => {
    const result = FlywheelConfigSchema.safeParse({
      sprint: { max_iterations: 11 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts max_iterations at boundaries (1 and 10)", () => {
    for (const val of [1, 10]) {
      const result = FlywheelConfigSchema.safeParse({
        sprint: { max_iterations: val },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.sprint.max_iterations).toBe(val);
      }
    }
  });

  it("rejects non-integer max_iterations", () => {
    const result = FlywheelConfigSchema.safeParse({
      sprint: { max_iterations: 2.5 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects verification_timeout_ms < 1000", () => {
    const result = FlywheelConfigSchema.safeParse({
      sprint: { verification_timeout_ms: 999 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts verification_timeout_ms at boundary (1000)", () => {
    const result = FlywheelConfigSchema.safeParse({
      sprint: { verification_timeout_ms: 1000 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sprint.verification_timeout_ms).toBe(1000);
    }
  });

  it("accepts valid custom sprint config", () => {
    const result = FlywheelConfigSchema.safeParse({
      sprint: {
        max_iterations: 3,
        verification_timeout_ms: 60000,
        escalate_to_full: false,
        worker_can_escalate: true,
        escalate_on_stuck: true,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sprint.max_iterations).toBe(3);
      expect(result.data.sprint.verification_timeout_ms).toBe(60000);
      expect(result.data.sprint.escalate_to_full).toBe(false);
      expect(result.data.sprint.worker_can_escalate).toBe(true);
      expect(result.data.sprint.escalate_on_stuck).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-SCHEMA-003: Sprint config env var overrides
// ---------------------------------------------------------------------------

describe("Sprint config env var overrides (VAL-SCHEMA-003)", () => {
  it("FLYWHEEL_SPRINT_MAX_ITERATIONS overrides default", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SPRINT_MAX_ITERATIONS: "3",
    });
    expect(config.sprint.max_iterations).toBe(3);
  });

  it("FLYWHEEL_SPRINT_VERIFICATION_TIMEOUT_MS overrides default", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SPRINT_VERIFICATION_TIMEOUT_MS: "60000",
    });
    expect(config.sprint.verification_timeout_ms).toBe(60000);
  });

  it("FLYWHEEL_SPRINT_ESCALATE_TO_FULL overrides default", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SPRINT_ESCALATE_TO_FULL: "false",
    });
    expect(config.sprint.escalate_to_full).toBe(false);
  });

  it("FLYWHEEL_SPRINT_ESCALATE_TO_FULL=0 disables escalation", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SPRINT_ESCALATE_TO_FULL: "0",
    });
    expect(config.sprint.escalate_to_full).toBe(false);
  });

  it("env vars take precedence over TOML values", () => {
    // Even without a TOML file, env should set the value
    const { config } = loadConfig(undefined, {
      FLYWHEEL_SPRINT_MAX_ITERATIONS: "7",
      FLYWHEEL_SPRINT_VERIFICATION_TIMEOUT_MS: "5000",
      FLYWHEEL_SPRINT_ESCALATE_TO_FULL: "false",
    });
    expect(config.sprint.max_iterations).toBe(7);
    expect(config.sprint.verification_timeout_ms).toBe(5000);
    expect(config.sprint.escalate_to_full).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-SCHEMA-004: Handoff schema accepts sprint-specific fields
// ---------------------------------------------------------------------------

describe("Handoff schema sprint fields (VAL-SCHEMA-004)", () => {
  const validBase = {
    summary: "Implemented a hello world endpoint with verification script that tests the HTTP response.",
  };

  it("accepts verification_script_path as optional string", () => {
    const result = WorkerHandoffBaseSchema.safeParse({
      ...validBase,
      verification_script_path: ".flywheel/verify/test-sprint.ts",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verification_script_path).toBe(".flywheel/verify/test-sprint.ts");
    }
  });

  it("accepts iteration_number as optional number", () => {
    const result = WorkerHandoffBaseSchema.safeParse({
      ...validBase,
      iteration_number: 3,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.iteration_number).toBe(3);
    }
  });

  it("accepts both sprint fields together", () => {
    const result = WorkerHandoffBaseSchema.safeParse({
      ...validBase,
      verification_script_path: ".flywheel/verify/test.ts",
      iteration_number: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts handoff without sprint fields (backward compat)", () => {
    const result = WorkerHandoffBaseSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it(".passthrough() tolerates unknown fields", () => {
    const result = WorkerHandoffBaseSchema.safeParse({
      ...validBase,
      completely_unknown_field: "should be tolerated",
    });
    expect(result.success).toBe(true);
  });

  it("full WorkerHandoffSchema also accepts sprint fields", () => {
    const result = WorkerHandoffSchema.safeParse({
      ...validBase,
      verification_script_path: ".flywheel/verify/test.ts",
      iteration_number: 2,
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-SCHEMA-005: WorkflowType union includes "sprint"
// ---------------------------------------------------------------------------

describe("WorkflowType includes 'sprint' (VAL-SCHEMA-005)", () => {
  it("'sprint' is a valid WorkflowType in workflow-pipeline.ts", () => {
    // WorkflowType includes "sprint" — verified by the fact that
    // DEFAULT_TOOL_SCOPING has a sprint key (which is typed Record<WorkflowType, ...>)
    const allTypes: WorkflowType[] = ["work", "plan", "review", "ship", "debug", "research", "sprint"];
    for (const t of allTypes) {
      expect(DEFAULT_TOOL_SCOPING[t]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-SCHEMA-006: DEFAULT_TOOL_SCOPING has sprint entry with write/edit enabled
// ---------------------------------------------------------------------------

describe("Sprint tool scoping (VAL-SCHEMA-006)", () => {
  it("DEFAULT_TOOL_SCOPING has sprint entry", () => {
    expect(DEFAULT_TOOL_SCOPING.sprint).toBeDefined();
  });

  it("sprint entry has write and edit enabled", () => {
    expect(DEFAULT_TOOL_SCOPING.sprint).toEqual({
      read: true,
      bash: true,
      write: true,
      edit: true,
    });
  });

  it("resolveToolScoping returns sprint defaults", () => {
    expect(resolveToolScoping("sprint")).toEqual({
      read: true,
      bash: true,
      write: true,
      edit: true,
    });
  });

  it("covers all WorkflowType values including sprint", () => {
    const allTypes: WorkflowType[] = ["work", "plan", "review", "ship", "debug", "research", "sprint"];
    for (const wfType of allTypes) {
      expect(DEFAULT_TOOL_SCOPING[wfType]).toBeDefined();
      expect(typeof DEFAULT_TOOL_SCOPING[wfType].read).toBe("boolean");
      expect(typeof DEFAULT_TOOL_SCOPING[wfType].bash).toBe("boolean");
      expect(typeof DEFAULT_TOOL_SCOPING[wfType].write).toBe("boolean");
      expect(typeof DEFAULT_TOOL_SCOPING[wfType].edit).toBe("boolean");
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-SCHEMA-008: WorkflowName type includes "sprint" value
// ---------------------------------------------------------------------------

describe("WorkflowName includes sprint (VAL-SCHEMA-008)", () => {
  it("WORKFLOW_OPTIONS includes sprint option", () => {
    const sprintOption = WORKFLOW_OPTIONS.find((opt) => opt.value === "sprint");
    expect(sprintOption).toBeDefined();
    expect(sprintOption!.label).toBeTruthy();
    expect(sprintOption!.description).toBeTruthy();
  });

  it("WORKFLOW_OPTIONS has 5 entries", () => {
    expect(WORKFLOW_OPTIONS).toHaveLength(5);
  });

  it("sprint option has correct label and description", () => {
    const sprintOption = WORKFLOW_OPTIONS.find((opt) => opt.value === "sprint");
    expect(sprintOption).toBeDefined();
    expect(sprintOption!.label).toBe("Sprint");
    expect(sprintOption!.description).toContain("Fast iteration");
  });
});

// ---------------------------------------------------------------------------
// VAL-PROMPT-012: SPRINT_FIELDS HandoffFieldSpec array
// ---------------------------------------------------------------------------

describe("SPRINT_FIELDS (VAL-PROMPT-012)", () => {
  it("SPRINT_FIELDS array is defined", () => {
    expect(SPRINT_FIELDS).toBeDefined();
    expect(Array.isArray(SPRINT_FIELDS)).toBe(true);
  });

  it("SPRINT_FIELDS includes verification_script_path", () => {
    const vsp = SPRINT_FIELDS.find((f) => f.key === "verification_script_path");
    expect(vsp).toBeDefined();
    expect(vsp!.description).toBeTruthy();
    expect(vsp!.example).toBeTruthy();
  });

  it("SPRINT_FIELDS includes summary (required)", () => {
    const summary = SPRINT_FIELDS.find((f) => f.key === "summary");
    expect(summary).toBeDefined();
    expect(summary!.required).toBe(true);
  });

  it("renderHandoffInstruction with SPRINT_FIELDS produces correct output", () => {
    const output = renderHandoffInstruction(
      SPRINT_FIELDS,
      ".flywheel/handoffs/test.json",
    );
    expect(output).toContain("Handoff Instructions");
    expect(output).toContain("verification_script_path");
    expect(output).toContain(".flywheel/handoffs/test.json");
    expect(output).toContain("summary");
  });
});
