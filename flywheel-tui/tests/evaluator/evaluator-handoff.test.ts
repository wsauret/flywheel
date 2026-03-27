/**
 * Tests for Step 3: Evaluator Handoff
 *
 * Verifies:
 * - Evaluator prompt includes renderEvaluatorHandoffInstruction(handoffPath)
 * - Evaluator transport reads verdict from file (not stdout parsing)
 * - Missing verdict file → retry with error feedback (HandoffMissingError)
 * - Invalid verdict → retry with error feedback (HandoffInvalidError)
 * - Handoff data in EvaluatorInput renders structured sections in prompt
 * - Backward compat: no handoff → renders worker_output
 * - EvaluatorInput schema accepts optional handoff field
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvaluatorInput, EvaluatorResult } from "../../src/schemas/evaluator";
import type { ProcessSpawner, SpawnOptions } from "../../src/worker/spawner";
import { EvaluatorInputSchema, EvaluatorHandoffDataSchema } from "../../src/schemas/evaluator";
import { EvaluatorVerdictSchema } from "../../src/schemas/handoff";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validVerdict(overrides?: Partial<import("../../src/schemas/handoff").EvaluatorVerdict>) {
  return {
    passed: true,
    reasoning: "All validation criteria met",
    suggestions: [],
    confidence: 0.9,
    feedback: "Good work",
    files_to_review: [],
    ...overrides,
  };
}

function baseEvaluatorInput(overrides?: Partial<EvaluatorInput>): EvaluatorInput {
  return {
    worker_output: "Worker completed the task successfully",
    evaluation_criteria: "Tests must pass",
    context_files: ["src/index.ts"],
    acceptance_criteria: ["must pass all tests"],
    artifacts_produced: ["src/new-file.ts"],
    tests_passed: true,
    duration_seconds: 30,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe("EvaluatorInput schema with handoff field", () => {
  it("accepts input without handoff (backward compat)", () => {
    const result = EvaluatorInputSchema.safeParse({
      worker_output: "output",
      evaluation_criteria: "criteria",
      context_files: [],
      acceptance_criteria: [],
      artifacts_produced: [],
      tests_passed: null,
      duration_seconds: 10,
    });
    expect(result.success).toBe(true);
  });

  it("accepts input with handoff data", () => {
    const result = EvaluatorInputSchema.safeParse({
      worker_output: "output",
      evaluation_criteria: "criteria",
      context_files: [],
      acceptance_criteria: [],
      artifacts_produced: [],
      tests_passed: null,
      duration_seconds: 10,
      handoff: {
        summary: "A".repeat(100),
        verification: { tests_passed: true, test_output_summary: "12/12 pass" },
        artifacts: { files_created: ["a.ts"], files_modified: ["b.ts"], commands_run: ["bun test"] },
        files_to_review: ["a.ts"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts input with minimal handoff (summary only)", () => {
    const result = EvaluatorInputSchema.safeParse({
      worker_output: "output",
      evaluation_criteria: "criteria",
      context_files: [],
      acceptance_criteria: [],
      artifacts_produced: [],
      tests_passed: null,
      duration_seconds: 10,
      handoff: {
        summary: "A".repeat(100),
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("EvaluatorHandoffDataSchema", () => {
  it("picks only summary, verification, artifacts, files_to_review from WorkerHandoff", () => {
    const data = {
      summary: "A".repeat(100),
      verification: { tests_passed: true },
      artifacts: { files_created: [], files_modified: [], commands_run: [] },
      files_to_review: ["src/foo.ts"],
    };
    const result = EvaluatorHandoffDataSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("tolerates fields not in pick set (inherits passthrough from WorkerHandoff)", () => {
    const data = {
      summary: "A".repeat(100),
      plan_file_path: "not in pick set but tolerated",
    };
    const result = EvaluatorHandoffDataSchema.safeParse(data);
    // pick on a .passthrough() schema inherits passthrough — extra fields are tolerated
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SubprocessEvaluatorTransport — handoff file tests
// ---------------------------------------------------------------------------

describe("SubprocessEvaluatorTransport: handoff file verdict", () => {
  let SubprocessEvaluatorTransport: typeof import("../../src/evaluator/subprocess-transport").SubprocessEvaluatorTransport;
  let tmpDir: string;

  beforeEach(async () => {
    const mod = await import("../../src/evaluator/subprocess-transport");
    SubprocessEvaluatorTransport = mod.SubprocessEvaluatorTransport;
    tmpDir = await mkdtemp(join(tmpdir(), "eval-handoff-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("prompt includes evaluator handoff instruction with handoff path", async () => {
    let capturedPrompt = "";

    // Create a spawner that writes the verdict file AND captures the prompt
    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        // Capture the prompt from -p flag (Claude) or stdin (OpenCode)
        const pIdx = args.indexOf("-p");
        if (pIdx > -1) {
          capturedPrompt = args[pIdx + 1];
        }
        if (options?.stdin) {
          capturedPrompt = options.stdin;
        }

        // Write verdict to the handoff path mentioned in the prompt
        // Extract the path from the prompt (it appears after "write a JSON file to:")
        const pathMatch = capturedPrompt.match(/`([^`]+\.json)`/);
        if (pathMatch) {
          await Bun.write(pathMatch[1], JSON.stringify(validVerdict()));
        }

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

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput());

    // Prompt should contain the evaluator handoff instruction
    expect(capturedPrompt).toContain("Evaluator Handoff Instructions");
    expect(capturedPrompt).toContain("Write a JSON file to:");
    expect(capturedPrompt).toContain(".json");
  });

  it("reads verdict from handoff file, not from stdout", async () => {
    const verdict = validVerdict({ reasoning: "Handoff-based verdict" });

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        let prompt = "";
        const pIdx = args.indexOf("-p");
        if (pIdx > -1) prompt = args[pIdx + 1];
        if (options?.stdin) prompt = options.stdin;

        // Write verdict to the handoff path
        const pathMatch = prompt.match(/`([^`]+\.json)`/);
        if (pathMatch) {
          await Bun.write(pathMatch[1], JSON.stringify(verdict));
        }

        // Stdout is empty — verdict comes from file
        return {
          result: Promise.resolve({
            output: "Some irrelevant stdout text",
            exitCode: 0,
            truncated: false,
            durationMs: 100,
            handoffPath: "/tmp/unused",
          }),
        };
      },
    };

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const result = await transport.invoke(baseEvaluatorInput());

    expect(result.reasoning).toBe("Handoff-based verdict");
    expect(result.passed).toBe(true);
  });

  it("retries when handoff file is missing (HandoffMissingError)", async () => {
    let callCount = 0;
    const verdict = validVerdict();

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        callCount++;
        let prompt = "";
        const pIdx = args.indexOf("-p");
        if (pIdx > -1) prompt = args[pIdx + 1];
        if (options?.stdin) prompt = options.stdin;

        // First call: don't write the file (missing)
        // Second call: write the file (success)
        if (callCount >= 2) {
          const pathMatch = prompt.match(/`([^`]+\.json)`/);
          if (pathMatch) {
            await Bun.write(pathMatch[1], JSON.stringify(verdict));
          }
        }

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

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const result = await transport.invoke(baseEvaluatorInput());

    expect(callCount).toBe(2); // retried once
    expect(result.passed).toBe(true);
  });

  it("retries when handoff file has invalid JSON (HandoffInvalidError)", async () => {
    let callCount = 0;
    const verdict = validVerdict();

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        callCount++;
        let prompt = "";
        const pIdx = args.indexOf("-p");
        if (pIdx > -1) prompt = args[pIdx + 1];
        if (options?.stdin) prompt = options.stdin;

        const pathMatch = prompt.match(/`([^`]+\.json)`/);
        if (pathMatch) {
          if (callCount === 1) {
            // First call: write invalid JSON
            await Bun.write(pathMatch[1], "{ not valid json }");
          } else {
            // Second call: write valid verdict
            await Bun.write(pathMatch[1], JSON.stringify(verdict));
          }
        }

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

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const result = await transport.invoke(baseEvaluatorInput());

    expect(callCount).toBe(2);
    expect(result.passed).toBe(true);
  });

  it("retries when handoff file fails schema validation (HandoffInvalidError)", async () => {
    let callCount = 0;
    const verdict = validVerdict();

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        callCount++;
        let prompt = "";
        const pIdx = args.indexOf("-p");
        if (pIdx > -1) prompt = args[pIdx + 1];
        if (options?.stdin) prompt = options.stdin;

        const pathMatch = prompt.match(/`([^`]+\.json)`/);
        if (pathMatch) {
          if (callCount === 1) {
            // First call: write valid JSON but missing required fields
            await Bun.write(pathMatch[1], JSON.stringify({ passed: true }));
          } else {
            // Second call: write valid verdict
            await Bun.write(pathMatch[1], JSON.stringify(verdict));
          }
        }

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

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const result = await transport.invoke(baseEvaluatorInput());

    expect(callCount).toBe(2);
    expect(result.passed).toBe(true);
  });

  it("throws after both attempts fail to produce valid handoff", async () => {
    const mockSpawner: ProcessSpawner = {
      async spawn() {
        // Never write a handoff file
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

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });

    await expect(transport.invoke(baseEvaluatorInput())).rejects.toThrow(
      /Evaluator subprocess failed after 2 attempts/,
    );
  });

  it("retry prompt mentions handoff file path", async () => {
    let retryPrompt = "";
    let callCount = 0;

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        callCount++;
        let prompt = "";
        const pIdx = args.indexOf("-p");
        if (pIdx > -1) prompt = args[pIdx + 1];
        if (options?.stdin) prompt = options.stdin;

        if (callCount === 2) {
          retryPrompt = prompt;
          // Write valid verdict on retry
          const pathMatch = prompt.match(/`([^`]+\.json)`/);
          if (pathMatch) {
            await Bun.write(pathMatch[1], JSON.stringify(validVerdict()));
          }
        }

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

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput());

    expect(retryPrompt).toContain("[RETRY]");
    expect(retryPrompt).toContain("handoff file");
  });

  it("maps EvaluatorVerdict fields to EvaluatorResult", async () => {
    const verdict = validVerdict({
      passed: false,
      reasoning: "Missing implementation",
      suggestions: ["Add error handling", "Write tests"],
      confidence: 0.7,
      feedback: "Incomplete work",
      files_to_review: ["src/main.ts"],
    });

    const mockSpawner: ProcessSpawner = {
      async spawn(command, args, options) {
        let prompt = "";
        const pIdx = args.indexOf("-p");
        if (pIdx > -1) prompt = args[pIdx + 1];
        if (options?.stdin) prompt = options.stdin;

        const pathMatch = prompt.match(/`([^`]+\.json)`/);
        if (pathMatch) {
          await Bun.write(pathMatch[1], JSON.stringify(verdict));
        }

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

    const transport = new SubprocessEvaluatorTransport({
      spawner: mockSpawner,
      engineName: "claude",
    });
    const result = await transport.invoke(baseEvaluatorInput());

    expect(result.passed).toBe(false);
    expect(result.reasoning).toBe("Missing implementation");
    expect(result.suggestions).toEqual(["Add error handling", "Write tests"]);
    expect(result.confidence).toBe(0.7);
    expect(result.feedback).toBe("Incomplete work");
    expect(result.files_to_review).toEqual(["src/main.ts"]);
  });
});

// ---------------------------------------------------------------------------
// buildPrompt — handoff data rendering
// ---------------------------------------------------------------------------

describe("SubprocessEvaluatorTransport: buildPrompt with handoff data", () => {
  let SubprocessEvaluatorTransport: typeof import("../../src/evaluator/subprocess-transport").SubprocessEvaluatorTransport;

  /** Helper to capture the prompt text from the -p flag (Claude engine route). */
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

        // Write verdict to handoff file
        const pathMatch = capturedPrompt.match(/`([^`]+\.json)`/);
        if (pathMatch) {
          await Bun.write(pathMatch[1], JSON.stringify(validVerdict()));
        }

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

  beforeEach(async () => {
    const mod = await import("../../src/evaluator/subprocess-transport");
    SubprocessEvaluatorTransport = mod.SubprocessEvaluatorTransport;
  });

  it("renders Worker Summary section when handoff is present", async () => {
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput({
      handoff: {
        summary: "Implemented the authentication middleware with JWT validation and tests.",
      },
    }));

    const prompt = getPrompt();
    expect(prompt).toContain("## Worker Summary");
    expect(prompt).toContain("authentication middleware");
    // Should NOT have Worker Output when handoff is present
    expect(prompt).not.toContain("## Worker Output");
  });

  it("renders Worker Output section when handoff is absent (backward compat)", async () => {
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput({
      worker_output: "The raw worker output text",
    }));

    const prompt = getPrompt();
    expect(prompt).toContain("## Worker Output");
    expect(prompt).toContain("The raw worker output text");
    expect(prompt).not.toContain("## Worker Summary");
  });

  it("renders Verification section from handoff", async () => {
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput({
      handoff: {
        summary: "A".repeat(100),
        verification: {
          tests_passed: true,
          test_output_summary: "24/24 tests pass in 3.2s",
        },
      },
    }));

    const prompt = getPrompt();
    expect(prompt).toContain("## Verification");
    expect(prompt).toContain("Tests passed: yes");
    expect(prompt).toContain("24/24 tests pass");
  });

  it("renders Artifacts section from handoff", async () => {
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput({
      handoff: {
        summary: "A".repeat(100),
        artifacts: {
          files_created: ["src/auth.ts"],
          files_modified: ["src/app.ts"],
          commands_run: ["bun test"],
        },
      },
    }));

    const prompt = getPrompt();
    expect(prompt).toContain("## Artifacts");
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("src/app.ts");
    expect(prompt).toContain("bun test");
  });

  it("renders Files to Review section from handoff", async () => {
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput({
      handoff: {
        summary: "A".repeat(100),
        files_to_review: ["src/auth.ts", "tests/auth.test.ts"],
      },
    }));

    const prompt = getPrompt();
    expect(prompt).toContain("## Files to Review");
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("tests/auth.test.ts");
  });

  it("still includes validation criteria, timing, and instructions alongside handoff data", async () => {
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
    });
    await transport.invoke(baseEvaluatorInput({
      handoff: {
        summary: "A".repeat(100),
      },
      evaluation_criteria: "All tests must pass",
      duration_seconds: 42,
    }));

    const prompt = getPrompt();
    expect(prompt).toContain("## Validation Criteria");
    expect(prompt).toContain("All tests must pass");
    expect(prompt).toContain("## Timing");
    expect(prompt).toContain("42s");
    expect(prompt).toContain("## Instructions");
  });
});
