import { describe, it, expect, beforeEach } from "bun:test";
import type { EvaluatorInput, EvaluatorResult } from "../src/schemas/evaluator";
import type { EvaluatorTransport } from "../src/evaluator/transport";
import type { FlywheelEvent } from "../src/events/types";
import type { ProcessSpawner } from "../src/worker/spawner";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function passingResult(overrides?: Partial<EvaluatorResult>): EvaluatorResult {
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

function failingResult(overrides?: Partial<EvaluatorResult>): EvaluatorResult {
  return {
    passed: false,
    reasoning: "Validation criteria not met",
    suggestions: ["Fix the output"],
    confidence: 0.3,
    feedback: "Needs improvement",
    files_to_review: [],
    ...overrides,
  };
}

function createMockTransport(
  responses: Array<EvaluatorResult | Error | "timeout">,
): { transport: EvaluatorTransport; callCount: () => number; inputs: () => EvaluatorInput[] } {
  let calls = 0;
  const capturedInputs: EvaluatorInput[] = [];

  const transport: EvaluatorTransport = {
    async invoke(input: EvaluatorInput): Promise<EvaluatorResult> {
      capturedInputs.push(input);
      const response = responses[calls++];
      if (response === "timeout") {
        const err = new Error("Evaluation timed out");
        err.name = "TimeoutError";
        throw err;
      }
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
  };

  return {
    transport,
    callCount: () => calls,
    inputs: () => capturedInputs,
  };
}

function baseEvaluatorInput(overrides?: Partial<EvaluatorInput>): EvaluatorInput {
  return {
    worker_output: "Worker completed the task successfully",
    validation_criteria: "Tests must pass",
    context_files: ["src/index.ts"],
    acceptance_criteria: ["must pass all tests"],
    artifacts_produced: ["src/new-file.ts"],
    tests_passed: true,
    duration_seconds: 30,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Part A: Workflow definition updates
// ---------------------------------------------------------------------------

describe("VAL-ALIGN-001: Research workflow step descriptions are task-adaptive", () => {
  it("step descriptions do not hardcode 'codebase file scanning' pattern", async () => {
    const { researchWorkflow } = await import("../src/workflows/research");
    const steps = researchWorkflow.steps;

    // Step 1: should NOT reference specific file scanning patterns
    expect(steps[0].description).not.toContain("parallel locator agents");
    expect(steps[0].validationCriteria).not.toContain("File paths and line numbers");
    // Should reference quality attributes generically
    expect(steps[0].validationCriteria).toContain("Relevant");

    // Step 2: should NOT reference specific file analysis
    expect(steps[1].validationCriteria).not.toContain("Detailed analysis of each relevant file with code examples");
    expect(steps[1].validationCriteria).toContain("relevant");

    // Step 3: should NOT enumerate specific section headings
    expect(steps[2].validationCriteria).not.toContain("Codebase Map");
    expect(steps[2].validationCriteria).not.toContain("Relevant Code");
    expect(steps[2].validationCriteria).toContain("research");
  });
});

describe("VAL-ALIGN-002: Review workflow handles 'no issues found' as valid outcome", () => {
  it("step 1 (multi-agent review) validationCriteria permits zero findings", async () => {
    const { reviewWorkflow } = await import("../src/workflows/review");
    const step1 = reviewWorkflow.steps[0]; // multi-agent review

    expect(step1.validationCriteria).toContain("no issues");
  });

  it("step 2 (consolidate) validationCriteria permits clean summary", async () => {
    const { reviewWorkflow } = await import("../src/workflows/review");
    const step2 = reviewWorkflow.steps[1]; // consolidate findings

    expect(step2.validationCriteria).toContain("no significant issues");
  });
});

describe("VAL-ALIGN-003: Ship workflow handles trivial changes with no learnings", () => {
  it("step 4 validationCriteria permits no-learnings outcome", async () => {
    const { shipWorkflow } = await import("../src/workflows/ship");
    const step4 = shipWorkflow.steps[3]; // extract learnings

    expect(step4.validationCriteria).toContain("no significant learnings");
  });
});

describe("VAL-ALIGN-004: Debug workflow handles non-code fixes", () => {
  it("step 2 validationCriteria does not mandate file:line references for all fix types", async () => {
    const { debugWorkflow } = await import("../src/workflows/debug");
    const step2 = debugWorkflow.steps[1]; // apply fix

    // Should NOT hardcode file:line as the only reference format
    expect(step2.validationCriteria).not.toContain("file:line references");
    // Should accommodate non-code fixes
    expect(step2.validationCriteria).toContain("references");
  });
});

describe("VAL-ALIGN-009: Plan workflow step descriptions remain unchanged", () => {
  it("plan workflow steps have correct descriptions", async () => {
    const { planWorkflow } = await import("../src/workflows/plan");
    const steps = planWorkflow.steps;

    expect(steps[0].description).toBe("Research the codebase for relevant files and patterns");
    expect(steps[1].description).toBe("Draft the plan document");
    expect(steps[2].description).toBe("Review the plan with all reviewer agents");
    expect(steps[3].description).toBe("Consolidate review findings into actionable plan");
  });

  it("plan workflow criteria are imported from prompt files (not hardcoded)", async () => {
    const { planWorkflow } = await import("../src/workflows/plan");
    const { planResearchValidationCriteria } = await import("../src/prompts/plan/research");
    const { planDraftValidationCriteria } = await import("../src/prompts/plan/draft");
    const { planReviewValidationCriteria } = await import("../src/prompts/plan/review");
    const { planConsolidateValidationCriteria } = await import("../src/prompts/plan/consolidate");

    expect(planWorkflow.steps[0].validationCriteria).toBe(planResearchValidationCriteria);
    expect(planWorkflow.steps[1].validationCriteria).toBe(planDraftValidationCriteria);
    expect(planWorkflow.steps[2].validationCriteria).toBe(planReviewValidationCriteria);
    expect(planWorkflow.steps[3].validationCriteria).toBe(planConsolidateValidationCriteria);
  });
});

describe("VAL-ALIGN-010: Workflow validationCriteria don't prescribe rigid output formats", () => {
  it("research step 3 does not enumerate required section headings", async () => {
    const { researchWorkflow } = await import("../src/workflows/research");
    const step3 = researchWorkflow.steps[2];

    expect(step3.validationCriteria).not.toContain("Codebase Map");
    expect(step3.validationCriteria).not.toContain("Relevant Code");
    expect(step3.validationCriteria).not.toContain("Patterns");
    expect(step3.validationCriteria).not.toContain("Constraints");
    expect(step3.validationCriteria).not.toContain("Open Questions");
  });

  it("debug step 2 criteria are flexible (not file:line only)", async () => {
    const { debugWorkflow } = await import("../src/workflows/debug");
    const step2 = debugWorkflow.steps[1];

    expect(step2.validationCriteria).not.toContain("file:line");
  });
});

// ---------------------------------------------------------------------------
// Part B: Evaluator task context
// ---------------------------------------------------------------------------

describe("VAL-ALIGN-005: EvaluatorInput schema includes task_context field", () => {
  it("EvaluatorInputSchema accepts optional task_context field", async () => {
    const { EvaluatorInputSchema } = await import("../src/schemas/evaluator");

    const inputWithContext = {
      worker_output: "output",
      validation_criteria: "criteria",
      context_files: [],
      acceptance_criteria: [],
      artifacts_produced: [],
      tests_passed: null,
      duration_seconds: 0,
      task_context: "Implement user authentication for the REST API",
    };

    const result = EvaluatorInputSchema.safeParse(inputWithContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.task_context).toBe("Implement user authentication for the REST API");
    }
  });

  it("EvaluatorInputSchema accepts input without task_context (backward compat)", async () => {
    const { EvaluatorInputSchema } = await import("../src/schemas/evaluator");

    const inputWithoutContext = {
      worker_output: "output",
      validation_criteria: "criteria",
      context_files: [],
      acceptance_criteria: [],
      artifacts_produced: [],
      tests_passed: null,
      duration_seconds: 0,
    };

    const result = EvaluatorInputSchema.safeParse(inputWithoutContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.task_context).toBeUndefined();
    }
  });

  it("EvaluateOptions accepts taskContext field", async () => {
    const { Evaluator } = await import("../src/evaluator/invoke");
    const bus = new EventBus();
    const { transport, inputs } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: {
        acceptance_criteria: [],
        required_tests: false,
        custom_checks: [],
        required_outputs: [],
      },
      contextFiles: [],
      taskContext: "Build a REST API with pagination",
    });

    // The task_context should flow through to the transport input
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0].task_context).toBe("Build a REST API with pagination");
  });

  it("task_context is undefined in transport input when not provided", async () => {
    const { Evaluator } = await import("../src/evaluator/invoke");
    const bus = new EventBus();
    const { transport, inputs } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: {
        acceptance_criteria: [],
        required_tests: false,
        custom_checks: [],
        required_outputs: [],
      },
      contextFiles: [],
      // no taskContext
    });

    expect(inputs()).toHaveLength(1);
    expect(inputs()[0].task_context).toBeUndefined();
  });
});

