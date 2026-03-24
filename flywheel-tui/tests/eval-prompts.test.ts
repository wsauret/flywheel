import { describe, it, expect } from "bun:test";

/**
 * Tests for eval-prompts.ts — fixture assembly, judge prompt construction,
 * CLI argument parsing, and result comparison.
 */

// ---------------------------------------------------------------------------
// We import from the eval-prompts module once it exists. For now, the tests
// reference the module path for the helpers that will be extracted.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. Test scenario fixture assembly
// ---------------------------------------------------------------------------

describe("eval-prompts: fixture assembly", () => {
  it("SIMPLE scenario assembles valid dispatcher input with no history, no context", async () => {
    const { buildSimpleScenario } = await import("../scripts/eval-prompts-fixtures");
    const scenario = buildSimpleScenario();

    expect(scenario.name).toBe("simple");
    expect(scenario.dispatcherInput.plan.phases.length).toBe(1);
    expect(scenario.dispatcherInput.state.completed_phases).toEqual([]);
    expect(scenario.dispatcherInput.state.current_phase_index).toBe(0);
    expect(scenario.dispatcherInput.available_context.conventions).toEqual([]);
    expect(scenario.dispatcherInput.available_context.standards).toEqual([]);
    expect(scenario.dispatcherInput.available_context.learnings).toEqual([]);
    expect(scenario.dispatcherInput.last_worker_result).toBeNull();
    expect(scenario.dispatcherInput.plan_truncated).toBe(false);
    expect(scenario.dispatcherInput.history_truncated).toBe(false);
    // No budget constraints
    expect(scenario.dispatcherInput.session_budget.invocations_remaining).toBeNull();
    expect(scenario.evaluatorInput.worker_output.length).toBeGreaterThan(0);
    expect(scenario.evaluatorInput.validation_criteria.length).toBeGreaterThan(0);
  });

  it("COMPLEX scenario has 4+ phases with 2 completed and context entries", async () => {
    const { buildComplexScenario } = await import("../scripts/eval-prompts-fixtures");
    const scenario = buildComplexScenario();

    expect(scenario.name).toBe("complex");
    expect(scenario.dispatcherInput.plan.phases.length).toBeGreaterThanOrEqual(4);
    expect(scenario.dispatcherInput.state.completed_phases.length).toBe(2);
    expect(scenario.dispatcherInput.state.current_phase_index).toBe(2);
    // Has context entries
    expect(scenario.dispatcherInput.available_context.conventions.length).toBeGreaterThan(0);
    expect(scenario.dispatcherInput.available_context.standards.length).toBeGreaterThan(0);
    expect(scenario.dispatcherInput.available_context.learnings.length).toBeGreaterThan(0);
    // Has last_worker_result
    expect(scenario.dispatcherInput.last_worker_result).not.toBeNull();
    // Has budget constraints
    expect(scenario.dispatcherInput.session_budget.invocations_remaining).not.toBeNull();
  });

  it("EDGE scenario has truncation flags, tight budget, and failed result", async () => {
    const { buildEdgeScenario } = await import("../scripts/eval-prompts-fixtures");
    const scenario = buildEdgeScenario();

    expect(scenario.name).toBe("edge");
    expect(scenario.dispatcherInput.plan_truncated).toBe(true);
    expect(scenario.dispatcherInput.history_truncated).toBe(true);
    // Tight budget
    expect(scenario.dispatcherInput.session_budget.invocations_remaining).toBeLessThanOrEqual(3);
    // Failed last worker result
    expect(scenario.dispatcherInput.last_worker_result).not.toBeNull();
    expect(scenario.dispatcherInput.last_worker_result!.status).toBe("failed");
  });

  it("each scenario has valid evaluator input", async () => {
    const { buildSimpleScenario, buildComplexScenario, buildEdgeScenario } = await import("../scripts/eval-prompts-fixtures");
    const { EvaluatorInputSchema } = await import("../src/schemas/evaluator");

    for (const build of [buildSimpleScenario, buildComplexScenario, buildEdgeScenario]) {
      const scenario = build();
      const parsed = EvaluatorInputSchema.safeParse(scenario.evaluatorInput);
      expect(parsed.success).toBe(true);
    }
  });

  it("each scenario has valid dispatcher input", async () => {
    const { buildSimpleScenario, buildComplexScenario, buildEdgeScenario } = await import("../scripts/eval-prompts-fixtures");
    const { DispatcherInputSchema } = await import("../src/schemas/dispatcher");

    for (const build of [buildSimpleScenario, buildComplexScenario, buildEdgeScenario]) {
      const scenario = build();
      const parsed = DispatcherInputSchema.safeParse(scenario.dispatcherInput);
      expect(parsed.success).toBe(true);
    }
  });

  it("all 3 scenarios are returned by buildAllScenarios", async () => {
    const { buildAllScenarios } = await import("../scripts/eval-prompts-fixtures");
    const scenarios = buildAllScenarios();

    expect(scenarios.length).toBe(3);
    expect(scenarios.map(s => s.name)).toEqual(["simple", "complex", "edge"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Judge prompt construction
// ---------------------------------------------------------------------------

describe("eval-prompts: judge prompt construction", () => {
  it("dispatcher judge prompt includes plan description and task_content", async () => {
    const { buildDispatcherJudgePrompt } = await import("../scripts/eval-prompts-fixtures");

    const prompt = buildDispatcherJudgePrompt(
      "Create a GET /hello endpoint returning { message: 'hello world' }",
      "Implement the endpoint in src/routes/hello.ts with proper error handling..."
    );

    expect(prompt).toContain("GET /hello");
    expect(prompt).toContain("Implement the endpoint");
    // Should mention the 3 scoring dimensions
    expect(prompt).toContain("Clarity");
    expect(prompt).toContain("Completeness");
    expect(prompt).toContain("Actionability");
    // Should ask for JSON output
    expect(prompt).toContain("JSON");
    // Should be under 500 tokens (~2000 chars as rough estimate)
    expect(prompt.length).toBeLessThan(3000);
  });

  it("evaluator judge prompt includes worker output and evaluator result", async () => {
    const { buildEvaluatorJudgePrompt } = await import("../scripts/eval-prompts-fixtures");

    const prompt = buildEvaluatorJudgePrompt(
      "Tests pass and endpoint returns 200",
      "Acceptance criteria:\n- endpoint returns 200\n- tests pass",
      { passed: true, reasoning: "All criteria met", confidence: 0.95 }
    );

    expect(prompt).toContain("Tests pass");
    expect(prompt).toContain("Acceptance criteria");
    expect(prompt).toContain("All criteria met");
    // Should mention the 3 scoring dimensions
    expect(prompt).toContain("Accuracy");
    expect(prompt).toContain("Thoroughness");
    expect(prompt).toContain("Usefulness");
    // Should ask for JSON output
    expect(prompt).toContain("JSON");
    // Should be under 500 tokens
    expect(prompt.length).toBeLessThan(3000);
  });

  it("judge prompts request 1-5 scale scores", async () => {
    const { buildDispatcherJudgePrompt, buildEvaluatorJudgePrompt } = await import("../scripts/eval-prompts-fixtures");

    const dispPrompt = buildDispatcherJudgePrompt("task desc", "task content");
    expect(dispPrompt).toContain("1-5");

    const evalPrompt = buildEvaluatorJudgePrompt("output", "criteria", { passed: true, reasoning: "ok", confidence: 0.9 });
    expect(evalPrompt).toContain("1-5");
  });
});

// ---------------------------------------------------------------------------
// 3. CLI argument parsing
// ---------------------------------------------------------------------------

describe("eval-prompts: CLI argument parsing", () => {
  function parseEvalArgs(argv: string[]): {
    engine?: string;
    baseline: boolean;
    compare: boolean;
    verbose: boolean;
    help: boolean;
  } {
    const verbose = argv.includes("--verbose");
    const baseline = argv.includes("--baseline");
    const compare = argv.includes("--compare");
    const help = argv.includes("--help");
    const engineArg = argv.find(a => a.startsWith("--engine="))?.split("=")[1];
    return { engine: engineArg, baseline, compare, verbose, help };
  }

  it("parses --engine=claude flag", () => {
    const result = parseEvalArgs(["--engine=claude"]);
    expect(result.engine).toBe("claude");
  });

  it("parses --baseline flag", () => {
    const result = parseEvalArgs(["--engine=claude", "--baseline"]);
    expect(result.baseline).toBe(true);
    expect(result.compare).toBe(false);
  });

  it("parses --compare flag", () => {
    const result = parseEvalArgs(["--engine=claude", "--compare"]);
    expect(result.compare).toBe(true);
    expect(result.baseline).toBe(false);
  });

  it("parses --verbose flag", () => {
    const result = parseEvalArgs(["--engine=claude", "--verbose"]);
    expect(result.verbose).toBe(true);
  });

  it("parses --help flag", () => {
    const result = parseEvalArgs(["--help"]);
    expect(result.help).toBe(true);
  });

  it("parses multiple flags together", () => {
    const result = parseEvalArgs(["--engine=opencode", "--baseline", "--verbose"]);
    expect(result.engine).toBe("opencode");
    expect(result.baseline).toBe(true);
    expect(result.verbose).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Comparison / delta calculation
// ---------------------------------------------------------------------------

describe("eval-prompts: baseline comparison", () => {
  it("calculates delta between baseline and current scores", async () => {
    const { calculateScoreDelta } = await import("../scripts/eval-prompts-fixtures");

    const baseline = { clarity: 4, completeness: 3, actionability: 5 };
    const current = { clarity: 5, completeness: 3, actionability: 4 };
    const delta = calculateScoreDelta(baseline, current);

    expect(delta.clarity).toBe(1);       // improved
    expect(delta.completeness).toBe(0);  // same
    expect(delta.actionability).toBe(-1); // regressed
  });

  it("calculates timing delta", async () => {
    const { calculateTimingDelta } = await import("../scripts/eval-prompts-fixtures");

    const delta = calculateTimingDelta(15000, 12000);
    expect(delta.absolute_ms).toBe(-3000);
    expect(delta.improved).toBe(true);
  });

  it("identifies regression when timing increases", async () => {
    const { calculateTimingDelta } = await import("../scripts/eval-prompts-fixtures");

    const delta = calculateTimingDelta(10000, 15000);
    expect(delta.absolute_ms).toBe(5000);
    expect(delta.improved).toBe(false);
  });
});
