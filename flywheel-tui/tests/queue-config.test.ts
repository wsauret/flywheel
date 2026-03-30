import { describe, it, expect } from "bun:test";
import {
  loadConfig,
  FlywheelConfigSchema,
  CONFIG_DEFAULTS,
} from "../src/config/loader";
import {
  ProtoStepSchema,
  ProtoStepArraySchema,
  EstimatedComplexitySchema,
  formalizeProtoSteps,
} from "../src/queue/proto-step";
import type { ProtoStep, StepWithPrompt } from "../src/queue/proto-step";

// ===========================================================================
// VAL-QUEUE-037: Config section [queue] in flywheel.toml
// ===========================================================================

describe("VAL-QUEUE-037: [queue] config section parsed from flywheel.toml", () => {
  it("FlywheelConfigSchema includes queue section", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.queue).toBeDefined();
      expect(typeof result.data.queue.max_steps).toBe("number");
      expect(typeof result.data.queue.persist_queue).toBe("boolean");
    }
  });

  it("accepts valid queue config", () => {
    const result = FlywheelConfigSchema.safeParse({
      queue: {
        max_steps: 100,
        persist_queue: false,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.queue.max_steps).toBe(100);
      expect(result.data.queue.persist_queue).toBe(false);
    }
  });

  it("accepts partial queue config (missing fields get defaults)", () => {
    const result = FlywheelConfigSchema.safeParse({
      queue: { max_steps: 200 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.queue.max_steps).toBe(200);
      expect(result.data.queue.persist_queue).toBe(true); // default
    }
  });

  it("loadConfig returns queue config from env vars", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_QUEUE_MAX_STEPS: "75",
      FLYWHEEL_QUEUE_PERSIST_QUEUE: "false",
    });
    expect(config.queue.max_steps).toBe(75);
    expect(config.queue.persist_queue).toBe(false);
  });
});

// ===========================================================================
// VAL-QUEUE-038: Config defaults
// ===========================================================================

describe("VAL-QUEUE-038: max_steps defaults to 50, persist_queue defaults to true", () => {
  it("max_steps defaults to 50 when not specified", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.queue.max_steps).toBe(50);
    }
  });

  it("persist_queue defaults to true when not specified", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.queue.persist_queue).toBe(true);
    }
  });

  it("CONFIG_DEFAULTS includes queue section with correct defaults", () => {
    expect(CONFIG_DEFAULTS.queue).toBeDefined();
    expect(CONFIG_DEFAULTS.queue.max_steps).toBe(50);
    expect(CONFIG_DEFAULTS.queue.persist_queue).toBe(true);
  });

  it("loadConfig returns queue defaults when no config file or env", () => {
    const { config } = loadConfig(undefined, {});
    expect(config.queue.max_steps).toBe(50);
    expect(config.queue.persist_queue).toBe(true);
  });
});

// ===========================================================================
// Queue config validation
// ===========================================================================

describe("Queue config validation", () => {
  it("rejects max_steps < 1", () => {
    const result = FlywheelConfigSchema.safeParse({
      queue: { max_steps: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects max_steps > 1000", () => {
    const result = FlywheelConfigSchema.safeParse({
      queue: { max_steps: 1001 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts max_steps at boundaries (1 and 1000)", () => {
    for (const val of [1, 1000]) {
      const result = FlywheelConfigSchema.safeParse({
        queue: { max_steps: val },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.queue.max_steps).toBe(val);
      }
    }
  });

  it("rejects non-integer max_steps", () => {
    const result = FlywheelConfigSchema.safeParse({
      queue: { max_steps: 2.5 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative max_steps", () => {
    const result = FlywheelConfigSchema.safeParse({
      queue: { max_steps: -1 },
    });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// Queue config env var overrides
// ===========================================================================

describe("Queue config env var overrides", () => {
  it("FLYWHEEL_QUEUE_MAX_STEPS overrides default", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_QUEUE_MAX_STEPS: "100",
    });
    expect(config.queue.max_steps).toBe(100);
  });

  it("FLYWHEEL_QUEUE_PERSIST_QUEUE=false disables persistence", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_QUEUE_PERSIST_QUEUE: "false",
    });
    expect(config.queue.persist_queue).toBe(false);
  });

  it("FLYWHEEL_QUEUE_PERSIST_QUEUE=0 disables persistence", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_QUEUE_PERSIST_QUEUE: "0",
    });
    expect(config.queue.persist_queue).toBe(false);
  });

  it("FLYWHEEL_QUEUE_PERSIST_QUEUE=true enables persistence", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_QUEUE_PERSIST_QUEUE: "true",
    });
    expect(config.queue.persist_queue).toBe(true);
  });

  it("FLYWHEEL_QUEUE_PERSIST_QUEUE=1 enables persistence", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_QUEUE_PERSIST_QUEUE: "1",
    });
    expect(config.queue.persist_queue).toBe(true);
  });

  it("env vars take precedence over defaults", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_QUEUE_MAX_STEPS: "200",
      FLYWHEEL_QUEUE_PERSIST_QUEUE: "false",
    });
    expect(config.queue.max_steps).toBe(200);
    expect(config.queue.persist_queue).toBe(false);
  });

  it("invalid (non-numeric) FLYWHEEL_QUEUE_MAX_STEPS is ignored", () => {
    const { config } = loadConfig(undefined, {
      FLYWHEEL_QUEUE_MAX_STEPS: "not-a-number",
    });
    // Falls back to default since parseInt returns NaN
    expect(config.queue.max_steps).toBe(50);
  });
});