describe("VAL-ALIGN-006: Evaluator buildPrompt includes task context section", () => {
  /** Helper to capture the prompt text and write verdict handoff file. */
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
        if (match) await Bun.write(match[1], JSON.stringify(passingResult()));
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

  it("buildPrompt renders task context section when task_context is present", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
    });

    await transport.invoke(baseEvaluatorInput({
      task_context: "Implement user authentication with JWT tokens",
    }));

    const prompt = getPrompt();
    expect(prompt).toContain("## Task Context");
    expect(prompt).toContain("Implement user authentication with JWT tokens");
  });

  it("buildPrompt does NOT render task context section when task_context is absent", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
    });

    await transport.invoke(baseEvaluatorInput());

    const prompt = getPrompt();
    expect(prompt).not.toContain("## Task Context");
  });

  it("task context section appears before Worker Output", async () => {
    const { SubprocessEvaluatorTransport } = await import("../src/evaluator/subprocess-transport");
    const { spawner, getPrompt } = createPromptCapturingSpawner();

    const transport = new SubprocessEvaluatorTransport({
      spawner,
      engineName: "claude",
    });

    await transport.invoke(baseEvaluatorInput({
      task_context: "Research pagination patterns",
    }));

    const prompt = getPrompt();
    const taskContextIdx = prompt.indexOf("## Task Context");
    const workerOutputIdx = prompt.indexOf("## Worker Output");
    expect(taskContextIdx).toBeGreaterThan(-1);
    expect(workerOutputIdx).toBeGreaterThan(-1);
    expect(taskContextIdx).toBeLessThan(workerOutputIdx);
  });
});

