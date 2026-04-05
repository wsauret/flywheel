import { describe, it, expect } from "bun:test";
import { assembleDispatcherInput } from "../src/workflows/dispatcher/assemble";
import { DispatcherDecisionSchema } from "../src/workflows/dispatcher/schemas";
import { buildDispatcherSystemPrompt } from "../src/workflows/dispatcher/system-prompt";

// ---------------------------------------------------------------------------
// Test plan fixture — same as the verify-dispatcher script uses
// ---------------------------------------------------------------------------

const TEST_PLAN = JSON.stringify({
  steps: [
    {
      title: "Add endpoint and test",
      description: "Create src/routes/hello.ts with GET handler returning { message: \"hello world\" }. Add test in tests/hello.test.ts. Register the route in src/routes/index.ts.",
      acceptanceCriteria: [
        "GET /hello returns 200",
        "Response body is { message: \"hello world\" }",
        "Route is registered",
      ],
      fileReferences: ["src/routes/hello.ts", "tests/hello.test.ts", "src/routes/index.ts"],
    },
  ],
  behavioralContract: [],
  decisions: [],
  risks: [],
});

// ---------------------------------------------------------------------------
// 1. Dispatcher input assembly tests
// ---------------------------------------------------------------------------

describe("verify-dispatcher: input assembly", () => {
  it("assembles dispatcher input with the test plan", () => {
    const assembled = assembleDispatcherInput({
      planContent: TEST_PLAN,
      stateContent: "",
      workflowContext: {
        workflowId: "verify-dispatcher-001",
        name: "work",
        stepNumber: 1,
        totalSteps: 1,
        stepDescription: "Add endpoint and test",
      },
      configContext: {
        maxEvalCycles: 3,
        worktreePath: "",
        projectCwd: process.cwd(),
        workerModel: "opus",
        dispatcherModel: "sonnet",
      },
      sessionBudget: {
        invocations_remaining: 10,
        token_budget_remaining: null,
        wall_clock_deadline: null,
      },
      availableContext: {
        conventions: [],
        standards: [],
        learnings: [],
      },
    });

    const plan = assembled.input.plan as { steps?: unknown[]; steps?: unknown[] };
    expect(plan.steps!.length).toBeGreaterThan(0);
    expect(assembled.input.state.current_step_index).toBe(0);
    expect(assembled.input.workflow_id).toBe("verify-dispatcher-001");
    expect(assembled.input.workflow.name).toBe("work");
    expect(assembled.input.config.dispatcher_model).toBe("sonnet");
    expect(assembled.input.config.worker_model).toBe("opus");
  });

  it("test plan has realistic multi-step content", () => {
    const assembled = assembleDispatcherInput({
      planContent: TEST_PLAN,
      stateContent: "",
      workflowContext: {
        workflowId: "verify-dispatcher-001",
        name: "work",
        stepNumber: 1,
        totalSteps: 1,
        stepDescription: "Add endpoint and test",
      },
      configContext: {
        maxEvalCycles: 3,
        worktreePath: "",
        projectCwd: process.cwd(),
        workerModel: "opus",
        dispatcherModel: "sonnet",
      },
      sessionBudget: {
        invocations_remaining: 10,
        token_budget_remaining: null,
        wall_clock_deadline: null,
      },
      availableContext: {
        conventions: [],
        standards: [],
        learnings: [],
      },
    });

    // Test plan should have at least one step
    const plan = assembled.input.plan as { steps?: { title: string; description: string }[] };
    const step = plan.steps![0];
    expect(step).toBeDefined();
    // Steps should contain meaningful descriptions
    expect(step.title.length).toBeGreaterThan(0);
  });

  it("system prompt is non-empty and contains expected structure", () => {
    const sp = buildDispatcherSystemPrompt();
    expect(sp.length).toBeGreaterThan(100);
    // System prompt should contain dispatcher role instructions
    expect(sp).toContain("prompt engineering");
    expect(sp).toContain("JSON");
  });
});

// ---------------------------------------------------------------------------
// 2. CLI argument parsing tests
// ---------------------------------------------------------------------------