// ===========================================================================
// ProtoStep schema validation
// ===========================================================================

describe("ProtoStep schema validates proto-step JSON", () => {
  const validProto: ProtoStep = {
    title: "Add user authentication",
    description: "Implement JWT-based authentication with login and logout endpoints",
    acceptanceCriteria: [
      "POST /login returns JWT token",
      "Protected routes require valid token",
      "POST /logout invalidates token",
    ],
  };

  it("accepts valid proto-step with required fields", () => {
    const result = ProtoStepSchema.safeParse(validProto);
    expect(result.success).toBe(true);
  });

  it("accepts proto-step with all optional fields", () => {
    const result = ProtoStepSchema.safeParse({
      ...validProto,
      milestone: "core-auth",
      fulfills: ["VAL-AUTH-001", "VAL-AUTH-002"],
      estimatedComplexity: "high",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.milestone).toBe("core-auth");
      expect(result.data.fulfills).toEqual(["VAL-AUTH-001", "VAL-AUTH-002"]);
      expect(result.data.estimatedComplexity).toBe("high");
    }
  });

  it("rejects missing title", () => {
    const result = ProtoStepSchema.safeParse({
      description: "some desc",
      acceptanceCriteria: ["criterion"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty title", () => {
    const result = ProtoStepSchema.safeParse({
      title: "",
      description: "some desc",
      acceptanceCriteria: ["criterion"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing description", () => {
    const result = ProtoStepSchema.safeParse({
      title: "title",
      acceptanceCriteria: ["criterion"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty description", () => {
    const result = ProtoStepSchema.safeParse({
      title: "title",
      description: "",
      acceptanceCriteria: ["criterion"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing acceptanceCriteria", () => {
    const result = ProtoStepSchema.safeParse({
      title: "title",
      description: "desc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty acceptanceCriteria array", () => {
    const result = ProtoStepSchema.safeParse({
      title: "title",
      description: "desc",
      acceptanceCriteria: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty string in acceptanceCriteria", () => {
    const result = ProtoStepSchema.safeParse({
      title: "title",
      description: "desc",
      acceptanceCriteria: ["valid", ""],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (.strict())", () => {
    const result = ProtoStepSchema.safeParse({
      ...validProto,
      unknownField: "should fail",
    });
    expect(result.success).toBe(false);
  });

  it("validates all 5 estimatedComplexity values", () => {
    for (const complexity of ["trivial", "low", "medium", "high", "critical"]) {
      const result = ProtoStepSchema.safeParse({
        ...validProto,
        estimatedComplexity: complexity,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid estimatedComplexity", () => {
    const result = ProtoStepSchema.safeParse({
      ...validProto,
      estimatedComplexity: "extreme",
    });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// ProtoStepArraySchema
// ===========================================================================

describe("ProtoStepArraySchema", () => {
  it("accepts array of valid proto-steps", () => {
    const result = ProtoStepArraySchema.safeParse([
      {
        title: "Step 1",
        description: "First step",
        acceptanceCriteria: ["criterion 1"],
      },
      {
        title: "Step 2",
        description: "Second step",
        acceptanceCriteria: ["criterion 2"],
      },
    ]);
    expect(result.success).toBe(true);
  });

  it("rejects empty array", () => {
    const result = ProtoStepArraySchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it("rejects array with invalid proto-step", () => {
    const result = ProtoStepArraySchema.safeParse([
      { title: "valid", description: "desc", acceptanceCriteria: ["c"] },
      { title: "" }, // invalid
    ]);
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// EstimatedComplexitySchema
// ===========================================================================

describe("EstimatedComplexitySchema", () => {
  it("accepts all valid values", () => {
    for (const val of ["trivial", "low", "medium", "high", "critical"]) {
      const result = EstimatedComplexitySchema.safeParse(val);
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid values", () => {
    for (const val of ["extreme", "easy", "hard", "", 0, null]) {
      const result = EstimatedComplexitySchema.safeParse(val);
      expect(result.success).toBe(false);
    }
  });
});

// ===========================================================================
// formalizeProtoSteps
// ===========================================================================

describe("formalizeProtoSteps converts proto-steps to full Steps", () => {
  const protoSteps: ProtoStep[] = [
    {
      title: "Add user model",
      description: "Create the User database model with email, password hash, and timestamps",
      acceptanceCriteria: [
        "User model has email, passwordHash, createdAt, updatedAt fields",
        "Model validates email format",
      ],
    },
    {
      title: "Add auth endpoints",
      description: "Create login and register API endpoints",
      acceptanceCriteria: [
        "POST /register creates new user",
        "POST /login returns JWT token",
      ],
      milestone: "auth",
      fulfills: ["VAL-AUTH-001"],
      estimatedComplexity: "medium",
    },
  ];

  it("returns Step[] with correct length", () => {
    const steps = formalizeProtoSteps(protoSteps);
    expect(steps).toHaveLength(2);
  });

  it("assigns sequential IDs by default", () => {
    const steps = formalizeProtoSteps(protoSteps);
    expect(steps[0].id).toBe("step-1");
    expect(steps[1].id).toBe("step-2");
  });

  it("uses custom idGenerator when provided", () => {
    const steps = formalizeProtoSteps(protoSteps, {
      idGenerator: (i) => `custom-${i * 10}`,
    });
    expect(steps[0].id).toBe("custom-0");
    expect(steps[1].id).toBe("custom-10");
  });

  it("assigns type 'work' by default", () => {
    const steps = formalizeProtoSteps(protoSteps);
    expect(steps[0].type).toBe("work");
    expect(steps[1].type).toBe("work");
  });

  it("uses custom stepType when provided", () => {
    const steps = formalizeProtoSteps(protoSteps, { stepType: "research" });
    expect(steps[0].type).toBe("research");
    expect(steps[1].type).toBe("research");
  });

  it("assigns status 'pending' to all steps", () => {
    const steps = formalizeProtoSteps(protoSteps);
    for (const step of steps) {
      expect(step.status).toBe("pending");
    }
  });

  it("preserves title from proto-step", () => {
    const steps = formalizeProtoSteps(protoSteps);
    expect(steps[0].title).toBe("Add user model");
    expect(steps[1].title).toBe("Add auth endpoints");
  });

  it("preserves milestone from proto-step", () => {
    const steps = formalizeProtoSteps(protoSteps);
    expect(steps[0].milestone).toBeUndefined();
    expect(steps[1].milestone).toBe("auth");
  });

  it("preserves fulfills from proto-step", () => {
    const steps = formalizeProtoSteps(protoSteps);
    expect(steps[0].fulfills).toBeUndefined();
    expect(steps[1].fulfills).toEqual(["VAL-AUTH-001"]);
  });

  it("generates prompt containing title", () => {
    const steps = formalizeProtoSteps(protoSteps);
    expect(steps[0].prompt).toContain("Add user model");
    expect(steps[1].prompt).toContain("Add auth endpoints");
  });

  it("generates prompt containing description", () => {
    const steps = formalizeProtoSteps(protoSteps);
    expect(steps[0].prompt).toContain(
      "Create the User database model with email, password hash, and timestamps",
    );
  });

  it("generates prompt containing acceptance criteria as checklist", () => {
    const steps = formalizeProtoSteps(protoSteps);
    expect(steps[0].prompt).toContain("- [ ] User model has email, passwordHash, createdAt, updatedAt fields");
    expect(steps[0].prompt).toContain("- [ ] Model validates email format");
  });

  it("generates prompt with step position (Step N of M)", () => {
    const steps = formalizeProtoSteps(protoSteps);
    expect(steps[0].prompt).toContain("Step 1 of 2");
    expect(steps[1].prompt).toContain("Step 2 of 2");
  });

  it("includes estimated complexity in prompt when provided", () => {
    const steps = formalizeProtoSteps(protoSteps);
    expect(steps[0].prompt).not.toContain("Estimated Complexity");
    expect(steps[1].prompt).toContain("Estimated Complexity: medium");
  });

  it("includes fulfills in prompt when provided", () => {
    const steps = formalizeProtoSteps(protoSteps);
    expect(steps[0].prompt).not.toContain("Fulfills");
    expect(steps[1].prompt).toContain("Fulfills: VAL-AUTH-001");
  });

  it("handles single proto-step", () => {
    const steps = formalizeProtoSteps([protoSteps[0]]);
    expect(steps).toHaveLength(1);
    expect(steps[0].prompt).toContain("Step 1 of 1");
  });

  it("does not mutate fulfills array", () => {
    const proto: ProtoStep = {
      title: "Test",
      description: "Test",
      acceptanceCriteria: ["criterion"],
      fulfills: ["VAL-001"],
    };
    const steps = formalizeProtoSteps([proto]);
    // Modifying the step fulfills should not affect the original
    steps[0].fulfills!.push("VAL-002");
    expect(proto.fulfills).toEqual(["VAL-001"]);
  });

  it("returns StepWithPrompt with prompt field", () => {
    const steps = formalizeProtoSteps(protoSteps);
    for (const step of steps) {
      expect(typeof step.prompt).toBe("string");
      expect(step.prompt.length).toBeGreaterThan(0);
    }
  });
});
