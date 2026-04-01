import { describe, it, expect } from "bun:test";
import {
  EvaluatorVerdictSchema,
  EvaluatorIssueSeverityEnum,
  EvaluatorIssueCategoryEnum,
  EvaluatorIssueSchema,
} from "../src/evaluator/schemas";
import type { EvaluatorInput, EvaluatorResult } from "../src/evaluator/schemas";
import type { ProcessSpawner } from "../src/worker/spawner";
import { renderEvaluatorHandoffInstruction } from "../src/queue/shared/handoff-render";

// ---------------------------------------------------------------------------
// VAL-EVAL-001: Evaluator verdict has structured issues
// ---------------------------------------------------------------------------

describe("EvaluatorVerdictSchema — structured issues (VAL-EVAL-001)", () => {
  const baseVerdict = {
    passed: true,
    reasoning: "All acceptance criteria met",
    suggestions: ["Consider adding edge case tests"],
    confidence: 0.92,
    feedback: "Good implementation overall",
    files_to_review: ["src/feature.ts"],
  };

  it("parses verdict with empty issues array", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...baseVerdict,
      issues: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([]);
    }
  });

  it("parses verdict with a blocking test_failure issue", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...baseVerdict,
      passed: false,
      issues: [
        {
          description: "Unit tests for auth module are failing",
          severity: "blocking",
          category: "test_failure",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toHaveLength(1);
      expect(result.data.issues[0].severity).toBe("blocking");
      expect(result.data.issues[0].category).toBe("test_failure");
    }
  });

  it("parses verdict with a non_blocking incomplete issue", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...baseVerdict,
      issues: [
        {
          description: "Missing edge case tests for null input",
          severity: "non_blocking",
          category: "incomplete",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues[0].severity).toBe("non_blocking");
      expect(result.data.issues[0].category).toBe("incomplete");
    }
  });

  it("parses verdict with multiple issues of different severities and categories", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...baseVerdict,
      passed: false,
      issues: [
        { description: "Tests failing", severity: "blocking", category: "test_failure" },
        { description: "Type error in utils.ts", severity: "blocking", category: "type_error" },
        { description: "API key found in source", severity: "blocking", category: "security" },
        { description: "Broke existing API", severity: "blocking", category: "regression" },
        { description: "Missing error handling", severity: "non_blocking", category: "incomplete" },
        { description: "Minor style issue", severity: "non_blocking", category: "other" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toHaveLength(6);
    }
  });

  // Severity enum validation
  it("rejects invalid severity value", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...baseVerdict,
      issues: [
        { description: "An issue", severity: "critical", category: "test_failure" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts both valid severity values: blocking and non_blocking", () => {
    for (const severity of ["blocking", "non_blocking"]) {
      const result = EvaluatorVerdictSchema.safeParse({
        ...baseVerdict,
        issues: [{ description: "An issue", severity, category: "other" }],
      });
      expect(result.success).toBe(true);
    }
  });

  // Category enum validation
  it("accepts all valid category values", () => {
    const categories = ["test_failure", "type_error", "security", "regression", "incomplete", "other"];
    for (const category of categories) {
      const result = EvaluatorVerdictSchema.safeParse({
        ...baseVerdict,
        issues: [{ description: "An issue", severity: "blocking", category }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid category value", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...baseVerdict,
      issues: [
        { description: "An issue", severity: "blocking", category: "performance" },
      ],
    });
    expect(result.success).toBe(false);
  });

  // Issue field validation
  it("rejects issue missing description", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...baseVerdict,
      issues: [{ severity: "blocking", category: "test_failure" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects issue missing severity", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...baseVerdict,
      issues: [{ description: "An issue", category: "test_failure" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects issue missing category", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...baseVerdict,
      issues: [{ description: "An issue", severity: "blocking" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects issue with unknown fields (.strict())", () => {
    const result = EvaluatorVerdictSchema.safeParse({
      ...baseVerdict,
      issues: [
        { description: "An issue", severity: "blocking", category: "test_failure", extra: "fail" },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-EVAL-005: Empty issues array when no issues found (not null/undefined)
// ---------------------------------------------------------------------------

describe("EvaluatorVerdictSchema — issues defaults to empty array (VAL-EVAL-005)", () => {
  const baseVerdict = {
    passed: true,
    reasoning: "All acceptance criteria met",
    suggestions: [],
    confidence: 0.92,
    feedback: "Good implementation overall",
    files_to_review: [],
  };

  it("issues field defaults to empty array when omitted", () => {
    const result = EvaluatorVerdictSchema.safeParse(baseVerdict);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([]);
      expect(Array.isArray(result.data.issues)).toBe(true);
    }
  });

  it("issues is never null or undefined after parsing", () => {
    const result = EvaluatorVerdictSchema.safeParse(baseVerdict);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).not.toBeNull();
      expect(result.data.issues).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-EVAL-006: Backward compatibility — verdicts without issues field
// ---------------------------------------------------------------------------

describe("EvaluatorVerdictSchema — backward compatibility (VAL-EVAL-006)", () => {
  it("old verdict without issues field parses successfully", () => {
    const oldVerdict = {
      passed: true,
      reasoning: "All acceptance criteria met",
      suggestions: ["Consider tests"],
      confidence: 0.85,
      feedback: "Solid work",
      files_to_review: ["src/file.ts"],
    };
    const result = EvaluatorVerdictSchema.safeParse(oldVerdict);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([]);
    }
  });

  it("old verdict with passed:false and no issues field still parses", () => {
    const oldVerdict = {
      passed: false,
      reasoning: "Tests not passing",
      suggestions: ["Fix failing tests"],
      confidence: 0.6,
      feedback: "Needs more work",
      files_to_review: [],
    };
    const result = EvaluatorVerdictSchema.safeParse(oldVerdict);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.issues).toEqual([]);
    }
  });

  it("existing tests still pass — verdict with all required fields", () => {
    const existingVerdict = {
      passed: true,
      reasoning: "All good",
      suggestions: [],
      confidence: 1,
      feedback: "Clean implementation",
      files_to_review: [],
    };
    const result = EvaluatorVerdictSchema.safeParse(existingVerdict);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EvaluatorIssueSeverityEnum and EvaluatorIssueCategoryEnum
// ---------------------------------------------------------------------------

describe("EvaluatorIssueSeverityEnum", () => {
  it("accepts 'blocking'", () => {
    expect(EvaluatorIssueSeverityEnum.safeParse("blocking").success).toBe(true);
  });

  it("accepts 'non_blocking'", () => {
    expect(EvaluatorIssueSeverityEnum.safeParse("non_blocking").success).toBe(true);
  });

  it("rejects 'critical'", () => {
    expect(EvaluatorIssueSeverityEnum.safeParse("critical").success).toBe(false);
  });

  it("rejects 'warning'", () => {
    expect(EvaluatorIssueSeverityEnum.safeParse("warning").success).toBe(false);
  });
});

describe("EvaluatorIssueCategoryEnum", () => {
  const validCategories = ["test_failure", "type_error", "security", "regression", "incomplete", "other"];

  for (const category of validCategories) {
    it(`accepts '${category}'`, () => {
      expect(EvaluatorIssueCategoryEnum.safeParse(category).success).toBe(true);
    });
  }

  it("rejects 'performance'", () => {
    expect(EvaluatorIssueCategoryEnum.safeParse("performance").success).toBe(false);
  });

  it("rejects 'lint'", () => {
    expect(EvaluatorIssueCategoryEnum.safeParse("lint").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EvaluatorIssueSchema standalone
// ---------------------------------------------------------------------------

describe("EvaluatorIssueSchema", () => {
  it("parses a valid issue", () => {
    const result = EvaluatorIssueSchema.safeParse({
      description: "TypeScript compilation error in utils.ts",
      severity: "blocking",
      category: "type_error",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("TypeScript compilation error in utils.ts");
      expect(result.data.severity).toBe("blocking");
      expect(result.data.category).toBe("type_error");
    }
  });

  it("rejects empty description", () => {
    const result = EvaluatorIssueSchema.safeParse({
      description: "",
      severity: "blocking",
      category: "test_failure",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (.strict())", () => {
    const result = EvaluatorIssueSchema.safeParse({
      description: "An issue",
      severity: "blocking",
      category: "test_failure",
      fix: "Do something",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers for prompt capture tests
// ---------------------------------------------------------------------------

function passingVerdict(): EvaluatorResult {
  return {
    passed: true,
    reasoning: "All good",
    suggestions: [],
    confidence: 0.9,
    feedback: "Good work",
    files_to_review: [],
  };
}

function createPromptCapturingSpawner(): { spawner: ProcessSpawner; getPrompt: () => string } {
  let capturedPrompt = "";
  const spawner: ProcessSpawner = {
    async spawn(command, args, options) {
      const pIdx = args.indexOf("-p");
      if (pIdx > -1) {
        capturedPrompt = args[pIdx + 1];
      }
      if (options?.stdin) {
        capturedPrompt = options.stdin;
      }
      // Write verdict to handoff file so transport can read it
      const match = capturedPrompt.match(/`([^`]+\.json)`/);
      if (match) await Bun.write(match[1], JSON.stringify(passingVerdict()));
      return {
        result: Promise.resolve({
          output: "",
          exitCode: 0,
          truncated: false,
          durationMs: 100,
          handoffPath: "/tmp/unused",
        }),
      };
    },
  };
  return { spawner, getPrompt: () => capturedPrompt };
}

function baseEvaluatorInput(overrides?: Partial<EvaluatorInput>): EvaluatorInput {
  return {
    worker_output: "Worker completed the task",
    evaluation_criteria: "Tests must pass",
    context_files: ["src/index.ts"],
    acceptance_criteria: ["must pass all tests"],
    artifacts_produced: [],
    tests_passed: true,
    duration_seconds: 30,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// VAL-EVAL-002: Evaluator prompt instructs issue extraction
// ---------------------------------------------------------------------------

describe("Evaluator prompt — issue extraction instructions (VAL-EVAL-002)", () => {
  it("prompt includes issues in the JSON schema description", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();
    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());
    const prompt = getPrompt();
    expect(prompt).toContain("issues");
  });

  it("prompt describes severity enum values", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();
    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());
    const prompt = getPrompt();
    expect(prompt).toContain("blocking");
    expect(prompt).toContain("non_blocking");
  });

  it("prompt describes all category enum values", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();
    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());
    const prompt = getPrompt();
    expect(prompt).toContain("test_failure");
    expect(prompt).toContain("type_error");
    expect(prompt).toContain("security");
    expect(prompt).toContain("regression");
    expect(prompt).toContain("incomplete");
    expect(prompt).toContain("other");
  });

  it("prompt includes examples of issue extraction", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();
    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());
    const prompt = getPrompt();
    // Should contain examples with different severities and categories
    expect(prompt).toContain("blocking");
    expect(prompt).toContain("test_failure");
    expect(prompt).toContain("security");
    expect(prompt).toContain("type_error");
    expect(prompt).toContain("incomplete");
    expect(prompt).toContain("regression");
  });

  it("prompt contains Issue Extraction Guidelines section", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();
    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());
    const prompt = getPrompt();
    // Issue categories are described in the verdict instructions
    expect(prompt).toContain("test_failure");
    expect(prompt).toContain("security");
    expect(prompt).toContain("incomplete");
  });
});

// ---------------------------------------------------------------------------
// VAL-EVAL-003: Evaluator prompt checks test/typecheck results
// ---------------------------------------------------------------------------

describe("Evaluator prompt — test/typecheck check instructions (VAL-EVAL-003)", () => {
  it("prompt instructs evaluator to classify issues with severity and category", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();
    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());
    const prompt = getPrompt();
    expect(prompt).toContain("blocking");
    expect(prompt).toContain("test_failure");
    expect(prompt).toContain("type_error");
  });

  it("prompt mentions classifying test failures as blocking test_failure", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();
    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());
    const prompt = getPrompt();
    // The prompt should mention that test failures are blocking
    expect(prompt.toLowerCase()).toContain("test");
    expect(prompt).toContain("blocking");
    expect(prompt).toContain("test_failure");
  });
});

// ---------------------------------------------------------------------------
// VAL-EVAL-004: Evaluator prompt checks for secrets/credentials
// ---------------------------------------------------------------------------

describe("Evaluator prompt — secrets/credentials check (VAL-EVAL-004)", () => {
  it("prompt instructs evaluator to check for secrets patterns", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();
    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());
    const prompt = getPrompt();
    // Should mention looking for secrets/credentials
    expect(prompt.toLowerCase()).toMatch(/secret|credential|api.?key|password/);
  });

  it("prompt classifies secrets as blocking security", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();
    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());
    const prompt = getPrompt();
    expect(prompt).toContain("security");
    expect(prompt).toContain("blocking");
    // Should mention both "security" category and "blocking" severity together
    const securitySectionMatch = prompt.includes("blocking security") || prompt.includes("blocking") && prompt.includes("security");
    expect(securitySectionMatch).toBe(true);
  });

  it("prompt mentions secrets as a fail condition", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();
    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
      sessionId: "test-session",
      baseDir: "/tmp/test",
    });
    await transport.invoke(baseEvaluatorInput());
    const prompt = getPrompt();
    expect(prompt.toLowerCase()).toContain("secrets");
  });
});

// ---------------------------------------------------------------------------
// renderEvaluatorHandoffInstruction includes issues field
// ---------------------------------------------------------------------------

describe("renderEvaluatorHandoffInstruction — includes issues field", () => {
  it("includes issues field in handoff instruction", () => {
    const output = renderEvaluatorHandoffInstruction("/tmp/eval.json");
    expect(output).toContain("issues");
  });

  it("handoff instruction mentions severity values", () => {
    const output = renderEvaluatorHandoffInstruction("/tmp/eval.json");
    expect(output).toContain("blocking");
    expect(output).toContain("non_blocking");
  });

  it("handoff instruction mentions category values", () => {
    const output = renderEvaluatorHandoffInstruction("/tmp/eval.json");
    expect(output).toContain("test_failure");
    expect(output).toContain("type_error");
    expect(output).toContain("security");
    expect(output).toContain("regression");
    expect(output).toContain("incomplete");
    expect(output).toContain("other");
  });
});