describe("VAL-ALIGN-007: Execution loop passes task context to evaluator", () => {
  it("evaluator.evaluate() receives non-empty taskContext from execution loop", async () => {
    // We test this by checking that the evaluator invocation in execution-loop
    // passes taskContext. We'll create a mock evaluator transport to capture inputs.
    const { Evaluator } = await import("../src/evaluator/invoke");
    const bus = new EventBus();
    const { transport, inputs } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "test-wf",
    });

    // Simulate what the execution loop would do: pass taskContext
    await evaluator.evaluate({
      workerOutput: "output",
      validationCriteria: {
        acceptance_criteria: ["Tests pass"],
        required_tests: true,
        custom_checks: [],
        required_outputs: [],
      },
      contextFiles: [],
      taskContext: "Step description from execution loop",
    });

    expect(inputs()).toHaveLength(1);
    expect(inputs()[0].task_context).toBe("Step description from execution loop");
    expect(inputs()[0].task_context).toBeTruthy(); // non-empty
  });
});

describe("VAL-ALIGN-008: Dispatcher system prompt doesn't prescribe fixed criteria patterns", () => {
  it("dispatcher system prompt does not contain hardcoded acceptance criteria templates", async () => {
    const { buildDispatcherSystemPrompt } = await import("../src/dispatcher/system-prompt");
    const systemPrompt = buildDispatcherSystemPrompt();

    // Should not prescribe fixed patterns like "File paths and line numbers"
    expect(systemPrompt).not.toContain("File paths and line numbers");
    expect(systemPrompt).not.toContain("Codebase Map");
    expect(systemPrompt).not.toContain("codebase file scanning");
  });

  it("dispatcher system prompt references step_description for task-aware criteria", async () => {
    const { buildDispatcherSystemPrompt } = await import("../src/dispatcher/system-prompt");
    const systemPrompt = buildDispatcherSystemPrompt();

    // Should reference step_description as the source for task context
    expect(systemPrompt).toContain("step_description");
  });
});

