import { describe, it, expect } from "bun:test";
import { EvaluatorResultSchema } from "../src/evaluator/schemas";

// ---------------------------------------------------------------------------
// Test fixtures — realistic evaluator inputs
// ---------------------------------------------------------------------------

const SAMPLE_WORKER_OUTPUT = `## Implementation Complete

I've implemented the GET /hello endpoint as requested:

### Changes Made:
1. Created \`src/routes/hello.ts\` with a GET handler that returns \`{ message: "hello world" }\`
2. Added test in \`tests/hello.test.ts\` verifying the endpoint returns 200 and expected body
3. Registered the route in \`src/routes/index.ts\`

### Test Results:
All 3 tests pass:
- GET /hello returns 200
- Response body matches { message: "hello world" }
- Content-Type is application/json

### Files Modified:
- src/routes/hello.ts (new)
- tests/hello.test.ts (new)
- src/routes/index.ts (modified)
`;

const SAMPLE_VALIDATION_CRITERIA =
  "Acceptance criteria:\n" +
  "- GET /hello endpoint exists and returns 200\n" +
  "- Response body is { message: \"hello world\" }\n" +
  "- Tests are written and pass\n" +
  "Required: tests must pass";

const SAMPLE_ACCEPTANCE_CRITERIA = [
  "GET /hello endpoint exists and returns 200",
  "Response body is { message: \"hello world\" }",
  "Tests are written and pass",
];

// ---------------------------------------------------------------------------
// 1. Evaluator input assembly tests
// ---------------------------------------------------------------------------

describe("verify-evaluator: input assembly", () => {
  it("assembles evaluator input with realistic worker output", () => {
    const input = {
      worker_output: SAMPLE_WORKER_OUTPUT,
      evaluation_criteria: SAMPLE_VALIDATION_CRITERIA,
      context_files: ["src/routes/hello.ts", "tests/hello.test.ts"],
      acceptance_criteria: SAMPLE_ACCEPTANCE_CRITERIA,
      artifacts_produced: ["src/routes/hello.ts", "tests/hello.test.ts"],
      tests_passed: true,
      duration_seconds: 45,
    };

    expect(input.worker_output.length).toBeGreaterThan(100);
    expect(input.evaluation_criteria.length).toBeGreaterThan(0);
    expect(input.acceptance_criteria.length).toBe(3);
    expect(input.artifacts_produced.length).toBe(2);
    expect(input.tests_passed).toBe(true);
    expect(input.duration_seconds).toBeGreaterThan(0);
  });

  it("worker output contains realistic code generation details", () => {
    expect(SAMPLE_WORKER_OUTPUT).toContain("src/routes/hello.ts");
    expect(SAMPLE_WORKER_OUTPUT).toContain("tests/hello.test.ts");
    expect(SAMPLE_WORKER_OUTPUT).toContain("Test Results");
    expect(SAMPLE_WORKER_OUTPUT).toContain("hello world");
  });

  it("validation criteria contain structured acceptance items", () => {
    expect(SAMPLE_VALIDATION_CRITERIA).toContain("Acceptance criteria:");
    expect(SAMPLE_VALIDATION_CRITERIA).toContain("tests must pass");
  });
});

// ---------------------------------------------------------------------------
// 2. CLI argument parsing tests
// ---------------------------------------------------------------------------

describe("verify-evaluator: CLI argument parsing", () => {
  function parseArgs(argv: string[]): {
    engine?: string;
    verbose: boolean;
    dryRun: boolean;
    help: boolean;
  } {
    const verbose = argv.includes("--verbose");
    const dryRun = argv.includes("--dry-run");
    const help = argv.includes("--help");
    const engineArg = argv.find(a => a.startsWith("--engine="))?.split("=")[1];
    return { engine: engineArg, verbose, dryRun, help };
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
});

// ---------------------------------------------------------------------------
// 3. Schema validation tests
// ---------------------------------------------------------------------------

describe("verify-evaluator: schema validation", () => {
  it("valid evaluator result passes schema validation", () => {
    const result = {
      passed: true,
      reasoning: "All acceptance criteria met. The endpoint exists, returns correct response, and tests pass.",
      suggestions: [],
      confidence: 0.95,
      feedback: "Worker output is complete and well-structured.",
      files_to_review: ["src/routes/hello.ts"],
    };

    const parsed = EvaluatorResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("failed evaluator result passes schema validation", () => {
    const result = {
      passed: false,
      reasoning: "Tests are mentioned but no test output evidence provided.",
      suggestions: ["Include actual test runner output to verify tests pass"],
      confidence: 0.7,
      feedback: "Worker output mentions tests but lacks evidence of execution.",
      files_to_review: ["tests/hello.test.ts"],
    };

    const parsed = EvaluatorResultSchema.safeParse(result);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.passed).toBe(false);
      expect(parsed.data.suggestions!.length).toBeGreaterThan(0);
    }
  });

  it("result missing required fields fails validation", () => {
    const result = {
      passed: true,
      // missing reasoning, confidence, feedback, files_to_review
    };

    const parsed = EvaluatorResultSchema.safeParse(result);
    expect(parsed.success).toBe(false);
  });

  it("confidence must be between 0 and 1", () => {
    const validResult = {
      passed: true,
      reasoning: "test",
      confidence: 0.5,
      feedback: "test",
      files_to_review: [],
    };
    expect(EvaluatorResultSchema.safeParse(validResult).success).toBe(true);

    const invalidResult = {
      ...validResult,
      confidence: 1.5,
    };
    expect(EvaluatorResultSchema.safeParse(invalidResult).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Engine binary availability tests
// ---------------------------------------------------------------------------

describe("verify-evaluator: engine binary availability", () => {
  it("SubprocessEvaluatorTransport throws clear error when engine binary is not found", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");

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
        new SubprocessEvaluatorTransport({ spawner: mockSpawner, engineName: "claude", sessionId: "test-session", baseDir: "/tmp/test" });
      }).toThrow(/claude CLI not found/);
    }

    // If opencode is not installed, this should throw with a descriptive message
    const opencodeAvailable = Bun.which("opencode") !== null;
    if (!opencodeAvailable) {
      expect(() => {
        new SubprocessEvaluatorTransport({ spawner: mockSpawner, engineName: "opencode", sessionId: "test-session", baseDir: "/tmp/test" });
      }).toThrow(/opencode CLI not found/);
    }

    // Unknown engine always throws
    expect(() => {
      new SubprocessEvaluatorTransport({ spawner: mockSpawner, engineName: "nonexistent", sessionId: "test-session", baseDir: "/tmp/test" });
    }).toThrow(/Unknown engine/);
  });
});

// ---------------------------------------------------------------------------
// 5. Timing measurement tests
// ---------------------------------------------------------------------------

describe("verify-evaluator: timing measurement", () => {
  it("performance.now() provides sub-millisecond wall-clock timing", () => {
    const start = performance.now();
    // Busy-wait briefly to ensure measurable time passes
    const arr = new Array(10000).fill(0).map((_, i) => i * i);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeGreaterThan(0);
    expect(typeof elapsed).toBe("number");
    const formattedSeconds = (elapsed / 1000).toFixed(1);
    expect(formattedSeconds).toMatch(/^\d+\.\d$/);
  });

  it("timing format matches expected output pattern", () => {
    const elapsedMs = 8765.4;
    const formatted = `Evaluator responded in ${(elapsedMs / 1000).toFixed(1)}s`;
    expect(formatted).toBe("Evaluator responded in 8.8s");
  });
});