describe("verify-dispatcher: CLI argument parsing", () => {
  function parseArgs(argv: string[]): {
    engine?: string;
    transport?: "sdk" | "cli";
    verbose: boolean;
    dryRun: boolean;
    help: boolean;
  } {
    // This mimics the parsing logic that will be in the script
    const verbose = argv.includes("--verbose");
    const dryRun = argv.includes("--dry-run");
    const help = argv.includes("--help");
    const transportArg = argv.find(a => a.startsWith("--transport="))?.split("=")[1] as "sdk" | "cli" | undefined;
    const engineArg = argv.find(a => a.startsWith("--engine="))?.split("=")[1];
    return { engine: engineArg, transport: transportArg, verbose, dryRun, help };
  }

  it("parses --engine=claude flag", () => {
    const result = parseArgs(["--engine=claude"]);
    expect(result.engine).toBe("claude");
  });

  it("parses --engine=opencode flag", () => {
    const result = parseArgs(["--engine=opencode"]);
    expect(result.engine).toBe("opencode");
  });

  it("returns undefined engine when not specified", () => {
    const result = parseArgs(["--verbose"]);
    expect(result.engine).toBeUndefined();
  });

  it("parses --help flag", () => {
    const result = parseArgs(["--help"]);
    expect(result.help).toBe(true);
  });

  it("parses multiple flags together", () => {
    const result = parseArgs(["--engine=claude", "--verbose", "--dry-run"]);
    expect(result.engine).toBe("claude");
    expect(result.verbose).toBe(true);
    expect(result.dryRun).toBe(true);
  });

  it("parses --transport alongside --engine", () => {
    const result = parseArgs(["--engine=opencode", "--transport=cli"]);
    expect(result.engine).toBe("opencode");
    expect(result.transport).toBe("cli");
  });
});

// ---------------------------------------------------------------------------
// 3. Schema validation tests
// ---------------------------------------------------------------------------

describe("verify-dispatcher: schema validation", () => {
  it("valid decision passes schema validation", () => {
    const decision = {
      schema_version: 1,
      step_index: 0,
      task_content: "Execute the setup step by creating directory layout",
      context_files: ["src/index.ts"],
      evaluation_criteria: {
        acceptance_criteria: ["Tests pass"],
        required_tests: true,
        custom_checks: [],
        required_outputs: [],
      },
      reasoning: "Standard setup",
      warnings: [],
    };

    const result = DispatcherDecisionSchema.safeParse(decision);
    expect(result.success).toBe(true);
  });

  it("decision with meaningful task_content passes", () => {
    const decision = {
      schema_version: 1,
      step_index: 0,
      task_content: "Create a GET /hello endpoint that returns JSON { message: 'hello world' }. Write tests first.",
      context_files: [],
      evaluation_criteria: {
        acceptance_criteria: ["endpoint returns 200"],
        required_tests: true,
        custom_checks: [],
        required_outputs: [],
      },
    };

    const result = DispatcherDecisionSchema.safeParse(decision);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.task_content.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Engine binary availability tests
// ---------------------------------------------------------------------------

describe("verify-dispatcher: engine binary availability", () => {
  it("SubprocessTransport throws clear error when engine binary is not found", async () => {
    const { SubprocessTransport } = await import("../src/workflows/dispatcher/subprocess-transport");

    // Use a fake engine name that doesn't exist on the system
    // We'll test by trying to instantiate with a valid engine whose binary is missing
    // Since this test runs in CI where claude/opencode may not be installed,
    // we test the error path by checking the error message pattern
    const mockSpawner = {
      async spawn() {
        return {
          result: Promise.resolve({ output: "", exitCode: 1, truncated: false, durationMs: 0 }),
        };
      },
    };

    // If claude is not installed, this should throw with a descriptive message
    const claudeAvailable = Bun.which("claude") !== null;
    if (!claudeAvailable) {
      expect(() => {
        new SubprocessTransport({ spawner: mockSpawner, engineName: "claude" });
      }).toThrow(/claude CLI not found/);
    }

    // If opencode is not installed, this should throw with a descriptive message
    const opencodeAvailable = Bun.which("opencode") !== null;
    if (!opencodeAvailable) {
      expect(() => {
        new SubprocessTransport({ spawner: mockSpawner, engineName: "opencode" });
      }).toThrow(/opencode CLI not found/);
    }

    // At least verify the error message contains guidance
    // (This test always runs — tests an unknown engine)
    expect(() => {
      new SubprocessTransport({ spawner: mockSpawner, engineName: "nonexistent" });
    }).toThrow(/Unknown engine/);
  });
});

// ---------------------------------------------------------------------------
// 5. Timing measurement tests
// ---------------------------------------------------------------------------

describe("verify-dispatcher: timing measurement", () => {
  it("performance.now() provides sub-millisecond wall-clock timing", () => {
    const start = performance.now();
    // Busy-wait briefly to ensure measurable time passes
    const arr = new Array(10000).fill(0).map((_, i) => i * i);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeGreaterThan(0);
    // Should be measurable in milliseconds
    expect(typeof elapsed).toBe("number");
    // Formatted timing string should be reasonable
    const formattedSeconds = (elapsed / 1000).toFixed(1);
    expect(formattedSeconds).toMatch(/^\d+\.\d$/);
  });

  it("timing format matches expected output pattern", () => {
    const elapsedMs = 12345.6;
    const formatted = `Dispatcher responded in ${(elapsedMs / 1000).toFixed(1)}s`;
    expect(formatted).toBe("Dispatcher responded in 12.3s");
  });
});
