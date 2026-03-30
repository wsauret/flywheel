import { describe, it, expect, mock } from "bun:test";
import { WorkflowDefinitionSchema } from "../src/schemas/workflow";
import { planWorkflow } from "../src/workflows/plan";
import { reviewWorkflow } from "../src/workflows/review";
import { shipWorkflow } from "../src/workflows/ship";
import { debugWorkflow } from "../src/workflows/debug";
import { researchWorkflow } from "../src/workflows/research";
import { workflowRegistry, buildWorkflowPrompt } from "../src/workflows/index";
import { parseArgs } from "../src/cli/args";

// ---------------------------------------------------------------------------
// Workflow Definitions
// ---------------------------------------------------------------------------

describe("Workflow Definitions", () => {
  describe("planWorkflow", () => {
    it("has 4 steps", () => {
      expect(planWorkflow.steps).toHaveLength(4);
    });

    it("is named 'plan'", () => {
      expect(planWorkflow.name).toBe("plan");
    });

    it("has a description", () => {
      expect(planWorkflow.description.length).toBeGreaterThan(0);
    });

    it("conforms to WorkflowDefinitionSchema", () => {
      const result = WorkflowDefinitionSchema.safeParse(planWorkflow);
      expect(result.success).toBe(true);
    });

    it("each step has a description", () => {
      for (const step of planWorkflow.steps) {
        expect(step.description.length).toBeGreaterThan(0);
      }
    });

    it("steps cover research, draft, review, consolidate", () => {
      expect(planWorkflow.steps[0].description).toContain("Research");
      expect(planWorkflow.steps[1].description).toContain("Draft");
      expect(planWorkflow.steps[2].description).toContain("Review");
      expect(planWorkflow.steps[3].description).toContain("Consolidate");
    });
  });

  describe("reviewWorkflow", () => {
    it("has 2 steps (fix step is dynamically injected at runtime)", () => {
      expect(reviewWorkflow.steps).toHaveLength(2);
    });

    it("is named 'review'", () => {
      expect(reviewWorkflow.name).toBe("review");
    });

    it("conforms to WorkflowDefinitionSchema", () => {
      const result = WorkflowDefinitionSchema.safeParse(reviewWorkflow);
      expect(result.success).toBe(true);
    });

    it("steps cover review and consolidate (fix is injected dynamically)", () => {
      expect(reviewWorkflow.steps[0].description).toContain("review");
      expect(reviewWorkflow.steps[1].description).toContain("Consolidate");
    });
  });

  describe("shipWorkflow", () => {
    it("has 4 steps", () => {
      expect(shipWorkflow.steps).toHaveLength(4);
    });

    it("is named 'ship'", () => {
      expect(shipWorkflow.name).toBe("ship");
    });

    it("conforms to WorkflowDefinitionSchema", () => {
      const result = WorkflowDefinitionSchema.safeParse(shipWorkflow);
      expect(result.success).toBe(true);
    });

    it("steps cover stage, commit, PR, learnings", () => {
      expect(shipWorkflow.steps[0].description).toContain("stage");
      expect(shipWorkflow.steps[1].description).toContain("commit");
      expect(shipWorkflow.steps[2].description).toContain("pull request");
      expect(shipWorkflow.steps[3].description).toContain("learnings");
    });
  });

  describe("debugWorkflow", () => {
    it("has 3 steps", () => {
      expect(debugWorkflow.steps).toHaveLength(3);
    });

    it("is named 'debug'", () => {
      expect(debugWorkflow.name).toBe("debug");
    });

    it("conforms to WorkflowDefinitionSchema", () => {
      const result = WorkflowDefinitionSchema.safeParse(debugWorkflow);
      expect(result.success).toBe(true);
    });

    it("steps cover investigate, fix, verify", () => {
      expect(debugWorkflow.steps[0].description).toContain("Investigate");
      expect(debugWorkflow.steps[1].description).toContain("Fix");
      expect(debugWorkflow.steps[2].description).toContain("Verify");
    });
  });

  describe("researchWorkflow", () => {
    it("has 3 steps", () => {
      expect(researchWorkflow.steps).toHaveLength(3);
    });

    it("is named 'research'", () => {
      expect(researchWorkflow.name).toBe("research");
    });

    it("conforms to WorkflowDefinitionSchema", () => {
      const result = WorkflowDefinitionSchema.safeParse(researchWorkflow);
      expect(result.success).toBe(true);
    });

    it("steps cover locate, analyze, persist", () => {
      expect(researchWorkflow.steps[0].description).toContain("Locate");
      expect(researchWorkflow.steps[1].description).toContain("Analyze");
      expect(researchWorkflow.steps[2].description).toContain("Persist");
    });
  });

  describe("workflowRegistry", () => {
    it("contains all 6 non-work workflows", () => {
      expect(Object.keys(workflowRegistry)).toHaveLength(6);
      expect(workflowRegistry.plan).toBeDefined();
      expect(workflowRegistry.review).toBeDefined();
      expect(workflowRegistry.ship).toBeDefined();
      expect(workflowRegistry.debug).toBeDefined();
      expect(workflowRegistry.research).toBeDefined();
      expect(workflowRegistry.sprint).toBeDefined();
    });

    it("all registry entries conform to schema", () => {
      for (const [_name, workflow] of Object.entries(workflowRegistry)) {
        const result = WorkflowDefinitionSchema.safeParse(workflow);
        expect(result.success).toBe(true);
      }
    });

    it("does not contain 'work' (work uses queue executor directly)", () => {
      expect(workflowRegistry.work).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Prompt Builder
// ---------------------------------------------------------------------------

describe("buildWorkflowPrompt", () => {
  it("produces non-empty prompts for all plan steps", () => {
    for (let i = 0; i < planWorkflow.steps.length; i++) {
      const prompt = buildWorkflowPrompt(i, planWorkflow, {
        description: "Build auth system",
      });
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("produces non-empty prompts for all review steps", () => {
    for (let i = 0; i < reviewWorkflow.steps.length; i++) {
      const prompt = buildWorkflowPrompt(i, reviewWorkflow, {});
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("produces non-empty prompts for all ship steps", () => {
    for (let i = 0; i < shipWorkflow.steps.length; i++) {
      const prompt = buildWorkflowPrompt(i, shipWorkflow, {});
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("produces non-empty prompts for all debug steps", () => {
    for (let i = 0; i < debugWorkflow.steps.length; i++) {
      const prompt = buildWorkflowPrompt(i, debugWorkflow, {
        description: "Test failure in auth module",
      });
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("produces non-empty prompts for all research steps", () => {
    for (let i = 0; i < researchWorkflow.steps.length; i++) {
      const prompt = buildWorkflowPrompt(i, researchWorkflow, {
        topic: "Authentication patterns",
      });
      expect(typeof prompt).toBe("string");
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it("includes description in plan prompts", () => {
    const prompt = buildWorkflowPrompt(0, planWorkflow, {
      description: "JWT authentication system",
    });
    expect(prompt).toContain("JWT authentication system");
  });

  it("includes topic in research prompts", () => {
    const prompt = buildWorkflowPrompt(0, researchWorkflow, {
      topic: "Event sourcing patterns",
    });
    expect(prompt).toContain("Event sourcing patterns");
  });

  it("passes previousResult through to prompt context", () => {
    const prompt = buildWorkflowPrompt(
      1,
      planWorkflow,
      { description: "test feature" },
      "Previous step found 3 relevant files",
    );
    expect(prompt).toContain("Previous step found 3 relevant files");
  });

  it("includes projectCwd when provided", () => {
    const prompt = buildWorkflowPrompt(
      0,
      planWorkflow,
      { description: "test" },
      undefined,
      "/home/user/project",
    );
    expect(prompt).toContain("/home/user/project");
  });

  it("falls back to generic prompt for out-of-range step index", () => {
    const prompt = buildWorkflowPrompt(99, planWorkflow, {
      description: "test",
    });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Research Prompt Routing (standalone /research uses dedicated per-step prompts)
// ---------------------------------------------------------------------------

describe("Research prompt routing", () => {
  it("each standalone research step produces a distinct prompt", () => {
    const prompts: string[] = [];
    for (let i = 0; i < researchWorkflow.steps.length; i++) {
      const prompt = buildWorkflowPrompt(i, researchWorkflow, {
        topic: "Event bus architecture",
      });
      prompts.push(prompt);
    }

    // All 3 prompts should be different from each other
    expect(prompts[0]).not.toBe(prompts[1]);
    expect(prompts[1]).not.toBe(prompts[2]);
    expect(prompts[0]).not.toBe(prompts[2]);
  });

  it("research step 0 (locate) produces a locate-specific prompt", () => {
    const prompt = buildWorkflowPrompt(0, researchWorkflow, {
      topic: "Event bus architecture",
    });
    expect(prompt).toContain("Research: Locate Sources");
    expect(prompt).toContain("Locator Dispatch");
    expect(prompt).toContain("BLOCKING Rule");
    // Should NOT contain analyzer or persist content
    expect(prompt).not.toContain("Research: Analyze Sources");
    expect(prompt).not.toContain("Research: Compile Document");
  });

  it("research step 1 (analyze) produces an analyze-specific prompt", () => {
    const prompt = buildWorkflowPrompt(
      1,
      researchWorkflow,
      { topic: "Event bus architecture" },
      "Located files: src/events/event-bus.ts, src/events/types.ts",
    );
    expect(prompt).toContain("Research: Analyze Sources");
    expect(prompt).toContain("Analyzer Dispatch");
    expect(prompt).toContain("Located files: src/events/event-bus.ts");
    // Should NOT contain locator or persist content
    expect(prompt).not.toContain("Research: Locate Sources");
    expect(prompt).not.toContain("Research: Compile Document");
  });

  it("research step 2 (persist) produces a persist-specific prompt", () => {
    const prompt = buildWorkflowPrompt(
      2,
      researchWorkflow,
      { topic: "Event bus architecture" },
      "Analysis results: EventBus uses pub/sub pattern...",
    );
    expect(prompt).toContain("Research: Compile Document");
    expect(prompt).toContain("research.md");
    expect(prompt).toContain("Analysis results: EventBus uses pub/sub pattern");
    // Should NOT contain locator or analyzer content
    expect(prompt).not.toContain("Research: Locate Sources");
    expect(prompt).not.toContain("Research: Analyze Sources");
  });

  it("plan step 0 still produces the plan research prompt (not standalone locate)", () => {
    const planPrompt = buildWorkflowPrompt(0, planWorkflow, {
      description: "Build auth system",
    });
    const researchPrompt = buildWorkflowPrompt(0, researchWorkflow, {
      topic: "Build auth system",
    });

    // Plan step 0 should NOT be the same as research step 0
    expect(planPrompt).not.toBe(researchPrompt);
    // Plan step 0 should contain plan-specific content (e.g. .context.md reference)
    expect(planPrompt).toContain(".context.md");
    // Research step 0 should contain standalone locate content
    expect(researchPrompt).toContain("Research: Locate Sources");
  });

  it("researchPrompts array length matches researchWorkflow.steps.length", () => {
    // Verify each step index produces a valid prompt (not a fallback)
    for (let i = 0; i < researchWorkflow.steps.length; i++) {
      const prompt = buildWorkflowPrompt(i, researchWorkflow, {
        topic: "test",
      });
      // Should NOT be the generic fallback (which starts with "# research — Step")
      expect(prompt).not.toMatch(/^# research — Step/);
    }
    // Going beyond should get fallback
    const fallback = buildWorkflowPrompt(
      researchWorkflow.steps.length,
      researchWorkflow,
      { topic: "test" },
    );
    expect(typeof fallback).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Research workflow cross-cutting assertions
// ---------------------------------------------------------------------------

describe("Research workflow cross-cutting (VAL-CROSS)", () => {
  it("VAL-CROSS-011: WorkflowDefinitionSchema validates researchWorkflow", () => {
    const result = WorkflowDefinitionSchema.safeParse(researchWorkflow);
    expect(result.success).toBe(true);
    // Step descriptions contain locate/analyze/persist
    expect(researchWorkflow.steps[0].description).toContain("Locate");
    expect(researchWorkflow.steps[1].description).toContain("Analyze");
    expect(researchWorkflow.steps[2].description).toContain("Persist");
  });

  it("VAL-CROSS-012: research steps chain correctly via previousResult", () => {
    // Step 1 receives step 0 output as previousResult
    const locateOutput = "Found 10 relevant files in src/events/";
    const step1Prompt = buildWorkflowPrompt(
      1,
      researchWorkflow,
      { topic: "event bus" },
      locateOutput,
    );
    expect(step1Prompt).toContain(locateOutput);

    // Step 2 receives step 1 output as previousResult
    const analyzeOutput = "EventBus implements pub/sub with 29 event types";
    const step2Prompt = buildWorkflowPrompt(
      2,
      researchWorkflow,
      { topic: "event bus" },
      analyzeOutput,
    );
    expect(step2Prompt).toContain(analyzeOutput);
  });

  it("VAL-CROSS-013: plan research .context.md is compatible with parseContextFile", async () => {
    const { parseContextFile } = await import("../src/controller/templates");

    // Simulate a well-formed plan research output in .context.md format
    const mockContextContent = [
      "## Codebase Map",
      "",
      "- `src/events/event-bus.ts:1-50` — EventBus class definition",
      "- `src/events/types.ts:10-30` — Event type definitions",
      "- `src/controller/execution-loop.ts:100-200` — Event consumption",
      "",
      "## Relevant Code",
      "",
      "- `src/events/event-bus.ts:15` — emit() method",
      "- `src/events/event-bus.ts:25` — subscribe() method",
      "",
      "## Patterns to Follow",
      "",
      "- Typed event emitter pattern using FlywheelEmitter",
      "",
      "## Constraints",
      "",
      "- Synchronous pub/sub (no async handlers)",
      "",
      "## Open Questions",
      "",
      "- How are events garbage-collected?",
    ].join("\n");

    const fileReferences = parseContextFile(mockContextContent);
    expect(fileReferences.length).toBeGreaterThan(0);
    // Should extract file paths from file:line references
    expect(fileReferences.some((ref) => ref.includes("event-bus.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseArgs (simplified — all args go to TUI)
// ---------------------------------------------------------------------------

describe("parseArgs (simplified)", () => {
  it("always returns tui command", async () => {
    const result = await parseArgs([]);
    expect(result).toEqual({ command: "tui" });
  });

  it("returns tui even with args", async () => {
    const result = await parseArgs(["anything"]);
    expect(result).toEqual({ command: "tui" });
  });
});
