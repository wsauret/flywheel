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
    it("has 4 steps", () => {
      expect(reviewWorkflow.steps).toHaveLength(4);
    });

    it("is named 'review'", () => {
      expect(reviewWorkflow.name).toBe("review");
    });

    it("conforms to WorkflowDefinitionSchema", () => {
      const result = WorkflowDefinitionSchema.safeParse(reviewWorkflow);
      expect(result.success).toBe(true);
    });

    it("steps cover diff, review, consolidate, fix", () => {
      expect(reviewWorkflow.steps[0].description).toContain("diff");
      expect(reviewWorkflow.steps[1].description).toContain("review");
      expect(reviewWorkflow.steps[2].description).toContain("Consolidate");
      expect(reviewWorkflow.steps[3].description.toLowerCase()).toMatch(/fix|implement/);
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
    it("contains all 5 non-work workflows", () => {
      expect(Object.keys(workflowRegistry)).toHaveLength(5);
      expect(workflowRegistry.plan).toBeDefined();
      expect(workflowRegistry.review).toBeDefined();
      expect(workflowRegistry.ship).toBeDefined();
      expect(workflowRegistry.debug).toBeDefined();
      expect(workflowRegistry.research).toBeDefined();
    });

    it("all registry entries conform to schema", () => {
      for (const [_name, workflow] of Object.entries(workflowRegistry)) {
        const result = WorkflowDefinitionSchema.safeParse(workflow);
        expect(result.success).toBe(true);
      }
    });

    it("does not contain 'work' (work uses dedicated WorkController)", () => {
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