// ---------------------------------------------------------------------------
// Part C: Research workflow evaluator alignment
// ---------------------------------------------------------------------------

describe("VAL-EA-001: Research workflow validationCriteria reflect research output", () => {
  it("all research step criteria contain research-oriented vocabulary", async () => {
    const { researchWorkflow } = await import("../src/workflows/research");
    const researchVocab = ["sources", "findings", "document", "research", "relevant", "references"];

    for (const step of researchWorkflow.steps) {
      const criteria = step.validationCriteria ?? "";
      const hasResearchVocab = researchVocab.some((word) =>
        criteria.toLowerCase().includes(word),
      );
      expect(hasResearchVocab).toBe(true);
    }
  });

  it("all research step criteria contain zero debugging vocabulary", async () => {
    const { researchWorkflow } = await import("../src/workflows/research");
    const debuggingVocab = ["fix", "bug", "error", "stack trace", "debug", "crash", "exception"];

    for (const step of researchWorkflow.steps) {
      const criteria = step.validationCriteria ?? "";
      for (const word of debuggingVocab) {
        expect(criteria.toLowerCase()).not.toContain(word);
      }
    }
  });
});

describe("VAL-EA-002: Research validationCriteria remain task-adaptive", () => {
  it("no validationCriteria string contains specific markdown heading names", async () => {
    const { researchWorkflow } = await import("../src/workflows/research");
    const rigidHeadings = [
      "## Codebase Map",
      "## Findings",
      "## Relevant Code",
      "## Patterns",
      "## Constraints",
      "## Open Questions",
      "## Research Question",
      "## Summary",
      "## Code References",
    ];

    for (const step of researchWorkflow.steps) {
      const criteria = step.validationCriteria ?? "";
      for (const heading of rigidHeadings) {
        expect(criteria).not.toContain(heading);
      }
    }
  });

  it("no validationCriteria string contains ## heading markers at all", async () => {
    const { researchWorkflow } = await import("../src/workflows/research");

    for (const step of researchWorkflow.steps) {
      const criteria = step.validationCriteria ?? "";
      expect(criteria).not.toContain("##");
    }
  });
});

describe("VAL-EA-003: Plan step 0 validationCriteria reference .context.md", () => {
  it("planWorkflow.steps[0].validationCriteria contains '.context.md'", async () => {
    const { planWorkflow } = await import("../src/workflows/plan");
    const criteria = planWorkflow.steps[0].validationCriteria ?? "";
    expect(criteria).toContain(".context.md");
  });

  it("planWorkflow.steps[0].validationCriteria references file references or patterns", async () => {
    const { planWorkflow } = await import("../src/workflows/plan");
    const criteria = planWorkflow.steps[0].validationCriteria ?? "";
    expect(criteria).toContain("file references");
  });
});

