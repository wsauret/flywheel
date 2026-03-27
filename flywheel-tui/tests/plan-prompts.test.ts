import { describe, test, expect } from "bun:test";
import { buildPlanDraftPrompt, planDraftValidationCriteria } from "../src/prompts/plan/draft";
import { buildPlanReviewPrompt, planReviewValidationCriteria } from "../src/prompts/plan/review";
import { buildPlanConsolidatePrompt, planConsolidateValidationCriteria } from "../src/prompts/plan/consolidate";
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
// Plan Review Prompt — JSON annotation (VAL-JSON-003, VAL-JSON-009)
// ---------------------------------------------------------------------------

describe("buildPlanReviewPrompt (JSON annotation)", () => {
  const ctx = makeCtx();
  const prompt = buildPlanReviewPrompt(ctx);

  test("includes JSON plan to review section", () => {
    expect(prompt).toContain("## JSON Plan to Review");
    expect(prompt).toContain("```json");
  });

  test("includes plan content from context", () => {
    expect(prompt).toContain("Add a hello world endpoint");
  });

  test("dispatches all 6 reviewer agents", () => {
    expect(prompt).toContain("reviewer-correctness");
    expect(prompt).toContain("reviewer-security");
    expect(prompt).toContain("reviewer-testing");
    expect(prompt).toContain("reviewer-architecture");
    expect(prompt).toContain("reviewer-scope");
    expect(prompt).toContain("reviewer-dependencies");
  });

  test("instructs producing annotated JSON output", () => {
    expect(prompt).toContain("annotated JSON");
    expect(prompt).toContain("produce a new JSON document");
  });

  test("annotated JSON example includes review.findings[] on steps", () => {
    expect(prompt).toContain('"review"');
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"severity"');
    expect(prompt).toContain('"reviewer"');
    expect(prompt).toContain('"actionRequired"');
  });

  test("annotated JSON example includes openQuestions[] at top level", () => {
    expect(prompt).toContain('"openQuestions"');
  });

  test("openQuestions schema requires question, raisedBy, options fields", () => {
    expect(prompt).toContain('"question"');
    expect(prompt).toContain('"raisedBy"');
    expect(prompt).toContain('"options"');
  });

  test("explicitly states openQuestions must have question, raisedBy, options", () => {
    expect(prompt).toContain("Each openQuestion must have");
    expect(prompt).toContain("`question`");
    expect(prompt).toContain("`raisedBy`");
    expect(prompt).toContain("`options`");
  });

  test("explicitly forbids modifying draft-authored fields", () => {
    expect(prompt).toContain("NEVER modify draft-authored fields");
    expect(prompt).toContain("DO NOT MODIFY");
  });

  test("lists all protected draft fields by name", () => {
    // All draft-authored fields that must not be modified
    expect(prompt).toContain("`title`");
    expect(prompt).toContain("`description`");
    expect(prompt).toContain("`acceptanceCriteria`");
    expect(prompt).toContain("`fileReferences`");
    expect(prompt).toContain("`feature`");
    expect(prompt).toContain("`fulfills`");
    expect(prompt).toContain("`milestone`");
    expect(prompt).toContain("`estimatedComplexity`");
    expect(prompt).toContain("`behavioralContract`");
    expect(prompt).toContain("`decisions`");
    expect(prompt).toContain("`risks`");
  });

  test("states only review and openQuestions may be added", () => {
    expect(prompt).toContain("Only add `review` and `openQuestions`");
  });

  test("does NOT contain markdown table output format", () => {
    expect(prompt).not.toContain("| # | Finding | File | Reviewers |");
    expect(prompt).not.toContain("| # | Finding | File | Reviewers | Action Required |");
    expect(prompt).not.toContain("## Critical (P1)");
    expect(prompt).not.toContain("## Important (P2)");
    expect(prompt).not.toContain("## Minor (P3)");
    expect(prompt).not.toContain("# Plan Review Summary");
  });

  test("does NOT contain markdown Open Questions heading", () => {
    // Old format used ## Open Questions as a parsed heading
    expect(prompt).not.toMatch(/^## Open Questions$/m);
  });

  test("includes severity definitions convention", () => {
    expect(prompt).toContain("Severity Definitions");
    expect(prompt).toContain("P1 (Critical)");
    expect(prompt).toContain("P2 (Important)");
    expect(prompt).toContain("P3 (Minor)");
  });

  test("includes token limits convention", () => {
    expect(prompt).toContain("Token Limits");
  });

  test("includes file/line discipline convention", () => {
    expect(prompt).toContain("File/Line Citation");
  });

  test("includes handoff instructions when handoff path provided", () => {
    expect(prompt).toContain("Handoff Instructions");
    expect(prompt).toContain(".flywheel/handoffs/test-handoff.json");
  });

  test("handles missing handoff path gracefully", () => {
    const noHandoff = makeCtx({ extra: {} });
    const result = buildPlanReviewPrompt(noHandoff);
    expect(result).not.toContain("Handoff Instructions");
  });

  test("findings use P1/P2/P3 severity levels", () => {
    expect(prompt).toContain('"P1"');
    expect(prompt).toContain("P1 = critical");
    expect(prompt).toContain("P2 = important");
    expect(prompt).toContain("P3 = minor");
  });

  test("instructs writing annotated JSON to same file path as original", () => {
    expect(prompt).toContain("Write the annotated JSON to the SAME file path");
  });

  test("instructs omitting review on steps with no findings", () => {
    expect(prompt).toContain("Omit `review` on steps with no findings");
  });

  test("instructs openQuestions is always present even if empty", () => {
    expect(prompt).toContain('openQuestions is always present');
    expect(prompt).toContain('"openQuestions": []');
  });

  test("includes contradiction handling for reviewers", () => {
    expect(prompt).toContain("Contradiction Handling");
    expect(prompt).toContain("open question");
  });

  test("includes deduplication rules", () => {
    expect(prompt).toContain("Deduplication Rules");
    expect(prompt).toContain("Identical findings");
    expect(prompt).toContain("Similar findings");
    expect(prompt).toContain("Unique findings");
  });

  test("JSON example in prompt is valid JSON", () => {
    // Extract the JSON block that shows the annotated format
    const jsonBlocks = prompt.match(/```json\n([\s\S]*?)```/g);
    expect(jsonBlocks).not.toBeNull();
    expect(jsonBlocks!.length).toBeGreaterThanOrEqual(1);
    // The annotated JSON example should be valid
    const annotatedExample = jsonBlocks!.find((b) => b.includes('"openQuestions"'));
    expect(annotatedExample).toBeDefined();
    const jsonContent = annotatedExample!.replace(/```json\n/, "").replace(/```$/, "");
    expect(() => JSON.parse(jsonContent)).not.toThrow();
  });

  test("annotated JSON example has openQuestion with question, raisedBy, options", () => {
    // Parse the annotated JSON example
    const jsonBlocks = prompt.match(/```json\n([\s\S]*?)```/g);
    const annotatedExample = jsonBlocks!.find((b) => b.includes('"openQuestions"'));
    const jsonContent = annotatedExample!.replace(/```json\n/, "").replace(/```$/, "");
    const parsed = JSON.parse(jsonContent);
    expect(parsed.openQuestions).toBeArray();
    expect(parsed.openQuestions.length).toBeGreaterThan(0);
    const q = parsed.openQuestions[0];
    expect(q).toHaveProperty("question");
    expect(q).toHaveProperty("raisedBy");
    expect(q).toHaveProperty("options");
    expect(typeof q.question).toBe("string");
    expect(typeof q.raisedBy).toBe("string");
    expect(Array.isArray(q.options)).toBe(true);
  });

  test("annotated JSON example has review.findings with severity, description, reviewer", () => {
    const jsonBlocks = prompt.match(/```json\n([\s\S]*?)```/g);
    const annotatedExample = jsonBlocks!.find((b) => b.includes('"openQuestions"'));
    const jsonContent = annotatedExample!.replace(/```json\n/, "").replace(/```$/, "");
    const parsed = JSON.parse(jsonContent);
    const stepWithReview = parsed.steps.find((s: any) => s.review);
    expect(stepWithReview).toBeDefined();
    expect(stepWithReview.review.findings).toBeArray();
    const finding = stepWithReview.review.findings[0];
    expect(finding).toHaveProperty("severity");
    expect(finding).toHaveProperty("description");
    expect(finding).toHaveProperty("reviewer");
    expect(["P1", "P2", "P3"]).toContain(finding.severity);
  });
});

// ---------------------------------------------------------------------------
// planReviewValidationCriteria — references annotated JSON
// ---------------------------------------------------------------------------

describe("planReviewValidationCriteria", () => {
  test("references annotated JSON", () => {
    expect(planReviewValidationCriteria).toContain("Annotated JSON");
  });

  test("references review findings", () => {
    expect(planReviewValidationCriteria).toContain("review findings");
  });

  test("references openQuestions", () => {
    expect(planReviewValidationCriteria).toContain("openQuestions");
  });

  test("references draft fields unmodified", () => {
    expect(planReviewValidationCriteria).toContain("Draft fields unmodified");
  });

  test("does NOT reference markdown format", () => {
    expect(planReviewValidationCriteria).not.toContain("P1/P2/P3 categorized findings");
    expect(planReviewValidationCriteria).not.toContain("Plan Review Summary");
  });
});

// ---------------------------------------------------------------------------
// Plan workflow definition — step 2 (review) validation criteria
// ---------------------------------------------------------------------------

describe("planWorkflow definition — step 2 (review)", () => {
  test("step 2 (review) validation criteria references annotated JSON", () => {
    const reviewStep = planWorkflow.steps[2];
    expect(reviewStep.validationCriteria).toContain("Annotated JSON");
  });

  test("step 2 (review) validation criteria references openQuestions", () => {
    const reviewStep = planWorkflow.steps[2];
    expect(reviewStep.validationCriteria).toContain("openQuestions");
  });

  test("step 2 (review) validation criteria references draft fields unmodified", () => {
    const reviewStep = planWorkflow.steps[2];
    expect(reviewStep.validationCriteria).toContain("Draft fields unmodified");
  });

  test("step 2 (review) dispatcher hint mentions 6 reviewer subagents", () => {
    const reviewStep = planWorkflow.steps[2];
    expect(reviewStep.dispatcherHint).toContain("6 reviewer subagents");
  });

  test("step 2 (review) dispatcher hint mentions annotated JSON", () => {
    const reviewStep = planWorkflow.steps[2];
    expect(reviewStep.dispatcherHint).toContain("annotated JSON");
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

// ---------------------------------------------------------------------------
// Plan Consolidation Prompt — JSON consolidation (VAL-JSON-004, VAL-JSON-010)
// ---------------------------------------------------------------------------

describe("buildPlanConsolidatePrompt (JSON consolidation)", () => {
  const ctx = makeCtx();
  const prompt = buildPlanConsolidatePrompt(ctx);

  test("includes annotated JSON plan section", () => {
    expect(prompt).toContain("## Annotated JSON Plan");
    expect(prompt).toContain("```json");
  });

  test("includes plan content from context", () => {
    expect(prompt).toContain("Add a hello world endpoint");
  });

  test("instructs merging P1/P2 findings into step content", () => {
    expect(prompt).toContain("P1");
    expect(prompt).toContain("P2");
    expect(prompt).toContain("findings");
    expect(prompt).toContain("merge");
  });

  test("instructs incorporating findings into descriptions and acceptanceCriteria", () => {
    expect(prompt).toContain("description");
    expect(prompt).toContain("acceptanceCriteria");
  });

  test("instructs stripping all review annotations from steps", () => {
    expect(prompt).toContain("review");
    expect(prompt).toContain("Strips all");
    expect(prompt).toContain("annotations");
  });

  test("instructs stripping openQuestions array", () => {
    expect(prompt).toContain("openQuestions");
  });

  test("instructs writing clean JSON to .flywheel/plans/<name>.plan.json", () => {
    expect(prompt).toContain(".flywheel/plans/");
    expect(prompt).toContain(".plan.json");
  });

  test("output schema matches draft schema (no review annotations)", () => {
    expect(prompt).toContain('"steps"');
    expect(prompt).toContain('"behavioralContract"');
    expect(prompt).toContain('"decisions"');
    expect(prompt).toContain('"risks"');
  });

  test("output schema includes step fields (title, description, acceptanceCriteria, fileReferences)", () => {
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('"description"');
    expect(prompt).toContain('"acceptanceCriteria"');
    expect(prompt).toContain('"fileReferences"');
  });

  test("includes synthesis principles for merging findings", () => {
    expect(prompt).toContain("Synthesis Principles");
    expect(prompt).toContain("Merge findings INTO steps");
  });

  test("includes quality checks before finalizing", () => {
    expect(prompt).toContain("Quality Checks");
    expect(prompt).toContain("Every P1 finding is incorporated");
  });

  test("does NOT contain markdown plan template instructions", () => {
    // No Phase headings
    expect(prompt).not.toContain("### Phase N:");
    expect(prompt).not.toContain("### Phase 1:");
    // No checklist syntax in template
    expect(prompt).not.toContain("## Implementation Checklist");
    // No milestone markers (## Milestone: format)
    expect(prompt).not.toMatch(/^## Milestone:/m);
    // No fulfills HTML annotations
    expect(prompt).not.toContain("<!-- fulfills:");
    // No instruction to generate a validation-contract.md
    expect(prompt).not.toContain("validation-contract.md");
    // No .state.md references
    expect(prompt).not.toContain(".state.md");
  });

  test("does NOT contain legacy markdown consolidated plan template", () => {
    expect(prompt).not.toContain("## Consolidated Plan Template");
    expect(prompt).not.toContain("## Executive Summary");
    expect(prompt).not.toContain("## Technical Reference");
    expect(prompt).not.toContain("## Appendix");
    expect(prompt).not.toContain("## Critical Items");
  });

  test("does NOT instruct producing separate validation-contract.md", () => {
    expect(prompt).not.toContain("Generate the validation contract");
    expect(prompt).not.toContain("validation-contract.md");
  });

  test("includes severity definitions convention", () => {
    expect(prompt).toContain("Severity Definitions");
  });

  test("includes scope discipline convention", () => {
    expect(prompt).toContain("Scope Discipline");
  });

  test("includes handoff instructions when handoff path provided", () => {
    expect(prompt).toContain("Handoff Instructions");
    expect(prompt).toContain(".flywheel/handoffs/test-handoff.json");
  });

  test("handles missing handoff path gracefully", () => {
    const noHandoff = makeCtx({ extra: {} });
    const result = buildPlanConsolidatePrompt(noHandoff);
    expect(result).not.toContain("Handoff Instructions");
  });

  test("JSON example in output schema is valid JSON", () => {
    const jsonBlocks = prompt.match(/```json\n([\s\S]*?)```/g);
    expect(jsonBlocks).not.toBeNull();
    expect(jsonBlocks!.length).toBeGreaterThanOrEqual(1);
    // Find the output schema example (has "steps" and "behavioralContract")
    const outputExample = jsonBlocks!.find(
      (b) => b.includes('"steps"') && b.includes('"behavioralContract"') && !b.includes('"openQuestions"'),
    );
    expect(outputExample).toBeDefined();
    if (outputExample) {
      const jsonContent = outputExample.replace(/```json\n/, "").replace(/```$/, "");
      expect(() => JSON.parse(jsonContent)).not.toThrow();
    }
  });

  test("instructs updating decisions with review findings and question resolutions", () => {
    expect(prompt).toContain("decisions");
    expect(prompt).toContain("review");
  });

  test("instructs updating risks with review findings", () => {
    expect(prompt).toContain("risks");
  });

  test("P1 findings are mandatory", () => {
    expect(prompt).toContain("P1 findings are mandatory");
  });

  test("P2 findings are strongly recommended", () => {
    expect(prompt).toContain("P2 findings");
  });

  test("instructs resolving ALL open questions", () => {
    expect(prompt).toContain("Resolve ALL open questions");
  });

  test("instructs no orphaned behavioral contract assertions", () => {
    expect(prompt).toContain("fulfills");
    expect(prompt).toContain("behavioralContract");
  });

  test("instructs overwriting annotated plan at same path", () => {
    expect(prompt).toContain(".flywheel/plans/");
    expect(prompt).toContain("overwrite");
  });
});

// ---------------------------------------------------------------------------
// HITL control in consolidation (VAL-JSON-010)
// ---------------------------------------------------------------------------

describe("buildPlanConsolidatePrompt — HITL question resolution", () => {
  test("HITL enabled: resolved questions show as Decisions Made section", () => {
    const ctx = makeCtx({
      extra: {
        handoffPath: ".flywheel/handoffs/test.json",
        resolvedQuestions: [
          {
            question: "Which auth provider?",
            answers: ["Auth0"],
            source: "user",
          },
        ],
      },
    });
    const prompt = buildPlanConsolidatePrompt(ctx);
    expect(prompt).toContain("## Decisions Made");
    expect(prompt).toContain("Which auth provider?");
    expect(prompt).toContain("Auth0");
    expect(prompt).toContain("user");
  });

  test("HITL disabled: unresolved questions show as Open Questions to Resolve section", () => {
    const ctx = makeCtx({
      extra: {
        handoffPath: ".flywheel/handoffs/test.json",
        unresolvedQuestions: [
          {
            question: "Which auth provider?",
            header: "Auth",
            options: [
              { label: "Auth0", description: "Managed auth service" },
              { label: "Cognito", description: "AWS native" },
            ],
          },
        ],
      },
    });
    const prompt = buildPlanConsolidatePrompt(ctx);
    expect(prompt).toContain("## Open Questions to Resolve");
    expect(prompt).toContain("Which auth provider?");
    expect(prompt).toContain("Auth0");
    expect(prompt).toContain("Cognito");
    expect(prompt).toContain("best judgment");
  });

  test("no questions: shows no open questions message", () => {
    const ctx = makeCtx({
      extra: {
        handoffPath: ".flywheel/handoffs/test.json",
      },
    });
    const prompt = buildPlanConsolidatePrompt(ctx);
    expect(prompt).toContain("No open questions");
  });

  test("multiple resolved questions all appear", () => {
    const ctx = makeCtx({
      extra: {
        handoffPath: ".flywheel/handoffs/test.json",
        resolvedQuestions: [
          { question: "Which DB?", answers: ["PostgreSQL"], source: "user" },
          { question: "Which ORM?", answers: ["Drizzle"], source: "user" },
        ],
      },
    });
    const prompt = buildPlanConsolidatePrompt(ctx);
    expect(prompt).toContain("Which DB?");
    expect(prompt).toContain("PostgreSQL");
    expect(prompt).toContain("Which ORM?");
    expect(prompt).toContain("Drizzle");
  });

  test("multiple unresolved questions all appear with options", () => {
    const ctx = makeCtx({
      extra: {
        handoffPath: ".flywheel/handoffs/test.json",
        unresolvedQuestions: [
          {
            question: "Which DB?",
            header: "Database",
            options: [
              { label: "PostgreSQL", description: "" },
              { label: "SQLite", description: "" },
            ],
          },
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "Express", description: "" },
              { label: "Hono", description: "" },
            ],
          },
        ],
      },
    });
    const prompt = buildPlanConsolidatePrompt(ctx);
    expect(prompt).toContain("Which DB?");
    expect(prompt).toContain("PostgreSQL");
    expect(prompt).toContain("Which framework?");
    expect(prompt).toContain("Express");
    expect(prompt).toContain("Hono");
  });
});

// ---------------------------------------------------------------------------
// planConsolidateValidationCriteria — references clean JSON
// ---------------------------------------------------------------------------

describe("planConsolidateValidationCriteria", () => {
  test("references clean JSON", () => {
    expect(planConsolidateValidationCriteria).toContain("JSON");
  });

  test("references .flywheel/plans/", () => {
    expect(planConsolidateValidationCriteria).toContain(".flywheel/plans/");
  });

  test("references review findings merged", () => {
    expect(planConsolidateValidationCriteria).toContain("review findings merged");
  });

  test("references P1 addressed", () => {
    expect(planConsolidateValidationCriteria).toContain("P1 addressed");
  });

  test("references no review annotations remaining", () => {
    expect(planConsolidateValidationCriteria).toContain("no review annotations");
  });

  test("does NOT reference markdown format", () => {
    expect(planConsolidateValidationCriteria).not.toContain(".md");
    expect(planConsolidateValidationCriteria).not.toContain("Implementation Checklist");
  });
});

// ---------------------------------------------------------------------------
// Plan workflow definition — step 3 (consolidation) validation criteria
// ---------------------------------------------------------------------------

describe("planWorkflow definition — step 3 (consolidation)", () => {
  test("step 3 validation criteria references clean JSON", () => {
    const consolidationStep = planWorkflow.steps[3];
    expect(consolidationStep.validationCriteria).toContain("JSON");
  });

  test("step 3 validation criteria references .flywheel/plans/", () => {
    const consolidationStep = planWorkflow.steps[3];
    expect(consolidationStep.validationCriteria).toContain(".flywheel/plans/");
  });

  test("step 3 validation criteria references review findings merged", () => {
    const consolidationStep = planWorkflow.steps[3];
    expect(consolidationStep.validationCriteria).toContain("review findings merged");
  });

  test("step 3 validation criteria references no review annotations remaining", () => {
    const consolidationStep = planWorkflow.steps[3];
    expect(consolidationStep.validationCriteria).toContain("no review annotations");
  });

  test("step 3 dispatcher hint mentions consolidation", () => {
    const consolidationStep = planWorkflow.steps[3];
    expect(consolidationStep.dispatcherHint).toContain("consolidate");
  });
});
