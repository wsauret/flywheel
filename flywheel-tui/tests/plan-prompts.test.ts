import { describe, test, expect } from "bun:test";
import { buildPlanDraftPrompt, planDraftValidationCriteria } from "../src/prompts/plan/draft";
import { buildPlanResearchPrompt, planResearchValidationCriteria } from "../src/prompts/plan/research";
import { planWorkflow } from "../src/workflows/plan";
import type { WorkflowStepContext } from "../src/prompts/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<WorkflowStepContext> = {}): WorkflowStepContext {
  return {
    planContent: "Add a hello world endpoint",
    keyDecisions: ["Use Bun.serve() for HTTP"],
    fileReferences: ["src/server.ts"],
    previousResult: "Research found existing patterns in src/app.ts",
    projectCwd: "/workspace/project",
    extra: {
      handoffPath: ".flywheel/handoffs/test-handoff.json",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Plan Draft Prompt — JSON output
// ---------------------------------------------------------------------------

describe("buildPlanDraftPrompt (JSON output)", () => {
  const ctx = makeCtx();
  const prompt = buildPlanDraftPrompt(ctx);

  test("includes JSON schema instructions", () => {
    expect(prompt).toContain("JSON");
    expect(prompt).toContain(".plan.json");
  });

  test("instructs writing to .flywheel/plans/<type>-<description>.plan.json", () => {
    expect(prompt).toContain(".flywheel/plans/");
    expect(prompt).toContain(".plan.json");
  });

  test("includes full JSON example with steps array", () => {
    expect(prompt).toContain('"steps"');
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('"description"');
    expect(prompt).toContain('"acceptanceCriteria"');
  });

  test("includes full JSON example with behavioralContract array", () => {
    expect(prompt).toContain('"behavioralContract"');
    expect(prompt).toContain('"id"');
    expect(prompt).toContain('"evidence"');
    expect(prompt).toContain('"area"');
  });

  test("includes decisions and risks in JSON schema", () => {
    expect(prompt).toContain('"decisions"');
    expect(prompt).toContain('"risks"');
  });

  test("includes step schema rules (fileReferences, feature, fulfills, milestone, estimatedComplexity)", () => {
    expect(prompt).toContain('"fileReferences"');
    expect(prompt).toContain('"feature"');
    expect(prompt).toContain('"fulfills"');
    expect(prompt).toContain('"milestone"');
    expect(prompt).toContain('"estimatedComplexity"');
  });

  test("includes behavioral contract assertion ID format (BC-AREA-NNN)", () => {
    expect(prompt).toContain("BC-");
    expect(prompt).toMatch(/BC-[A-Z]+-\d{3}/);
  });

  test("does NOT contain markdown plan template instructions", () => {
    // No Phase headings
    expect(prompt).not.toContain("### Phase N:");
    expect(prompt).not.toContain("### Phase 1:");
    // No checklist syntax
    expect(prompt).not.toContain("- [ ] **");
    // No milestone markers (## Milestone: format)
    expect(prompt).not.toMatch(/^## Milestone:/m);
    // No fulfills HTML annotations
    expect(prompt).not.toContain("<!-- fulfills:");
    // No instruction to generate a validation-contract.md (the "What NOT to produce"
    // section may mention it to explicitly forbid it — that's fine)
    expect(prompt).not.toContain("## Validation Contract Output");
    expect(prompt).not.toContain("generate a validation contract");
    // No context file output section
    expect(prompt).not.toContain("## Context File Output");
    // No .context.md output instruction
    expect(prompt).not.toContain("generate a context file");
  });

  test("does NOT contain markdown plan template format", () => {
    expect(prompt).not.toContain("## Plan Template (MORE format)");
    expect(prompt).not.toContain("## Implementation Checklist");
    expect(prompt).not.toContain("## Formatting Rules");
    expect(prompt).not.toContain("## Validation Contract Output");
    expect(prompt).not.toContain("Assertion ID Format");
  });

  test("includes feature description from context", () => {
    expect(prompt).toContain("Add a hello world endpoint");
  });

  test("includes research results from context", () => {
    expect(prompt).toContain("Research found existing patterns in src/app.ts");
  });

  test("includes key decisions from context", () => {
    expect(prompt).toContain("Use Bun.serve() for HTTP");
  });

  test("includes step decomposition rules", () => {
    expect(prompt).toContain("Test-first");
    expect(prompt).toContain("Single responsibility");
    expect(prompt).toContain("Dependencies flow forward");
  });

  test("includes scope discipline convention", () => {
    expect(prompt).toContain("Scope Discipline");
  });

  test("includes file/line discipline convention", () => {
    expect(prompt).toContain("File/Line Citation");
  });

  test("includes what NOT to produce section", () => {
    expect(prompt).toContain("Do NOT produce a markdown plan file");
    expect(prompt).toContain("Do NOT produce a separate validation-contract.md");
  });

  test("includes handoff instructions when handoff path provided", () => {
    expect(prompt).toContain("Handoff Instructions");
    expect(prompt).toContain(".flywheel/handoffs/test-handoff.json");
  });

  test("handles missing previous result gracefully", () => {
    const noResearch = makeCtx({ previousResult: undefined });
    const result = buildPlanDraftPrompt(noResearch);
    expect(result).toContain("No research results available");
  });

  test("handles empty key decisions gracefully", () => {
    const noDecisions = makeCtx({ keyDecisions: [] });
    const result = buildPlanDraftPrompt(noDecisions);
    expect(result).toContain("No prior decisions");
  });

  test("JSON example in prompt is valid JSON", () => {
    // Extract the JSON example block from the prompt
    const jsonMatch = prompt.match(/```json\n([\s\S]*?)```/);
    expect(jsonMatch).not.toBeNull();
    if (jsonMatch) {
      // The first JSON block should be valid
      expect(() => JSON.parse(jsonMatch[1])).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// planDraftValidationCriteria — references JSON
// ---------------------------------------------------------------------------

describe("planDraftValidationCriteria", () => {
  test("references JSON plan format", () => {
    expect(planDraftValidationCriteria).toContain("JSON");
    expect(planDraftValidationCriteria).toContain(".plan.json");
  });

  test("references steps, behavioralContract, decisions, risks", () => {
    expect(planDraftValidationCriteria).toContain("steps");
    expect(planDraftValidationCriteria).toContain("behavioralContract");
    expect(planDraftValidationCriteria).toContain("decisions");
    expect(planDraftValidationCriteria).toContain("risks");
  });

  test("does NOT reference markdown format", () => {
    expect(planDraftValidationCriteria).not.toContain("phases");
    expect(planDraftValidationCriteria).not.toContain("checklist");
  });
});

// ---------------------------------------------------------------------------
// Plan research prompt — UNCHANGED
// ---------------------------------------------------------------------------

describe("buildPlanResearchPrompt (unchanged)", () => {
  const ctx = makeCtx();
  const prompt = buildPlanResearchPrompt(ctx);

  test("still produces .context.md output", () => {
    expect(prompt).toContain(".context.md");
  });

  test("research validation criteria references .context.md", () => {
    expect(planResearchValidationCriteria).toContain(".context.md");
  });
});

// ---------------------------------------------------------------------------
// Plan workflow definition — step 1 validation criteria
// ---------------------------------------------------------------------------

describe("planWorkflow definition", () => {
  test("step 1 (draft) validation criteria references JSON", () => {
    // step 0 = research, step 1 = draft
    const draftStep = planWorkflow.steps[1];
    expect(draftStep.validationCriteria).toContain("JSON");
    expect(draftStep.validationCriteria).toContain(".plan.json");
  });

  test("step 0 (research) validation criteria unchanged (references .context.md)", () => {
    const researchStep = planWorkflow.steps[0];
    expect(researchStep.validationCriteria).toContain(".context.md");
  });

  test("step 1 (draft) references steps, behavioralContract, decisions, risks", () => {
    const draftStep = planWorkflow.steps[1];
    expect(draftStep.validationCriteria).toContain("steps");
    expect(draftStep.validationCriteria).toContain("behavioralContract");
    expect(draftStep.validationCriteria).toContain("decisions");
    expect(draftStep.validationCriteria).toContain("risks");
  });
});
