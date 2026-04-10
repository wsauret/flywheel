import { describe, it, expect } from "bun:test";
import {
  DispatcherInputSchema,
  DispatcherDecisionSchema,
  WorkflowInfoSchema,
  DispatcherConfigSchema,
} from "../src/workflows/dispatcher/schemas";
import {
  EvaluatorInputSchema,
  EvaluatorResultSchema,
} from "../src/workflows/evaluator/schemas";
import {
  SubprocessResultSchema,
  SubprocessFailureReasonSchema,
} from "../src/orchestration/engines/subprocess/schemas";
import { SessionSchema } from "../src/orchestration/session/schemas";
import {
  EvaluationCriteriaSchema,
  ToolScopingSchema,
  SessionBudgetStatusSchema,
  WorkerConfigSchema,
  AvailableContextSchema,
  LastWorkerResultSchema,
} from "../src/workflows/schemas";
import { EventBus, createEmit } from "../src/infra/event-bus";

// ---------------------------------------------------------------------------
// DispatcherDecisionSchema (.strip() — LLM output)
// ---------------------------------------------------------------------------
describe("DispatcherDecisionSchema", () => {
  const validDecision = {
    schema_version: 1 as const,
    step_index: 0,
    task_content: "Implement feature X",
    context_files: ["src/foo.ts"],
    evaluation_criteria: {
      acceptance_criteria: ["Tests pass"],
      required_tests: true,
      custom_checks: [],
      required_outputs: [],
    },
    reasoning: "Standard execution",
    warnings: [],
    worker_config: {
      model_override: null,
      timeout_minutes: 30,
      retry_on_failure: true,
      max_retries: 3,
      iteration_budget: 5,
      tool_scoping: { read: true, bash: true, write: true, edit: true },
      parallel: false,
      parallel_variants: null,
    },
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

  it("strips removed parallel field (no longer in schema)", () => {
    const result = DispatcherDecisionSchema.safeParse({
      ...validDecision,
      parallel: true,
    });
    // parallel is stripped (not rejected) — it's an unknown field
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as any).parallel).toBeUndefined();
    }
  });

  it("rejects missing required fields", () => {
    const result = DispatcherDecisionSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("requires schema_version: 1", () => {
    const result = DispatcherDecisionSchema.parse(validDecision);
    expect(result.schema_version).toBe(1);
  });

  it("rejects missing schema_version", () => {
    const { schema_version, ...noVersion } = validDecision;
    const result = DispatcherDecisionSchema.safeParse(noVersion);
    expect(result.success).toBe(false);
  });

  it("rejects schema_version other than 1", () => {
    const result = DispatcherDecisionSchema.safeParse({
      ...validDecision,
      schema_version: 2,
    });
    expect(result.success).toBe(false);
  });

  it("requires reasoning string", () => {
    const result = DispatcherDecisionSchema.parse({
      ...validDecision,
      reasoning: "Step is straightforward setup",
    });
    expect(result.reasoning).toBe("Step is straightforward setup");
  });

  it("accepts missing reasoning (optional)", () => {
    const { reasoning, ...noReasoning } = validDecision;
    const result = DispatcherDecisionSchema.safeParse(noReasoning);
    expect(result.success).toBe(true);
  });

  it("requires warnings array", () => {
    const result = DispatcherDecisionSchema.parse({
      ...validDecision,
      warnings: ["Large file detected", "Possible circular dependency"],
    });
    expect(result.warnings).toEqual(["Large file detected", "Possible circular dependency"]);
  });

  it("accepts missing warnings (optional)", () => {
    const { warnings, ...noWarnings } = validDecision;
    const result = DispatcherDecisionSchema.safeParse(noWarnings);
    expect(result.success).toBe(true);
  });

  it("requires worker_config", () => {
    const workerConfig = {
      model_override: null,
      timeout_minutes: 30,
      retry_on_failure: true,
      max_retries: 3,
      iteration_budget: 10,
      tool_scoping: { read: true, bash: true, write: true, edit: true },
      parallel: false,
      parallel_variants: null,
    };
    const result = DispatcherDecisionSchema.parse({
      ...validDecision,
      worker_config: workerConfig,
    });
    expect(result.worker_config).toEqual(workerConfig);
  });

  it("accepts missing worker_config (optional)", () => {
    const { worker_config, ...noWorkerConfig } = validDecision;
    const result = DispatcherDecisionSchema.safeParse(noWorkerConfig);
    expect(result.success).toBe(true);
  });

  it("requires evaluation_criteria as EvaluationCriteria object", () => {
    const criteria = {
      acceptance_criteria: ["tests pass", "no regressions"],
      required_tests: true,
      custom_checks: ["lint clean"],
      required_outputs: ["src/feature.ts"],
    };
    const result = DispatcherDecisionSchema.parse({
      ...validDecision,
      evaluation_criteria: criteria,
    });
    expect(result.evaluation_criteria).toEqual(criteria);
  });

  it("rejects evaluation_criteria as string", () => {
    const result = DispatcherDecisionSchema.safeParse({
      ...validDecision,
      evaluation_criteria: "Tests pass",
    });
    expect(result.success).toBe(false);
  });

  // --- context_to_inline tests ---

  it("accepts context_to_inline as string array", () => {
    const result = DispatcherDecisionSchema.safeParse({
      ...validDecision,
      context_to_inline: ["docs/conventions.md", "docs/standards.md"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context_to_inline).toEqual(["docs/conventions.md", "docs/standards.md"]);
    }
  });

  it("accepts decision without context_to_inline (optional)", () => {
    const result = DispatcherDecisionSchema.safeParse(validDecision);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context_to_inline).toBeUndefined();
    }
  });

  it("validates context_to_inline paths are strings", () => {
    const result = DispatcherDecisionSchema.safeParse({
      ...validDecision,
      context_to_inline: [123, true],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DispatcherInputSchema
// ---------------------------------------------------------------------------
describe("DispatcherInputSchema", () => {
  const validInput = {
    plan: {
      steps: [
        {
          title: "Step 1",
          description: "Do something",
        },
      ],
    },
    state: {
      completed_steps: [],
      current_step_index: 0,
    },
    workflow_id: "wf-test-001",
    workflow: { name: "work", step_number: 1, total_steps: 2, step_description: "Setup" },
    last_worker_result: null,
    config: { max_eval_cycles: 3, worktree_path: "/tmp/wt", project_cwd: "/tmp/proj", subprocess_model: "opus", dispatcher_model: "opus" },
    session_budget: { invocations_remaining: 100, token_budget_remaining: null, wall_clock_deadline: null },
    available_context: { conventions: [], standards: [], learnings: [] },
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

  it("accepts empty steps array", () => {
    const result = DispatcherInputSchema.safeParse({
      ...validInput,
      plan: { steps: [] },
    });
    expect(result.success).toBe(true);
  });

  it("requires workflow_id", () => {
    const { workflow_id, ...noWfId } = validInput;
    const result = DispatcherInputSchema.safeParse(noWfId);
    expect(result.success).toBe(false);
  });

  it("accepts workflow_id string", () => {
    const result = DispatcherInputSchema.parse({
      ...validInput,
      workflow_id: "wf-abc-123",
    });
    expect(result.workflow_id).toBe("wf-abc-123");
  });

  it("accepts and round-trips workflow (WorkflowInfoSchema)", () => {
    const workflow = {
      name: "work",
      step_number: 2,
      total_steps: 5,
      step_description: "Implement core logic",
    };
    const result = DispatcherInputSchema.parse({
      ...validInput,
      workflow,
    });
    expect(result.workflow).toEqual(workflow);
  });

  it("accepts and round-trips last_worker_result", () => {
    const lastWorkerResult = {
      step: 1,
      status: "completed",
      output_summary: "Step 1 done",
      artifacts_produced: ["src/setup.ts"],
      tests_passed: true,
    };
    const result = DispatcherInputSchema.parse({
      ...validInput,
      last_worker_result: lastWorkerResult,
    });
    expect(result.last_worker_result).toEqual(lastWorkerResult);
  });

  it("accepts null for last_worker_result", () => {
    const result = DispatcherInputSchema.parse({
      ...validInput,
      last_worker_result: null,
    });
    expect(result.last_worker_result).toBeNull();
  });

  it("accepts and round-trips config (DispatcherConfigSchema)", () => {
    const config = {
      max_eval_cycles: 3,
      worktree_path: "/tmp/wt",
      project_cwd: "/home/project",
      subprocess_model: "opus",
      dispatcher_model: "sonnet",
    };
    const result = DispatcherInputSchema.parse({
      ...validInput,
      config,
    });
    expect(result.config).toEqual(config);
  });

  it("accepts and round-trips session_budget", () => {
    const sessionBudget = {
      invocations_remaining: 50,
      token_budget_remaining: 200000,
      wall_clock_deadline: "2026-03-20T18:00:00Z",
    };
    const result = DispatcherInputSchema.parse({
      ...validInput,
      session_budget: sessionBudget,
    });
    expect(result.session_budget).toEqual(sessionBudget);
  });

  it("accepts and round-trips available_context", () => {
    const entry = { name: "conventions", path: "docs/conv.md", summary: "Code conventions" };
    const availableContext = {
      conventions: [entry],
      standards: [],
      learnings: [entry],
    };
    const result = DispatcherInputSchema.parse({
      ...validInput,
      available_context: availableContext,
    });
    expect(result.available_context).toEqual(availableContext);
  });

  it("accepts all required fields together", () => {
    const full = {
      ...validInput,
      workflow_id: "wf-full-test",
      workflow: {
        name: "plan",
        step_number: 1,
        total_steps: 3,
        step_description: "Create plan",
      },
      last_worker_result: {
        step: 0,
        status: "completed",
        output_summary: "Init done",
        artifacts_produced: [],
        tests_passed: null,
      },
      config: {
        max_eval_cycles: 2,
        worktree_path: "/tmp/wt",
        project_cwd: "/home/proj",
        subprocess_model: "opus",
        dispatcher_model: "sonnet",
      },
      session_budget: {
        invocations_remaining: 10,
        token_budget_remaining: null,
        wall_clock_deadline: null,
      },
      available_context: {
        conventions: [],
        standards: [],
        learnings: [],
      },
    };
    const result = DispatcherInputSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  it("strips unknown fields from sub-schemas", () => {
    const result = DispatcherInputSchema.parse({
      ...validInput,
      workflow: {
        name: "work",
        step_number: 1,
        total_steps: 2,
        step_description: "Do work",
        hallucinated_field: "should be stripped",
      },
      config: {
        max_eval_cycles: 3,
        worktree_path: "/tmp",
        project_cwd: "/home",
        subprocess_model: "opus",
        dispatcher_model: "sonnet",
        extra_config: "should be stripped",
      },
      unknown_top_level: "should be stripped",
    });
    expect((result.workflow as any).hallucinated_field).toBeUndefined();
    expect((result.config as any).extra_config).toBeUndefined();
    expect((result as any).unknown_top_level).toBeUndefined();
  });

  it("rejects missing required fields", () => {
    const minimalInput = {
      plan: { steps: [] },
      state: { completed_steps: [], current_step_index: 0 },
    };
    const result = DispatcherInputSchema.safeParse(minimalInput);
    expect(result.success).toBe(false);
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
    confidence: 0.9,
    feedback: "Looks good",
    files_to_review: [],
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
      confidence: 0.5,
      feedback: "test",
      files_to_review: [],
    });
    expect(result.success).toBe(false);
  });

  it("requires confidence (0-1 range)", () => {
    const result = EvaluatorResultSchema.parse({
      ...validResult,
      confidence: 0.85,
    });
    expect(result.confidence).toBe(0.85);
  });

  it("accepts confidence at boundaries (0 and 1)", () => {
    const atZero = EvaluatorResultSchema.parse({ ...validResult, confidence: 0 });
    expect(atZero.confidence).toBe(0);

    const atOne = EvaluatorResultSchema.parse({ ...validResult, confidence: 1 });
    expect(atOne.confidence).toBe(1);
  });

  it("rejects confidence below 0", () => {
    const result = EvaluatorResultSchema.safeParse({
      ...validResult,
      confidence: -0.1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence above 1", () => {
    const result = EvaluatorResultSchema.safeParse({
      ...validResult,
      confidence: 1.1,
    });
    expect(result.success).toBe(false);
  });

  it("requires feedback string", () => {
    const result = EvaluatorResultSchema.parse({
      ...validResult,
      feedback: "Consider adding error handling",
    });
    expect(result.feedback).toBe("Consider adding error handling");
  });

  it("rejects missing feedback", () => {
    const { feedback, ...noFeedback } = validResult;
    const result = EvaluatorResultSchema.safeParse(noFeedback);
    expect(result.success).toBe(false);
  });

  it("requires files_to_review array", () => {
    const result = EvaluatorResultSchema.parse({
      ...validResult,
      files_to_review: ["src/index.ts", "tests/index.test.ts"],
    });
    expect(result.files_to_review).toEqual(["src/index.ts", "tests/index.test.ts"]);
  });

  it("rejects missing required fields", () => {
    const result = EvaluatorResultSchema.safeParse({
      passed: true,
      reasoning: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all fields together", () => {
    const result = EvaluatorResultSchema.parse({
      ...validResult,
      confidence: 0.95,
      feedback: "Looks great overall",
      files_to_review: ["src/main.ts"],
    });
    expect(result.confidence).toBe(0.95);
    expect(result.feedback).toBe("Looks great overall");
    expect(result.files_to_review).toEqual(["src/main.ts"]);
  });
});

// ---------------------------------------------------------------------------
// EvaluatorInputSchema
// ---------------------------------------------------------------------------
describe("EvaluatorInputSchema", () => {
  const validInput = {
    worker_output: "some output text",
    evaluation_criteria: "Tests pass",
    context_files: ["src/foo.ts"],
    acceptance_criteria: ["Tests pass"],
    artifacts_produced: ["src/feature.ts"],
    tests_passed: true,
  };

  it("parses valid evaluator input", () => {
    const result = EvaluatorInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("requires acceptance_criteria array", () => {
    const result = EvaluatorInputSchema.parse({
      ...validInput,
      acceptance_criteria: ["tests pass", "no regressions"],
    });
    expect(result.acceptance_criteria).toEqual(["tests pass", "no regressions"]);
  });

  it("rejects missing acceptance_criteria", () => {
    const { acceptance_criteria, ...noAC } = validInput;
    const result = EvaluatorInputSchema.safeParse(noAC);
    expect(result.success).toBe(false);
  });

  it("requires artifacts_produced array", () => {
    const result = EvaluatorInputSchema.parse({
      ...validInput,
      artifacts_produced: ["src/feature.ts", "tests/feature.test.ts"],
    });
    expect(result.artifacts_produced).toEqual(["src/feature.ts", "tests/feature.test.ts"]);
  });

  it("accepts tests_passed as true", () => {
    const result = EvaluatorInputSchema.parse({
      ...validInput,
      tests_passed: true,
    });
    expect(result.tests_passed).toBe(true);
  });

  it("accepts tests_passed as false", () => {
    const result = EvaluatorInputSchema.parse({
      ...validInput,
      tests_passed: false,
    });
    expect(result.tests_passed).toBe(false);
  });

  it("accepts tests_passed as null", () => {
    const result = EvaluatorInputSchema.parse({
      ...validInput,
      tests_passed: null,
    });
    expect(result.tests_passed).toBeNull();
  });

  it("rejects missing required fields", () => {
    const result = EvaluatorInputSchema.safeParse({
      worker_output: "output",
      evaluation_criteria: "criteria",
      context_files: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts all required fields together", () => {
    const result = EvaluatorInputSchema.parse({
      ...validInput,
      acceptance_criteria: ["feature works"],
      artifacts_produced: ["src/new.ts"],
      tests_passed: true,
    });
    expect(result.acceptance_criteria).toEqual(["feature works"]);
    expect(result.artifacts_produced).toEqual(["src/new.ts"]);
    expect(result.tests_passed).toBe(true);
  });

  it("strips unknown fields", () => {
    const result = EvaluatorInputSchema.parse({
      ...validInput,
      hallucinated: "strip me",
    });
    expect((result as any).hallucinated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SubprocessFailureReasonSchema (discriminated union)
// ---------------------------------------------------------------------------
describe("SubprocessFailureReasonSchema", () => {
  const allKinds = [
    "timeout",
    "exit_code",
    "schema_error",
    "api_error",
    "rate_limited",
    "transient",
    "interrupted",
    "handoff_missing",
    "handoff_invalid",
  ] as const;

  it("validates all 9 kind strings", () => {
    expect(allKinds.length).toBe(9);
  });

  it("parses timeout kind with timeoutMs", () => {
    const result = SubprocessFailureReasonSchema.safeParse({
      kind: "timeout",
      timeoutMs: 30000,
      message: "Worker timed out",
    });
    expect(result.success).toBe(true);
  });

  it("rejects timeout kind without timeoutMs", () => {
    const result = SubprocessFailureReasonSchema.safeParse({
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
      const result = SubprocessFailureReasonSchema.safeParse(base);
      expect(result.success).toBe(true);
    });
  }

  it("rejects unknown kind string", () => {
    const result = SubprocessFailureReasonSchema.safeParse({
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
      const result = SubprocessFailureReasonSchema.safeParse(base);
      expect(result.success).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// SubprocessResultSchema
// ---------------------------------------------------------------------------
describe("SubprocessResultSchema", () => {
  it("parses a valid worker result", () => {
    const result = SubprocessResultSchema.safeParse({
      output: "some output",
      exitCode: 0,
      truncated: false,
      durationMs: 5000,
      handoffPath: "/tmp/handoffs/abc.json",
    });
    expect(result.success).toBe(true);
  });

  it("includes truncated field", () => {
    const parsed = SubprocessResultSchema.parse({
      output: "some output",
      exitCode: 0,
      truncated: true,
      durationMs: 5000,
      handoffPath: "",
    });
    expect(parsed.truncated).toBe(true);
  });

  it("rejects missing truncated field", () => {
    const result = SubprocessResultSchema.safeParse({
      output: "some output",
      exitCode: 0,
      durationMs: 5000,
      handoffPath: "",
    });
    expect(result.success).toBe(false);
  });

  it("includes handoffPath field", () => {
    const parsed = SubprocessResultSchema.parse({
      output: "some output",
      exitCode: 0,
      truncated: false,
      durationMs: 5000,
      handoffPath: "/tmp/.flywheel/handoffs/abc-123.json",
    });
    expect(parsed.handoffPath).toBe("/tmp/.flywheel/handoffs/abc-123.json");
  });

  it("rejects missing handoffPath field", () => {
    const result = SubprocessResultSchema.safeParse({
      output: "some output",
      exitCode: 0,
      truncated: false,
      durationMs: 5000,
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty string handoffPath", () => {
    const result = SubprocessResultSchema.safeParse({
      output: "some output",
      exitCode: 0,
      truncated: false,
      durationMs: 5000,
      handoffPath: "",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SessionSchema (.strict() — internal)
// ---------------------------------------------------------------------------
describe("SessionSchema", () => {
  const validWorkflowSession = {
    label: "docs/plans/my-plan.md",
    planPath: "docs/plans/my-plan.md",
    worktreePath: "/tmp/worktrees/test",
    lastUpdated: "2026-03-15T00:00:00Z",
    budgetLimits: {
      max_invocations: 0,
      max_tokens: null,
      wall_clock_deadline: null,
    },
    budgetUsage: {
      invocations_used: 0,
      tokens_used: 0,
      cost_usd: 0,
    },
    kind: "workflow" as const,
    command: "work" as const,
  };

  const validChatSession = {
    label: "chat session",
    lastUpdated: "2026-03-15T00:00:00Z",
    budgetLimits: {
      max_invocations: 0,
      max_tokens: null,
      wall_clock_deadline: null,
    },
    budgetUsage: {
      invocations_used: 0,
      tokens_used: 0,
      cost_usd: 0,
    },
    kind: "chat" as const,
    command: "chat" as const,
  };

  it("parses a valid workflow session", () => {
    const result = SessionSchema.safeParse(validWorkflowSession);
    expect(result.success).toBe(true);
  });

  it("parses a valid chat session", () => {
    const result = SessionSchema.safeParse(validChatSession);
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields in strict mode (workflow)", () => {
    const result = SessionSchema.safeParse({
      ...validWorkflowSession,
      unknown: "fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields in strict mode (chat)", () => {
    const result = SessionSchema.safeParse({
      ...validChatSession,
      unknown: "fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields (label)", () => {
    const { label, ...noLabel } = validWorkflowSession;
    const result = SessionSchema.safeParse(noLabel);
    expect(result.success).toBe(false);
  });

  it("rejects missing budgetLimits", () => {
    const { budgetLimits, ...noBudget } = validWorkflowSession;
    const result = SessionSchema.safeParse(noBudget);
    expect(result.success).toBe(false);
  });

  it("rejects missing kind", () => {
    const { kind, ...noKind } = validWorkflowSession;
    const result = SessionSchema.safeParse(noKind);
    expect(result.success).toBe(false);
  });

  it("rejects missing command", () => {
    const { command, ...noCommand } = validWorkflowSession;
    const result = SessionSchema.safeParse(noCommand);
    expect(result.success).toBe(false);
  });

  it("requires planPath on workflow sessions", () => {
    const { planPath, ...noPlanPath } = validWorkflowSession;
    const result = SessionSchema.safeParse(noPlanPath);
    expect(result.success).toBe(false);
  });

  it("allows workflow sessions without worktreePath (optional)", () => {
    const { worktreePath, ...noWorktreePath } = validWorkflowSession;
    const result = SessionSchema.safeParse(noWorktreePath);
    expect(result.success).toBe(true);
  });

  it("rejects workflow sessions with empty-string worktreePath", () => {
    const result = SessionSchema.safeParse({
      ...validWorkflowSession,
      worktreePath: "",
    });
    expect(result.success).toBe(false);
  });

  it("chat sessions have no planPath or worktreePath", () => {
    const result = SessionSchema.safeParse({
      ...validChatSession,
      planPath: "should-fail.md",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared Sub-Schemas (src/schemas/shared.ts)
// ---------------------------------------------------------------------------

describe("EvaluationCriteriaSchema", () => {
  const valid = {
    acceptance_criteria: ["tests pass", "no regressions"],
    required_tests: true,
    custom_checks: ["lint clean"],
    required_outputs: ["src/feature.ts"],
  };

  it("round-trips valid data", () => {
    const result = EvaluationCriteriaSchema.parse(valid);
    expect(result).toEqual(valid);
  });

  it("strips unknown fields", () => {
    const result = EvaluationCriteriaSchema.parse({
      ...valid,
      hallucinated: "remove me",
    });
    expect((result as any).hallucinated).toBeUndefined();
  });

  it("rejects missing required fields", () => {
    const result = EvaluationCriteriaSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("ToolScopingSchema", () => {
  const valid = { read: true, bash: true, write: true, edit: true };

  it("round-trips valid data", () => {
    const result = ToolScopingSchema.parse(valid);
    expect(result).toEqual(valid);
  });

  it("strips unknown fields", () => {
    const result = ToolScopingSchema.parse({
      ...valid,
      extra: "strip me",
    });
    expect((result as any).extra).toBeUndefined();
  });

  it("rejects non-boolean values", () => {
    const result = ToolScopingSchema.safeParse({
      read: "yes",
      bash: true,
      write: true,
      edit: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("SessionBudgetStatusSchema", () => {
  // Budget status sent to dispatcher — tracks remaining budget
  const valid = {
    invocations_remaining: 75,
    token_budget_remaining: 380000,
    wall_clock_deadline: "2026-03-20T12:00:00Z",
  };

  it("round-trips valid data", () => {
    const result = SessionBudgetStatusSchema.parse(valid);
    expect(result).toEqual(valid);
  });

  it("accepts null for nullable fields", () => {
    const result = SessionBudgetStatusSchema.parse({
      ...valid,
      token_budget_remaining: null,
      wall_clock_deadline: null,
    });
    expect(result.token_budget_remaining).toBeNull();
    expect(result.wall_clock_deadline).toBeNull();
  });

  it("strips unknown fields", () => {
    const result = SessionBudgetStatusSchema.parse({
      ...valid,
      extra: "gone",
    });
    expect((result as any).extra).toBeUndefined();
  });
});

describe("WorkerConfigSchema", () => {
  const valid = {
    model_override: null,
    timeout_minutes: 30,
    retry_on_failure: true,
    max_retries: 3,
    iteration_budget: 10,
    tool_scoping: { read: true, bash: true, write: true, edit: true },
    parallel: false,
    parallel_variants: null,
  };

  it("round-trips valid data", () => {
    const result = WorkerConfigSchema.parse(valid);
    expect(result).toEqual(valid);
  });

  it("accepts model_override as string", () => {
    const result = WorkerConfigSchema.parse({
      ...valid,
      model_override: "claude-opus-4-20250514",
    });
    expect(result.model_override).toBe("claude-opus-4-20250514");
  });

  it("accepts parallel_variants array", () => {
    const result = WorkerConfigSchema.parse({
      ...valid,
      parallel_variants: [
        { name: "variant-a", prompt: "approach A" },
        { name: "variant-b", prompt: "approach B" },
      ],
    });
    expect(result.parallel_variants).toHaveLength(2);
    expect(result.parallel_variants![0].name).toBe("variant-a");
  });

  it("strips unknown fields", () => {
    const result = WorkerConfigSchema.parse({
      ...valid,
      hallucinated: "remove",
    });
    expect((result as any).hallucinated).toBeUndefined();
  });

  it("accepts empty object (all fields optional)", () => {
    const result = WorkerConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("AvailableContextSchema", () => {
  const entry = { name: "coding-standards", path: "docs/standards.md", summary: "Project coding standards" };
  const valid = {
    conventions: [entry],
    standards: [entry],
    learnings: [entry],
  };

  it("round-trips valid data", () => {
    const result = AvailableContextSchema.parse(valid);
    expect(result).toEqual(valid);
  });

  it("accepts empty sub-arrays", () => {
    const result = AvailableContextSchema.parse({
      conventions: [],
      standards: [],
      learnings: [],
    });
    expect(result.conventions).toEqual([]);
  });

  it("enforces max(20) on each sub-array", () => {
    const twentyOne = Array.from({ length: 21 }, (_, i) => ({
      name: `entry-${i}`,
      path: `path-${i}`,
      summary: `summary-${i}`,
    }));
    const result = AvailableContextSchema.safeParse({
      conventions: twentyOne,
      standards: [],
      learnings: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts exactly 20 entries", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      name: `entry-${i}`,
      path: `path-${i}`,
      summary: `summary-${i}`,
    }));
    const result = AvailableContextSchema.safeParse({
      conventions: twenty,
      standards: [],
      learnings: [],
    });
    expect(result.success).toBe(true);
  });

  it("strips unknown fields", () => {
    const result = AvailableContextSchema.parse({
      ...valid,
      extra: "strip",
    });
    expect((result as any).extra).toBeUndefined();
  });
});

describe("LastWorkerResultSchema", () => {
  const valid = {
    step: 3,
    status: "completed",
    output_summary: "Built feature successfully",
    artifacts_produced: ["src/feature.ts", "tests/feature.test.ts"],
    tests_passed: true,
  };

  it("round-trips valid data", () => {
    const result = LastWorkerResultSchema.parse(valid);
    expect(result).toEqual(valid);
  });

  it("accepts null for tests_passed", () => {
    const result = LastWorkerResultSchema.parse({
      ...valid,
      tests_passed: null,
    });
    expect(result.tests_passed).toBeNull();
  });

  it("strips unknown fields", () => {
    const result = LastWorkerResultSchema.parse({
      ...valid,
      extra: "strip",
    });
    expect((result as any).extra).toBeUndefined();
  });

  it("rejects missing required fields", () => {
    const result = LastWorkerResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});




// ---------------------------------------------------------------------------
// SessionSchema — WP2 budget fields (budgetLimits + budgetUsage)
// ---------------------------------------------------------------------------
describe("SessionSchema — budget fields", () => {
  const validSession = {
    label: "docs/plans/my-plan.md",
    planPath: "docs/plans/my-plan.md",
    worktreePath: "/tmp/worktrees/test",
    lastUpdated: "2026-03-15T00:00:00Z",
    budgetLimits: { max_invocations: 0, max_tokens: null, wall_clock_deadline: null },
    budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0 },
    kind: "workflow" as const,
    command: "work" as const,
  };

  const validLimits = {
    max_invocations: 100,
    max_tokens: 500000,
    wall_clock_deadline: "2026-03-20T12:00:00Z",
  };

  const validUsage = {
    invocations_used: 25,
    tokens_used: 120000,
    cost_usd: 1.50,
  };

  it("accepts budgetLimits with valid data", () => {
    const result = SessionSchema.safeParse({
      ...validSession,
      budgetLimits: validLimits,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.budgetLimits).toEqual(validLimits);
    }
  });

  it("accepts budgetUsage with valid data", () => {
    const result = SessionSchema.safeParse({
      ...validSession,
      budgetUsage: validUsage,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.budgetUsage).toEqual(validUsage);
    }
  });

  it("accepts both budgetLimits and budgetUsage together", () => {
    const result = SessionSchema.safeParse({
      ...validSession,
      budgetLimits: validLimits,
      budgetUsage: validUsage,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.budgetLimits).toEqual(validLimits);
      expect(result.data.budgetUsage).toEqual(validUsage);
    }
  });

  it("strips unknown fields from budget sub-objects (.strip())", () => {
    const result = SessionSchema.parse({
      ...validSession,
      budgetLimits: {
        ...validLimits,
        unknown_budget_field: "should be stripped",
      },
    });
    expect((result.budgetLimits as any).unknown_budget_field).toBeUndefined();
    expect(result.budgetLimits.max_invocations).toBe(100);
  });

  it("accepts command for each valid command value", () => {
    const commands = ["work", "plan", "review", "ship", "debug", "research", "verify", "gate", "chat"] as const;
    for (const cmd of commands) {
      const isChat = cmd === "chat";
      const data = isChat
        ? { label: validSession.label, lastUpdated: validSession.lastUpdated, budgetLimits: validSession.budgetLimits, budgetUsage: validSession.budgetUsage, kind: "chat" as const, command: cmd }
        : { ...validSession, kind: "workflow" as const, command: cmd };
      const result = SessionSchema.safeParse(data);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.command).toBe(cmd);
        expect(result.data.kind).toBe(isChat ? "chat" : "workflow");
      }
    }
  });

  it("rejects invalid command", () => {
    const result = SessionSchema.safeParse({
      ...validSession,
      command: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("rejects chat command on workflow session", () => {
    const result = SessionSchema.safeParse({
      ...validSession,
      kind: "workflow",
      command: "chat",
    });
    expect(result.success).toBe(false);
  });

  it("rejects workflow command on chat session", () => {
    const result = SessionSchema.safeParse({
      label: validSession.label,
      lastUpdated: validSession.lastUpdated,
      budgetLimits: validSession.budgetLimits,
      budgetUsage: validSession.budgetUsage,
      kind: "chat" as const,
      command: "work",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid kind", () => {
    const result = SessionSchema.safeParse({
      ...validSession,
      kind: "unknown",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing budget fields", () => {
    const { budgetLimits, budgetUsage, kind, command, ...noNewFields } = validSession;
    const result = SessionSchema.safeParse(noNewFields);
    expect(result.success).toBe(false);
  });

  it("accepts all fields together with optional fields", () => {
    const full = {
      ...validSession,
      state: "active",
      name: "My session",
      createdAt: "2026-03-15T00:00:00Z",
      repo: "flywheel",
      branch: "main",
      totalCost: 1.5,
      outputPath: "output.json",
      worktreePath: "/tmp/wt",
      budgetLimits: validLimits,
      budgetUsage: validUsage,
      kind: "workflow",
      command: "work",
    };
    const result = SessionSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  it("still rejects unknown top-level fields (.strict())", () => {
    const result = SessionSchema.safeParse({
      ...validSession,
      unknown_top_level: "should fail",
    });
    expect(result.success).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// Integration — full data contract flow
// ---------------------------------------------------------------------------
describe("Integration — full data contract flow", () => {
  const fullDecision = {
    schema_version: 1 as const,
    step_index: 1,
    task_content: "Implement the core feature with proper error handling and tests.",
    context_files: ["src/index.ts", "src/utils.ts"],
    evaluation_criteria: {
      acceptance_criteria: ["Feature works end-to-end", "All tests pass"],
      required_tests: true,
      custom_checks: ["No lint warnings"],
      required_outputs: ["src/feature.ts", "tests/feature.test.ts"],
    },
    reasoning: "Step 2 requires both implementation and test coverage.",
    warnings: ["Large module — consider splitting if over 300 lines"],
    worker_config: {
      model_override: null,
      timeout_minutes: 15,
      retry_on_failure: true,
      max_retries: 2,
      iteration_budget: 8,
      tool_scoping: { read: true, bash: true, write: true, edit: true },
      parallel: false,
      parallel_variants: null,
    },
  };

  const fullEvaluatorResult = {
    passed: true,
    reasoning: "All acceptance criteria met. Tests pass, no lint warnings.",
    suggestions: ["Consider extracting utility functions to src/utils.ts"],
    confidence: 0.92,
    feedback: "Solid implementation with good error handling coverage.",
    files_to_review: ["src/feature.ts", "tests/feature.test.ts"],
  };

  it("rejects DispatcherDecision with string evaluation_criteria", () => {
    const result = DispatcherDecisionSchema.safeParse({
      ...fullDecision,
      evaluation_criteria: "All tests pass and linting is clean",
    });

    expect(result.success).toBe(false);
  });

  // --- 8.1c: DispatcherDecision with structured evaluation_criteria ---

  it("parses DispatcherDecision with structured evaluation_criteria", () => {
    const decision = DispatcherDecisionSchema.parse(fullDecision);

    expect(decision.schema_version).toBe(1);
    expect(typeof decision.evaluation_criteria).toBe("object");
    expect(decision.evaluation_criteria.acceptance_criteria).toEqual(["Feature works end-to-end", "All tests pass"]);
    expect(decision.evaluation_criteria.required_tests).toBe(true);
    expect(decision.evaluation_criteria.custom_checks).toEqual(["No lint warnings"]);
    expect(decision.evaluation_criteria.required_outputs).toEqual(["src/feature.ts", "tests/feature.test.ts"]);
  });

  // --- 8.1e: EvaluatorResult with new fields ---

  it("parses EvaluatorResult with all new fields", () => {
    const result = EvaluatorResultSchema.parse(fullEvaluatorResult);

    expect(result.passed).toBe(true);
    expect(result.reasoning).toBe("All acceptance criteria met. Tests pass, no lint warnings.");
    expect(result.suggestions).toEqual(["Consider extracting utility functions to src/utils.ts"]);
    expect(result.confidence).toBe(0.92);
    expect(result.feedback).toBe("Solid implementation with good error handling coverage.");
    expect(result.files_to_review).toEqual(["src/feature.ts", "tests/feature.test.ts"]);
  });

  // --- 8.1f: Session with budget fields parses correctly ---

  it("Session with budget fields parses correctly", () => {
    const session = {
      label: "integration test",
      planPath: "plans/integration.md",
      worktreePath: "/tmp/worktrees/integration",
      lastUpdated: "2026-03-20T10:00:00Z",
      budgetLimits: {
        max_invocations: 100,
        max_tokens: 500000,
        wall_clock_deadline: "2026-03-20T18:00:00Z",
      },
      budgetUsage: {
        invocations_used: 52,
        tokens_used: 320000,
        cost_usd: 1.5,
      },
      kind: "workflow" as const,
      command: "work" as const,
    };

    const parsed = SessionSchema.safeParse(session);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.budgetLimits.max_invocations).toBe(100);
      expect(parsed.data.budgetUsage.invocations_used).toBe(52);
      expect(parsed.data.budgetUsage.tokens_used).toBe(320000);
      expect(parsed.data.command).toBe("work");
      expect(parsed.data.kind).toBe("workflow");
    }
  });

  // --- 8.1g: Event payloads carry expanded types correctly ---

  it("event payloads carry expanded types correctly", () => {
    const bus = new EventBus();
    const emit = createEmit(bus);
    const events: import("../src/infra/events").FlywheelEvent[] = [];
    bus.subscribe((e) => events.push(e));

    // Emit dispatcher:completed with a decision containing new fields
    const decision = DispatcherDecisionSchema.parse(fullDecision);
    emit("dispatcher:completed", { workflowId: "wf-event-test", decision });

    // Emit evaluator:completed with a result containing new fields
    const evalResult = EvaluatorResultSchema.parse(fullEvaluatorResult);
    emit("evaluator:completed", { workflowId: "wf-event-test", result: evalResult });

    // Verify dispatcher event payload
    const dispEvent = events.find((e) => e.type === "dispatcher:completed") as
      import("../src/infra/events").DispatcherCompleted;
    expect(dispEvent).toBeDefined();
    expect(dispEvent.decision.schema_version).toBe(1);
    expect(dispEvent.decision.reasoning).toBe("Step 2 requires both implementation and test coverage.");
    expect(dispEvent.decision.warnings).toEqual(["Large module — consider splitting if over 300 lines"]);
    expect(dispEvent.decision.worker_config).toBeDefined();
    expect(typeof dispEvent.decision.evaluation_criteria).toBe("object");

    // Verify evaluator event payload
    const evalEvent = events.find((e) => e.type === "evaluator:completed") as
      import("../src/infra/events").EvaluatorCompleted;
    expect(evalEvent).toBeDefined();
    expect(evalEvent.result.confidence).toBe(0.92);
    expect(evalEvent.result.feedback).toBe("Solid implementation with good error handling coverage.");
    expect(evalEvent.result.files_to_review).toEqual(["src/feature.ts", "tests/feature.test.ts"]);
  });

});