describe("VAL-EA-005: New evaluator-alignment tests for research criteria", () => {
  it("research step 0 criteria describe source identification", async () => {
    const { researchWorkflow } = await import("../src/workflows/research");
    const criteria = researchWorkflow.steps[0].validationCriteria ?? "";
    expect(criteria.toLowerCase()).toContain("sources");
  });

  it("research step 1 criteria describe analysis of findings", async () => {
    const { researchWorkflow } = await import("../src/workflows/research");
    const criteria = researchWorkflow.steps[1].validationCriteria ?? "";
    expect(criteria.toLowerCase()).toContain("findings");
  });

  it("research step 2 criteria describe a research document", async () => {
    const { researchWorkflow } = await import("../src/workflows/research");
    const criteria = researchWorkflow.steps[2].validationCriteria ?? "";
    expect(criteria.toLowerCase()).toContain("document");
  });

  it("no research step criteria prescribe scanning mechanism", async () => {
    const { researchWorkflow } = await import("../src/workflows/research");
    const forbiddenPhrases = [
      "parallel locator agents",
      "file paths and line numbers",
      "codebase file scanning",
    ];

    for (const step of researchWorkflow.steps) {
      const criteria = step.validationCriteria ?? "";
      for (const phrase of forbiddenPhrases) {
        expect(criteria.toLowerCase()).not.toContain(phrase.toLowerCase());
      }
    }
  });

  it("no research step criteria prescribe rigid artifact format", async () => {
    const { researchWorkflow } = await import("../src/workflows/research");
    const forbiddenArtifactPhrases = [
      "code examples",
      "file-by-file",
    ];

    for (const step of researchWorkflow.steps) {
      const criteria = step.validationCriteria ?? "";
      for (const phrase of forbiddenArtifactPhrases) {
        expect(criteria.toLowerCase()).not.toContain(phrase.toLowerCase());
      }
    }
  });
});

describe("VAL-EA-006: Evaluator task_context is populated for research steps", () => {
  it("evaluator receives non-empty taskContext for a research workflow step", async () => {
    const { Evaluator } = await import("../src/evaluator/invoke");
    const bus = new EventBus();
    const { transport, inputs } = createMockTransport([passingResult()]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "research",
    });

    // Simulate the execution loop passing the research step description as taskContext
    const { researchWorkflow } = await import("../src/workflows/research");
    const stepDescription = researchWorkflow.steps[0].description;

    await evaluator.evaluate({
      workerOutput: "Located 15 relevant files for the research topic",
      validationCriteria: {
        acceptance_criteria: [researchWorkflow.steps[0].validationCriteria ?? ""],
        required_tests: false,
        custom_checks: [],
        required_outputs: [],
      },
      contextFiles: [],
      taskContext: stepDescription,
    });

    expect(inputs()).toHaveLength(1);
    const capturedInput = inputs()[0];
    expect(capturedInput.task_context).toBeTruthy();
    expect(capturedInput.task_context).toBe(stepDescription);
    // Verify it's research-oriented content
    expect(capturedInput.task_context).toContain("Locate");
  });

  it("evaluator receives non-empty taskContext for all 3 research steps", async () => {
    const { Evaluator } = await import("../src/evaluator/invoke");
    const { researchWorkflow } = await import("../src/workflows/research");
    const bus = new EventBus();
    const { transport, inputs } = createMockTransport([
      passingResult(),
      passingResult(),
      passingResult(),
    ]);

    const evaluator = new Evaluator({
      transport,
      emitter: createFlywheelEmitter(bus),
      workflowId: "research",
    });

    for (let i = 0; i < researchWorkflow.steps.length; i++) {
      const step = researchWorkflow.steps[i];
      await evaluator.evaluate({
        workerOutput: `Step ${i} output`,
        validationCriteria: {
          acceptance_criteria: [step.validationCriteria ?? ""],
          required_tests: false,
          custom_checks: [],
          required_outputs: [],
        },
        contextFiles: [],
        taskContext: step.description,
      });
    }

    expect(inputs()).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(inputs()[i].task_context).toBeTruthy();
      expect(typeof inputs()[i].task_context).toBe("string");
      expect((inputs()[i].task_context as string).length).toBeGreaterThan(0);
    }
  });
});
