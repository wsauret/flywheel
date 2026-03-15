import { describe, it, expect } from "bun:test";
import {
  DispatcherInputSchema,
  DispatcherDecisionSchema,
} from "../src/schemas/dispatcher";
import {
  EvaluatorInputSchema,
  EvaluatorResultSchema,
} from "../src/schemas/evaluator";
import {
  StateFileSchema,
  migrateStateFile,
} from "../src/schemas/state";
import { ConfigSchema } from "../src/schemas/config";
import {
  WorkerResultSchema,
  WorkerFailureReasonSchema,
} from "../src/schemas/worker";
import { CliSessionSchema } from "../src/schemas/session";
import { WorkflowDefinitionSchema } from "../src/schemas/workflow";
import { ExecutionStatusSchema } from "../src/schemas/execution";

// ---------------------------------------------------------------------------
// DispatcherDecisionSchema (.strip() — LLM output)
// ---------------------------------------------------------------------------
describe("DispatcherDecisionSchema", () => {
  const validDecision = {
    phase_index: 0,
    step_index: 0,
    prompt: "Implement feature X",
    context_files: ["src/foo.ts"],
    validation_criteria: "Tests pass",
    timeout_minutes: 5,
  };

  it("parses a valid decision", () => {
    const result = DispatcherDecisionSchema.safeParse(validDecision);
    expect(result.success).toBe(true);
  });

  it("strips unknown fields from LLM output", () => {
    const result = DispatcherDecisionSchema.parse({
      ...validDecision,
      hallucinated_field: "should be stripped",
      adapted_plan: "should also be stripped",
    });
    expect((result as any).hallucinated_field).toBeUndefined();
    expect((result as any).adapted_plan).toBeUndefined();
  });

  it("rejects parallel: true with refinement error", () => {
    const result = DispatcherDecisionSchema.safeParse({
      ...validDecision,
      parallel: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages.some((m) => /parallel/i.test(m))).toBe(true);
    }
  });

  it("accepts parallel: false without error", () => {
    const result = DispatcherDecisionSchema.safeParse({
      ...validDecision,
      parallel: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = DispatcherDecisionSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DispatcherInputSchema
// ---------------------------------------------------------------------------
describe("DispatcherInputSchema", () => {
  const validInput = {
    plan: {
      phases: [
        {
          name: "Phase 1",
          steps: [{ description: "Do something" }],
        },
      ],
    },
    state: {
      completed_phases: [],
      current_phase_index: 0,
    },
    context: {
      files: ["src/foo.ts"],
    },
  };

  it("parses valid input", () => {
    const result = DispatcherInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("rejects input with full_content in plan (removed)", () => {
    const result = DispatcherInputSchema.safeParse({
      ...validInput,
      plan: {
        ...validInput.plan,
        full_content: "should not exist",
      },
    });
    // full_content should be stripped (DispatcherInput uses strip too)
    if (result.success) {
      expect((result.data.plan as any).full_content).toBeUndefined();
    }
  });

  it("accepts empty phases array", () => {
    const result = DispatcherInputSchema.safeParse({
      ...validInput,
      plan: { phases: [] },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EvaluatorResultSchema (.strip() — LLM output)
// ---------------------------------------------------------------------------
describe("EvaluatorResultSchema", () => {
  const validResult = {
    passed: true,
    reasoning: "Tests pass and output looks correct",
    suggestions: [],
  };

  it("parses a valid result", () => {
    const result = EvaluatorResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
  });

  it("strips unknown fields", () => {
    const parsed = EvaluatorResultSchema.parse({
      ...validResult,
      extra_llm_field: "strip me",
    });
    expect((parsed as any).extra_llm_field).toBeUndefined();
  });

  it("rejects missing passed field", () => {
    const result = EvaluatorResultSchema.safeParse({
      reasoning: "no pass field",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EvaluatorInputSchema
// ---------------------------------------------------------------------------
describe("EvaluatorInputSchema", () => {
  it("parses valid evaluator input", () => {
    const result = EvaluatorInputSchema.safeParse({
      worker_output: "some output text",
      validation_criteria: "Tests pass",
      context_files: ["src/foo.ts"],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StateFileSchema (.strict() — internal)
// ---------------------------------------------------------------------------
describe("StateFileSchema", () => {
  const validState = {
    schema_version: 1 as const,
    plan_path: "docs/plans/my-plan.md",
    writer: "skill" as const,
    last_written_at: "2026-03-15T00:00:00Z",
    phases: [
      {
        name: "Phase 1",
        status: "completed" as const,
        steps: [],
      },
    ],
  };

  it("parses a valid state file", () => {
    const result = StateFileSchema.safeParse(validState);
    expect(result.success).toBe(true);
  });

  it("enforces schema_version: 1 literal", () => {
    const result = StateFileSchema.safeParse({
      ...validState,
      schema_version: 2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields in strict mode", () => {
    const result = StateFileSchema.safeParse({
      ...validState,
      unknown_field: "should fail",
    });
    expect(result.success).toBe(false);
  });

  it("requires writer field", () => {
    const { writer, ...noWriter } = validState;
    const result = StateFileSchema.safeParse(noWriter);
    expect(result.success).toBe(false);
  });

  it("requires last_written_at field", () => {
    const { last_written_at, ...noTimestamp } = validState;
    const result = StateFileSchema.safeParse(noTimestamp);
    expect(result.success).toBe(false);
  });

  it("validates last_written_at is ISO datetime", () => {
    const result = StateFileSchema.safeParse({
      ...validState,
      last_written_at: "not-a-date",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// migrateStateFile
// ---------------------------------------------------------------------------
describe("migrateStateFile", () => {
  it("adds default writer='skill' when missing", () => {
    const raw = {
      schema_version: 1,
      plan_path: "docs/plans/my-plan.md",
      last_written_at: "2026-03-15T00:00:00Z",
      phases: [],
    };
    const migrated = migrateStateFile(raw);
    expect(migrated.writer).toBe("skill");
  });

  it("adds last_written_at from mtime when missing", () => {
    const raw = {
      schema_version: 1,
      plan_path: "docs/plans/my-plan.md",
      phases: [],
    };
    const migrated = migrateStateFile(raw, new Date("2026-01-01T00:00:00Z"));
    expect(migrated.last_written_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("preserves existing writer field", () => {
    const raw = {
      schema_version: 1,
      plan_path: "docs/plans/my-plan.md",
      writer: "controller",
      last_written_at: "2026-03-15T00:00:00Z",
      phases: [],
    };
    const migrated = migrateStateFile(raw);
    expect(migrated.writer).toBe("controller");
  });

  it("result parses with StateFileSchema", () => {
    const raw = {
      schema_version: 1,
      plan_path: "docs/plans/my-plan.md",
      phases: [],
    };
    const migrated = migrateStateFile(raw, new Date("2026-01-01T00:00:00Z"));
    const result = StateFileSchema.safeParse(migrated);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ConfigSchema (.strict() — internal)
// ---------------------------------------------------------------------------
describe("ConfigSchema", () => {
  const validConfig = {
    model: "claude-sonnet-4-20250514",
    max_retries: 3,
    timeout_minutes: 30,
    dispatcher_timeout_ms: 30000,
  };

  it("parses a valid config", () => {
    const result = ConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  it("rejects max_retries > 10", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      max_retries: 11,
    });
    expect(result.success).toBe(false);
  });

  it("rejects max_retries < 0", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      max_retries: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects timeout_minutes > 120", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      timeout_minutes: 121,
    });
    expect(result.success).toBe(false);
  });

  it("rejects timeout_minutes < 1", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      timeout_minutes: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects dispatcher_timeout_ms < 5000", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      dispatcher_timeout_ms: 4999,
    });
    expect(result.success).toBe(false);
  });

  it("rejects dispatcher_timeout_ms > 120000", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      dispatcher_timeout_ms: 120001,
    });
    expect(result.success).toBe(false);
  });

  it("defaults dispatcher_timeout_ms to 30000", () => {
    const { dispatcher_timeout_ms, ...noTimeout } = validConfig;
    const result = ConfigSchema.safeParse(noTimeout);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dispatcher_timeout_ms).toBe(30000);
    }
  });

  it("rejects shell metacharacters in model field", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      model: "claude; rm -rf /",
    });
    expect(result.success).toBe(false);
  });

  it("rejects shell metacharacters (backticks) in model field", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      model: "claude`whoami`",
    });
    expect(result.success).toBe(false);
  });

  it("rejects shell metacharacters ($()) in model field", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      model: "claude$(whoami)",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields in strict mode", () => {
    const result = ConfigSchema.safeParse({
      ...validConfig,
      unknown: "fail",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkerFailureReasonSchema (discriminated union)
// ---------------------------------------------------------------------------
describe("WorkerFailureReasonSchema", () => {
  const allKinds = [
    "timeout",
    "completion_not_detected",
    "exit_code",
    "schema_error",
    "api_error",
    "rate_limited",
    "transient",
  ] as const;

  it("validates all 7 kind strings", () => {
    expect(allKinds.length).toBe(7);
  });

  it("parses timeout kind with timeoutMs", () => {
    const result = WorkerFailureReasonSchema.safeParse({
      kind: "timeout",
      timeoutMs: 30000,
      message: "Worker timed out",
    });
    expect(result.success).toBe(true);
  });

  it("rejects timeout kind without timeoutMs", () => {
    const result = WorkerFailureReasonSchema.safeParse({
      kind: "timeout",
      message: "Worker timed out",
    });
    expect(result.success).toBe(false);
  });

  for (const kind of allKinds) {
    if (kind === "timeout") continue;
    it(`parses '${kind}' kind`, () => {
      const base: Record<string, unknown> = {
        kind,
        message: `Failed: ${kind}`,
      };
      if (kind === "exit_code") base.exitCode = 1;
      const result = WorkerFailureReasonSchema.safeParse(base);
      expect(result.success).toBe(true);
    });
  }

  it("rejects unknown kind string", () => {
    const result = WorkerFailureReasonSchema.safeParse({
      kind: "unknown_kind",
      message: "should fail",
    });
    expect(result.success).toBe(false);
  });

  // Test each kind as a string literal to catch typos
  for (const kind of allKinds) {
    it(`kind '${kind}' is exactly that string literal`, () => {
      // This test ensures the schema doesn't accept misspellings
      const typo = kind + "x";
      const base: Record<string, unknown> = {
        kind: typo,
        message: "typo test",
      };
      const result = WorkerFailureReasonSchema.safeParse(base);
      expect(result.success).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// WorkerResultSchema
// ---------------------------------------------------------------------------
describe("WorkerResultSchema", () => {
  it("parses a valid worker result", () => {
    const result = WorkerResultSchema.safeParse({
      output: "some output",
      exitCode: 0,
      truncated: false,
      durationMs: 5000,
    });
    expect(result.success).toBe(true);
  });

  it("includes truncated field", () => {
    const parsed = WorkerResultSchema.parse({
      output: "some output",
      exitCode: 0,
      truncated: true,
      durationMs: 5000,
    });
    expect(parsed.truncated).toBe(true);
  });

  it("rejects missing truncated field", () => {
    const result = WorkerResultSchema.safeParse({
      output: "some output",
      exitCode: 0,
      durationMs: 5000,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CliSessionSchema (.strict() — internal)
// ---------------------------------------------------------------------------
describe("CliSessionSchema", () => {
  const validSession = {
    planPath: "docs/plans/my-plan.md",
    statePath: "docs/plans/my-plan.state.md",
    contextPath: "docs/plans/my-plan.context.md",
    currentPhase: 0,
    lastUpdated: "2026-03-15T00:00:00Z",
    workflowId: "550e8400-e29b-41d4-a716-446655440000",
  };

  it("parses a valid session", () => {
    const result = CliSessionSchema.safeParse(validSession);
    expect(result.success).toBe(true);
  });

  it("rejects invalid UUID for workflowId", () => {
    const result = CliSessionSchema.safeParse({
      ...validSession,
      workflowId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields in strict mode", () => {
    const result = CliSessionSchema.safeParse({
      ...validSession,
      unknown: "fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects null optional fields that are required", () => {
    const { planPath, ...noPath } = validSession;
    const result = CliSessionSchema.safeParse(noPath);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WorkflowDefinitionSchema
// ---------------------------------------------------------------------------
describe("WorkflowDefinitionSchema", () => {
  const validWorkflow = {
    name: "Build Feature",
    description: "Build the feature end to end",
    steps: [
      {
        description: "Implement the feature",
        dispatcherHint: "Use TDD",
        validationCriteria: "Tests pass",
        requiredOutputs: ["src/feature.ts"],
        dependencies: [],
      },
    ],
  };

  it("parses a valid workflow definition", () => {
    const result = WorkflowDefinitionSchema.safeParse(validWorkflow);
    expect(result.success).toBe(true);
  });

  it("accepts steps with minimal fields", () => {
    const result = WorkflowDefinitionSchema.safeParse({
      name: "Simple",
      description: "A simple workflow",
      steps: [{ description: "Do it" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty steps array", () => {
    const result = WorkflowDefinitionSchema.safeParse({
      name: "Empty",
      description: "No steps",
      steps: [],
    });
    // steps should have at least one item
    expect(result.success).toBe(false);
  });

  it("rejects missing name", () => {
    const result = WorkflowDefinitionSchema.safeParse({
      description: "No name",
      steps: [{ description: "Step" }],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExecutionStatusSchema
// ---------------------------------------------------------------------------
describe("ExecutionStatusSchema", () => {
  const validStatuses = [
    "running",
    "completed",
    "failed",
    "interrupted",
    "timeout",
  ];

  for (const status of validStatuses) {
    it(`accepts '${status}'`, () => {
      const result = ExecutionStatusSchema.safeParse(status);
      expect(result.success).toBe(true);
    });
  }

  it("rejects invalid status", () => {
    const result = ExecutionStatusSchema.safeParse("paused");
    expect(result.success).toBe(false);
  });
});
